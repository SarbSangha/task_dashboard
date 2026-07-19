# Reports Module — Analytics Mapping: User Intelligence

**Scope:** Design spec for the User Intelligence slice — *User Activity, Retention,
Power Users, AI Maturity Score.* Every card traces
**Business Question → Data Source → API → Metric Formula → Visualization → Business Decision.**

**Architecture:** identical to shipped slices — faculty-gated `/api/reports/*`
aggregation endpoints reading existing models, rendered via the shared Reports
primitives + theme-aware Recharts. No mock data.

---

## Data availability & honesty constraints (read first)

| Signal | Captured? | Source | Treatment |
|---|---|---|---|
| Daily per-user presence (login, session seconds, active/idle, heartbeats, status) | ✅ Yes | `user_activities` (date, login_time, total_session_duration, active_time, status, heartbeat_count) | **Real** — powers DAU/WAU/MAU, session trends, retention cohorts |
| Signup date | ✅ Yes | `users.created_at` | Real — retention cohort anchor |
| Generation output per user | ✅ Yes | `generation_records` (count, provider, credits, capture_status) | Real — power-user & maturity inputs |
| ChatGPT usage per user | ✅ Yes | `conversation_records` (count) | Real — tool-diversity input |
| **Prompt quality score** | ❌ No | — | **Excluded** from AI Maturity — no scoring model exists. Replaced by *output success rate* (real). |
| **Task-completion improvement** | ❌ No baseline | — | **Excluded** — needs a pre-AI productivity baseline. |
| Dollar productivity value | ❌ No | — | Not used |

> **A user is "active on a day"** = a `user_activities` row exists for that date with `login_time IS NOT NULL OR heartbeat_count > 0`. This avoids counting empty auto-created rows.

---

## New API endpoints (to build)

| Endpoint | Purpose |
|---|---|
| `GET /api/reports/users/summary` | DAU/WAU/MAU, active users, avg session, retention headline + Δ vs prior period |
| `GET /api/reports/users/activity-trends` | Daily active users, daily avg session minutes, active users by department, status mix |
| `GET /api/reports/users/retention` | Weekly cohort retention heatmap + D1/D7/D30 windows + churn-risk count |
| `GET /api/reports/users/power-users` | Ranked users with generations, credits, active-days, tool diversity, success rate, **AI Maturity Score + level** |

Params: `?start=&end=&department=` (retention also takes `?weeks=`).

---

## 1. User Activity
| # | Business Question | Data Source | API | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| UA-01 | How many employees actively use the platform? | `user_activities` distinct `user_id` (active) | `users/summary` | **Active Users** = distinct users active in range; Δ% vs prior equal window | KPI + sparkline | Set adoption targets |
| UA-02 | What are DAU / WAU / MAU? | `user_activities.date` | `users/summary` | DAU = distinct active users today · WAU = trailing 7d · MAU = trailing 30d | 3 KPI cards | Track engagement cadence |
| UA-03 | Is daily engagement trending up? | `user_activities.date` daily | `users/activity-trends.daily` | Count distinct active users per day | Area chart | Confirm momentum / intervene |
| UA-04 | How long are work sessions, and is depth changing? | `total_session_duration`, `active_time` | `users/summary` + `activity-trends` | Avg session min = `avg(total_session_duration)/60`; daily trend | KPI + line | Investigate shrinking sessions |
| UA-05 | Which departments are most/least active? | `user_activities` × `users.department` | `activity-trends.byDepartment` | Distinct active users per department | Horizontal bar | Target enablement to laggards |
| UA-06 | What is the live engagement mix right now? | `user_activities.status` | `activity-trends.statusMix` | Count by ACTIVE/IDLE/AWAY/OFFLINE | Donut | Operational awareness |

## 2. Retention
| # | Business Question | Data Source | API | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| RE-01 | Do users keep using AI after first adoption? | `users.created_at` (cohort) + `user_activities` | `users/retention` | Cohort = signup week. `retention[cohort][w]` = users active in week-window *w* ÷ cohort size | **Cohort heatmap** | Fix the week retention collapses |
| RE-02 | What is D1 / D7 / D30 retention? | same | `users/retention.windows` | D_n = % of cohort users active within *n* days after signup day (excluding day 0) | 3 KPI cards | Prioritise onboarding vs long-term |
| RE-03 | Who is at risk of churning? | `user_activities` recency | `users/retention.churnRisk` | Users active before but **no active day in last 14d** | KPI + count | Trigger re-engagement |
| RE-04 | Which signup cohorts retain best? | cohort × window | `users/retention` | Compare cohort rows | Heatmap rows | Replicate best cohort's onboarding |

## 3. Power Users
| # | Business Question | Data Source | API | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| PU-01 | Who are our AI power users / champions? | `generation_records` + `user_activities` + `conversation_records` | `users/power-users` | Ranked by **AI Maturity Score** (below); champion badge if score ≥ 75 | Leaderboard → drill | Recruit internal champions |
| PU-02 | Who generates the most AI content? | `generation_records` per owner | `users/power-users` | `count(generation_records)` per user | Sortable table col | Recognition / mentoring |
| PU-03 | Who are the most consistent daily users? | `user_activities` active-day count | `users/power-users` | Active days in range | Table col | Identify habit exemplars |
| PU-04 | How concentrated is output among the top few? | generation counts | `users/power-users` | Top-N share of total generations | Insight banner | De-risk single-user dependence |

## 4. AI Maturity Score  *(the unique signal — 0–100, all inputs real)*

**Formula** (weighted 0–100 sub-scores):

| Component | Weight | Formula (real data) | Rationale |
|---|---|---|---|
| **Usage Frequency** | 25% | `active_days ÷ period_days × 100` | How habitually they use AI |
| **Output Volume** | 20% | `min(100, generations^0.6 × 8)` (log-shaped) | Productive output, diminishing returns |
| **Tool Diversity** | 15% | distinct AI tools used → 1→25, 2→55, 3→80, 4+→100 (providers in `generation_records` + ChatGPT) | Breadth of AI fluency |
| **Output Success** | 20% | `successful ÷ total generations × 100` (`capture_status ∈ {active,completed}`) | Quality proxy (replaces unmeasured "prompt quality") |
| **Consistency** | 20% | `weeks_with_activity ÷ total_weeks × 100` | Sustained, regular usage |

`AI Maturity Score = 0.25·Frequency + 0.20·Volume + 0.15·Diversity + 0.20·Success + 0.20·Consistency`

**Levels:** 0–25 **Beginner** · 25–50 **Explorer** · 50–75 **Practitioner** · 75–100 **AI Champion**

| # | Business Question | Data Source | API | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| AM-01 | What is the workforce AI-maturity distribution? | power-users scores | `users/power-users` | Count of users per level band | Level distribution bars/donut | Size the enablement gap |
| AM-02 | Who are AI Champion candidates? | score ≥ 75 | `users/power-users` | Filter champions | Champion cards | Formalise a champions program |
| AM-03 | What holds a user back from the next level? | component sub-scores | `users/power-users` (per-user components) | Weakest component | Radar / bar per user (drill) | Targeted coaching |

> **Excluded by design (documented):** "Prompt Quality" and "Task-Completion Improvement" from the requested formula are **not** included — no prompt-scoring model and no productivity baseline exist. Substituted with *Output Success* (real) and *Consistency* (real). The score is fully transparent and reproducible from stored data.

---

## UI composition
- **User Activity** (`user-activity`): 5 KPIs (Active, DAU, WAU, MAU, Avg Session) → daily-active area + avg-session line + by-department bar + status donut.
- **Retention** (`user-retention`): D1/D7/D30 KPIs + churn-risk KPI → **cohort heatmap** (CSS grid, token-colored).
- **Power Users** (`power-users`): concentration insight → leaderboard (score, level badge, generations, credits, active days) with drill-down to the user profile.
- **AI Maturity** (`ai-maturity`): level-distribution chart + champion candidate list + per-user component breakdown.

_Analytics & BI Office — Reports module, slice 3._
