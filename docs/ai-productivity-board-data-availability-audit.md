# AI Productivity Board — Data Availability Audit

**Question bank audited:** `docs/ai-productivity-board-question-bank.md` (10 categories, 32 subcategories, 320 questions)
**Audited against:** live ORM (`backend/models_new.py`, `backend/providers/chatgpt/models.py`) and the existing analytics layer (`backend/routers/reports_router.py`, 23 endpoints).
**Date:** 2026-07-17

---

## 1. Executive summary

The 320 questions are **not 320 distinct queries**. They are **32 subcategories × 10 repeated question archetypes** (baseline → trend → lead/lag → cohort → funnel → drivers → correlation → outliers → forecast → intervention). Answerability is therefore driven by two things only:

1. **The grouping dimension** the question needs (user, department, tool, model, date — vs. team, manager, geography).
2. **The question archetype** (a simple count/trend is cheap; a forecast, driver-importance, or A/B intervention is not).

Headline verdict:

| Tier | Meaning | Share of 320 | Notes |
| --- | --- | --- | --- |
| 🟢 **Answerable today** | Data exists; often already built | **~35%** | Baseline, trend, lead/lag, cohort, outlier archetypes where the dimension is user/department/tool/model/date. |
| 🟡 **Answerable with derivation or config** | Data exists but needs a computed field, a cost constant, or event-sequence logging | **~30%** | Cost/ROI, completion-time, success/failure taxonomy, funnels, rework. |
| 🔴 **Blocked — needs new data source or ML** | Requires org hierarchy (HRIS), forecasting, experimentation, or NLP | **~35%** | team/manager/geography splits, all forecast rows, all intervention rows, prompt classification/similarity, anomaly detection. |

**Most important finding:** the single biggest unlock is not more analytics code — it is **three missing data sources**: (a) an org hierarchy (team / manager / role / location), (b) a **credit→currency cost constant**, and (c) a **structured capture-failure reason**. These three gaps alone are what push a large fraction of otherwise-easy questions into 🟡/🔴.

---

## 2. Data inventory — what actually exists

### Core generation telemetry
| Field group | Table.column | Present? |
| --- | --- | --- |
| User + email | `users.id`, `users.email`, `users.name`, `users.employee_id` | 🟢 |
| Department | `users.department` | 🟢 *(nullable — verify population rate)* |
| Role | `users.position`, `user_roles.role` | 🟡 free-text/role-list, not a clean taxonomy |
| Account age / cohort | `users.created_at`, `users.last_login` | 🟢 |
| Session / login | `user_activities.login_time/logout_time/total_session_duration/active_time/idle_time` | 🟢 |
| Date & time | `generation_records.created_at`, `it_portal_tool_usage_events.event_date` | 🟢 |
| Credit burn | `generation_records.credits_burned`, `it_portal_tool_usage_events.credits_before/after/burned/expected` | 🟢 |
| Prompt | `generation_records.prompt_text`, `conversation_prompts.prompt_text/prompt_length` | 🟢 |
| Generated video/asset | `generation_records.canonical_asset_url`, `conversation_generated_assets` | 🟢 |
| Task/generation ID | `generation_records.provider_task_id/provider_generation_id` | 🟢 |
| Capture status | `generation_records.capture_status` (`active`/`completed`/…) | 🟡 coarse — no failure taxonomy |
| Model / duration / resolution | `generation_records.model_label/duration_label/resolution_label` | 🟢 |
| Project | `generation_records.project_id` → `generation_projects` | 🟢 |
| Ingestion / recovery | `ingestion_source`, `recovery_audit_id`, `generation_recovery_audits.*` | 🟢 |
| Tool identity | `it_portal_tools.name/slug/category` | 🟢 |
| Task workflow timing | `tasks.created_at/started_at/completed_at/status`, `task_status_history`, `task_stages.*_at` | 🟢 |

### Data that does **not** exist anywhere
| Missing field (referenced by the question bank) | Impact |
| --- | --- |
| `team`, `manager_name` | Blocks every "team / manager portfolio" split (COO, HR, Spend-to-Value). |
| `location` / geography | Blocks every "geography" split (CEO). |
| `token_usage` | Kling has no tokens; ChatGPT capture stores lengths, not token counts. Blocks token-efficiency questions. |
| `cost_per_task`, `roi_value`, credit→₹ rate | No cost constant stored. Blocks all cost/ROI/spend-to-value $ figures. |
| `rework_count` | Not tracked (partially derivable from `result_version` / stage revisions). |
| `feature_name`, `prompt_pattern` | No feature-level events; no prompt classification. |
| Structured `missing_reason` (timeout / missing asset / API error / task missing / network error) | `capture_status` is a single coarse enum. Blocks capture-diagnostics pie charts. |
| `event_sequence` / `step_name` clickstream | No page/step clickstream. Blocks all **funnel/journey** archetype rows. |
| `release_calendar`, `campaign_calendar`, `holiday_flag` | Blocks forecast archetype context. |
| `intervention_type`, `pre/post_metric`, `pilot_group`, `control_group` | No experimentation framework. Blocks all **intervention** archetype rows. |

---

## 3. Availability by question archetype (applies across all 32 subcategories)

Each subcategory (`XXX-01`…`-10`) repeats these 10 shapes. This table is the fastest way to read all 320 at once:

| # | Archetype (the `-01…-10` pattern) | Verdict | Why |
| --- | --- | --- | --- |
| 01 | **Baseline level** across dimension | 🟢 / 🔴 by dim | 🟢 for user/dept/tool/model; 🔴 if split is team/manager/geo |
| 02 | **Multi-grain trend** (hour→quarter) | 🟢 | timestamps exist; hourly/daily/weekly/monthly all derivable |
| 03 | **Lead vs lag** across dimension | 🟢 / 🔴 by dim | same dimension caveat as 01 |
| 04 | **Cohort** (new/returning/inactive/power) | 🟢 | derivable from `created_at`/`last_login`; power-user endpoint already exists |
| 05 | **Funnel / journey** drop-off | 🔴 | no step-level clickstream (`event_sequence`, `step_name`) |
| 06 | **Drivers** (importance) | 🟡 | needs a driver-importance / feature-importance model, not just SQL |
| 07 | **Correlation** with a business outcome | 🟡 | computable (Pearson/regression) but needs a stats pass + the outcome metric defined |
| 08 | **Outliers** after normalizing for size | 🟡 | needs team_size/workload normalizer; 🟢 if normalized by user count only |
| 09 | **30/60/90-day forecast** | 🔴 | no forecasting model or calendar features |
| 10 | **Best intervention** (train/product/policy…) | 🔴 | no experimentation / pre-post framework |

**Rule of thumb:** within any subcategory, archetypes **02 and 04 are always 🟢**, **01/03/08 are 🟢 unless the split dimension is team/manager/geography**, **06/07 are 🟡**, and **05/09/10 are 🔴**. That single rule classifies ~90% of the 320.

---

## 4. Category-by-category verdict

| Category | Subcats | Answerable today (🟢) | Main blocker |
| --- | --- | --- | --- |
| **CEO Executive** | 4 | Platform growth, AI adoption, transformation baselines/trends/cohorts | geography split, ROI $ figures, forecasts |
| **COO Operational** | 4 | Throughput, bottlenecks, tool effectiveness, capacity — **task tables support these well** | team/manager splits, SLA target field, forecasts |
| **HR Analytics** | 3–4 | Employee adoption/proficiency, engagement | manager hierarchy, burnout signals need session-depth thresholds |
| **Product Analytics** | 3 | Feature adoption is 🔴 (no feature events); navigation is 🔴 (no clickstream) | **feature-level + clickstream events missing** |
| **AI Usage Intelligence** | 3 | Tool mix, model mix, credit/token efficiency — **credit side 🟢, token side 🔴** | token counts, infra cost |
| **User Behavior** | 3 | Acquisition/onboarding partial, engagement depth 🟢, retention/churn 🟢 (endpoint exists) | onboarding funnel needs step events |
| **Security & Compliance** | 2 | Access anomalies partial (audit tables exist), policy adherence 🔴 | no content-safety / policy classification |
| **Cost Optimization** | 2 | Credit-based spend 🟢; $ optimization 🟡 | **credit→₹ constant**, no per-team cost |
| **Future Prediction** | 3 | Almost entirely 🔴 | forecasting + risk models |
| **AI Recommendation** | 3 | Next-best-tool 🟡, personalized nudges 🔴, golden-prompt 🟢 (endpoint exists) | recommendation/ML engine |

---

## 5. What is already built (do not rebuild)

`backend/routers/reports_router.py` already ships these — they cover a large slice of the 🟢 questions:

`/executive`, `/kling/summary|trends|users`, `/chatgpt/summary|trends|users`, `/cost/summary|breakdown`, `/users/summary|activity-trends|retention|power-users`, `/prompts/summary|trends|golden|engineers`, `/tasks/summary|trends|bottlenecks|ai-impact`, `/recommendations`, `/filters`.

Notable existing logic: success is defined as `capture_status IN ('active','completed')` (`SUCCESS_STATUSES`); video vs image is inferred from presence of `duration_label`; department filtering joins `User.department`.

---

## 6. Remediation roadmap (ordered by unlock-per-effort)

**Tier 1 — Config only (unlocks all cost/ROI dollar figures):**
- Add a `credit_cost` setting (1 credit = ₹X) + tool-level rate table. Turns every 🟡 cost/ROI/spend question into 🟢.

**Tier 2 — Derivation on existing data (no new capture):**
- Structured **capture-failure reason**: promote the coarse `capture_status` into `{success, timeout, missing_asset, api_error, task_missing, network_error}` (backfill from `metadata_json` where possible). Unlocks the whole "Success/Failure/Recovery Diagnostics" and "Capture Pipeline Health" set.
- Precompute **completion_time / step_duration** from `tasks.started_at/completed_at` and `task_stages.*_at`. Unlocks COO cycle-time questions.
- Derive **rework** from `result_version` / stage revision counts.

**Tier 3 — New data source (org context):**
- Add **team / manager / role / location** to `users` (or a `department_directory`-style org table). This is the highest-leverage 🔴→🟢 move: it unblocks the "team", "manager portfolio", and "geography" split on ~1 in 4 questions.

**Tier 4 — New capture (clickstream & tokens):**
- Emit **step/event-sequence** events (page, tool-launch, generation, review) to unlock every **funnel/journey (archetype 05)** row.
- Capture **token usage** for ChatGPT to unlock token-efficiency questions.

**Tier 5 — Modeling / ML (longest lead time):**
- Forecasting (archetype 09), risk/churn prediction, driver-importance (06) and correlation (07) engines, prompt embeddings for classification/similarity/golden-prompt clustering, anomaly detection, recommendation engine.

---

## 7. Bottom line

- **~35% of the 320 questions are answerable today**, and a good portion already have endpoints.
- **~30% more** unlock with **three cheap moves**: a cost constant (Tier 1), a failure-reason enum (Tier 2), and an org hierarchy (Tier 3) — none of which require ML.
- **The remaining ~35%** (forecasts, interventions, funnels, prompt NLP, anomaly detection) are a genuine **Phase 2 / AI** effort and should be scoped separately, not promised on the first dashboard.
