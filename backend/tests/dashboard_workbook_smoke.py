"""Interactive dashboard workbook: the Excel formulas give the page's numbers.

Run from backend/:
    python tests/dashboard_workbook_smoke.py
builds one workbook per filter scenario from synthetic rows, with the figures
the Usage & Spend page would show (computed here in Python by the page's
rules), and checks the workbook's structure. If the `formulas` package (an
Excel formula engine) is installed it then recalculates every workbook and
compares; otherwise it prints how to run that step with any Python that has
it (needs only openpyxl + formulas):
    python tests/dashboard_workbook_smoke.py --evaluate <folder it printed>
"""

import json
import os
import sys
import tempfile
from pathlib import Path

TOL = 0.011


# --------------------------------------------------------------------------- #
# Evaluate step: only openpyxl + formulas, no project imports
# --------------------------------------------------------------------------- #
def evaluate(folder: str) -> None:
    import formulas
    from openpyxl import load_workbook

    def check(condition, message):
        if not condition:
            raise AssertionError(message)
        print("ok -", message)

    cases = json.loads((Path(folder) / "expected.json").read_text(encoding="utf-8"))
    for case in cases:
        path = str(Path(folder) / case["file"])
        names = {}
        for name, dn in load_workbook(path).defined_names.items():
            names[name] = dn.attr_text
        model = formulas.ExcelModel().loads(path).finish()
        solution = model.calculate()
        book = os.path.basename(path)          # the engine keeps the file name's case, upper-cases sheets

        def value(ref: str):
            sheet, cell = ref.replace("$", "").split("!")
            key = f"'[{book}]{sheet.strip(chr(39)).upper()}'!{cell.upper()}"
            v = solution[key].value
            v = v[0][0] if hasattr(v, "__getitem__") and not isinstance(v, str) else v
            return v.item() if hasattr(v, "item") else v

        def named(name: str, offset: int = 0):
            ref = names[name]
            sheet, cells = ref.split("!")
            first = cells.replace("$", "").split(":")[0]
            col = first.rstrip("0123456789")
            row = int(first[len(col):]) + offset
            return value(f"{sheet}!{col}{row}")

        print(f"\n[{case['name']}]")
        for key, expected in case["scalars"].items():
            got = named(key)
            if isinstance(expected, str):
                check(str(got) == expected, f"{key} = {expected!r} (got {got!r})")
            else:
                check(abs(float(got or 0) - expected) <= TOL, f"{key} = {expected} (got {got})")
        for block, rows in case["ranked"].items():
            for k, expected_name in enumerate(rows):
                # row k+1 of the tab: the entity whose rank is k+1
                ranks = [named(f"{block}_rank", i) for i in range(case["sizes"][block])]
                idx = ranks.index(k + 1) if (k + 1) in ranks else None
                got = named(f"{block}_name", idx) if idx is not None else None
                check(got == expected_name, f"{block} #{k + 1} = {expected_name!r} (got {got!r})")
        for i, expected_name in enumerate(case["donut"]):
            got = named("dn_name", i)
            check((got or "") == expected_name, f"donut slice {i + 1} = {expected_name!r} (got {got!r})")
        for i, expected_name in enumerate(case["dept_chart"]):
            got = named("dc_name", i)
            check((got or "") == expected_name, f"department bar {i + 1} = {expected_name!r} (got {got!r})")
        for i, (pos, expected_person, expected_tool) in enumerate(case["activity"]):
            got_pos = named("dSeq", 0)  # sentinel
            check(got_pos == 0, "activity sentinel Seq is 0") if i == 0 else None
            seq = [named("dSeq", j) for j in range(case["sizes"]["data"] + 1)]
            k = i + 1
            # the workbook's lookup: MATCH(k-1, Seq, 1) + 1 on an ascending Seq
            p = max(j for j, s in enumerate(seq) if s <= k - 1) + 1
            check(named("dPerson", p) == expected_person and named("dTool", p) == expected_tool,
                  f"activity row {k} = {expected_person} / {expected_tool}")
        for (person, days) in case["active_days"]:
            names_col = [named("p_name", i) for i in range(case["sizes"]["p"])]
            got = named("p_days", names_col.index(person))
            check(abs(float(got) - days) < TOL, f"{person} active days = {days} (got {got})")
        if case is cases[0]:
            check_links(path, value, named, names, check)
    print("\nALL DASHBOARD WORKBOOK FORMULA CHECKS PASSED")


# Activity column showing each Data link field (the field a link to Activity matches on)
ACTIVITY_FIELD_COL = {"dLnkPerson": "E", "dLnkTool": "F", "dLnkClient": "K", "dLnkDate": "C"}
TAB_HEAD = 5


def check_links(path, value, named, names, check) -> None:
    """Replays each interlink's lookup on the recalculated values and checks
    it lands on a row of the target tab showing the entity: for a ranked tab,
    the entity's Calc index found in the tab's key column A; for Activity, the
    Seq of the entity's first filtered Data row. A circular reference would
    leave these cells uncomputed, so reading them also proves there is none."""
    import re
    from openpyxl import load_workbook

    wb = load_workbook(path)
    ranked_re = re.compile(r"MATCH\(MATCH\(INDEX\(([A-Za-z_]+),(\$A\d+|\d+)\),([a-z_]+),0\),'([A-Za-z]+)'!\$A\$(\d+):\$A\$(\d+),0\)")
    activity_re = re.compile(r"MATCH\(INDEX\(([a-zA-Z_]+),(\$A\d+|\d+)\),(dLnk[A-Za-z]+),0\)")
    places = [(s, range(6, 9)) for s in ("Activity", "People", "Tools", "Clients", "Daily", "Departments")]
    places.append(("Dashboard", range(35, 37)))
    seen, data_rows = set(), [None]

    def lookup_value(sheet, ref, pos):
        """The cell's lookup: INDEX(ref, $A<row>) on a tab, INDEX(ref, n) on the Dashboard."""
        k = value(f"'{sheet}'!{pos[1:]}") if pos.startswith("$A") else int(pos)
        return named(ref, int(k) - 1)

    for sheet, rows in places:
        for r in rows:
            for cell in wb[sheet][r]:
                formula = cell.value if isinstance(cell.value, str) else ""
                ranked, activity = ranked_re.search(formula), activity_re.search(formula)
                if not (ranked or activity):
                    continue
                shown = value(f"'{sheet}'!{cell.coordinate}")      # KeyError here = never computed
                if shown in ("", None):
                    continue
                shown = shown.replace("■  ", "") if isinstance(shown, str) else shown
                if ranked:
                    ref, pos, calc_names, tsheet, first, last = ranked.groups()
                    want = lookup_value(sheet, ref, pos)
                    calc_list = [named(calc_names, i) for i in range(int(last) - int(first) + 1)]
                    index = calc_list.index(want) + 1
                    keys = [value(f"'{tsheet}'!A{tr}") for tr in range(int(first), int(last) + 1)]
                    landing = int(first) + keys.index(index)
                    landed = value(f"'{tsheet}'!C{landing}")
                    landed = landed.replace("■  ", "") if isinstance(landed, str) else landed
                    check(landed == want, f"{sheet}!{cell.coordinate} {shown!r} opens {tsheet}!C{landing} ({landed!r})")
                else:
                    ref, pos, helper = activity.groups()
                    tsheet = "Activity"
                    want = lookup_value(sheet, ref, pos)
                    if data_rows[0] is None:
                        n = len(wb["Data"]["A"]) - 1
                        data_rows[0] = n
                    helpers = [named(helper, i) for i in range(data_rows[0])]
                    seq = named("dSeq", helpers.index(want))
                    landing = TAB_HEAD + int(seq)
                    landed = value(f"'Activity'!{ACTIVITY_FIELD_COL[helper]}{landing}")
                    check(landed == want, f"{sheet}!{cell.coordinate} {shown!r} opens Activity row {landing} ({landed!r})")
                seen.add((sheet, tsheet))
    expected = {("Activity", "People"), ("Activity", "Tools"), ("Activity", "Clients"), ("Activity", "Departments"),
                ("Activity", "Daily"), ("People", "Activity"), ("People", "Departments"), ("People", "Clients"),
                ("Tools", "Activity"), ("Tools", "People"), ("Clients", "Activity"), ("Clients", "People"),
                ("Clients", "Tools"), ("Daily", "Activity"), ("Daily", "Tools"), ("Departments", "People"),
                ("Departments", "Tools"), ("Dashboard", "Tools"), ("Dashboard", "Departments")}
    check(expected <= seen, f"every interlink route present ({len(seen)} checked; missing {sorted(expected - seen)})")


if len(sys.argv) == 3 and sys.argv[1] == "--evaluate":
    evaluate(sys.argv[2])
    sys.exit(0)


# --------------------------------------------------------------------------- #
# Generate step (project venv)
# --------------------------------------------------------------------------- #
from datetime import date, datetime, timedelta  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from openpyxl import load_workbook  # noqa: E402
from utils.credit_report import dashboard_workbook as W  # noqa: E402
from utils.credit_report.costing import PAY_PER_USE, SUBSCRIPTION  # noqa: E402
from utils.credit_report.facts import CHARGED, FAILED, PENDING, UNASSIGNED  # noqa: E402


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok -", message)


START = date(2026, 10, 1)
DAYS = 10
PEOPLE = {"Asha": "Creative", "Bilal": "Creative", "Chen": "Gen AI", "Dev": "Gen AI", "Esha": "Digital",
          UNASSIGNED: "No department"}
TOOLS = {"Kling": PAY_PER_USE, "Freepik": SUBSCRIPTION, "Suno": SUBSCRIPTION, "ChatGPT": SUBSCRIPTION}
CLIENTS = ["Acme", "Globex", "No client"]
ACCOUNTS = {"Kling": "kling@x.com", "Freepik": "fp@x.com", "Suno": "suno@x.com", "ChatGPT": "gpt@x.com"}


def make_rows(period: str, start: date, n: int, seed: int) -> list:
    rows = []
    people, tools = list(PEOPLE), list(TOOLS)
    for i in range(n):
        k = i * 7 + seed
        tool = tools[k % len(tools)]
        status = CHARGED if k % 11 else (PENDING if k % 2 else FAILED)
        when = datetime.combine(start + timedelta(days=(k * 3) % DAYS), datetime.min.time()) + timedelta(
            hours=8 + k % 12, minutes=k % 60)
        rows.append(W.Row(
            period=period, when=when, tool=tool, account=ACCOUNTS[tool], account_id=k % 4, user_id=k % 6,
            person=people[k % len(people)], dept=PEOPLE[people[k % len(people)]], client=CLIENTS[k % 3],
            task="", out_type="AI Video" if tool == "Kling" else "AI Image", what="Video", prompt=f"prompt {i} cat",
            credits=float(k % 9 + 1), cost=round(((k % 13) + 1) * 3.5, 2) if status == CHARGED else 0.0,
            status=status, basis=TOOLS[tool], link=f"https://dash.example/open-output?ref={tool}:{i}" if i % 3 else "",
        ))
    rows.sort(key=lambda r: r.when, reverse=True)
    return rows


def build_data() -> W.DashboardData:
    rows = make_rows(W.CUR, START, 90, 1)
    prev = make_rows(W.PREV, START - timedelta(days=DAYS), 50, 4)
    return W.DashboardData(
        start=START, end=START + timedelta(days=DAYS - 1),
        prev_start=START - timedelta(days=DAYS), prev_end=START - timedelta(days=1),
        generated_at=datetime(2026, 10, 11, 9, 30), rows=rows, prev_rows=prev,
        plan_fee={"Freepik": 900.0, "Suno": 500.0, "ChatGPT": 300.0}, unused={"Freepik": 120.0, "Suno": 75.5},
        untracked={"Semrush": 400.0}, prev_unused=50.0, prev_untracked=400.0,
        people={p: d for p, d in PEOPLE.items()}, person_by_id={}, account_by_id={},
    )


def expected(data: W.DashboardData, f: dict) -> dict:
    """The page's figures for filter selection f, by its rules."""
    def match(r):
        return all((f.get("tool") in (None, r.tool), f.get("account") in (None, r.account),
                    f.get("department") in (None, r.dept), f.get("person") in (None, r.person),
                    f.get("client") in (None, r.client)))
    search = (f.get("search") or "").lower()

    cur = [r for r in data.rows if r.status == CHARGED and match(r)]
    prev = [r for r in data.prev_rows if r.status == CHARGED and match(r)]
    flt = any(f.get(k) for k in ("tool", "account", "department", "person", "client"))
    item = sum(r.cost for r in cur)
    ppu = sum(r.cost for r in cur if r.basis == PAY_PER_USE)
    plans = item - ppu + (0 if flt else sum(data.unused.values()))
    total = ppu + plans + (0 if flt else sum(data.untracked.values()))
    prev_total = sum(r.cost for r in prev) + (0 if flt else data.prev_unused + data.prev_untracked)
    change = (total - prev_total) / prev_total * 100 if prev_total else None
    change_text = ("—" if not prev_total and not total else "new" if not prev_total
                   else f"{'▲' if change > 0 else '▼'} {abs(round(change))}%")

    def by(key, measure):
        out = {}
        for r in cur:
            out[key(r)] = out.get(key(r), 0) + measure(r)
        return out

    spend_tool = by(lambda r: r.tool, lambda r: r.cost)
    if not flt:
        for t, v in list(data.unused.items()) + list(data.untracked.items()):
            spend_tool[t] = spend_tool.get(t, 0) + v
    outs_tool = by(lambda r: r.tool, lambda r: 1)
    tool_keys = sorted({t for t in spend_tool if outs_tool.get(t, 0) > 0 or spend_tool[t] > 0},
                       key=lambda t: (-round(spend_tool[t], 2), W._layout(data).tools.index(t)))
    measure = {"By outputs": outs_tool, "By spend": spend_tool,
               "By credits": by(lambda r: r.tool, lambda r: r.credits)}[f.get("tool_measure", "By outputs")]
    order = W._layout(data).tools
    donut_rank = sorted([t for t in measure if measure[t] > 0], key=lambda t: (-round(measure[t], 4), order.index(t)))
    donut = donut_rank[:5] + (["Others"] if len(donut_rank) > 5 else [])
    donut += [""] * (6 - len(donut))

    lay = W._layout(data)
    person_order = [p for p, _d in lay.people]
    p_spend = by(lambda r: r.person, lambda r: r.cost)
    p_out = by(lambda r: r.person, lambda r: 1)
    p_tools = {p: [t for t in lay.tools if any(r.person == p and r.tool == t for r in cur)] for p in p_out}

    def hit(p):
        if not search:
            return True
        tools_text = ", ".join(f"{t} ({sum(1 for r in cur if r.person == p and r.tool == t)})" for t in p_tools[p])
        return search in f"{p} {PEOPLE[p]} {tools_text}".lower()

    people_rank = sorted([p for p in p_out if hit(p)], key=lambda p: (-round(p_spend[p], 2), person_order.index(p)))
    named = {p for p in p_out if p != UNASSIGNED}

    c_spend = by(lambda r: r.client, lambda r: r.cost)
    clients_rank = sorted(c_spend, key=lambda c: (-round(c_spend[c], 2), lay.clients.index(c)))
    d_spend = by(lambda r: r.dept, lambda r: r.cost)
    depts_rank = sorted(d_spend, key=lambda d: (-round(d_spend[d], 2), lay.depts.index(d)))
    dept_chart = [d for d in depts_rank if d_spend[d] > 0][:6]

    acts = [r for r in data.rows if match(r) and (not search or search in " ".join(
        (r.person, r.dept, r.tool, r.out_type, r.what, r.prompt, r.client, r.task)).lower())]
    active_days = {p: len({r.day for r in cur if r.person == p}) for p in p_out}
    return {
        "scalars": {
            "kTotal": round(total, 2), "kItem": round(item, 2), "kPPU": round(ppu, 2), "kPlans": round(plans, 2),
            "kPrevTotal": round(prev_total, 2), "kOutputs": len(cur), "kCredits": round(sum(r.credits for r in cur), 2),
            "kPeople": len(named), "kTools": len({r.tool for r in cur}), "kFlt": 1 if flt else 0,
            "kActCount": len(acts), "kChange": change_text,
        },
        "ranked": {"t": tool_keys[:3], "p": people_rank[:3], "c": clients_rank[:3], "d": depts_rank[:3]},
        "donut": donut,
        "dept_chart": dept_chart + [""] * (6 - len(dept_chart)),
        "activity": [(i, r.person, r.tool) for i, r in enumerate(acts[:3])],
        "active_days": sorted(active_days.items())[:3],
    }


def named_cell(wb, name: str) -> str:
    """The cell a workbook name points at, e.g. 'B12'."""
    return wb.defined_names[name].attr_text.split("!")[1].replace("$", "")


SCENARIOS = [
    ("no filters", {}),
    ("tool Freepik", {"tool": "Freepik"}),
    ("department Creative", {"department": "Creative"}),
    ("person Chen + client Acme", {"person": "Chen", "client": "Acme"}),
    ("account kling@x.com", {"account": "kling@x.com"}),
    ("search 'cat 1'", {"search": "prompt 1"}),
    ("spend measure", {"tool_measure": "By spend"}),
]


def main() -> None:
    data = build_data()
    folder = tempfile.mkdtemp(prefix="dashboard-workbook-")
    cases = []
    for i, (name, f) in enumerate(SCENARIOS):
        initial = {k: v for k, v in f.items() if k != "tool_measure"}
        path = os.path.join(folder, f"case{i}.xlsx")
        W.write_dashboard_workbook(data, path, initial=initial)
        if f.get("tool_measure"):          # the toggle cell, as a viewer would change it
            wb = load_workbook(path)
            wb["Dashboard"][named_cell(wb, "mTool")] = f["tool_measure"]
            wb.save(path)
        exp = expected(data, f)
        lay = W._layout(data)
        cases.append({"name": name, "file": os.path.basename(path), **exp,
                      "sizes": {"t": len(lay.tools), "p": len(lay.people), "c": len(lay.clients),
                                "d": len(lay.depts), "data": len(data.rows)}})

    # structure
    wb = load_workbook(os.path.join(folder, "case0.xlsx"))
    check(wb.sheetnames[:9] == ["Dashboard", "Activity", "People", "Tools", "Clients", "Daily", "Monthly",
                                "Departments", "Compare"], "visible sheets in the page's tab order")
    check(all(wb[s].sheet_state == "hidden" for s in ("Data", "Agg", "Calc", "Lists")), "helper sheets hidden")
    for name in ("fTool", "fAcct", "fDept", "fPerson", "fClient", "fSearch", "mTool", "mDept", "kTotal", "aCost"):
        check(name in wb.defined_names, f"name {name} defined")
    check(len(wb["Dashboard"]._charts) == 3, "three charts on the Dashboard")
    check(len(wb["Dashboard"].data_validations.dataValidation) >= 7, "filter and measure dropdowns present")
    check(wb.calculation.fullCalcOnLoad, "recalculates on open")
    wb1 = load_workbook(os.path.join(folder, "case1.xlsx"))
    check(wb1["Dashboard"][named_cell(wb1, "fTool")].value == "Freepik",
          "the page's filters become the starting filter values")
    for sheet in ("Activity", "People", "Tools", "Clients", "Daily", "Monthly", "Departments"):
        ref = wb[sheet].auto_filter.ref or ""
        check(ref.startswith("A5:"), f"{sheet}: header filter from the hidden key column ({ref})")

    (Path(folder) / "expected.json").write_text(json.dumps(cases, indent=1, default=str), encoding="utf-8")
    try:
        import formulas  # noqa: F401
    except ImportError:
        print(f"\nStructure checks passed. Formula step skipped (no `formulas` package). Run:\n"
              f"  <python with openpyxl+formulas> tests/dashboard_workbook_smoke.py --evaluate \"{folder}\"")
        return
    evaluate(folder)


if __name__ == "__main__":
    main()
