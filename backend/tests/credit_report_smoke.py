"""Credit Consumption Report: aggregation, reconciliation and link checks.

Run from backend/:  python tests/credit_report_smoke.py

Seeds every tool table in an in-memory SQLite database with known numbers,
then checks:
  * status mapping (raw status -> Charged / Pending / Failed / Refunded) in
    Python and SQL
  * the GROUP BY queries: credits, Kling clamp, owner-less rows as
    "Unassigned", IST date boundaries, every filter, the test & admin
    account exclusion
  * the model: ranks, ties, Unassigned never ranked, client-tagging rate
  * duplicate detection (same user/tool/prompt within 5 s, both charged)
  * an end-to-end workbook: Charged totals reconcile across every sheet
    (Unassigned included), Charged + Pending + Failed = every log row, no
    Output link contains "localhost", and every internal hyperlink lands on
    an existing cell whose text matches the link label
  * edge cases: no data in range, formula-looking prompts stay text, long
    prompts are truncated, mostly-empty Task / Model columns are dropped
  * the API: Section Access gating, options, validation, output lookup
"""
import os
import re
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from openpyxl import load_workbook  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from models_new import (  # noqa: E402
    Base,
    GenerationClient,
    GenerationRecord,
    ITPortalTool,
    ITPortalToolUsageEvent,
    User,
    UserFeatureAccess,
    UserRole,
)
from providers.elevenlabs.models import ElevenlabsGeneration  # noqa: E402
from providers.envato.models import EnvatoGeneration  # noqa: E402
from providers.epidemicsound.models import EpidemicAdaptation  # noqa: E402
from providers.flow.models import FlowGeneration  # noqa: E402
from providers.freepik.models import FreepikGeneration  # noqa: E402
from providers.heygen.models import HeygenGeneration  # noqa: E402
from providers.higgsfield.models import HiggsfieldGeneration  # noqa: E402
from providers.suno.models import SunoGeneration  # noqa: E402
from utils.credit_report import (  # noqa: E402
    CHARGED,
    FAILED,
    NO_CLIENT,
    PENDING,
    UNASSIGNED,
    UNASSIGNED_USER_ID,
    ReportFilters,
    build_model,
    charge_status,
    generate_report,
    load_excluded_summary,
    load_groups,
    resolve_excluded_accounts,
)
from utils.credit_report import workbook as W  # noqa: E402
from utils.credit_report.facts import EXCLUDED_ACCOUNTS_ENV  # noqa: E402

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
TABLES = [
    User, UserRole, UserFeatureAccess, GenerationClient, ITPortalTool, ITPortalToolUsageEvent, GenerationRecord,
    FreepikGeneration, EnvatoGeneration, HeygenGeneration, HiggsfieldGeneration, ElevenlabsGeneration,
    FlowGeneration, SunoGeneration, EpidemicAdaptation,
]
Base.metadata.create_all(bind=engine, tables=[m.__table__ for m in TABLES])

OCT1, OCT7, SEP1 = "2026-10-01", "2026-10-07", "2026-09-01"
DASHBOARD = "https://dash.example.com"
LONG_PROMPT = "x" * 40_000
INJECTION = '=HYPERLINK("http://evil.example","click")'
DUP_PROMPT = "a red fox, cinematic"
IDS: dict = {}

# Expected figures for 1-7 Oct 2026 (IST), admin accounts excluded.
# Tester is a test account but is only excluded once listed in CREDIT_REPORT_EXCLUDED_ACCOUNTS.
EXPECTED_USER_CHARGED = {"Ravi": 230, "Asha": 200, "Bob": 1035, "Zed": 10, "Del": 15, "Tester": 33, UNASSIGNED: 999}
CHARGED_TOTAL = 2522
CHARGED_ROWS = 18
PENDING_TOTAL = 2536
PENDING_ROWS = 8
FAILED_TOTAL = 40
FAILED_ROWS = 1
ALL_ROWS = CHARGED_ROWS + PENDING_ROWS + FAILED_ROWS
ADMIN_CREDITS, TESTER_CREDITS = 77, 33


def _assert(condition, message):
    if not condition:
        raise AssertionError(message)


def _close(a, b, message):
    _assert(abs(float(a) - float(b)) < 0.005, f"{message}: {a} != {b}")


def seed():
    """Rows per user (Oct, IST), C = Charged, P = Pending, F = Failed:

    Ravi  Kling 100 C Acme, 50 C, duplicate pair 10+10 C 3 s apart, 10 C 20 s later (not a dup),
          10 P same prompt (not a dup: pending); HeyGen 50 C Acme           = 230 C, 10 P
    Asha  Kling 5000->0 C, Freepik 20 C Beta, HeyGen 180 C Beta, HeyGen 6 P processing,
          HeyGen 0 P draft                                                  = 200 C, 6 P
    Bob   Freepik 30 C Acme (long prompt), Freepik 40 F, ElevenLabs 5 C (no status), ElevenLabs 1500 P
          generating_music, Suno None C complete, Suno P streaming, Epidemic 1000 C Acme, 1000 P draft,
          Kling 0 P submitted, Kling 20 P reconciling                       = 1035 C, 2520 P, 40 F
    Zed   (blank dept) Envato 10 C, Flow 0 C (30 Sep 20:00 UTC = 1 Oct IST)  = 10 C
    Del   (deleted) Higgsfield 15 C Gamma                                   = 15 C
    (no owner) Freepik 999 C, history-sync import                           = 999 C  -> "Unassigned"
    Admin (is_admin) Freepik 77 C; Tester HeyGen 33 C                        -> excluded by default
    Outside the range: Kling Ravi 70 C on 30 Sep, Flow Zed on 8 Oct IST.
    """
    with SessionLocal() as db:
        def user(name, dept, deleted=False, admin=False, email=None):
            u = User(email=email or f"{name.lower()}@example.com", name=name, hashed_password="x", department=dept,
                     is_active=True, is_deleted=deleted, is_admin=admin, employee_id=f"E-{name}")
            db.add(u)
            db.flush()
            IDS[name] = u.id
            return u.id

        ravi, asha = user("Ravi", "Design"), user("Asha", " Design ")
        bob, zed, dele = user("Bob", "Video"), user("Zed", "  "), user("Del", "Video", deleted=True)
        admin = user("Admin", "Management", admin=True)
        tester = user("Tester", "Video", email="tester@example.com")
        role_admin = user("RoleAdmin", "Management")
        db.add(UserRole(user_id=role_admin, role="admin"))
        user("Plain", "Video")
        db.add_all([GenerationClient(name="Acme"), GenerationClient(name="Beta"), GenerationClient(name="Gamma")])
        kling = ITPortalTool(name="Kling AI", slug="kling", website_url="https://kling.example")
        db.add(kling)
        db.flush()

        def ev(uid, credits, client=None, day=date(2026, 10, 3), prompt=None, status="settled", at=None):
            e = ITPortalToolUsageEvent(tool_id=kling.id, user_id=uid, event_type="generation", event_date=day,
                                       credits_burned=credits, linked_client_name=client, prompt_text=prompt,
                                       status=status, created_at=at or datetime(day.year, day.month, day.day, 6))
            db.add(e)
            db.flush()
            return e

        e1 = ev(ravi, 100, "Acme", prompt="a cat on the moon")
        ev(ravi, 50, "  ")
        dup_day = datetime(2026, 10, 4, 6, 0, 0)
        ev(ravi, 10, prompt=DUP_PROMPT, day=date(2026, 10, 4), at=dup_day)
        ev(ravi, 10, prompt=DUP_PROMPT, day=date(2026, 10, 4), at=dup_day.replace(second=3))
        ev(ravi, 10, prompt=DUP_PROMPT, day=date(2026, 10, 4), at=dup_day.replace(second=2), status="submitted")
        ev(ravi, 10, prompt=DUP_PROMPT, day=date(2026, 10, 4), at=dup_day.replace(second=20))
        ev(asha, 5000)                                          # outside 0-3000 -> 0 credits
        ev(ravi, 70, "Acme", day=date(2026, 9, 30))             # September
        ev(bob, 0, status="submitted")
        ev(bob, 20, status="reconciling")
        db.add(GenerationRecord(provider="kling", provider_task_id="k1", source_usage_event_id=e1.id,
                                canonical_asset_url="https://cdn.kling.example/k1.mp4", owner_user_id=ravi))
        IDS["kling_event"] = e1.id

        at = datetime(2026, 10, 2, 9)
        db.add_all([
            FreepikGeneration(creation_id="f1", owner_user_id=asha, credits_charged=20, linked_client_name="Beta",
                              provider_created_at=at, prompt="beta poster", status="completed"),
            FreepikGeneration(creation_id="f2", owner_user_id=bob, credits_charged=30, linked_client_name="Acme",
                              provider_created_at=at, prompt=LONG_PROMPT, raw_url="https://freepik.example/f2.png",
                              status="completed"),
            FreepikGeneration(creation_id="f3", owner_user_id=None, credits_charged=999, provider_created_at=at,
                              status="completed", ingestion_source="recovered", ownership_status="unknown"),
            FreepikGeneration(creation_id="f4", owner_user_id=bob, credits_charged=40, provider_created_at=at,
                              status="failed"),
            FreepikGeneration(creation_id="f5", owner_user_id=admin, credits_charged=ADMIN_CREDITS,
                              provider_created_at=at, status="completed"),
            HeygenGeneration(video_id="h1", owner_user_id=ravi, credits_used=50, linked_client_name="Acme",
                             provider_created_at=at, status="completed"),
            HeygenGeneration(video_id="h2", owner_user_id=asha, credits_used=180, linked_client_name="Beta",
                             provider_created_at=at, status="completed"),
            HeygenGeneration(video_id="h3", owner_user_id=asha, credits_used=6, provider_created_at=at, status="processing"),
            HeygenGeneration(video_id="h4", owner_user_id=asha, credits_used=0, provider_created_at=at, status="draft"),
            HeygenGeneration(video_id="h5", owner_user_id=tester, credits_used=TESTER_CREDITS, provider_created_at=at,
                             status="completed"),
            ElevenlabsGeneration(provider_creation_id="el1", owner_user_id=bob, credits_used=5, prompt=INJECTION,
                                 provider_created_at=at),
            ElevenlabsGeneration(provider_creation_id="el2", owner_user_id=bob, credits_used=1500,
                                 provider_created_at=at, status="generating_music"),
            SunoGeneration(provider_creation_id="s1", owner_user_id=bob, credits_used=None, provider_created_at=at,
                           status="complete", asset_mirror_status="mirrored", mirrored_asset_key="suno/s1.mp3",
                           media_url="https://cdn.suno.example/s1.mp3", model_name="chirp-v4"),
            SunoGeneration(provider_creation_id="s2", owner_user_id=bob, provider_created_at=at, status="streaming"),
            EpidemicAdaptation(version_id="ep1", owner_user_id=bob, credits_used=1000, status="completed",
                               linked_client_name="Acme", created_at=at),
            EpidemicAdaptation(version_id="ep2", owner_user_id=bob, credits_used=1000, status="draft", created_at=at),
            EnvatoGeneration(item_uuid="en1", owner_user_id=zed, credits_badge=10, provider_created_at=at),
            FlowGeneration(provider_creation_id="fl1", owner_user_id=zed, provider_created_at=datetime(2026, 9, 30, 20)),
            FlowGeneration(provider_creation_id="fl2", owner_user_id=zed, provider_created_at=datetime(2026, 10, 7, 19)),
            HiggsfieldGeneration(generation_id="hf1", owner_user_id=dele, credits_used=15, linked_client_name="Gamma",
                                 provider_created_at=at, status="completed"),
        ])
        db.commit()


def _filters(db, **kw):
    f = ReportFilters.build(start=kw.pop("start", OCT1), end=kw.pop("end", OCT7), **kw)
    if f.exclude_test_accounts:
        f.excluded_accounts = resolve_excluded_accounts(db)
    return f


def _charged(groups, key):
    out = {}
    for g in groups:
        if g.charge_status == CHARGED:
            out[getattr(g, key)] = out.get(getattr(g, key), 0.0) + g.credits
    return out


def _sum(groups, status, attr="credits"):
    return sum(getattr(g, attr) for g in groups if g.charge_status == status)


# --------------------------------------------------------------------------- #
# Status mapping, aggregation, filters, exclusion
# --------------------------------------------------------------------------- #
def test_status_mapping():
    charged = ["Settled", "settled", "Completed", "complete", "Captured", "success", "done", "active", "", None, "  "]
    pending = ["Submitted", "Queued", "Running", "Generating_Music", "Reconciling", "Streaming", "processing",
               "rendering", "pending", "draft", "brand-new-status"]
    failed = ["failed", "Error", "cancelled", "canceled", "rejected", "timeout", "Refunded"]
    for raw in charged:
        _assert(charge_status(raw) == CHARGED, f"{raw!r} -> Charged")
    for raw in pending:
        _assert(charge_status(raw) == PENDING, f"{raw!r} -> Pending")
    for raw in failed:
        _assert(charge_status(raw) == FAILED, f"{raw!r} -> Failed / Refunded")
    print("ok  status mapping")


def test_group_queries():
    os.environ.pop(EXCLUDED_ACCOUNTS_ENV, None)
    with SessionLocal() as db:
        groups = load_groups(db, _filters(db))
        _close(_sum(groups, CHARGED), CHARGED_TOTAL, "charged credits")
        _assert(_sum(groups, CHARGED, "generations") == CHARGED_ROWS, "charged generations")
        _close(_sum(groups, PENDING), PENDING_TOTAL, "pending credits (SQL status mapping)")
        _assert(_sum(groups, PENDING, "generations") == PENDING_ROWS, "pending generations")
        _close(_sum(groups, FAILED), FAILED_TOTAL, "failed credits")
        _assert(sum(g.generations for g in groups) == ALL_ROWS, "Charged + Pending + Failed = all rows")
        by_user = _charged(groups, "user_name")
        for name, expected in EXPECTED_USER_CHARGED.items():
            _close(by_user.get(name, 0), expected, f"{name} charged credits")
        unassigned = [g for g in groups if g.user_id == UNASSIGNED_USER_ID]
        _assert(unassigned and all(g.department == UNASSIGNED for g in unassigned), "no owner -> Unassigned/Unassigned")
        _close(_charged(groups, "tool")["Kling"], 180, "Kling: clamp 5000 -> 0, September excluded")
        flow = [g for g in groups if g.tool == "Flow"]
        _assert(sum(g.generations for g in flow) == 1, "Flow: IST boundaries keep 1 of 2 rows")
        _assert({g.month for g in groups} == {"2026-10"}, "IST month")
        _assert("Admin" not in by_user and "RoleAdmin" not in by_user, "admins excluded by default")
        _assert("Tester" in by_user, "unlisted test account still included")
        zero = sum(g.zero_credit for g in groups if g.charge_status == CHARGED)
        _assert(zero == 3, f"zero-credit charged rows (clamped Kling, Suno, Flow): {zero}")
    print("ok  group queries")


def test_filters_and_exclusion():
    with SessionLocal() as db:
        design = load_groups(db, _filters(db, department="Design"))
        _assert({g.user_name for g in design} == {"Ravi", "Asha"}, "department filter")
        un = load_groups(db, _filters(db, department=UNASSIGNED))
        _assert({g.user_name for g in un} == {"Zed", UNASSIGNED}, "Unassigned department = blank dept + no owner")
        owner_less = load_groups(db, _filters(db, user_id=UNASSIGNED_USER_ID))
        _assert({g.user_name for g in owner_less} == {UNASSIGNED}, "user filter 0 = owner-less rows")
        _assert({g.tool for g in load_groups(db, _filters(db, tool="Kling"))} == {"Kling"}, "tool filter")
        nc = load_groups(db, _filters(db, client=NO_CLIENT))
        _assert(nc and {g.client for g in nc} == {NO_CLIENT}, "No client filter")
        _close(_sum(load_groups(db, _filters(db, user_id=IDS["Bob"])), CHARGED), 1035, "user filter")
        _assert(load_groups(db, _filters(db, tool="Nope")) == [], "unknown tool returns nothing")

        # Exclusion: off -> admin + tester counted; env list adds the tester.
        off = load_groups(db, _filters(db, exclude_test_accounts=False))
        _close(_sum(off, CHARGED), CHARGED_TOTAL + ADMIN_CREDITS, "exclusion off includes the admin")
        os.environ[EXCLUDED_ACCOUNTS_ENV] = "Tester@Example.com, 999999"
        try:
            f = _filters(db)
            names = {n for _i, n in f.excluded_accounts}
            _assert(names == {"Admin", "RoleAdmin", "Tester"}, f"flag, role row and env list: {names}")
            on = load_groups(db, f)
            _close(_sum(on, CHARGED), CHARGED_TOTAL - TESTER_CREDITS, "env-listed test account excluded")
            ex = load_excluded_summary(db, f)
            _close(ex["credits"], ADMIN_CREDITS + TESTER_CREDITS, "excluded credits summary")
            _assert(ex["accounts"] == 3 and ex["generations"] == 2, f"excluded summary {ex}")
        finally:
            os.environ.pop(EXCLUDED_ACCOUNTS_ENV, None)
    print("ok  filters and exclusion")


def test_model():
    with SessionLocal() as db:
        model = build_model(load_groups(db, _filters(db)))
    ranks = {u.name: (u.company_rank, u.department_rank) for u in model.users}
    _assert(ranks["Bob"] == (1, 1) and ranks["Ravi"] == (2, 1) and ranks["Asha"] == (3, 2), f"ranks {ranks}")
    _assert(ranks[UNASSIGNED] == ("—", "—"), "Unassigned is not ranked")
    _assert(model.users[-1].name == UNASSIGNED, "Unassigned listed last")
    video = next(d for d in model.departments if d.name == "Video")
    _assert(video.top_user.keys == (IDS["Bob"],), "top user never Unassigned")
    unassigned_dept = next(d for d in model.departments if d.name == UNASSIGNED)
    _assert(unassigned_dept.top_user.keys == (IDS["Zed"],), "Unassigned dept's top user is a person")
    bob = model.user(IDS["Bob"])
    _close(bob.client_rate, 0.5, "Bob: 2 of 4 charged generations have a client")
    _close(bob.totals.credits_per_generation, 1035 / 4, "credits per generation")
    _assert(bob.top_tool.keys == ("Epidemic Sound",) and bob.top_tool.generations == 1, "top tool with gens")
    suno = next(t for t in model.tools if t.name == "Suno")
    _assert("Not captured" in suno.cost_note, "Suno marked as cost not captured")
    _assert(model.clients[-1].name == NO_CLIENT, "No client sorts last")
    clients_in_order = [r[2] for r in model.user_client_rows]
    _assert(clients_in_order == sorted(clients_in_order, key=[c.name for c in model.clients].index),
            "User x Client sorted by client")
    print("ok  model")


def test_duplicate_detection():
    def row(sec, prompt="p", tool="Kling", credits=10.0, status=CHARGED, user=1):
        return SimpleNamespace(user_id=user, tool=tool, prompt=prompt, credits=credits, charge_status=status,
                               occurred_at=datetime(2026, 10, 1, 6, 0, sec))
    rows = [row(0), row(3), row(9), row(14, credits=0), row(15, tool="Freepik"), row(16, prompt="q"),
            row(17, status=PENDING), row(18, user=2), row(30), row(35)]
    flags = [e["dup"] for e in W.flag_duplicates(rows)]
    _assert(flags == [True, True, False, False, False, False, False, False, True, True],
            f"dup flags: {flags}")
    print("ok  duplicate detection")


def test_log_columns_dropped_when_empty():
    m = SimpleNamespace(task_fill=0.19, model_fill=0.25)
    headers = W.log_headers(m)
    _assert("Task" not in headers and "Model / type" in headers, f"80% empty rule: {headers}")
    print("ok  log column drop rule")


# --------------------------------------------------------------------------- #
# Workbook
# --------------------------------------------------------------------------- #
LINK_RE = re.compile(r'^=HYPERLINK\("(?P<target>(?:[^"]|"")*)","(?P<label>(?:[^"]|"")*)"\)$')
INTERNAL_RE = re.compile(r"^#'(?P<sheet>[^']+)'!(?P<col>[A-Z]+)(?P<row>\d+)$")


def _build(path, **kw):
    with SessionLocal() as db:
        return generate_report(db, _filters(db, **kw), path, dashboard_url=DASHBOARD)


def _display(value, fmt=None):
    """What a cell shows: a link's label, a number at 2 dp, a date in its
    number format ("mmm yyyy" -> "Mar 2026"), or the text."""
    if isinstance(value, str):
        m = LINK_RE.match(value)
        return m.group("label").replace('""', '"') if m else value
    if isinstance(value, datetime):
        if fmt == "mmm yyyy":
            return value.strftime("%b %Y")
        if fmt == "dd mmm yyyy":
            return value.strftime("%d %b %Y")
        return value.isoformat(sep=" ")
    if isinstance(value, (int, float)):
        return f"{value:,.2f}"
    return "" if value is None else str(value)


def _normalize_label(label):
    label = label.strip()
    for prefix in ("⬅ Back to ", "⬅ "):
        if label.startswith(prefix):
            label = label[len(prefix):]
    return label[:-2] if label.endswith(" →") else label


def _table(ws, name=None):
    tables = list(ws.tables.values())
    table = next(t for t in tables if t.displayName == name) if name else tables[0]
    first, last = table.ref.split(":")
    header_row = int(re.sub(r"[A-Z]", "", first))
    last_row = int(re.sub(r"[A-Z]", "", last))
    headers = [c.value for c in ws[header_row]][: len(table.tableColumns)]
    rows = list(ws.iter_rows(min_row=header_row + 1, max_row=last_row, max_col=len(headers), values_only=True))
    return headers, rows


def _col_sum(ws, header, table=None, where=None):
    headers, rows = _table(ws, table)
    i = headers.index(header)
    if where:
        wi = headers.index(where[0])
        rows = [r for r in rows if r[wi] == where[1]]
    return sum(float(r[i] or 0) for r in rows)


def _links(wb):
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.data_type == "f" and cell.value.startswith("=HYPERLINK("):
                    m = LINK_RE.match(cell.value)
                    _assert(m, f"{ws.title}!{cell.coordinate} malformed link {cell.value[:80]}")
                    yield ws, cell, m.group("target").replace('""', '"'), m.group("label").replace('""', '"')


def _validate_links(wb):
    internal = external = 0
    for ws, cell, target, label in _links(wb):
        where = f"{ws.title}!{cell.coordinate}"
        if not target.startswith("#"):
            _assert("localhost" not in target and "127.0.0.1" not in target, f"{where}: local URL {target}")
            _assert(target.startswith(f"{DASHBOARD}/open-output?ref="), f"{where}: output link {target}")
            external += 1
            continue
        m = INTERNAL_RE.match(target)
        _assert(m, f"{where}: bad internal target {target}")
        sheet, col, row = m.group("sheet"), m.group("col"), int(m.group("row"))
        _assert(sheet in wb.sheetnames, f"{where} -> missing sheet {sheet}")
        dest = wb[sheet]
        _assert(row <= dest.max_row, f"{where} -> {target} past last row {dest.max_row}")
        target_cell = dest[f"{col}{row}"]
        shown = _display(target_cell.value, target_cell.number_format)
        _assert(shown == _normalize_label(label), f"{where} '{label}' -> {target} shows '{shown}'")
        internal += 1
    return internal, external


def test_workbook_end_to_end():
    fd, path = tempfile.mkstemp(suffix=".xlsx")
    os.close(fd)
    try:
        model = _build(path)
        wb = load_workbook(path)
        _assert(wb.sheetnames == list(W.SHEET_ORDER) + [W.LISTS], f"sheet order {wb.sheetnames}")
        _assert(wb[W.LISTS].sheet_state == "hidden", "Lists sheet is hidden")
        _assert_no_banned_functions(wb)
        log_headers = [c.value for c in wb[W.LOG][W.HEADER_ROW]]
        _assert({"Date", "Month", "Week", "Quarter", "Charged"} <= set(log_headers), f"log date columns {log_headers}")
        log_ws = wb[W.LOG]
        month_col = log_headers.index("Month") + 1
        first_month = log_ws.cell(W.FIRST_DATA_ROW, month_col)
        _assert(isinstance(first_month.value, datetime) and first_month.value.day == 1
                and first_month.number_format == "mmm yyyy", "Month is a real date shown mmm yyyy")
        week = log_ws.cell(W.FIRST_DATA_ROW, log_headers.index("Week") + 1).value
        _assert(isinstance(week, datetime) and week.weekday() == 0, "Week starts on Monday")
        charged_vals = {log_ws.cell(r, log_headers.index("Charged") + 1).value
                        for r in range(W.FIRST_DATA_ROW, W.FIRST_DATA_ROW + ALL_ROWS)}
        _assert(charged_vals == {True, False}, f"Charged is TRUE/FALSE: {charged_vals}")
        for ws in wb.worksheets:
            if ws.title == W.LISTS:          # hidden dropdown data, not a page
                continue
            if ws.title != W.HOME:
                _assert(_display(ws["A1"].value) == "⬅ Back to Home", f"{ws.title} A1 back link")
            if ws.title not in (W.HOME, W.PERIOD):
                _assert(_display(ws["B1"].value) == f"{W.PERIOD} →", f"{ws.title} links to Period Explorer")
            _assert(ws.freeze_panes, f"{ws.title} has frozen panes")
        for name in (W.DEPT, W.USER, W.TOOL, W.CLIENT, W.DEPT_TOOL, W.USER_TOOL, W.USER_CLIENT, W.QUALITY, W.LOG):
            _assert(len(wb[name].tables) == 1, f"{name} has one Excel Table")
        _assert(len(wb[W.TREND].tables) == 9, f"Monthly Trend tables: {list(wb[W.TREND].tables)}")
        _assert(wb[W.DEPT]["B5"].number_format == W.CREDITS_FMT, "credits use thousands separators")

        # Charged totals reconcile everywhere, Unassigned included.
        home = wb[W.HOME]
        log = wb[W.LOG]
        totals = {
            "Home KPI": home["A11"].value,
            "By Department": _col_sum(wb[W.DEPT], "Credits"),
            "By User": _col_sum(wb[W.USER], "Credits"),
            "By Tool": _col_sum(wb[W.TOOL], "Credits"),
            "By Client": _col_sum(wb[W.CLIENT], "Credits"),
            "Dept × Tool": _col_sum(wb[W.DEPT_TOOL], "Total"),
            "User × Tool": _col_sum(wb[W.USER_TOOL], "Total"),
            "User × Client": _col_sum(wb[W.USER_CLIENT], "Credits"),
            "Trend by tool": _col_sum(wb[W.TREND], "Total", "tblTrendToolCredits"),
            "Trend by department": _col_sum(wb[W.TREND], "Total", "tblTrendDeptCredits"),
            "Generation Log (Charged)": _col_sum(log, "Credits", where=("Charge status", CHARGED)),
        }
        for name, value in totals.items():
            _close(value, CHARGED_TOTAL, f"{name} charged total")
        _close(home["B11"].value, PENDING_TOTAL, "Home pending KPI")
        _close(_col_sum(wb[W.DEPT], "Pending credits"), PENDING_TOTAL, "By Department pending")
        _close(_col_sum(log, "Credits", where=("Charge status", PENDING)), PENDING_TOTAL, "log pending")
        _assert(home["C11"].value == CHARGED_ROWS, "Home generations KPI counts charged rows")
        _assert(_col_sum(wb[W.TREND], "Total", "tblTrendToolGenerations") == CHARGED_ROWS, "trend generations")

        headers, rows = _table(log)
        status_i = headers.index("Charge status")
        counts = {s: sum(1 for r in rows if r[status_i] == s) for s in (CHARGED, PENDING, FAILED)}
        _assert(counts == {CHARGED: CHARGED_ROWS, PENDING: PENDING_ROWS, FAILED: FAILED_ROWS}, f"log statuses {counts}")
        _assert(sum(counts.values()) == len(rows) == ALL_ROWS, "Charged + Pending + Failed = every log row")
        raw_i = headers.index("Raw status")
        _assert({"settled", "submitted", "reconciling", "generating_music", "draft", "streaming", "(none)"}
                <= {r[raw_i] for r in rows}, "raw status kept in the log")
        unassigned_rows = [r for r in rows if r[headers.index("User")] == UNASSIGNED]
        _assert(len(unassigned_rows) == 1 and unassigned_rows[0][headers.index("Department")] == UNASSIGNED,
                "Unassigned row in the log")

        # Duplicates, dropped columns, injection, truncation, IST.
        dup_i = headers.index(W.DUPLICATE_LABEL)
        _assert(sum(1 for r in rows if r[dup_i] == W.DUPLICATE_LABEL) == 2, "exactly one duplicate pair flagged")
        _assert("Task" not in headers and "Model / type" not in headers, f"empty Task/Model dropped: {headers}")
        prompt_col = W.get_column_letter(headers.index("Prompt") + 1)
        prompts = [log[f"{prompt_col}{r}"] for r in range(W.FIRST_DATA_ROW, W.FIRST_DATA_ROW + ALL_ROWS)]
        injected = [c for c in prompts if c.value == INJECTION]
        _assert(injected and injected[0].data_type == "s", "formula-looking prompt stays text")
        longest = max((c.value or "" for c in prompts), key=len)
        _assert(len(longest) <= 32_767 and longest.endswith(W.TRUNCATION_MARKER), "long prompt truncated")
        _assert(any(isinstance(r[0], datetime) and (r[0].hour, r[0].minute) == (1, 30) for r in rows), "IST times")

        # Links: none local, every internal one lands on matching text.
        internal, external = _validate_links(wb)
        _assert(internal > 80 and external == 3, f"links checked: {internal} internal, {external} output")

        # Users' first log rows really are their first rows.
        user_headers, user_rows = _table(wb[W.USER])
        for (cell,) in wb[W.USER].iter_rows(min_row=5, max_row=4 + len(user_rows), max_col=1):
            target = INTERNAL_RE.match(LINK_RE.match(cell.value).group("target"))
            row = int(target.group("row"))
            ucol = W.get_column_letter([c.value for c in log[W.HEADER_ROW]].index("User") + 1)
            _assert(row == W.FIRST_DATA_ROW or log[f"{ucol}{row - 1}"].value != log[f"{ucol}{row}"].value,
                    f"{_display(cell.value)} -> first log row")

        # Data Quality and Home.
        dq_headers, dq_rows = _table(wb[W.QUALITY])
        dq = {r[0]: r for r in dq_rows}
        _assert(dq[UNASSIGNED][1] == 1 and abs(dq[UNASSIGNED][2] - 999) < 0.01, "DQ Unassigned")
        _assert(dq[PENDING][1] == PENDING_ROWS and abs(dq[PENDING][2] - PENDING_TOTAL) < 0.01, "DQ Pending")
        _assert(dq[W.DUPLICATE_LABEL][1] == 2 and abs(dq[W.DUPLICATE_LABEL][2] - 20) < 0.01, "DQ duplicates")
        _assert(dq["Zero-credit generations"][1] == 3, "DQ zero-credit rows")
        _assert(dq["Test & admin accounts excluded"][1] == 1, "DQ excluded (admin's one generation)")
        qa_headers, qa_rows = _table(home, "tblQuickAnswers")
        _assert(len(qa_rows) <= 9 and not any("top user on" in (r[0] or "").lower() for r in qa_rows),
                f"{len(qa_rows)} quick answers, no per-tool rows")
        home_text = " ".join(str(c.value) for row in home.iter_rows() for c in row if c.value)
        _assert("Excluded: Admin, RoleAdmin" in home_text, "exclusion setting printed on Home")
        _assert(f"Output links open on {DASHBOARD}" in home_text.replace("  ", " ") or DASHBOARD in home_text,
                "dashboard URL printed")
        _assert(len(home._charts) == 3, f"department, tool and trend charts: {len(home._charts)}")
        tool_headers, tool_rows = _table(wb[W.TOOL])
        cost = {r[0]: r[tool_headers.index("Cost")] for r in tool_rows}
        tool_names = {_display(k): v for k, v in cost.items()}
        _assert(tool_names["Suno"].startswith("Not captured") and tool_names["Flow"].startswith("Not captured"),
                "Suno and Flow marked")
        _assert(tool_names["Kling"] == "Recorded", "recorded tools say so")
        _assert("Credits per generation" in tool_headers and "Credits per generation" in user_headers,
                "credits per generation on By Tool and By User")
        _assert("% generations with a client" in user_headers, "client-tagging rate on By User")
    finally:
        os.remove(path)
    print("ok  workbook end to end")


BANNED = re.compile(r"\b(FILTER|UNIQUE|SORT|LET|LAMBDA)\s*\(", re.IGNORECASE)


def _assert_no_banned_functions(wb):
    n = 0
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.data_type == "f" and isinstance(cell.value, str):
                    n += 1
                    _assert(not BANNED.search(cell.value), f"{ws.title}!{cell.coordinate} uses a 365-only function")
    for dv_ws in wb.worksheets:
        for dv in dv_ws.data_validations.dataValidation:
            _assert(not BANNED.search(str(dv.formula1 or "")), "validation formula")
    _assert(n > 100, "formulas were scanned")


def _assert_month_consistency(wb, model):
    """Month Drill-down total = Monthly Trend row = SUM of the month's Charged log rows."""
    headers, rows = _table(wb[W.TREND], "tblTrendSummary")
    trend = {r[0].strftime("%Y-%m"): r[headers.index("Credits")] for r in rows}
    trend_gens = {r[0].strftime("%Y-%m"): r[headers.index("Generations")] for r in rows}
    drill = {}
    for row in wb["Month Drill-down"].iter_rows(values_only=True):
        if row and isinstance(row[0], str) and len(row) > 4 and row[1] == "Credits":
            try:
                month = datetime.strptime(row[0], "%b %Y").strftime("%Y-%m")
            except ValueError:
                continue                     # a table header such as "Department | Credits | ..."
            drill[month] = (row[2], row[4])
    lh, lrows = _table(wb[W.LOG])
    log = {}
    for r in lrows:
        if r[lh.index("Charged")] is True:
            key = r[lh.index("Month")].strftime("%Y-%m")
            c, g = log.get(key, (0.0, 0))
            log[key] = (c + float(r[lh.index("Credits")] or 0), g + 1)
    _assert(set(trend) == set(drill) == set(model.months), f"months {set(trend)} {set(drill)}")
    for m in model.months:
        _close(trend[m], drill[m][0], f"{m}: Monthly Trend vs Drill-down")
        _close(trend[m], log.get(m, (0, 0))[0], f"{m}: Monthly Trend vs log")
        _assert(trend_gens[m] == drill[m][1] == log.get(m, (0, 0))[1], f"{m}: generations agree")
    print("ok  month totals agree: trend = drill-down = log, for", ", ".join(model.months))


SOFFICE_CANDIDATES = (r"C:\Program Files\LibreOffice\program\soffice.com", r"C:\Program Files\LibreOffice\program\soffice.exe",
                      "/usr/bin/soffice", "/usr/bin/libreoffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice")


def _soffice():
    import shutil
    for path in SOFFICE_CANDIDATES:
        if os.path.exists(path):
            return path
    return shutil.which("soffice") or shutil.which("libreoffice")


def _recalc(src: str) -> "Workbook":
    """Open in LibreOffice headless, recalculate, save as xlsx, read the values."""
    import subprocess
    out = tempfile.mkdtemp()
    profile = tempfile.mkdtemp()
    subprocess.run([_soffice(), f"-env:UserInstallation=file:///{profile.replace(os.sep, '/')}", "--headless",
                    "--norestore", "--convert-to", "xlsx", "--outdir", out, src],
                   check=True, timeout=300, capture_output=True)
    return load_workbook(os.path.join(out, os.path.basename(src)), data_only=True)


def _with_inputs(path: str, **cells) -> str:
    wb = load_workbook(path)
    ws = wb[W.PERIOD]
    for ref, value in cells.items():
        ws[ref] = value
    fd, out = tempfile.mkstemp(suffix=".xlsx")
    os.close(fd)
    wb.save(out)
    return out


def test_period_explorer_recalc(path, wb):
    """Recalculate with LibreOffice: defaults = Home total; one month = that
    month's Monthly Trend total; Department X = By Department row X."""
    if not _soffice():
        print("SKIP period explorer recalculation: LibreOffice not installed")
        return
    home_total = wb[W.HOME]["A11"].value
    vals = _recalc(path)
    pe = vals[W.PERIOD]
    _close(pe["B20"].value, home_total, "Period Explorer default total = Home total")
    _assert(pe["B21"].value == wb[W.HOME]["C11"].value, "default generations = Home generations")
    _assert(isinstance(pe["B27"].value, str) and pe["B27"].value not in ("", "—"), f"top user: {pe['B27'].value}")

    headers, rows = _table(wb[W.TREND], "tblTrendSummary")
    sept = next(r for r in rows if r[0] == datetime(2026, 9, 1))
    one_month = _recalc(_with_inputs(path, B5=datetime(2026, 9, 1), B6=datetime(2026, 9, 30)))
    _close(one_month[W.PERIOD]["B20"].value, sept[headers.index("Credits")], "From/To = Sep -> Sep's Monthly Trend total")

    dh, drows = _table(wb[W.DEPT])
    design = next(r for r in drows if _display(r[0]) == "Design")
    dept = _recalc(_with_inputs(path, B7="Design"))
    _close(dept[W.PERIOD]["B20"].value, design[dh.index("Credits")], "Department = Design -> By Department row")

    pending = _recalc(_with_inputs(path, B11="Yes"))
    _assert(pending[W.PERIOD]["B20"].value > home_total, "Include Pending adds pending credits")

    # Force a tie: zero every log credit, then give two people's charged rows 5 each.
    tie_wb = load_workbook(path)
    log = tie_wb[W.LOG]
    heads = [c.value for c in log[W.HEADER_ROW]]
    ci, si, ui = heads.index("Credits") + 1, heads.index("Charged") + 1, heads.index("User") + 1
    chosen = {}
    for r in range(W.FIRST_DATA_ROW, log.max_row + 1):
        if log.cell(r, ci).value is None or not isinstance(log.cell(r, ui).value, str):
            continue
        log.cell(r, ci).value = 0
        user = log.cell(r, ui).value
        if log.cell(r, si).value is True and user not in chosen and user not in ("Unassigned",) and len(chosen) < 2:
            chosen[user] = r
    for r in chosen.values():
        log.cell(r, ci).value = 5
    fd, tie_path = tempfile.mkstemp(suffix=".xlsx")
    os.close(fd)
    tie_wb.save(tie_path)
    top_user = _recalc(tie_path)[W.PERIOD]["B27"].value
    _assert(top_user.startswith("Tie: ") and all(name in top_user for name in chosen), f"tie shown: {top_user!r}")
    print("ok  Period Explorer recalculated in LibreOffice: defaults, one month, department, pending")


def test_trend_filtered_and_empty_workbooks():
    fd, path = tempfile.mkstemp(suffix=".xlsx")
    os.close(fd)
    try:
        model = _build(path, start=SEP1)
        _assert(model.months == ["2026-09", "2026-10"], f"months {model.months}")
        wb = load_workbook(path)
        headers, rows = _table(wb[W.TREND], "tblTrendToolCredits")
        sept = next(r for r in rows if r[0] == datetime(2026, 9, 1))
        _close(sept[headers.index("Kling")], 70, "September Kling credits")
        _validate_links(wb)
        _assert_month_consistency(wb, model)
        _assert_no_banned_functions(wb)
        test_period_explorer_recalc(path, wb)

        _build(path, department="Design", client="Acme")
        wb = load_workbook(path)
        text = " ".join(str(c.value) for row in wb[W.HOME].iter_rows() for c in row if c.value)
        _assert("Department: Design" in text and "Client: Acme" in text, "applied filters printed")
        _close(wb[W.HOME]["A11"].value, 150, "Design + Acme charged total")
        _validate_links(wb)

        _build(path, exclude_test_accounts=False)
        wb = load_workbook(path)
        _close(wb[W.HOME]["A11"].value, CHARGED_TOTAL + ADMIN_CREDITS, "exclusion off")
        text = " ".join(str(c.value) for row in wb[W.HOME].iter_rows() for c in row if c.value)
        _assert("Included (the export option was turned off)" in text, "exclusion off printed")

        model = _build(path, start="2020-01-01", end="2020-01-31")
        _assert(model.is_empty, "no data in range")
        wb = load_workbook(path)
        text = " ".join(str(c.value) for row in wb[W.HOME].iter_rows() for c in row if c.value)
        _assert("No credit activity was found" in text, "friendly empty message on Home")
        pe = " ".join(str(c.value) for row in wb[W.PERIOD].iter_rows() for c in row if c.value)
        _assert("nothing to explore" in pe, "Period Explorer explains there is no data")
        for name in W.SHEET_ORDER[1:]:
            if name in (W.QUALITY, W.PERIOD):
                continue
            _assert(wb[name]["A5"].value == W.EMPTY_MESSAGE or wb[name]["A4"].value == W.EMPTY_MESSAGE,
                    f"{name} empty message")
        _validate_links(wb)
    finally:
        os.remove(path)
    print("ok  trend, filtered and empty workbooks")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
def test_api():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import routers.credit_report_router as R
    from database_config import get_operational_db
    from utils.permissions import get_current_user

    os.environ["PUBLIC_DASHBOARD_URL"] = DASHBOARD
    R.OperationalSessionLocal = SessionLocal
    app = FastAPI()
    app.include_router(R.router)
    who = {"id": IDS["Plain"]}

    def _db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def _user():
        with SessionLocal() as db:
            u = db.query(User).filter(User.id == who["id"]).one()
            u.feature_grants, u.role_assignments  # load before the session closes
            db.expunge(u)
            return u

    app.dependency_overrides[get_operational_db] = _db
    app.dependency_overrides[get_current_user] = _user
    client = TestClient(app)

    _assert(client.get("/api/reports/credit/export.xlsx").status_code == 403, "ungranted user is refused")
    # Output links only need a signed-in account.
    r = client.get(f"/api/reports/credit/output/Kling/{IDS['kling_event']}")
    _assert(r.status_code == 200 and r.json()["url"] == "https://cdn.kling.example/k1.mp4", "output lookup")
    _assert(client.get("/api/reports/credit/output/Kling/999999").status_code == 404, "missing output 404")
    with SessionLocal() as db:
        suno_id = db.query(SunoGeneration.id).filter(SunoGeneration.provider_creation_id == "s1").scalar()
    r = client.get(f"/api/reports/credit/output/Suno/{suno_id}")
    _assert(r.status_code == 200 and r.json()["url"].startswith("https://"), "Suno falls back without R2")

    with SessionLocal() as db:
        db.add(UserFeatureAccess(user_id=IDS["Plain"], feature="credit_report"))
        db.commit()
    r = client.get("/api/reports/credit/export.xlsx", params={"start": OCT1, "end": OCT7})
    _assert(r.status_code == 200, f"granted user downloads: {r.status_code} {r.text[:200]}")
    _assert('filename="credit-report_2026-10-01_to_2026-10-07.xlsx"' in r.headers["content-disposition"],
            r.headers["content-disposition"])
    _assert(b"localhost" not in r.content, "no localhost anywhere in the file")
    r = client.get("/api/reports/credit/export.xlsx", params={"excludeTestAccounts": "false"})
    _assert(r.status_code == 200, "exclusion can be turned off")
    for params in ({"start": "07-10-2026"}, {"start": OCT7, "end": OCT1}, {"tool": "Nope"}):
        _assert(client.get("/api/reports/credit/export.xlsx", params=params).status_code == 400, f"rejects {params}")
    opts = client.get("/api/reports/credit/options").json()
    _assert(opts["dashboardUrl"] == DASHBOARD, "options report the link base")
    _assert(opts["users"][0]["id"] == UNASSIGNED_USER_ID, "Unassigned is a user option")
    _assert({a["name"] for a in opts["excludedAccounts"]} == {"Admin", "RoleAdmin"}, "excluded accounts listed")
    who["id"] = IDS["Admin"]
    _assert(client.get("/api/reports/credit/options").status_code == 200, "admins bypass the grant")
    print("ok  api")


def main() -> int:
    seed()
    test_status_mapping()
    test_group_queries()
    test_filters_and_exclusion()
    test_model()
    test_duplicate_detection()
    test_log_columns_dropped_when_empty()
    test_workbook_end_to_end()
    test_trend_filtered_and_empty_workbooks()
    test_api()
    print("ALL CREDIT REPORT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
