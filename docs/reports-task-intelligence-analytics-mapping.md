# Reports Module — Analytics Mapping: Task Intelligence

**Scope:** Design spec for the Task Intelligence slice — *Productivity, Completion,
AI Impact, Bottlenecks.* Every card traces
**Business Question → Data Source → Available Fields → Metric Formula → Visualization → Business Decision.**

**Why this slice matters:** it adds the missing **business-outcome** layer so leadership
can ask "is AI actually improving work?" — and it is deliberately honest about how far
the data lets us answer that today.

**Architecture:** identical to shipped slices — faculty-gated `/api/reports/*`
aggregations over existing models, rendered through the shared Reports primitives. No mock data.

---

## Data availability & the attribution gap (read first — this shapes the whole slice)

| Signal | Captured? | Source | Treatment |
|---|---|---|---|
| Task lifecycle (created, started, submitted, completed) | ✅ Yes | `tasks.created_at/started_at/submitted_at/completed_at` | Real — cycle & execution time |
| Task status & outcome | ✅ Yes | `tasks.status` (`COMPLETED`; `REJECTED`/`CANCELLED` = failed) | Real |
| Deadline / on-time | ✅ Yes | `tasks.deadline` vs `completed_at` | Real |
| Planned vs actual effort | ✅ Yes | `tasks.estimated_hours`, `tasks.actual_hours` | Real — estimation accuracy |
| Department / priority / type | ✅ Yes | `tasks.to_department`, `.from_department`, `.priority`, `.task_type` | Real |
| Stage/status dwell time | ✅ Yes | `task_status_history.status_from/status_to/timestamp` | Real — bottleneck analysis |
| **Task ↔ AI tool / prompt / generation link** | ❌ **NO** | — | **No foreign key exists.** `generation_records` and `conversation_records` carry no `task_id`. |
| **Per-task "AI-assisted" attribution** | ❌ No | — | **Not possible** — cannot claim a given task used Kling/prompt X. |
| **Time-saved per task / before-after** | ❌ No baseline | — | **Not measurable** — no per-task AI link and no pre-AI baseline. |

### How we answer "is AI improving work?" honestly

Because there is no task↔AI join, we do **not** fabricate an "AI-assisted task %" or a
per-task "time saved". Instead we measure a **user-level cohort correlation**:

> Split users into **AI-active** (≥1 generation or ChatGPT conversation in the period) vs
> **non-AI**, then compare their task throughput and completion time. This is a
> **correlation, not causation**, and is labelled as such on every card.

**Roadmap to true attribution (documented, not built):** add a `task_id`/`generation_id`
bridge at capture time, or link `generation_projects` ↔ `tasks.project_id`. Until then,
cohort correlation is the honest ceiling.

---

## New API endpoints (to build)

| Endpoint | Purpose |
|---|---|
| `GET /api/reports/tasks/summary` | Created, completed, completion rate, avg cycle time, on-time rate + Δ + daily series |
| `GET /api/reports/tasks/trends` | Created-vs-completed daily, by department, by priority, status distribution, by type |
| `GET /api/reports/tasks/bottlenecks` | Aging backlog, avg dwell by status, overdue, slowest types, rejection/rework rate |
| `GET /api/reports/tasks/ai-impact` | **Cohort correlation** — AI-active vs non-AI users: throughput, cycle time; department scatter |

Params: `?start=&end=&department=`.

---

## 1. Productivity Analysis
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| TP-01 | How much work is getting done? | `tasks` | `created_at`, `status`, `completed_at` | completed in period; per active user | KPI + sparkline | Set throughput targets |
| TP-02 | How fast do tasks complete? | `tasks` | `created_at`, `completed_at` | avg `(completed_at − created_at)` hours | KPI + trend | SLA & staffing |
| TP-03 | Which departments are most productive? | `tasks` | `to_department`, `status` | completed per department | Horizontal bar | Rebalance / recognise |
| TP-04 | Are estimates accurate? | `tasks` | `estimated_hours`, `actual_hours` | `actual ÷ estimated` (where both present) | KPI + scatter | Improve planning |
| TP-05 | Who completes the most tasks? | `tasks` | `creator_id`, `status` | completed per user (top N) | Table | Coaching / load-levelling |

## 2. Completion Analysis
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| TC-01 | What is our completion rate? | `tasks` | `status`, `created_at` | `completed ÷ created × 100` | KPI + trend | Address backlog growth |
| TC-02 | Created vs completed over time? | `tasks` | `created_at`, `completed_at` | daily created & completed | Dual-line | Capacity vs demand |
| TC-03 | Where do tasks sit (status funnel)? | `tasks` | `status` | count by status | Funnel / bar | Spot stuck states |
| TC-04 | Are we on time? | `tasks` | `deadline`, `completed_at` | `on-time ÷ completed-with-deadline × 100` | KPI + bar | Renegotiate commitments |
| TC-05 | Which tasks fail/get rejected? | `tasks` | `status` (`REJECTED`,`CANCELLED`) | rejection rate; by type | Bar | Fix top failure source |
| TC-06 | How does completion vary by priority? | `tasks` | `priority`, `status` | completion % by priority | Grouped bar | Fix triage if high-pri lags |

## 3. AI Impact  *(user-level correlation — labelled, not causal)*
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| AI-01 | Do AI-active users complete more tasks? | `tasks` + `generation_records` + `conversation_records` | task `creator_id`,`status`; AI ownership in period | cohort avg completed/user: AI-active vs non-AI; Δ% | Two-cohort bars + delta | Justify/scale AI enablement |
| AI-02 | Do AI-active users complete tasks faster? | same | `created_at`,`completed_at` | cohort avg cycle-time hours; Δ% | Two-cohort bars | Evidence for rollout |
| AI-03 | Does department AI-adoption track productivity? | `tasks` + AI ownership + `users` | dept AI-active share; completed/user | scatter: adoption% vs throughput | Scatter | Target low-adoption depts |
| AI-04 | What is the honest headline? | derived | cohort deltas | "AI-active users complete N% more / M% faster (correlation)" | Insight banner | Frame the AI value story |

> **Explicitly excluded (documented):** "AI-assisted task %", per-task "time saved", and a composite "AI Impact Score" mixing unmeasured factors. These require a task↔AI link that does not exist. We ship the **defensible correlation** instead and state the caveat on-screen.

## 4. Bottlenecks
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| TB-01 | Where is work piling up (aging backlog)? | `tasks` | open `status`, `created_at` | open tasks by age bucket (0-1d,1-3d,3-7d,7-14d,14d+) | Aging bar | Clear oldest first |
| TB-02 | Which stage holds tasks longest? | `task_status_history` | `status_from/to`, `timestamp` | avg dwell between consecutive transitions, by status | Bar (dwell by status) | Re-resource slow stage |
| TB-03 | How many tasks are overdue? | `tasks` | `deadline`, `status` | open tasks past `deadline` | KPI + list | Escalate overdue |
| TB-04 | Which task types are slowest? | `tasks` | `task_type`, cycle time | avg cycle time by type | Bar | Streamline slow types |
| TB-05 | What is the rework/rejection rate? | `tasks` | `status` `NEED_IMPROVEMENT`,`REJECTED` | rework ÷ total | KPI | Improve first-pass quality |

---

## UI composition
- **Productivity** (`productivity`): 5 KPIs (Completed, Completion Rate, Avg Cycle Time, On-time %, Est. Accuracy) → completed trend + by-department bar + top-performers table.
- **Completion Analysis** (`completion`): created-vs-completed dual line + status funnel + by-priority + on-time + rejection.
- **AI Impact** (`task-ai-impact`): cohort comparison bars (throughput, cycle time) + department adoption-vs-productivity scatter, with a prominent correlation caveat.
- **Bottlenecks** (`bottlenecks`): aging backlog + dwell-by-status + overdue KPI + slowest-types bar.

_Analytics & BI Office — Reports module, slice 5._
