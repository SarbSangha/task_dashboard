"""
Live In-App Excel & Zomato-Style Quick Report Engine for RMW Eye.

Builds a unified JSON payload directly from the Credit Report facts +
management rupee model (every tracked tool, ChatGPT and Claude included) so the frontend
can render an interactive, multi-sheet Excel workbook right inside RMW Eye
in 1-2 clicks — with filters for Days, Months, Averages, and ₹ Spending.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import (
    GenerationClient,
    GenerationRecord,
    ITPortalTool,
    ITPortalToolCredential,
    ITPortalToolUsageEvent,
    ToolCreditRate,
    User,
)
from providers.chatgpt.models import ConversationRecord
from providers.elevenlabs.models import ElevenlabsGeneration
from providers.envato.models import EnvatoGeneration
from providers.epidemicsound.models import EpidemicAdaptation
from providers.flow.models import FlowGeneration
from providers.freepik.models import FreepikGeneration
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from providers.suno.models import SunoGeneration

from .facts import (
    CHARGED,
    FAILED,
    IST_MINUTES,
    KLING,
    NO_CLIENT,
    PENDING,
    UNASSIGNED,
    UNASSIGNED_DEPARTMENT,
    UNASSIGNED_USER_ID,
    ReportFilters,
    cost_note,
    load_day_groups,
    load_excluded_summary,
    load_groups,
    load_model_counts,
    load_options,
    prepare,
    recent_log,
    stream_log,
)
from .management import build_management, change_text, period_label
from .model import build_model

IST_DELTA = timedelta(minutes=IST_MINUTES)

TOOL_OUTPUT_CATEGORY = {
    "Kling": "AI Video",
    "Freepik": "AI Image & Video",
    "HeyGen": "Avatar Video",
    "Higgsfield": "Motion Video",
    "ElevenLabs": "Voice / Audio",
    "Suno": "AI Music",
    "Flow": "Cinematic Video",
    "Envato": "Creative Asset",
    "Epidemic Sound": "Soundtrack",
    "ChatGPT": "Chat / Copy",
    "Claude": "Chat / Copy",
    "Grammarly": "Writing",
    "Splice": "Music Samples",
}


def classify_generation(tool: str, model_label: Optional[str], prompt: Optional[str]) -> tuple[str, str]:
    """Return (output_type, what_generated_summary) for a single generation."""
    m = (model_label or "").strip()
    m_low = m.lower()
    p_short = (prompt or "").strip()
    if len(p_short) > 48:
        p_short = p_short[:45].rstrip() + "…"

    if tool == "Kling":
        out_type = "AI Image" if "image" in m_low else "AI Video"
        label = f"{out_type} ({m})" if m else f"{out_type} · Kling Studio"
    elif tool == "Freepik":
        if "video" in m_low or "kling" in m_low or "minimax" in m_low:
            out_type = "AI Video"
        elif "upscale" in m_low or "retouch" in m_low:
            out_type = "Image Upscale"
        else:
            out_type = "AI Image"
        label = f"{out_type} ({m})" if m else f"{out_type} · Freepik AI"
    elif tool == "HeyGen":
        out_type = "Avatar Video"
        label = f"Avatar Video ({m})" if m else "Avatar Video · HeyGen"
    elif tool == "Higgsfield":
        out_type = "Motion Video"
        label = f"Motion Video ({m})" if m else "Motion Reel · Higgsfield"
    elif tool == "ElevenLabs":
        out_type = "Voice / Audio"
        label = f"Voiceover ({m})" if m else "Voiceover / TTS"
    elif tool == "Suno":
        out_type = "AI Music"
        label = f"Music Track ({m})" if m else "AI Song · Suno"
    elif tool == "Flow":
        out_type = "Cinematic Video"
        label = f"Flow Scene ({m})" if m else "Cinematic Scene · Flow"
    elif tool == "Envato":
        out_type = "Creative Asset"
        label = f"Asset ({m})" if m else "Design Asset · Envato"
    elif tool == "Epidemic Sound":
        out_type = "Soundtrack"
        label = f"Soundtrack ({m})" if m else "Music Adaptation · Epidemic"
    elif tool in ("ChatGPT", "Claude"):
        out_type = "Chat / Copy"
        label = f"AI Chat ({m})" if m else f"Prompt · {tool}"
    elif tool == "Grammarly":
        out_type = "Writing"
        label = f"Document · {p_short}" if p_short else "Document · Grammarly"
    elif tool == "Splice":
        out_type = "Music Samples"
        label = f"Sample · {p_short}" if p_short else "Sample download · Splice"
    else:
        out_type = TOOL_OUTPUT_CATEGORY.get(tool, "AI Output")
        label = f"{out_type} ({m})" if m else out_type

    return out_type, label


def _month_label(ym: str) -> str:
    try:
        dt = datetime.strptime(ym, "%Y-%m")
        return dt.strftime("%b %Y")
    except Exception:
        return ym


def build_live_sheet(
    db: Session,
    *,
    start: Optional[str] = None,
    end: Optional[str] = None,
    department: Optional[str] = None,
    user_id: Optional[int] = None,
    tool: Optional[str] = None,
    client: Optional[str] = None,
    accounts=None,
    output_type: Optional[str] = None,
    search: Optional[str] = None,
    exclude_test_accounts: bool = False,
    log_limit: int = 800,
) -> dict:
    """Return the complete live multi-sheet Excel payload + KPIs + averages."""
    clean_tool = (tool or "").strip() or None
    if clean_tool and clean_tool.lower() == "all":
        clean_tool = None
    clean_dept = (department or "").strip() or None
    if clean_dept and clean_dept.lower() == "all":
        clean_dept = None
    clean_client = (client or "").strip() or None
    if clean_client and clean_client.lower() == "all":
        clean_client = None
    clean_out_type = (output_type or "").strip() or None
    if clean_out_type and clean_out_type.lower() == "all":
        clean_out_type = None
    search_q = (search or "").strip().lower()

    # A tool the report does not track (e.g. a "Paid, not tracked" one) has
    # no rows: facts_subquery returns an empty result for an unknown name.
    facts_tool = clean_tool
    filters = ReportFilters.build(
        start=start,
        end=end,
        department=clean_dept,
        user_id=user_id,
        tool=facts_tool,
        client=clean_client,
        accounts=accounts,
        exclude_test_accounts=exclude_test_accounts,
    )
    prepare(db, filters)

    groups = load_groups(db, filters)
    excluded_info = load_excluded_summary(db, filters)
    model = build_model(groups, excluded_info)
    day_groups = load_day_groups(db, filters)
    mgmt = build_management(db, filters, groups, day_groups=day_groups)

    # User metadata lookup
    user_meta: dict[int, dict] = {
        UNASSIGNED_USER_ID: {
            "name": UNASSIGNED,
            "employeeId": "—",
            "department": UNASSIGNED_DEPARTMENT,
        }
    }
    for u in model.users:
        user_meta[u.user_id] = {
            "name": u.label,
            "employeeId": u.employee_id,
            "department": u.department,
        }
    # Ensure all DB users are in user_meta for day/log lookups
    for uid, uname, uemp, udept in db.query(User.id, User.name, User.employee_id, User.department).all():
        if uid not in user_meta:
            user_meta[int(uid)] = {
                "name": filters.display.person_name(uid, uname) or f"User {uid}",
                "employeeId": (uemp or "").strip() or f"U{uid}",
                "department": filters.display.department_name(udept) or UNASSIGNED_DEPARTMENT,
            }

    # Stream individual log rows + track per-user output types
    log_rows = []
    user_output_types: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    user_active_days: dict[int, set[str]] = defaultdict(set)
    day_tools_map: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    day_users_map: dict[str, set[int]] = defaultdict(set)
    day_agg_map: dict[str, dict] = defaultdict(
        lambda: {"generations": 0, "credits": 0.0, "rupees": 0.0, "pending": 0, "failed": 0}
    )

    for dg in day_groups:
        d_key = dg.day or filters.start.isoformat()
        bucket = day_agg_map[d_key]
        if dg.charge_status == CHARGED:
            bucket["generations"] += dg.rows
            bucket["credits"] += dg.credits
            bucket["rupees"] += dg.rupees
            day_tools_map[d_key][dg.tool] += dg.rows
            day_users_map[d_key].add(dg.user_id)
            user_active_days[dg.user_id].add(d_key)
        elif dg.charge_status == PENDING:
            bucket["pending"] += dg.rows
        else:
            bucket["failed"] += dg.rows

    # Pull individual generation log rows. Without a search or output-type
    # filter the log is just the newest `log_limit` rows, read straight from
    # the database; a filter has to look at every row, so it streams them all.
    scan_all = bool(search_q or clean_out_type)
    if model.log_user_order and not scan_all:
        for r in load_model_counts(db, filters):
            out_type, _what = classify_generation(r.tool, r.model, None)
            user_output_types[r.user_id][out_type] += int(r.rows or 0)
        log_source = recent_log(db, filters, log_limit)
    elif model.log_user_order:
        log_source = stream_log(db, filters, model.log_user_order)
    else:
        log_source = ()
    if log_source:
        for raw_row in log_source:
            u_info = user_meta.get(raw_row.user_id, user_meta[UNASSIGNED_USER_ID])
            out_type, what_gen = classify_generation(raw_row.tool, raw_row.model, raw_row.prompt)
            if scan_all and raw_row.charge_status == CHARGED:
                user_output_types[raw_row.user_id][out_type] += 1

            if clean_out_type and out_type.lower() != clean_out_type.lower():
                continue

            occ = raw_row.occurred_at
            if occ is not None:
                ist_dt = occ + IST_DELTA
                date_str = ist_dt.strftime("%Y-%m-%d")
                time_str = ist_dt.strftime("%H:%M")
                month_str = ist_dt.strftime("%Y-%m")
            else:
                date_str = filters.start.isoformat()
                time_str = "—"
                month_str = date_str[:7]

            prompt_text = (raw_row.prompt or "").strip()
            client_name = raw_row.client or NO_CLIENT
            task_name = (raw_row.task or "").strip() or "—"

            if search_q:
                haystack = " ".join([
                    u_info["name"],
                    u_info["department"],
                    raw_row.tool,
                    out_type,
                    what_gen,
                    prompt_text,
                    client_name,
                    task_name,
                ]).lower()
                if search_q not in haystack:
                    continue

            if len(log_rows) < log_limit:
                log_rows.append({
                    "rowNum": len(log_rows) + 1,
                    "tool": raw_row.tool,
                    "recordId": raw_row.record_id,
                    "date": date_str,
                    "time": time_str,
                    "month": month_str,
                    "userId": raw_row.user_id,
                    "userName": u_info["name"],
                    "employeeId": u_info["employeeId"],
                    "department": u_info["department"],
                    "outputType": out_type,
                    "whatGenerated": what_gen,
                    "model": (raw_row.model or "").strip() or "Standard",
                    "prompt": prompt_text or "—",
                    "client": client_name,
                    "task": task_name,
                    "accountId": raw_row.account,
                    "account": filters.display.account_label(raw_row.account, raw_row.tool),
                    "credits": round(float(raw_row.credits or 0.0), 2),
                    "spendRupees": round(float(raw_row.rupees or 0.0), 2),
                    "chargeStatus": raw_row.charge_status,
                    "basis": raw_row.basis,
                    "costNote": cost_note(raw_row),
                    "hasOutput": bool(raw_row.has_output),
                    "outputRef": f"{raw_row.tool}:{raw_row.record_id}" if raw_row.has_output else None,
                })

    # Sort log_rows newest first and re-number
    log_rows.sort(key=lambda r: (r["date"], r["time"]), reverse=True)
    for idx, r in enumerate(log_rows, start=1):
        r["rowNum"] = idx

    period_days = max(int(mgmt.cur.days or 1), 1)
    months_equiv = max(period_days / 30.0, 1.0)
    active_days_count = max(len([d for d, b in day_agg_map.items() if b["generations"] > 0]), 1)

    cur_view = mgmt.cur
    prev_view = mgmt.prev
    total_spend_rs = round(float(cur_view.total_spend or 0.0), 2)
    item_spend_rs = round(float(cur_view.total.rupees or 0.0), 2)
    ppu_spend_rs = round(float(cur_view.pay_per_use or 0.0), 2)
    sub_spend_rs = round(float(cur_view.subscription_total or 0.0), 2)
    unused_sub_rs = round(float(cur_view.not_used or 0.0), 2)
    prev_spend_rs = round(float(prev_view.total_spend or 0.0), 2)

    total_gens = int(model.totals.generations)
    total_credits = round(float(model.totals.credits or 0.0), 2)

    # Build Sheet 2: Users
    users_sheet = []
    user_tools_map: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for g in groups:
        if g.charge_status == CHARGED and g.generations > 0:
            user_tools_map[g.user_id][g.tool] += g.generations

    for u in model.users:
        uid = u.user_id
        u_gens = int(u.totals.generations)
        u_credits = round(float(u.totals.credits or 0.0), 2)
        u_rupees = round(float(u.totals.rupees or 0.0), 2)
        u_days = max(len(user_active_days.get(uid, set())), 1 if u_gens > 0 else 0)
        tools_dict = user_tools_map.get(uid, {})
        tools_list = [f"{t} ({c})" for t, c in sorted(tools_dict.items(), key=lambda kv: -kv[1])]
        out_types_dict = user_output_types.get(uid, {})
        what_summary = ", ".join(
            f"{ot}: {cnt}" for ot, cnt in sorted(out_types_dict.items(), key=lambda kv: (-kv[1], kv[0]))
        ) or "—"
        share_pct = round((u_rupees / item_spend_rs * 100.0), 1) if item_spend_rs > 0 else (
            round((u_gens / total_gens * 100.0), 1) if total_gens > 0 else 0.0
        )

        if search_q:
            hay = f"{u.label} {u.department} {' '.join(tools_list)} {what_summary}".lower()
            if search_q not in hay:
                continue

        users_sheet.append({
            "rank": u.company_rank,
            "userId": uid,
            "userName": u.label,
            "employeeId": u.employee_id,
            "department": u.department,
            "toolsUsed": tools_list,
            "toolsUsedText": ", ".join(tools_list) if tools_list else "—",
            "topTool": u.top_tool.first or "—",
            "whatGeneratedSummary": what_summary,
            "topClient": u.top_client.first or NO_CLIENT,
            "generations": u_gens,
            "activeDays": u_days,
            "avgGenerationsPerDay": round(u_gens / period_days, 2),
            "avgGenerationsPerActiveDay": round(u_gens / max(u_days, 1), 2),
            "avgGenerationsPerMonth": round(u_gens / months_equiv, 1),
            "credits": u_credits,
            "spendRupees": u_rupees,
            "avgSpendPerDay": round(u_rupees / period_days, 2),
            "avgSpendPerMonth": round(u_rupees / months_equiv, 2),
            "avgSpendPerOutput": round(u_rupees / max(u_gens, 1), 2),
            "sharePct": share_pct,
        })

    # Build Sheet 3: Tools
    tools_sheet = []
    sub_by_tool: dict[str, dict[str, float]] = defaultdict(lambda: {"fee": 0.0, "unused": 0.0})
    for s in cur_view.subscriptions:
        sub_by_tool[s.tool]["fee"] += float(s.period_fee or 0.0)
        sub_by_tool[s.tool]["unused"] += float(s.not_used or 0.0)

    for t in model.tools:
        t_gens = int(t.totals.generations)
        t_credits = round(float(t.totals.credits or 0.0), 2)
        t_rupees = round(float(t.totals.rupees or 0.0), 2)
        sub_info = sub_by_tool.get(t.name, {"fee": 0.0, "unused": 0.0})
        total_tool_spend = round(t_rupees + sub_info["unused"], 2)
        share_pct = round((total_tool_spend / total_spend_rs * 100.0), 1) if total_spend_rs > 0 else (
            round((t_gens / total_gens * 100.0), 1) if total_gens > 0 else 0.0
        )
        tools_sheet.append({
            "tool": t.name,
            "outputCategory": TOOL_OUTPUT_CATEGORY.get(t.name, "AI Output"),
            "users": t.users,
            "topUser": t.top_named_user.first or t.top_user.first or "—",
            "topDepartment": t.top_department.first or "—",
            "generations": t_gens,
            "avgGenerationsPerDay": round(t_gens / period_days, 2),
            "avgGenerationsPerMonth": round(t_gens / months_equiv, 1),
            "credits": t_credits,
            "itemSpendRupees": t_rupees,
            "subscriptionFeeRupees": round(sub_info["fee"], 2),
            "unusedFeeRupees": round(sub_info["unused"], 2),
            "totalSpendRupees": total_tool_spend,
            "avgSpendPerDay": round(total_tool_spend / period_days, 2),
            "avgSpendPerOutput": round(t_rupees / max(t_gens, 1), 2),
            "sharePct": share_pct,
            "costNote": t.cost_note or "",
        })

    # Every paid tool appears on the Tools sheet, even with no usage in the
    # period: a tracked tool nobody used ("Paid, not used") and a tool whose
    # usage the dashboard cannot capture ("Paid, not tracked", e.g. Semrush).
    # Their fees are already inside total spend; listing them makes the
    # Tools sheet add up to it. Left out when a department / user / client
    # filter is on, since a fee belongs to no one person or team.
    if not cur_view.filtered:
        listed = {t["tool"] for t in tools_sheet}
        paid_rows: dict[str, dict] = {}
        for s in list(cur_view.subscriptions) + list(cur_view.other_subscriptions):
            if s.tool in listed or s.to_confirm:
                continue
            fee = float(s.period_fee or 0.0)
            if fee <= 0:
                continue
            row = paid_rows.setdefault(s.tool, {"fee": 0.0, "tracked": bool(s.tracked)})
            row["fee"] += fee
        for name, info in sorted(paid_rows.items(), key=lambda kv: -kv[1]["fee"]):
            if clean_tool and name != clean_tool:
                continue
            fee = round(info["fee"], 2)
            tools_sheet.append({
                "tool": name,
                "outputCategory": TOOL_OUTPUT_CATEGORY.get(name, "Subscription"),
                "users": 0,
                "topUser": "—",
                "topDepartment": "—",
                "generations": 0,
                "avgGenerationsPerDay": 0.0,
                "avgGenerationsPerMonth": 0.0,
                "credits": 0.0,
                "itemSpendRupees": 0.0,
                "subscriptionFeeRupees": fee,
                "unusedFeeRupees": fee,
                "totalSpendRupees": fee,
                "avgSpendPerDay": round(fee / period_days, 2),
                "avgSpendPerOutput": 0.0,
                "sharePct": round(fee / total_spend_rs * 100.0, 1) if total_spend_rs > 0 else 0.0,
                "costNote": "Paid, not used in this period" if info["tracked"]
                            else "Paid, not tracked: the dashboard captures no usage for this tool",
                "tracked": info["tracked"],
            })

    # Build Sheet 4A: Daily breakdown
    daily_sheet = []
    for d_key in sorted(day_agg_map.keys(), reverse=True):
        b = day_agg_map[d_key]
        if b["generations"] == 0 and b["pending"] == 0 and b["failed"] == 0:
            continue
        t_map = day_tools_map.get(d_key, {})
        t_sorted = sorted(t_map.items(), key=lambda kv: -kv[1])
        u_cnt = len(day_users_map.get(d_key, set()))
        d_gens = int(b["generations"])
        d_rupees = round(float(b["rupees"]), 2)
        daily_sheet.append({
            "date": d_key,
            "month": d_key[:7],
            "activeUsers": u_cnt,
            "generations": d_gens,
            "toolsUsed": ", ".join(f"{k} ({v})" for k, v in t_sorted) or "—",
            "topTool": t_sorted[0][0] if t_sorted else "—",
            "credits": round(float(b["credits"]), 2),
            "spendRupees": d_rupees,
            "avgSpendPerUser": round(d_rupees / max(u_cnt, 1), 2),
            "avgSpendPerOutput": round(d_rupees / max(d_gens, 1), 2),
            "pending": int(b["pending"]),
            "failed": int(b["failed"]),
        })

    # Build Sheet 4B: Monthly breakdown
    monthly_sheet = []
    for ym in sorted(model.months, reverse=True):
        m_tot = model.month_totals.get(ym)
        if not m_tot:
            continue
        m_gens = int(m_tot.generations)
        m_credits = round(float(m_tot.credits or 0.0), 2)
        m_rupees = round(float(m_tot.rupees or 0.0), 2)
        m_users = len(m_tot.users)
        m_active_days = max(len([d for d in daily_sheet if d["month"] == ym and d["generations"] > 0]), 1)
        m_tools = []
        for t in model.tools:
            tup = model.month_tool.get((ym, t.name))
            if tup and tup[1] > 0:
                m_tools.append((t.name, tup[1], tup[2]))
        m_tools.sort(key=lambda x: -x[1])
        monthly_sheet.append({
            "month": ym,
            "monthLabel": _month_label(ym),
            "activeDays": m_active_days,
            "activeUsers": m_users,
            "generations": m_gens,
            "avgGenerationsPerDay": round(m_gens / m_active_days, 2),
            "toolsUsed": ", ".join(f"{n} ({g})" for n, g, _r in m_tools) or "—",
            "topTool": m_tools[0][0] if m_tools else "—",
            "credits": m_credits,
            "spendRupees": m_rupees,
            "avgSpendPerActiveDay": round(m_rupees / m_active_days, 2),
            "avgSpendPerUser": round(m_rupees / max(m_users, 1), 2),
            "avgSpendPerOutput": round(m_rupees / max(m_gens, 1), 2),
        })

    # Build Sheet 5: Departments & Clients
    departments_sheet = []
    for d in model.departments:
        d_gens = int(d.totals.generations)
        d_rupees = round(float(d.totals.rupees or 0.0), 2)
        d_users = max(int(d.users), 1)
        departments_sheet.append({
            "department": d.name,
            "users": d.users,
            "topUser": d.top_named_user.first or d.top_user.first or "—",
            "topTool": d.top_tool.first or "—",
            "generations": d_gens,
            "avgGenerationsPerDay": round(d_gens / period_days, 2),
            "avgGenerationsPerUser": round(d_gens / d_users, 1),
            "credits": round(float(d.totals.credits or 0.0), 2),
            "spendRupees": d_rupees,
            "avgSpendPerDay": round(d_rupees / period_days, 2),
            "avgSpendPerUser": round(d_rupees / d_users, 2),
            "avgSpendPerOutput": round(d_rupees / max(d_gens, 1), 2),
            "sharePct": round((d_rupees / item_spend_rs * 100.0), 1) if item_spend_rs > 0 else 0.0,
        })

    clients_sheet = []
    for c in model.clients:
        c_gens = int(c.totals.generations)
        c_rupees = round(float(c.totals.rupees or 0.0), 2)
        clients_sheet.append({
            "client": c.name,
            "users": c.users,
            "topUser": c.top_named_user.first or c.top_user.first or "—",
            "topTool": c.top_tool.first or "—",
            "generations": c_gens,
            "avgGenerationsPerDay": round(c_gens / period_days, 2),
            "credits": round(float(c.totals.credits or 0.0), 2),
            "spendRupees": c_rupees,
            "avgSpendPerOutput": round(c_rupees / max(c_gens, 1), 2),
            "sharePct": round((c_rupees / item_spend_rs * 100.0), 1) if item_spend_rs > 0 else 0.0,
        })

    active_users_cnt = len([u for u in users_sheet if u["userId"] != UNASSIGNED_USER_ID and u["generations"] > 0])
    active_tools_cnt = len([t for t in tools_sheet if t["generations"] > 0])

    opts = load_options(db, filters.display)

    return {
        "success": True,
        "period": {
            "start": filters.start.isoformat(),
            "end": filters.end.isoformat(),
            "label": period_label(filters.start, filters.end),
            "days": period_days,
            "activeDays": active_days_count,
            "monthsCount": max(len(monthly_sheet), 1),
            "prevStart": prev_view.start.isoformat(),
            "prevEnd": prev_view.end.isoformat(),
            "prevLabel": prev_view.label,
        },
        "kpis": {
            "totalSpendRupees": total_spend_rs,
            "itemSpendRupees": item_spend_rs,
            "payPerUseRupees": ppu_spend_rs,
            "subscriptionRupees": sub_spend_rs,
            "unusedSubscriptionRupees": unused_sub_rs,
            "prevTotalSpendRupees": prev_spend_rs,
            "spendChangeText": change_text(total_spend_rs, prev_spend_rs),
            "totalGenerations": total_gens,
            "pendingGenerations": int(model.totals.pending_generations),
            "failedGenerations": int(model.totals.failed_generations),
            "totalCredits": total_credits,
            "activeUsers": active_users_cnt,
            "activeTools": active_tools_cnt,
            "activeDays": active_days_count,
            "averages": {
                "spendPerDay": round(total_spend_rs / period_days, 2),
                "spendPerActiveDay": round(total_spend_rs / active_days_count, 2),
                "spendPerMonth": round(total_spend_rs / months_equiv, 2),
                "spendPerUser": round(item_spend_rs / max(active_users_cnt, 1), 2),
                "spendPerOutput": round(item_spend_rs / max(total_gens, 1), 2),
                "generationsPerDay": round(total_gens / period_days, 2),
                "generationsPerActiveDay": round(total_gens / active_days_count, 2),
                "generationsPerMonth": round(total_gens / months_equiv, 1),
                "generationsPerUser": round(total_gens / max(active_users_cnt, 1), 1),
                "creditsPerDay": round(total_credits / period_days, 2),
                "creditsPerOutput": round(total_credits / max(total_gens, 1), 2),
            },
        },
        "options": {
            **opts,
            "outputTypes": [
                "AI Video",
                "AI Image",
                "Avatar Video",
                "Motion Video",
                "Voice / Audio",
                "AI Music",
                "Cinematic Video",
                "Creative Asset",
                "Soundtrack",
                "Chat / Copy",
                "Writing",
                "Music Samples",
            ],
        },
        "insights": {
            "keyPoints": list(mgmt.key_points or []),
            "attention": [a.sentence for a in (mgmt.attention or [])],
        },
        "sheets": {
            "log": log_rows,
            "users": users_sheet,
            "tools": tools_sheet,
            "daily": daily_sheet,
            "monthly": monthly_sheet,
            "departments": departments_sheet,
            "clients": clients_sheet,
        },
    }


def seed_demo_ai_usage(db: Session) -> dict:
    """Seed realistic multi-user, multi-tool, multi-month AI generation data
    with credit rates and subscription costs so the local dashboard & Excel
    reports are immediately populated with rich data."""
    from auth import get_password_hash

    today = (datetime.utcnow() + IST_DELTA).date()

    # 1. Ensure Demo Users across departments
    demo_users_spec = [
        ("aryan.sharma@ritzmediaworld.com", "Aryan Sharma", "EMP-101", "GEN AI", "AI Creative Lead"),
        ("priya.verma@ritzmediaworld.com", "Priya Verma", "EMP-102", "CREATIVE", "Senior Motion Designer"),
        ("rohan.mehta@ritzmediaworld.com", "Rohan Mehta", "EMP-103", "DIGITAL", "Performance Video Editor"),
        ("neha.kapoor@ritzmediaworld.com", "Neha Kapoor", "EMP-104", "CONTENT CREATOR", "AI Content Specialist"),
        ("vikram.singh@ritzmediaworld.com", "Vikram Singh", "EMP-105", "3D Visualizer", "3D & Visual Artist"),
        ("ananya.gupta@ritzmediaworld.com", "Ananya Gupta", "EMP-106", "GEN AI", "Prompt Engineer"),
        ("kabir.joshi@ritzmediaworld.com", "Kabir Joshi", "EMP-107", "CRACK TEAM", "Creative Director"),
    ]
    user_map: dict[str, User] = {}
    default_pw = get_password_hash("Rmw@12345")
    for email, name, emp_id, dept, pos in demo_users_spec:
        u = db.query(User).filter(func.lower(User.email) == email.lower()).first()
        if not u:
            u = User(
                email=email,
                name=name,
                employee_id=emp_id,
                hashed_password=default_pw,
                department=dept,
                position=pos,
                roles_json=["employee", "user"],
                is_admin=False,
                is_active=True,
                is_deleted=False,
            )
            db.add(u)
            db.flush()
        user_map[name] = u

    # 2. Ensure Clients
    clients_list = [
        "Hero MotoCorp",
        "DLF Luxury Homes",
        "Tata Motors EV",
        "RMW",
        "PITCH",
        "Boat Lifestyle",
        "Malabar Gold",
    ]
    for c_name in clients_list:
        if not db.query(GenerationClient).filter(GenerationClient.name == c_name).first():
            db.add(GenerationClient(name=c_name, is_active=True))
    db.flush()

    # 3. Ensure IT Portal Tools & Credentials (Subscriptions + Pay-per-use)
    tools_spec = [
        ("Kling AI", "kling-ai", "AI Video", "https://klingai.com", 0.0, "credit"),
        ("Freepik", "freepik", "AI Image & Video", "https://www.freepik.com", 4800.0, "subscription"),
        ("HeyGen", "heygen", "Avatar Video", "https://www.heygen.com", 0.0, "credit"),
        ("ElevenLabs", "elevenlabs", "Voice / Audio", "https://elevenlabs.io", 3600.0, "subscription"),
        ("Higgsfield", "higgsfield", "Motion Video", "https://higgsfield.ai", 3200.0, "subscription"),
        ("Suno", "suno", "AI Music", "https://suno.com", 2400.0, "subscription"),
        ("Envato", "envato", "Creative Asset", "https://elements.envato.com", 2900.0, "subscription"),
        ("Flow", "flow", "Cinematic Video", "https://labs.google/fx/tools/flow", 2500.0, "subscription"),
        ("Epidemic Sound", "epidemic-sound", "Soundtrack", "https://www.epidemicsound.com", 1800.0, "subscription"),
        ("ChatGPT", "chatgpt", "AI Assistant", "https://chatgpt.com", 4200.0, "subscription"),
    ]
    tool_objs: dict[str, ITPortalTool] = {}
    cred_objs: dict[str, ITPortalToolCredential] = {}

    for t_name, t_slug, t_cat, t_url, monthly_rs, r_type in tools_spec:
        t_obj = db.query(ITPortalTool).filter(func.lower(ITPortalTool.slug) == t_slug).first()
        if not t_obj:
            t_obj = ITPortalTool(
                name=t_name,
                slug=t_slug,
                category=t_cat,
                description=f"{t_name} — {t_cat} suite",
                website_url=t_url,
                login_url=t_url,
                icon="Zap",
                launch_mode="extension_autofill",
                status="active",
                is_active=True,
            )
            db.add(t_obj)
            db.flush()
        tool_objs[t_slug] = t_obj

        cred = db.query(ITPortalToolCredential).filter(ITPortalToolCredential.tool_id == t_obj.id).first()
        if not cred:
            cred = ITPortalToolCredential(
                tool_id=t_obj.id,
                scope="company",
                tool_cost=monthly_rs if monthly_rs > 0 else None,
                renewal_type="MONTHLY",
                renewal_date=today + timedelta(days=18),
                auto_renew=True,
                is_active=True,
            )
            db.add(cred)
            db.flush()
        elif monthly_rs > 0 and not cred.tool_cost:
            cred.tool_cost = monthly_rs
            cred.renewal_date = today + timedelta(days=18)
        cred_objs[t_slug] = cred

    # 4. Ensure Credit Rates for Pay-Per-Use tools (Kling = ₹8.5/credit, HeyGen = ₹45/credit)
    kling_cred = cred_objs["kling-ai"]
    heygen_cred = cred_objs["heygen"]
    rate_start = today - timedelta(days=120)
    if not db.query(ToolCreditRate).filter(ToolCreditRate.credential_id == kling_cred.id).first():
        db.add(ToolCreditRate(
            credential_id=kling_cred.id,
            provider="kling",
            tool_id=tool_objs["kling-ai"].id,
            currency="INR",
            package_credits=1000,
            package_rupees=8500,
            rate_per_credit=8.5,
            effective_from=rate_start,
            notes="Kling Pro Pack (₹8.50 / credit)",
        ))
    if not db.query(ToolCreditRate).filter(ToolCreditRate.credential_id == heygen_cred.id).first():
        db.add(ToolCreditRate(
            credential_id=heygen_cred.id,
            provider="heygen",
            tool_id=tool_objs["heygen"].id,
            currency="INR",
            package_credits=200,
            package_rupees=9000,
            rate_per_credit=45.0,
            effective_from=rate_start,
            notes="HeyGen Business Credits (₹45 / credit)",
        ))
    db.flush()

    # Check if we already seeded demo generations
    existing_kling = db.query(func.count(ITPortalToolUsageEvent.id)).scalar() or 0
    if existing_kling >= 25:
        db.commit()
        return {"seeded": False, "message": "Demo AI usage data is already loaded."}

    # 5. Seed 65 days of multi-tool generations across users, tools, and clients
    kling_samples = [
        ("Aryan Sharma", "Hero MotoCorp", "Hero Xtreme 160R Launch Reel", "Cinematic night highway tracking shot of sports motorcycle banking through neon rain reflections, 4K 60fps", "kling-v1-6-pro", 30.0),
        ("Priya Verma", "DLF Luxury Homes", "DLF Camellias Walkthrough", "Golden hour drone fly-through of ultra-luxury glass penthouse terrace overlooking golf course", "kling-v1-6-pro", 40.0),
        ("Rohan Mehta", "Tata Motors EV", "Curvv EV Social Ad", "Futuristic electric SUV driving through misty mountain pass with glowing LED lightbar trails", "kling-v1-5-std", 20.0),
        ("Vikram Singh", "Malabar Gold", "Festive Jewellery Film", "Slow-motion macro shot of handcrafted temple gold necklace catching warm studio rim lighting", "kling-v1-6-pro", 35.0),
        ("Aryan Sharma", "Boat Lifestyle", "Airdopes 3D Product Reveal", "Exploded 3D view of matte black wireless earbuds floating with bass shockwaves in dark studio", "kling-v1-6-pro", 30.0),
        ("Kabir Joshi", "PITCH", "New Brand Pitch Concept", "Dynamic montage of young urban creators collaborating in sunlit industrial loft studio", "kling-v1-5-std", 25.0),
    ]

    freepik_samples = [
        ("Priya Verma", "Hero MotoCorp", "Instagram Carousel Visuals", "Hyper-realistic poster key visual of biker silhouette against dramatic Himalayan sunset", "mystic-2.5", "image-generator", 15.0),
        ("Neha Kapoor", "DLF Luxury Homes", "Brochure Lifestyle Hero", "Editorial architectural photography of modern minimalist living room with Italian marble", "flux-pro-1.1", "image-generator", 12.0),
        ("Ananya Gupta", "Boat Lifestyle", "Gen-Z Campaign Key Art", "Vibrant cyberpunk street style portrait with neon headphones and holographic typography", "mystic-2.5", "image-generator", 15.0),
        ("Vikram Singh", "Tata Motors EV", "3D Concept Environment", "Minimalist futuristic charging plaza in glass dome city with soft volumetric lighting", "flux-pro-1.1", "image-generator", 18.0),
        ("Aryan Sharma", "Malabar Gold", "Bridal Campaign Teaser", "Cinematic motion transition of silk saree fabric with gold bokeh particles", "video-generator", "video-generator", 45.0),
    ]

    heygen_samples = [
        ("Neha Kapoor", "DLF Luxury Homes", "AI Spokesperson Walkthrough", "Welcome to DLF Luxury Residences — experience bespoke living crafted for modern leaders.", "Avatar IV Pro", 4.0),
        ("Rohan Mehta", "Tata Motors EV", "Dealer Training Module", "Introducing the next-generation battery architecture and intelligent cockpit controls.", "Studio Avatar v3", 3.5),
        ("Kabir Joshi", "PITCH", "Founder Pitch Personalized Intro", "Here is how RMW Creative Intelligence scales brand storytelling 5x faster.", "Avatar IV Pro", 5.0),
    ]

    elevenlabs_samples = [
        ("Rohan Mehta", "Hero MotoCorp", "TV Commercial Voiceover", "Built for the bold. Engineered to conquer every road ahead — the new Hero Xtreme.", "Aria — Warm Commercial", 240.0),
        ("Neha Kapoor", "Malabar Gold", "Festive Radio Spot", "Celebrate every precious moment with timeless craftsmanship from Malabar Gold & Diamonds.", "Kabir — Deep Narrative", 310.0),
        ("Ananya Gupta", "Tata Motors EV", "Explainer Video Narration", "Zero emissions, instant torque, and intelligent range optimization for Indian highways.", "Meera — Crisp Corporate", 280.0),
    ]

    suno_samples = [
        ("Rohan Mehta", "Boat Lifestyle", "High-Energy Reel Beat", "Upbeat electronic trap anthem with punchy bass drops and energetic synth hooks, 128 BPM", "chirp-v4", 10.0),
        ("Priya Verma", "DLF Luxury Homes", "Ambient Piano Score", "Warm cinematic orchestral strings with delicate grand piano arpeggios for luxury real estate film", "chirp-v4", 10.0),
    ]

    higgsfield_samples = [
        ("Aryan Sharma", "Boat Lifestyle", "Dynamic Camera Whip Reel", "Fast whip-pan camera motion around street dancer wearing wireless headphones in Mumbai alley", 15.0),
        ("Vikram Singh", "Hero MotoCorp", "FPV Drone Chase Shot", "High-speed FPV camera diving alongside motorcycle through canyon curves", 20.0),
    ]

    envato_samples = [
        ("Priya Verma", "Malabar Gold", "Gold Particle Overlays", "Luxury golden dust bokeh transition pack & 4K LUT bundle", "video-template", 5.0),
        ("Vikram Singh", "DLF Luxury Homes", "Architectural 3D Foliage", "Photorealistic tropical palm and terrace garden 3D asset kit", "3d-render", 8.0),
    ]

    chatgpt_samples = [
        ("Ananya Gupta", "Hero MotoCorp Launch Ad Scripts & Hook Variations", "gpt-4o", 18),
        ("Neha Kapoor", "DLF Luxury Residences Brochure Copy & SEO Pillars", "gpt-4o", 14),
        ("Kabir Joshi", "Q4 Brand Pitch Strategy & Creative Direction Deck", "o3-mini", 22),
        ("Aryan Sharma", "Kling & Flux Cinematic Prompt Engineering Templates", "gpt-4o", 16),
    ]

    # Spread events across the last 65 days (covering current month, last month, and 2 months ago)
    day_offsets = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 17, 20, 23, 26, 29, 33, 37, 41, 45, 50, 56, 62]

    seq = 1000
    for idx, offset in enumerate(day_offsets):
        ev_date = today - timedelta(days=offset)
        # Convert IST midday to UTC
        occ_utc = datetime(ev_date.year, ev_date.month, ev_date.day, 11, (idx * 7) % 55) - IST_DELTA

        # Kling events (2 per active day)
        for k_idx in range(2):
            u_name, c_name, task_name, prompt_t, model_l, cr = kling_samples[(idx + k_idx) % len(kling_samples)]
            u_obj = user_map[u_name]
            seq += 1
            ev = ITPortalToolUsageEvent(
                tool_id=tool_objs["kling-ai"].id,
                credential_id=kling_cred.id,
                user_id=u_obj.id,
                event_type="generation",
                generation_id=f"kl-job-{seq}",
                source="xhr_response",
                prompt_text=prompt_t,
                model_label=model_l,
                status="settled",
                credits_burned=cr,
                event_date=ev_date,
                linked_client_name=c_name,
                linked_task_name=task_name,
                created_at=occ_utc + timedelta(minutes=k_idx * 25),
            )
            db.add(ev)
            db.flush()
            db.add(GenerationRecord(
                provider="kling",
                provider_task_id=f"kl-job-{seq}",
                source_usage_event_id=ev.id,
                owner_user_id=u_obj.id,
                ownership_status="resolved",
                prompt_text=prompt_t,
                model_label=model_l,
                resolution_label="1080p",
                credits_burned=cr,
                capture_status="active",
                canonical_asset_url=f"https://assets.ritzmediaworld.in/demo/kling-{seq}.mp4",
                created_at=occ_utc + timedelta(minutes=k_idx * 25),
            ))

        # Freepik events (2 per active day)
        for f_idx in range(2):
            u_name, c_name, task_name, prompt_t, model_l, tool_n, cr = freepik_samples[(idx + f_idx) % len(freepik_samples)]
            u_obj = user_map[u_name]
            seq += 1
            db.add(FreepikGeneration(
                provider="freepik",
                creation_id=f"fp-gen-{seq}",
                owner_user_id=u_obj.id,
                credential_id=cred_objs["freepik"].id,
                prompt=prompt_t,
                name_field=task_name,
                tool_name=tool_n,
                tool=tool_n,
                mode=model_l,
                status="completed",
                credits_charged=cr,
                credits_estimated=cr,
                preview_url=f"https://assets.ritzmediaworld.in/demo/freepik-{seq}.png",
                linked_client_name=c_name,
                linked_task_name=task_name,
                provider_created_at=occ_utc + timedelta(minutes=40 + f_idx * 15),
                created_at=occ_utc + timedelta(minutes=40 + f_idx * 15),
            ))

        # HeyGen (every 2nd active day)
        if idx % 2 == 0:
            u_name, c_name, task_name, script_t, avatar_n, cr = heygen_samples[idx % len(heygen_samples)]
            u_obj = user_map[u_name]
            seq += 1
            db.add(HeygenGeneration(
                provider="heygen",
                video_id=f"hg-vid-{seq}",
                owner_user_id=u_obj.id,
                credential_id=heygen_cred.id,
                script_text=script_t,
                avatar_name=avatar_n,
                motion_engine="Avatar IV",
                status="completed",
                credits_used=cr,
                video_url=f"https://assets.ritzmediaworld.in/demo/heygen-{seq}.mp4",
                linked_client_name=c_name,
                linked_task_name=task_name,
                provider_created_at=occ_utc + timedelta(hours=1),
                created_at=occ_utc + timedelta(hours=1),
            ))

        # ElevenLabs (every active day)
        u_name, c_name, task_name, prompt_t, voice_n, cr = elevenlabs_samples[idx % len(elevenlabs_samples)]
        u_obj = user_map[u_name]
        seq += 1
        db.add(ElevenlabsGeneration(
            provider="elevenlabs",
            provider_creation_id=f"el-tts-{seq}",
            owner_user_id=u_obj.id,
            credential_id=cred_objs["elevenlabs"].id,
            prompt=prompt_t,
            prompt_length=len(prompt_t),
            voice_name=voice_n,
            source="tts",
            status="completed",
            credits_used=cr,
            media_url=f"https://assets.ritzmediaworld.in/demo/elevenlabs-{seq}.mp3",
            linked_client_name=c_name,
            linked_task_name=task_name,
            provider_created_at=occ_utc + timedelta(hours=2),
            created_at=occ_utc + timedelta(hours=2),
        ))

        # Suno (every 2nd active day)
        if idx % 2 == 1:
            u_name, c_name, task_name, prompt_t, model_n, cr = suno_samples[idx % len(suno_samples)]
            u_obj = user_map[u_name]
            seq += 1
            db.add(SunoGeneration(
                provider="suno",
                provider_creation_id=f"suno-clip-{seq}",
                owner_user_id=u_obj.id,
                credential_id=cred_objs["suno"].id,
                prompt=prompt_t,
                model_name=model_n,
                status="complete",
                credits_used=cr,
                media_url=f"https://assets.ritzmediaworld.in/demo/suno-{seq}.mp3",
                linked_client_name=c_name,
                linked_task_name=task_name,
                provider_created_at=occ_utc + timedelta(hours=3),
                created_at=occ_utc + timedelta(hours=3),
            ))

        # Higgsfield (every 3rd active day)
        if idx % 3 == 0:
            u_name, c_name, task_name, prompt_t, cr = higgsfield_samples[idx % len(higgsfield_samples)]
            u_obj = user_map[u_name]
            seq += 1
            db.add(HiggsfieldGeneration(
                provider="higgsfield",
                generation_id=f"hf-gen-{seq}",
                owner_user_id=u_obj.id,
                credential_id=cred_objs["higgsfield"].id,
                prompt_text=prompt_t,
                status="completed",
                credits_used=cr,
                video_url=f"https://assets.ritzmediaworld.in/demo/higgsfield-{seq}.mp4",
                linked_client_name=c_name,
                linked_task_name=task_name,
                provider_created_at=occ_utc + timedelta(hours=3, minutes=30),
                created_at=occ_utc + timedelta(hours=3, minutes=30),
            ))

        # Envato (every 3rd active day)
        if idx % 3 == 1:
            u_name, c_name, task_name, prompt_t, item_t, cr = envato_samples[idx % len(envato_samples)]
            u_obj = user_map[u_name]
            seq += 1
            db.add(EnvatoGeneration(
                provider="envato",
                item_uuid=f"env-gen-{seq}",
                owner_user_id=u_obj.id,
                credential_id=cred_objs["envato"].id,
                prompt=prompt_t,
                title=task_name,
                item_type=item_t,
                credits_badge=cr,
                canvas_url=f"https://assets.ritzmediaworld.in/demo/envato-{seq}.png",
                linked_client_name=c_name,
                linked_task_name=task_name,
                provider_created_at=occ_utc + timedelta(hours=4),
                created_at=occ_utc + timedelta(hours=4),
            ))

        # ChatGPT Conversations
        u_name, title_t, model_n, p_cnt = chatgpt_samples[idx % len(chatgpt_samples)]
        u_obj = user_map[u_name]
        seq += 1
        db.add(ConversationRecord(
            provider="chatgpt",
            provider_conversation_id=f"cgpt-conv-{seq}",
            owner_user_id=u_obj.id,
            title=title_t,
            model_label=model_n,
            prompt_count=p_cnt,
            response_count=p_cnt,
            created_at=occ_utc + timedelta(hours=2, minutes=15),
            updated_at=occ_utc + timedelta(hours=2, minutes=45),
        ))

    db.commit()
    return {"seeded": True, "message": "Seeded realistic RMW AI Tool usage, users, tools, and ₹ spend data."}
