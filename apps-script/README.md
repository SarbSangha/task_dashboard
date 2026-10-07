# Sheet Activity — Google Sheet edit capture

`Code.gs` records every change made to the shared Google Sheet and sends it to
the dashboard. The dashboard shows it under **Sheets → Sheet Activity**:
who made each change, when, on which tab and cell, and the old and new value.

How it fits together:

```
Google Sheet ──(installable onEdit / onChange triggers)──> Code.gs
     Code.gs ──POST JSON + X-Sheet-Activity-Secret──> /api/sheet-activity ──> sheet_activity table
     Code.gs ──(if the POST fails)──> hidden "_AuditLog" tab ──(hourly resendAuditLog)──> /api/sheet-activity
```

## Setup

### 1. Backend settings

In `backend/.env` (and the production environment):

| Variable | Value |
|---|---|
| `SHEET_ACTIVITY_WEBHOOK_SECRET` | A long random string, at least 24 characters. Generate one with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. |
| `SHEET_ACTIVITY_SPREADSHEET_IDS` | The spreadsheet ID: the long part of the sheet's URL between `/d/` and `/edit`. Comma-separate several. Events from any other spreadsheet are refused. |

Restart the backend. Its startup migration creates the `sheet_activity` table.
Without a secret, the webhook refuses every request with a 503.

### 2. Install the script

Do this signed in as the **spreadsheet owner**. Triggers run as the account
that installs them, and the protected `_AuditLog` tab is editable only by that
account.

1. Open the sheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with this folder's `Code.gs` and save.
3. **Project Settings → Script Properties**, add:
   - `BACKEND_URL` = `https://dashboard.ritzmediaworld.in/api/sheet-activity`
   - `WEBHOOK_SECRET` = the same value as `SHEET_ACTIVITY_WEBHOOK_SECRET`
4. In the editor, choose `setupTriggers` and click **Run**. Approve the
   permissions prompt. This installs three triggers:
   - `handleEdit` on edit
   - `handleChange` on change
   - `resendAuditLog` every hour

   It also creates the hidden, protected `_AuditLog` tab.
5. Choose `checkConfiguration` and click **Run**. The log must say
   `OK - backend reachable and secret accepted`.

Re-running `setupTriggers` is safe: it replaces its own triggers rather than
adding duplicates.

### 3. Give people access

Admin Queue → **Section Access** → tick **Sheet Activity** for each person
who should see the tab. Admins always see it.

### Backfill

Events that failed to send sit in `_AuditLog` until `resendAuditLog` delivers
them. It runs hourly, and you can also run it by hand from the editor.

If the rows have to be loaded somewhere else, download the `_AuditLog` tab as
CSV and run, from `backend/`:

```
python scripts/backfill_sheet_activity.py path/to/_AuditLog.csv --dry-run
python scripts/backfill_sheet_activity.py path/to/_AuditLog.csv
```

Every event carries an ID made by the script, so resending or importing the
same row twice never creates a duplicate.

## Known limitations

- **Blank emails.** Apps Script only reveals the editor's email when they are
  signed in with an account on the same Google Workspace domain as the trigger
  owner. Personal Gmail accounts and editors outside the domain arrive blank
  and show as **Unknown user**. Their changes are still recorded, but you
  can't tell those editors apart. To identify everyone, share the sheet only
  with company accounts.
- **Old values for single cells only.** For a paste, fill or multi-cell
  delete, the log shows "multiple cells" with the new values. Only the
  top-left 20 × 20 cells are sent, and values longer than 2,000 characters are
  shortened. Truncated events are marked.
- **Cleared cells** show the old value and "(cleared)".
- **Formulas.** The new value is what the cell displays. The formula is stored
  as well and shown with ƒ.
- **Changes that fire no trigger.** Edits made through the Sheets API, other
  scripts, add-ons or importers aren't captured. Some actions, such as
  inserting or deleting rows, columns or tabs, sorting or formatting, only
  fire `onChange`, which doesn't say which cells changed. For those, the log
  shows the selection at the time as an approximate location. A deleted tab's
  name isn't available.
- **Quotas.** Each change is one `UrlFetchApp` call. The daily quota is
  20,000 calls on consumer accounts and 100,000 on Workspace. Payloads are
  kept small. If the quota runs out, or the backend is down, events wait in
  `_AuditLog` and are resent hourly.
- **Undo** is recorded as a new edit, not as the reversal of the previous one.
- **Timestamps** are when the trigger ran, in UTC. The dashboard shows them in
  the viewer's local time and filters by IST calendar day.

## End-to-end test

Use two or three different company accounts that can edit the sheet.

1. As user A, change one cell. Within 30 seconds, Sheet Activity should show
   one Edit by A with old → new and the cell address.
2. As user B, paste a 3 × 3 block. Expect one Edit by B showing "multiple
   cells (3×3)" and the pasted values.
3. As user B, clear a cell. Expect old value → (cleared).
4. As user A, insert a row, then add a tab. Expect "Rows inserted" and "Tab
   added" by A.
5. As a personal Gmail account, if one has access, edit a cell. Expect
   Unknown user.
6. Click user A in **People**. The log should show only A's changes. Export
   CSV and check that the rows match.
7. Set `BACKEND_URL` to a wrong address and edit a cell. Confirm the row
   appears in `_AuditLog` with `sent = FALSE`. Restore the URL and run
   `resendAuditLog`. The edit appears in the dashboard and the row turns
   `TRUE`.

---

# Sheets section — content requests (user input vs Claude's response)

**Sheets → Sheets** in the dashboard tracks each row of a content sheet as
one request. It shows what a person entered, what the scheduled Claude agent
wrote back, who approved it, and how long each stage took.

## How it reads the sheet

The dashboard downloads the sheet through its public **"Anyone with the link →
Viewer"** export about every 90 seconds and compares it with the last copy.
No service account or Google credentials are used, and the dashboard never
writes to the sheet. The Claude agent writes through the API, which fires no
Apps Script trigger, so this comparison is how its responses are captured.

| Change seen between two reads | Recorded as | By |
|---|---|---|
| Topic goes from blank to filled | NEW_REQUEST | user |
| Any other input column changes | INPUT_EDIT | user |
| Status becomes "Awaiting Approval" (with the Optimized Structure) | STRUCTURE_GENERATED | Claude |
| Optimized Structure edited while the status stays the same | STRUCTURE_EDITED_BY_USER | user |
| Status becomes "Approved" | APPROVED | user |
| Status becomes "In Progress" | DRAFT_STARTED | Claude |
| Status becomes "Delivered" | DELIVERED, plus ERROR if Final Doc Link is empty | Claude |
| Status contains "error" or "fail" | ERROR | Claude |

Columns are matched by **header name**, never by position. Each sheet's
mapping, status names and stuck-request limits can be edited in its Settings.

## Add a sheet

1. In Google Sheets, choose **Share → General access → Anyone with the link →
   Viewer**.
2. In the dashboard, open **Sheets → Add a sheet** (admins only), paste the
   link and click **Check access**. Tabs with a Topic and a Status column are
   ticked automatically.
3. Check the column roles, then tick who may see the sheet. Optionally, enter
   each person's Google email if it differs from their dashboard login. That
   email is how the Apps Script names editors.
4. Click **Add sheet**. The first read imports the rows already there. They
   are marked "before tracking", because their earlier history is unknown.
5. Grant the **Sheets** column in Admin Queue → Section Access to everyone
   who should see the section.

## Optional: install the Apps Script for names and exact times

Without the script, the dashboard knows *what* changed and roughly *when*,
but not *who*: every user action shows as "Unknown user". To attribute edits
to people, someone with **edit access** to the sheet installs `Code.gs`, as
described at the top of this file. The Sheets section then matches each
change to that person's edit and records their name and exact time.

To also add a hidden **Request ID** column, so a row keeps its history even
if "No." values are renumbered:

1. Add the Script Property `TRACKED_TABS`, for example
   `Ritz Media World,My Property Fact,Contenaissance,Creative Thinks Media`.
2. Run `setupRequestIds()` once. New rows get an ID when someone first
   types in them.

Check that the Claude agent still works afterwards. It should find columns by
header name, and the new column is added after the last one.

## Limitations

- **The Claude agent's own details aren't visible.** The model, token usage
  and run time stay empty, because the agent writes to the sheet directly.
  Times between stages are measured from when the dashboard noticed each
  change.
- **Times are approximate** (marked ≈), to within about 90 seconds, unless
  the Apps Script saw the edit. A stage shorter than one read can be missed:
  for example, "In Progress" that turns into "Delivered" between two reads
  shows only DELIVERED.
- **Editor emails need the Apps Script and company accounts.** Personal
  Gmail accounts, or accounts outside the Workspace domain, show as "Unknown
  user".
- **Old values come from the dashboard's own copy**, so they're available
  even for pastes. Values typed and changed back between two reads aren't
  seen.
- **Long Optimized Structure text** is stored in full. Tables shorten it,
  and the request detail shows it all, with headings rendered.
- **Rows are identified by "Request ID", then "No.", then row number.** A
  row without either that moves to a different position looks like a new
  request.
- **The sheet must stay link-shared.** If sharing is turned off, the sheet
  card shows the error and reads resume once it's restored.
- **Example rows.** The template's pale-yellow example rows are skipped. The
  current sheet no longer has one.

---

# Sheets section — keyword ranking sheets

A **Keyword ranking** sheet, such as `keyword_ranking_tracker`, has one tab
per site and one row per keyword. Each ranking run adds a Position /
AI Overview column pair under a date header. The dashboard turns that wide
layout into one result per keyword per run, and shows:

- positions over time
- AI Overview citations
- who added each keyword
- alerts

## How the data gets in

| What | Who writes it | How the dashboard gets it |
|---|---|---|
| Keyword | A person, in the **Keyword URL Source Sheet**. The job copies it here. | New, edited and removed rows are seen on each read. Names come from `Code.gs` installed on the source sheet. |
| Live URL | The ranking job. It's the page Google ranks for the keyword; no keyword that never ranked has one. | Read from the sheet and stored as that run's ranking page. A change is recorded as URL_CHANGED by the job. |
| Position, AI Overview | The ranking job (Apps Script) | Read from the sheet on every poll. The full history is imported the first time. |
| URL that actually ranked, raw response, cost, duration | The ranking job | Only if the job calls `RankingLog.gs`, see below |

The importer finds the header row by its "Keyword" text, the sub-header row
by "Position", and each run by its date header. A header can be a real date
or text such as "21-Aug-2026 (Baseline)". New date columns are picked up
automatically, and no fixed number of runs is assumed.

Values are normalised as follows:

| In the sheet | Stored as |
|---|---|
| 1, 7.0, "12" | ranked, with that position |
| "Not in Top 10" or "Not in Top 50", any spacing | not ranked within 10 or 50, with that depth kept |
| "CHECK FAILED", "Check failed" | failed check |
| AI Overview "Yes" / "No" / "No AI Overview" | cited / not cited / no AI Overview |
| Anything else, such as "N5" | unreadable. The raw value is kept and flagged. |

## Add the sheet

1. Make sure the sheet is shared as **Anyone with the link → Viewer**.
2. Open **Sheets → Add a sheet** and paste the link. The dashboard detects
   the keyword-ranking layout and shows each tab's header rows, keyword
   count and runs.
3. Paste the **Keyword URL Source Sheet** link. Tick who may see it, then
   save. The first read imports every run since the first date column.

## Optional: name who added each keyword

Install `Code.gs` on the **Keyword URL Source Sheet**, following the steps at
the top of this file. The dashboard then matches each new keyword to the
person who typed it there, with their email and exact time. Installing it on
the ranking sheet as well names anyone who types over a result by hand.

## Optional: log runs from the ranking job

Add `RankingLog.gs` to the ranking job's Apps Script project, then:

1. Add the Script Property `RANKING_RESULTS_URL` =
   `https://dashboard.ritzmediaworld.in/api/sheets/ranking-results`.
2. Add `WEBHOOK_SECRET`, if it isn't already set.
3. In the job, call these for each tab, as shown at the top of
   `RankingLog.gs`:
   - `startRankingRun(tab, {...})` once
   - `addRankingResult(run, {...})` once per keyword
   - `finishRankingRun(run)` at the end
4. Run `setupRankingLogTrigger()` once, so reports that failed to send are
   retried hourly from the hidden `_RankingLog` tab.

Each report is merged with the run the importer read from the same date
column.

## Alerts

| Alert | When |
|---|---|
| Big drop | The keyword lost 5 or more places since the previous run |
| Fell out of the top 10 | It was in the top 10 last run, and isn't now |
| Lost AI Overview citation | It was cited last run; now it's not cited, or there's no AI Overview |
| Ranking page changed | Google ranks a different page of the site than in the previous run |
| Ranked, no Live URL | The keyword ranks, but the job left Live URL blank |
| Missed Monday run | There's no run dated a Monday, checked after 9 PM IST that day |
| Failed checks | The latest run has CHECK FAILED results |
| Manual override | A result changed after the run (see Limitations) |
| Unreadable value | A cell isn't a position or Yes / No / No AI Overview |
| Duplicate keyword | The same keyword appears more than once on a tab |

## Limitations

- **Editor emails need `Code.gs` and company accounts.** Personal Gmail
  accounts and editors outside the Workspace domain show as "Unknown user".
  Without `Code.gs` on the source sheet, every new keyword shows as Unknown
  user, timed at the poll that first saw it, which is usually after the
  Monday sync.
- **Results written by the job fire no trigger.** They're read from the sheet
  every 90 seconds, or reported by `RankingLog.gs`.
- **Manual overrides are inferred.** A result that changes on a run 2 or more
  days old is flagged as a likely manual override, because the job never
  rewrites old runs. A same-day change is treated as the job re-running. An
  override is attributed to a person only when `Code.gs` saw the edit.
- **"Not in Top 10" and "Not in Top 50" aren't comparable.** Early runs only
  checked the top 10, so a move from "Not in Top 10" to 30 shows as "not
  comparable" rather than a drop.
- **Scheduled versus manual is inferred from the date:** Monday is
  scheduled, other days are manual. The job's report overrides this.
- **Each run's ranking page** comes from the Live URL as it was when that run
  was read. History imported at registration only has today's Live URL, so
  only the latest run gets one; every later run records its own.
- **The raw API response, cost and duration** exist only for runs the job
  reported through `RankingLog.gs`.
- **The sheet's note is out of date.** It says people add "keyword+URL pairs",
  but people only type the keyword; the job fills in Live URL.
- **Duplicate keywords on a tab are tracked as separate rows.** They're
  numbered in order, so deleting the first copy shifts the history to the
  second.
