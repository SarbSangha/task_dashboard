# Report Distribution Architecture

**Scope:** The enterprise distribution layer for the Reports module — turning a built
report into a stored, exportable, schedulable, auditable business artifact.
Covers: generation flow, storage model, permissions, audit logging, scheduling,
email delivery, and export formats.

**Guiding principle (unchanged across this platform):** ship what is real and verifiable;
be explicit about what needs deployment infrastructure. Nothing here claims to email a
PDF automatically unless the operator has provided the pieces that make that true.

---

## 0. Dependency & infrastructure honesty (read first)

| Capability | Needs | In this codebase? | Phase-1 behaviour |
|---|---|---|---|
| Store report definitions & history | DB tables | ✅ added | **Built** — `saved_reports` |
| Server-side HTML render | Python template | ✅ added (`utils/report_render.py`) | **Built** |
| CSV export | stdlib `csv` | ✅ always | **Built** |
| Excel (.xlsx) | `openpyxl` | ➕ added to requirements (pure-python) | **Built** (guarded — 501 if missing) |
| PowerPoint (.pptx) | `python-pptx` | ➕ added to requirements (pure-python) | **Built** (guarded) |
| **PDF (server-side)** | `weasyprint` (+ cairo/pango system libs) **or** headless browser | ❌ **not installed** (heavy/system deps) | **Optional** — used only if `weasyprint` importable; otherwise clients use the **browser print-to-PDF** already shipped in Report Builder |
| **Email delivery** | SMTP server + `SMTP_*` env vars (uses stdlib `smtplib`) | ❌ **not configured** | Sender **built**; sends **only if** `SMTP_HOST` etc. are set — otherwise the run is recorded as `email_skipped` |
| **Automatic schedule firing** | a cron/worker calling `run-due`, or an in-process scheduler | ❌ **no scheduler** | Schedules are **stored & processable**; firing is triggered by `POST /schedules/run-due` (call it from the existing deploy cron). No silent double-send. |
| Artifact object storage | `boto3` (R2/S3 present) | ✅ available | Phase-2 option; Phase-1 stores the HTML snapshot in the DB |

`GET /api/reports/distribution/capabilities` returns this matrix at runtime so the UI shows
the operator exactly what is active — never a button that silently no-ops.

---

## 1. Report generation flow

```
Report Builder (client)                Backend
──────────────────────                 ───────
definition {branding, blocks}
  + rendered HTML snapshot
        │  POST /api/reports/library
        ▼
                                 saved_reports (definition_json, html_snapshot, owner, dept, version)
                                 report_audit_log  (action=created)
        │  GET .../{id}/export?format=pdf|xlsx|pptx|csv|html
        ▼
                                 utils/report_render  → HTML (from definition, live blocks re-fetched or snapshot)
                                 utils/report_exports → bytes (format-specific, guarded)
                                 report_audit_log (action=exported, format)
        │  POST /api/reports/schedules
        ▼
                                 report_schedules (cadence, recipients, next_run_at)
   cron → POST /schedules/run-due
        ▼
                                 render → export → email (if SMTP) → update next_run → audit
```

**Definition is the source of truth.** A report is stored as its definition (branding +
ordered blocks) plus an HTML snapshot taken at save time. Re-exports render from the
definition; **live-data blocks** are re-fetched at export/schedule time so a weekly report
always reflects current numbers, while question/custom blocks stay stable.

---

## 2. Storage model

**`saved_reports`**
| column | type | notes |
|---|---|---|
| id | PK | |
| name | varchar | report title/name |
| definition_json | JSON | `{branding, blocks}` — the full builder state |
| html_snapshot | TEXT | rendered HTML at save time (fast preview/download) |
| owner_user_id | FK users | creator |
| department | varchar | scope tag (nullable) |
| version | int | bumped on overwrite |
| created_at / updated_at | timestamp | |

**`report_schedules`**
| column | type | notes |
|---|---|---|
| id | PK | |
| name | varchar | |
| definition_json | JSON | report to render each run |
| cadence | varchar | `daily` \| `weekly` \| `monthly` |
| hour_utc | int | send hour |
| weekday / day_of_month | int | for weekly/monthly |
| recipients_json | JSON | list of email addresses |
| formats_json | JSON | e.g. `["pdf","xlsx"]` |
| active | bool | |
| owner_user_id | FK users | |
| next_run_at / last_run_at / last_status | timestamp / varchar | |
| created_at | timestamp | |

**`report_audit_log`**
| column | type | notes |
|---|---|---|
| id | PK | |
| report_id / schedule_id | int | nullable references |
| action | varchar | created · exported · deleted · scheduled · sent · email_skipped · run |
| format | varchar | for exports |
| user_id | FK users | actor (null for system runs) |
| detail | TEXT | freeform (recipients, error, counts) |
| created_at | timestamp | |

---

## 3. Permissions model

Reuses the existing `RoleChecker` roles (`admin`, `faculty`, `user`).

| Action | admin | faculty | user |
|---|---|---|---|
| Build & export a report | ✅ | ✅ | ✅ (own) |
| Save to library | ✅ | ✅ | ✅ (own) |
| List/open reports | all | own + dept | own |
| Delete report | any | own | own |
| Create/list schedules | all | own | ✗ (Phase-1: faculty+) |
| Run-due (trigger) | ✅ | ✗ | ✗ |
| View audit log | ✅ | ✗ | ✗ |

Scoping is enforced server-side: non-admins get `owner_user_id == current_user.id`
(faculty additionally by `department` where set). Data inside a report already inherits the
faculty-gated analytics endpoints, so no new data-exposure surface is created.

---

## 4. Audit logging

Every state-changing action writes one `report_audit_log` row: **created, exported (+format),
deleted, scheduled, run, sent, email_skipped**. Admin-only `GET /api/reports/audit` returns the
trail. This gives enterprise traceability ("who exported the Q3 cost report, when, in what
format") without extra tooling.

---

## 5. Scheduling

- A schedule stores a report definition + cadence + recipients + formats + `next_run_at`.
- `POST /api/reports/schedules/run-due` (admin/system) finds schedules with `next_run_at <= now`
  and `active`, renders + exports each, emails if SMTP is configured, records audit, and advances
  `next_run_at` by cadence.
- **Firing** is intentionally external: the existing deploy already runs cron/SSH steps — point a
  cron at `run-due` (e.g. hourly). This avoids per-worker double-fires and needs no new dependency.
  An in-process APScheduler loop is a documented Phase-2 upgrade (guarded by a single-instance lock
  via the already-present Redis).

---

## 6. Email delivery

- Implemented with **stdlib `smtplib` + `email.message`** — no new dependency.
- Activated only when `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`
  are set (TLS via `SMTP_STARTTLS=1`). `email_configured()` reports this; capabilities endpoint
  surfaces it to the UI.
- When unconfigured, a scheduled run still renders and audits, recording `email_skipped` — the
  operator sees exactly why nothing was sent. **No fake "email sent" state.**

---

## 7. Export formats

| Format | Engine | Content |
|---|---|---|
| **HTML** | snapshot / server render | the branded document |
| **PDF** | browser print (client) — or `weasyprint` if installed (server) | pixel-accurate branded doc |
| **CSV** | stdlib `csv` | flattened blocks: section, field, value |
| **Excel** | `openpyxl` | one sheet: sections + KPI/table rows, branded header |
| **PowerPoint** | `python-pptx` | title slide + one slide per block |

Each server export is a `GET .../{id}/export?format=…` returning the file with the right
mimetype and filename; missing optional engines return `501` with a clear message, and the UI
disables that button based on the capabilities probe.

---

## 8. Phase map

**Phase 1 (this slice — built & verifiable):** storage + history, server render, CSV/Excel/PPTX
exports, optional server PDF, permissions, audit log, schedule records + `run-due`, stdlib email
(env-gated), capabilities probe; frontend Save-to-Library, Export Center, Report History,
Scheduled Reports.

**Phase 2 (documented, needs infra/decisions):** in-process scheduler (Redis-locked) or external
cron wiring; R2/S3 artifact storage for large histories; a hardened PDF renderer (weasyprint image
or headless-browser service); per-department delivery policies; report templates gallery; and
natural-language report generation ("build a monthly marketing AI report") that assembles blocks
from the question bank.

_Analytics & BI Office — Reports module, distribution layer._
