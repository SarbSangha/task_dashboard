# AI Productivity Board — Remediation Plan & Endpoint Coverage

**Companion to:** `docs/ai-productivity-board-data-availability-audit.md`
**Scope:** (A) drop-in Tier 1–3 schema/migration drafts in this repo's exact migration style, (B) a full 320-question → 23-endpoint coverage map.
**Date:** 2026-07-17
**Status:** DRAFT — nothing here has been applied to the database. Migration snippets are written to slot into `_ensure_postgres_schema(conn)` in `backend/db_migrations.py`.

---

# Part A — Tiered Remediation (schema / migration drafts)

All snippets follow the existing convention in `backend/db_migrations.py`:
- Columns via `_pg_add_column_if_missing(conn, table, column, sql_type)` (idempotent).
- Tables via `CREATE TABLE IF NOT EXISTS …`.
- Backfills as guarded `UPDATE … WHERE … IS NULL`.

## Tier 1 — Config only → unlocks all cost/ROI $ figures

**Goal:** turn `credits_burned` into money. Today no currency rate is stored anywhere.

### 1.1 New table: `tool_credit_rates`
```sql
CREATE TABLE IF NOT EXISTS tool_credit_rates (
    id              SERIAL PRIMARY KEY,
    tool_id         INTEGER REFERENCES it_portal_tools(id) ON DELETE CASCADE,  -- NULL = global default
    currency        VARCHAR(8)     NOT NULL DEFAULT 'INR',
    rate_per_credit NUMERIC(12,4)  NOT NULL,          -- e.g. 1 credit = 0.85 INR
    effective_from  DATE           NOT NULL DEFAULT CURRENT_DATE,
    effective_to    DATE,                             -- NULL = current
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_tool_credit_rates_tool_effective
    ON tool_credit_rates (tool_id, effective_from);
```
`ORM model` to add in `models_new.py`: `ToolCreditRate` mirroring the above.

**Seed (global default, editable in admin):**
```sql
INSERT INTO tool_credit_rates (tool_id, currency, rate_per_credit, effective_from)
SELECT NULL, 'INR', 1.0000, CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM tool_credit_rates WHERE tool_id IS NULL);
```

**Cost derivation formula** (used in `/cost/*` endpoints):
```
cost = credits_burned * COALESCE(tool_rate.rate_per_credit, global_rate.rate_per_credit)
```
Pick the rate row where `tool_id` matches (else global) and `event_date BETWEEN effective_from AND COALESCE(effective_to, 'infinity')`.

**Unlocks:** every `-01/-02/-03` cost row in *Business Value & ROI*, *Cost Optimization*, *Spend-to-Value*, plus the `Total Cost` executive KPI.

---

## Tier 2 — Derived from existing tables (no new capture)

### 2.1 Structured capture-failure reason
Today success = `capture_status IN ('active','completed')`; every other state is an undifferentiated "not success."

```sql
-- new columns on generation_records
```
```python
_pg_add_column_if_missing(conn, "generation_records", "failure_reason", "VARCHAR(40)")
_pg_add_column_if_missing(conn, "generation_records", "is_recovered", "BOOLEAN DEFAULT FALSE")
```
**Allowed `failure_reason` vocabulary:** `NULL` (success) | `timeout` | `missing_asset` | `api_error` | `task_missing` | `network_error` | `no_output` | `unknown`.

**Backfill from what we already store** (`metadata_json`, `capture_status`, `recovery_audit_id`):
```sql
UPDATE generation_records
SET failure_reason = CASE
    WHEN capture_status IN ('active','completed') THEN NULL
    WHEN canonical_asset_url IS NULL AND provider_task_id IS NULL THEN 'task_missing'
    WHEN canonical_asset_url IS NULL THEN 'missing_asset'
    WHEN metadata_json->>'error' ILIKE '%timeout%' THEN 'timeout'
    WHEN metadata_json->>'error' ILIKE '%network%' THEN 'network_error'
    WHEN metadata_json->>'error' IS NOT NULL THEN 'api_error'
    ELSE 'unknown'
END
WHERE failure_reason IS NULL AND capture_status NOT IN ('active','completed');

UPDATE generation_records SET is_recovered = TRUE
WHERE recovery_audit_id IS NOT NULL AND is_recovered = FALSE;
```
**Unlocks:** *Success, Failure & Recovery Diagnostics*, Capture Pipeline Health pie charts, recovery-rate KPI.

### 2.2 Completion time & step duration (derived, not stored)
No column needed — compute in-query from timestamps that already exist.

**Task completion time (minutes):**
```sql
EXTRACT(EPOCH FROM (tasks.completed_at - tasks.started_at)) / 60.0
```
**Per-stage duration (minutes)** from `task_stages`:
```sql
EXTRACT(EPOCH FROM (COALESCE(task_stages.completed_at, task_stages.submitted_at) - task_stages.started_at)) / 60.0
```
Optional materialization if query cost matters:
```python
_pg_add_column_if_missing(conn, "tasks", "completion_minutes", "DOUBLE PRECISION")
```
backfilled with the formula above (recompute on task completion in app code).
**Unlocks:** COO cycle-time / SLA / bottleneck `-01/-02/-03/-05` rows, `/tasks/bottlenecks` enrichment.

### 2.3 Rework count (derived)
Two viable sources already in schema — pick one:
- **From result versions:** `tasks.result_version` (already increments on redo).
- **From workflow revisions (richer):** count of `task_status_history` rows with `action`/`status_to` indicating `need_improvement`/rejection per task, or `task_stage_submissions` with `version > 1`.
```sql
-- rework via stage resubmissions
SELECT s.task_id, GREATEST(0, COUNT(*) FILTER (WHERE sub.version > 1)) AS rework_count
FROM task_stages s
JOIN task_stage_submissions sub ON sub.stage_id = s.id
GROUP BY s.task_id;
```
**Unlocks:** *Tool Effectiveness & Process Waste* rework metrics.

---

## Tier 3 — New data source (org hierarchy) → unblocks ~1 in 4 questions

The team / manager / geography splits are the largest single 🔴 block. `users.department` exists; `team`, `manager`, `location`, and a clean `role` do not.

### 3.1 Extend `users`
```python
_pg_add_column_if_missing(conn, "users", "team", "VARCHAR(120)")
_pg_add_column_if_missing(conn, "users", "manager_id", "INTEGER")   # FK users.id (self-ref)
_pg_add_column_if_missing(conn, "users", "location", "VARCHAR(120)")
_pg_add_column_if_missing(conn, "users", "role_title", "VARCHAR(120)")
```
```sql
CREATE INDEX IF NOT EXISTS ix_users_team ON users (team);
CREATE INDEX IF NOT EXISTS ix_users_manager_id ON users (manager_id);
CREATE INDEX IF NOT EXISTS ix_users_location ON users (location);
```
> Note: a clean role taxonomy can also reuse the existing `user_roles` table; `role_title` above is the display/HRIS role, distinct from access roles.

### 3.2 Optional: `team_directory` (parallels the existing `department_directory`)
```sql
CREATE TABLE IF NOT EXISTS team_directory (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(120) NOT NULL UNIQUE,
    department    VARCHAR(120),
    manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```
**Population:** manual admin entry, or CSV/HRIS import. Until populated these splits stay 🔴, so this is a **data-entry dependency, not just a schema change**.
**Unlocks:** every "team / manager portfolio / geography" split across CEO, COO, HR, Spend-to-Value (archetypes `-01/-03/-08` for those subcategories).

### Out of scope here (Tier 4–5, from the audit): clickstream/`event_sequence`, token capture, forecasting, experimentation, prompt embeddings, anomaly detection. Those are Phase 2.

---

# Part B — Endpoint ↔ Question Coverage Map

## B.1 How to read this

Legend: **✅ answerable today** (endpoint exists) · **⚠ needs Tier 1–3** · **🔴 Phase 2 (ML/new capture)**.

Within **every** subcategory the 10 question IDs (`-01…-10`) follow the fixed archetype pattern, so coverage is mostly determined by archetype:

| Archetype | `-NN` | Default verdict |
| --- | --- | --- |
| Baseline | 01 | ✅ (⚠ if split = team/manager/geo) |
| Trend | 02 | ✅ |
| Lead/Lag | 03 | ✅ (⚠ if split = team/manager/geo) |
| Cohort | 04 | ✅ |
| Funnel/Journey | 05 | 🔴 (no clickstream) |
| Drivers | 06 | ⚠ (needs driver model) |
| Correlation | 07 | ⚠ (needs stats pass) |
| Outliers | 08 | ✅/⚠ (needs size normalizer) |
| Forecast | 09 | 🔴 |
| Intervention | 10 | 🔴 |

So per subcategory the shape is typically: **02/04 ✅**, **01/03/08 ✅-or-⚠**, **06/07 ⚠**, **05/09/10 🔴**. The table below records the *primary existing endpoint* for the ✅ cells and the *specific* blocker for the rest.

## B.2 Subcategory coverage (all 32)

| Subcategory | Primary existing endpoint(s) | ✅ today | ⚠ Tier | 🔴 Phase 2 |
| --- | --- | --- | --- | --- |
| Platform Growth & Active Usage | `/executive`, `/users/summary`, `/users/activity-trends` | 01,02,03,04,08 | 06,07 | 05,09,10 |
| AI Adoption & Penetration | `/executive`, `/kling/users`, `/chatgpt/users` | 01,02,03,04,08 | 06,07 | 05,09,10 |
| Business Value & ROI Realization | `/cost/summary`, `/cost/breakdown` | 02,04 | 01,03,08 (Tier 1 $), 06,07 | 05,09,10 |
| Department Transformation & Expansion | `/executive`, `/cost/breakdown` | 02,04 | 01,03,08 (Tier 3 mgr), 06,07 | 05,09,10 |
| Workflow Throughput & SLA | `/tasks/summary`, `/tasks/trends` | 02,04 | 01,03 (Tier 3 team), 08 (Tier 2 time), 06,07 | 05,09,10 |
| Operational Bottlenecks & Delay Drivers | `/tasks/bottlenecks` | 02 | 01,03 (Tier 2 step_duration), 06,07,08 | 05,09,10 |
| Tool Effectiveness & Process Waste | `/kling/summary`, `/tasks/ai-impact` | 02,04 | 01,03 (Tier 2 rework/failure), 06,07,08 | 05,09,10 |
| Team Capacity & Execution Balance | `/tasks/summary`, `/users/summary` | 02 | 01,03,08 (Tier 3 team/mgr), 06,07 | 05,09,10 |
| Employee Adoption & Proficiency | `/users/summary`, `/users/power-users`, `/kling/users` | 01,02,03,04,08 | 06,07 | 05,09,10 |
| Retention, Engagement & Burnout Signals | `/users/retention`, `/users/activity-trends` | 01,02,04 | 03,08 (burnout thresholds), 06,07 | 05,09,10 |
| Training Needs & Enablement Gaps | `/users/power-users` (inverse), `/recommendations` | 02,04 | 01,03 (Tier 3 role), 06,07 | 05,09,10 |
| Feature Adoption & Value | — | — | — | 01–10 🔴 (no feature-level events) |
| Feature Friction & Drop-off | — | — | — | 01–10 🔴 (no clickstream) |
| Experience Design & Navigation | — | — | — | 01–10 🔴 (no clickstream) |
| Tool Mix & Model Mix | `/kling/summary`, `/cost/breakdown`, `/filters` | 01,02,03,04,08 | 06,07 | 05,09,10 |
| Credits, Tokens & Infra Efficiency | `/cost/summary`, `/cost/breakdown` | 01,02,03,08 (credits) | (Tier 1 $) | tokens 🔴, 05,09,10 |
| Prompt Quality & Generation Quality | `/prompts/summary`, `/prompts/golden`, `/prompts/engineers` | 02,04 | 01,03 (Tier 2 failure), 06 | quality-scoring 🔴, 05,09,10 |
| Acquisition, Onboarding & Activation | `/users/summary` | 01,02 | 03,04 | onboarding funnel 05 🔴, 09,10 |
| Engagement Depth & Habit Formation | `/users/activity-trends`, `/users/retention` | 01,02,04 | 03,06,07 | 05,09,10 |
| Retention, Churn & Resurrection | `/users/retention` | 01,02,03,04 | 08 | churn-risk 🔴, 05,09,10 |
| Creativity, Reuse & Content Patterns | `/prompts/summary`, `/prompts/trends`, `/prompts/golden` | 01,02,04 | 03,06 | similarity/embeddings 🔴, 05,09,10 |
| Productivity & Performance Improvement | `/tasks/ai-impact`, `/users/summary` | 02,04 | 01,03,06,07 | 05,09,10 |
| Journey Sequencing & Conversion Pathways | — | — | — | 01–10 🔴 (no event sequence) |
| Access Anomalies & Auditability | `it_portal_tool_audit`, `task_edit_logs` (raw; no report endpoint) | — | 01,02,03 (needs new endpoint over audit tables) | anomaly detection 🔴, 05,09,10 |
| Policy Adherence, Content Safety & Governance | — | — | — | 01–10 🔴 (no content classification) |
| Spend-to-Value Optimization | `/cost/breakdown` | 02 | 01,03,08 (Tier 1 $ + Tier 3 team) | 05,09,10 |
| Demand Forecasting & Capacity Planning | `/kling/trends`, `/users/activity-trends` (history only) | 02 (history) | — | forecast 09 + most 🔴 |
| Risk Prediction (Churn/Failure/Low Adoption) | — | — | — | 01–10 🔴 (predictive models) |
| Success, Failure & Recovery Diagnostics | `/kling/summary` (partial) | 02 | 01,03,08 (Tier 2 failure_reason) | 05,09,10 |
| Next-Best Tool, Prompt & Workflow Guidance | `/recommendations` (partial) | — | 01,06 (rules) | personalized recs 🔴 |
| Personalized Enablement, Nudges & Automation | — | — | — | 01–10 🔴 (recommender) |
| Roadmap Prioritization & Experimentation | — | — | — | 01–10 🔴 (experimentation framework) |

## B.3 Rollup

| Bucket | Approx. questions | Notes |
| --- | --- | --- |
| ✅ answerable today (endpoint exists) | **~110 / 320** | mostly `-02/-04` and dimension-safe `-01/-03/-08` |
| ⚠ unlock via Tier 1–3 (no ML) | **~95 / 320** | cost $, failure taxonomy, cycle-time, team/mgr splits, correlation |
| 🔴 Phase 2 (ML / new capture) | **~115 / 320** | all `-05/-09/-10`, feature/clickstream/policy/forecast/recommender subcats |

*(Counts are archetype-derived estimates, not a hand-audit of all 320 rows; the per-subcategory table above is the source of truth.)*

---

# Part C — Suggested execution order

1. **Tier 1 (½ day):** `tool_credit_rates` + wire the cost formula into `/cost/*`. Immediately lights up every $ KPI on the executive board.
2. **Tier 2 (1–2 days):** `failure_reason` + backfill (Capture Health page), then completion-time / rework derivations (COO page).
3. **Tier 3 (schema ½ day + ongoing data entry):** org-hierarchy columns; splits go live only as the data is populated.
4. **New read endpoints** for the ⚠ cells that now have data: a `/capture/health`, a `/cost/*` currency mode, and an `/audit/anomalies` over the existing audit tables.
5. **Phase 2 backlog:** clickstream capture, token capture, forecasting, recommender, content-safety, experimentation — scope separately.

**Nothing above is applied yet.** On your go-ahead I can wire the Tier 1–3 snippets into `_ensure_postgres_schema()` in `backend/db_migrations.py` and add the matching ORM models, or start with just Tier 1.
