# Enterprise AI Analytics — Business Question Library

**Author:** Senior Data Analyst (BI) · **Scope:** Whole platform, not one tool.
**Supersedes:** `kling-analytics-question-library.md` (Kling-only). This library reframes analytics as **business questions that happen to use the platform's data** — Kling, ChatGPT, tasks, logins, sessions, credits, cost, prompts, departments, models and audit trails.
**Purpose:** A domain- and persona-organised question library + data-readiness roadmap, structured so the Report Builder surfaces only the relevant subset per category and data-availability.

## Persona map (who asks)

| Code | Persona | What they optimise for |
|------|---------|------------------------|
| **Exec** | CEO / CxO / Board | ROI, adoption, total cost, business impact |
| **Fin** | Finance | Spend, budget, forecast, cost per unit |
| **Mgr** | Department / Team Manager | Team output, waste, training needs, idle resources |
| **Ops** | Operations | Peaks, failures, latency, capture health, SLAs |
| **AI** | AI / Prompt Engineering | Prompt/model performance, quality, mix |
| **Sec** | Security / Governance | Access, abuse, policy, credential risk |
| **User** | Enablement / HR | Adoption, retention, maturity, champions |

## Legend

**Priority** — `E` Executive · `H` High · `M` Medium · `L` Low.
**Readiness** (grounded in the *actual* captured data):
- **✅ Available now** — answerable today from captured fields.
- **🟡 Needs capture** — partial or degenerate today (e.g. Kling under one shared login, all-`active` status, sparse labels, AI cost not attributed to employee/department).
- **🔴 Future** — needs new instrumentation (latency, retries, asset lifecycle, storage, token billing) or a model (forecast, anomaly, quality/similarity).

**What is genuinely captured today:** `user_activities` (48 users — real logins, sessions, idle/active, heartbeats), `tasks`/`task_stages`/`task_status_history` (workflow + timing), `conversation_records`/`prompts`/`responses` (ChatGPT), `it_portal_tool_usage_events` + `generation_records` (Kling — per **account**, prompts, model labels, credits), `tool_credit_rates` (₹), `it_portal_tool_audit`/`task_edit_logs` (audit). **Key limits:** Kling activity is under shared logins in one `ADMIN` department (per-employee/department AI cost = 🟡); Kling status is uniformly `active` (real failure/latency/retry = 🔴).

---

# LEVEL 1 — EXECUTIVE

## 1. Executive Overview
*Primary persona: Exec. Cross-tool: adoption, ROI, total cost, business impact.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| EXEC-001 | How many employees actively use AI, and is it growing? | Headline signal the investment is taking root. | Active users + MoM growth % | Set rollout & enablement pace. | KPI + trend | E | ✅ |
| EXEC-002 | What is total AI spend across all tools, and is it controlled? | Board accountability for consumption. | Total ₹ (Kling credits × rate) + trend | Set consumption guardrails. | KPI + area | E | 🟡 |
| EXEC-003 | Which AI platform gives the best ROI (Kling vs ChatGPT)? | Directs future investment. | Output/value per ₹ by tool | Rebalance tool investment. | Comparison bars | E | 🟡 |
| EXEC-004 | Is AI adoption accelerating or plateauing? | Durable transformation vs early spike. | Adoption growth rate | Reallocate change-mgmt budget. | Trend + slope | E | ✅ |
| EXEC-005 | Are AI investments increasing productivity? | Core justification for spend. | Output/tasks per active user vs baseline | Continue/adjust investment. | Dual-axis trend | E | 🟡 |
| EXEC-006 | Which departments benefit most and least from AI? | Reveals where transformation is real. | Value contribution by dept | Target training & reinvestment. | Ranked bar | E | 🟡 |
| EXEC-007 | Are we overspending relative to output? | Prevents runaway consumption eroding ROI. | Cost growth vs output growth | Trigger guardrails. | Dual-axis trend | E | 🟡 |
| EXEC-008 | What is cost per active user across the platform? | Normalised efficiency of spend. | Total ₹ ÷ active users | Benchmark & budget. | KPI + trend | E | 🟡 |
| EXEC-009 | Are employees actually using AI, or is it shelfware? | Adoption depth vs licence waste. | Active ÷ provisioned users | Reclaim or re-enable seats. | Gauge | E | ✅ |
| EXEC-010 | What is the platform-wide success/reliability rate? | Reliability underpins trust & ROI. | Cross-tool success % | Escalate reliability program. | Gauge | E | 🟡 |
| EXEC-011 | How much spend is wasted (failed/unused output)? | Fastest recoverable cost. | Wasted ₹ + % | Fund reliability/cleanup. | Stacked bar | E | 🟡 |
| EXEC-012 | What is our AI cost run-rate and annual projection? | Budget certainty. | Monthly run-rate → annual | Set annual AI budget. | Projection line | E | ✅ |
| EXEC-013 | Is usage concentrated in a few people/accounts (key-person risk)? | Resilience of the capability. | Top-N share of usage & ₹ | De-risk concentration. | Pareto | E | ✅ |
| EXEC-014 | What is the 90-day outlook for adoption, usage and cost? | Plan ahead of the curve. | Forecasts + confidence | Pre-approve budget/capacity. | Forecast lines | E | 🔴 |
| EXEC-015 | How does this quarter compare to last on all headline KPIs? | Momentum at a glance. | QoQ deltas on core KPIs | Board narrative & targets. | Scorecard | E | ✅ |
| EXEC-016 | What is the measurable business impact of AI to date? | The ultimate accountability question. | Tasks/output uplift for AI-active cohort | Justify next investment. | Cohort comparison | E | 🟡 |
| EXEC-017 | Which tool is growing fastest and should get more investment? | Directs capability bets. | Growth % by tool | Fund the winner. | Small multiples | E | ✅ |
| EXEC-018 | Are we getting more output per rupee over time? | Efficiency, not vanity volume. | Output ÷ ₹ over time | Confirm efficient scaling. | Trend | E | 🟡 |
| EXEC-019 | What share of the org has adopted AI at all? | Penetration ceiling. | Adopters ÷ headcount | Set penetration target. | Gauge | E | ✅ |
| EXEC-020 | Where is the single biggest opportunity to improve ROI? | Focus executive attention. | Ranked opportunity by ₹ impact | Fund the top lever. | Impact/effort matrix | E | 🟡 |
| EXEC-021 | What is our credit runway before the next purchase? | Avoid capability stoppage. | Remaining credits ÷ burn rate | Time credit purchase. | Burn-down | E | 🟡 |
| EXEC-022 | Are there any red-flag anomalies this period? | Surface risk early to leadership. | Anomaly count + severity | Direct investigation. | Alert scorecard | E | 🟡 |
| EXEC-023 | How does AI usage correlate with delivered work? | Links AI to real business outcomes. | Usage vs task throughput | Validate value story. | Scatter + regression | E | 🟡 |
| EXEC-024 | What is our overall AI maturity trajectory? | Strategic transformation view. | Composite maturity index over time | Set transformation roadmap. | Index trend | E | 🟡 |

# LEVEL 2 — FINANCE

## 2. Finance & Cost Analytics
*Primary persona: Fin. Spend, budget, forecast, unit economics.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| FIN-001 | What is total monthly AI spend (₹)? | Core finance number. | Monthly ₹ | Track vs budget. | KPI + trend | E | 🟡 |
| FIN-002 | What is the credit burn rate across all accounts? | Consumption pace. | Credits/day | Time top-ups. | Burn-down | H | ✅ |
| FIN-003 | What is cost per successful generation (₹)? | Unit economics. | ₹ ÷ successful gen | Scale/optimise. | KPI + benchmark | H | 🟡 |
| FIN-004 | What is cost per department? | Departmental accountability. | ₹ by department | Chargeback / budgets. | Ranked bar | H | 🟡 |
| FIN-005 | What is cost per employee? | Normalised spend per head. | ₹ ÷ headcount by dept | Fair budgeting. | Bar | H | 🟡 |
| FIN-006 | What is cost per project? | Project-level cost control. | ₹ by project | Project budgeting. | Bar | M | 🟡 |
| FIN-007 | How does ₹/credit differ across accounts (package pricing)? | Buy future credits cheapest. | rate_per_credit by account | Optimise purchasing. | Bar | H | ✅ |
| FIN-008 | What is the cost trend and is it accelerating? | Runaway-spend warning. | ₹ over time + slope | Trigger guardrails. | Trend + slope | E | 🟡 |
| FIN-009 | How much ₹ is wasted on failed/unused output? | Recoverable cost. | Wasted ₹ + % | Fund fixes. | Stacked bar | H | 🟡 |
| FIN-010 | What is projected spend next month/quarter? | Budget planning. | Forecast ₹ + band | Set budget. | Forecast line | E | 🔴 |
| FIN-011 | Which accounts/users drive most spend? | Cost concentration. | ₹ by account | Caps / review. | Pareto | H | ✅ |
| FIN-012 | Which model/mode is most cost-efficient? | Value-based routing. | ₹/output by model | Prefer best-value model. | Sorted bar | M | 🟡 |
| FIN-013 | What is credit consumption by tool (Kling vs ChatGPT)? | Tool-level cost split. | Credits/₹ by tool | Rebalance spend. | Donut | H | 🟡 |
| FIN-014 | Are we buying credits efficiently vs consuming them? | Purchasing cadence. | Purchased vs burned balance | Adjust buying. | Balance line | H | 🟡 |
| FIN-015 | What is our effective ₹ per active user by tool? | Efficiency benchmark. | ₹ ÷ active users by tool | Tool investment. | Bar | M | 🟡 |
| FIN-016 | What would a price/rate change do to total cost? | Scenario planning. | Cost sensitivity to rate | Negotiate/renew. | Tornado / what-if | M | ✅ |
| FIN-017 | What is month-to-date spend vs budget pace? | Live budget guardrail. | MTD ₹ vs pace | Throttle/approve. | Pace gauge | H | 🟡 |
| FIN-018 | What is the cost of idle/provisioned-but-unused accounts? | Reclaim waste. | ₹ tied to idle accounts | Deprovision. | KPI | M | ✅ |
| FIN-019 | What is the highest single-generation cost outlier? | Outlier control. | Top-N ₹/gen | Review costly items. | Ranked table | M | 🟡 |
| FIN-020 | What is the cost-per-output trend (unit economics over time)? | Scaling decision. | ₹/output trend | Scale or optimise. | Trend | H | 🟡 |
| FIN-021 | What credit buffer avoids stockout at target service level? | Safety-stock policy. | Recommended buffer | Set reorder point. | KPI + policy | M | 🟡 |
| FIN-022 | What is the forecast annual AI budget need? | Annual planning. | Annualised forecast | Approve budget. | Forecast | E | 🔴 |
| FIN-023 | Which department is over/under its AI budget? | Budget governance. | Actual vs allocated by dept | Rebalance budgets. | Variance bars | H | 🟡 |
| FIN-024 | What share of spend produces measurable output? | Value-for-money. | Productive ₹ ÷ total ₹ | Cut low-value spend. | Stacked bar | H | 🟡 |
| FIN-025 | How volatile is our AI spend month to month? | Predictability of cost. | Spend variance/σ | Smooth purchasing. | Trend + band | L | ✅ |
| FIN-026 | What is cost per session / per working hour? | Operational cost intensity. | ₹ ÷ active period | Capacity budgeting. | KPI | L | 🟡 |
| FIN-027 | What is the ROI of the most expensive account/user? | Justify heavy spenders. | Output/value ÷ ₹ for top spenders | Coach or cap. | Table | M | 🟡 |
| FIN-028 | What is the token/message cost of ChatGPT usage? | Conversational-AI cost. | Tokens × price (needs billing) | Size ChatGPT spend. | Bar | M | 🔴 |

# LEVEL 3 — DEPARTMENT / MANAGER

## 3. Department Analytics
*Primary persona: Mgr, Exec. Team output, waste, efficiency, adoption gaps.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| DEPT-001 | Which departments consume the most AI budget while producing the least output? | The core management efficiency question. | ₹ vs output by dept | Intervene on low-value teams. | Quadrant (cost×output) | E | 🟡 |
| DEPT-002 | Which team generates the most content/output? | Where work concentrates. | Output by dept | Allocate resources. | Ranked bar | H | 🟡 |
| DEPT-003 | Which team wastes the most credits/₹? | Waste accountability. | Wasted ₹ by dept | Coach worst teams. | Bar | H | 🟡 |
| DEPT-004 | Which department is most AI-efficient (output per ₹)? | Benchmark teams fairly. | Output ÷ ₹ by dept | Spread best practice. | Sorted bar | H | 🟡 |
| DEPT-005 | Which departments are underutilising AI? | Enablement gaps. | Adoption vs headcount by dept | Targeted enablement. | Gap chart | H | ✅ |
| DEPT-006 | How is each department's AI usage trending? | Rising/declining teams. | Usage over time by dept | Rebalance capacity. | Multi-line | M | 🟡 |
| DEPT-007 | Which department completes the most tasks? | Delivery throughput. | Completed tasks by dept | Set throughput targets. | Bar | H | ✅ |
| DEPT-008 | Which department has the best task completion rate? | Reliability of delivery. | Completion % by dept | Reward & scale. | Bar | M | ✅ |
| DEPT-009 | Which department is slowest (longest cycle time)? | Bottleneck teams. | Avg cycle time by dept | Re-resource. | Bar | H | ✅ |
| DEPT-010 | How many active AI users per department? | Adoption breadth. | Active users by dept | Prioritise laggards. | Bar | M | ✅ |
| DEPT-011 | Which department logs in most/least (engagement)? | Engagement signal. | Session count by dept | Engagement drives. | Bar | M | ✅ |
| DEPT-012 | Which department has the most idle accounts/seats? | Reclaim resources. | Idle seats by dept | Deprovision. | Bar | M | ✅ |
| DEPT-013 | What is cost-per-employee by department? | Normalised spend. | ₹ ÷ headcount by dept | Fair budgeting. | Bar | M | 🟡 |
| DEPT-014 | Which department produces the most successful output? | Quality-adjusted contribution. | Successful output by dept | Reward & scale. | Bar | M | 🟡 |
| DEPT-015 | How concentrated is spend/usage across departments? | Governance of spread. | Dept share (HHI) | Set caps. | Treemap | M | 🟡 |
| DEPT-016 | Which departments improved most quarter-over-quarter? | Momentum & recognition. | QoQ delta by dept | Recognise progress. | Slope chart | M | 🟡 |
| DEPT-017 | Which department has the highest AI maturity? | Transformation leaders. | Maturity index by dept | Mentor other teams. | Ranked bar | M | 🟡 |
| DEPT-018 | Which teams need training the most? | Directs enablement. | Low adoption + low success by dept | Run training. | Quadrant | H | 🟡 |
| DEPT-019 | What is average output per employee by department? | Fair productivity view. | Output ÷ headcount | Set expectations. | Bar | M | 🟡 |
| DEPT-020 | Which department relies most on a single person? | Key-person risk per team. | Top-user share within dept | De-risk. | Bar | L | 🟡 |
| DEPT-021 | How does department usage split across tools? | Tool fit per team. | Tool mix by dept | Right-tool guidance. | Stacked bar | L | 🟡 |
| DEPT-022 | Which department has the best cost-to-value ratio? | Reward efficient teams. | Value ÷ ₹ by dept | Reinvest in leaders. | Sorted bar | M | 🟡 |

# LEVEL 4 — USER / ADOPTION

## 4. User & Adoption Analytics
*Primary persona: User (enablement/HR), Mgr. Real per-user platform data (`user_activities`).*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| USER-001 | What are our DAU / WAU / MAU? | Canonical engagement denominators. | DAU · WAU · MAU + stickiness | Track engagement cadence. | Trend | H | ✅ |
| USER-002 | Who are the most active users overall? | Champions & heavy adopters. | Sessions/activity per user | Recognise & mentor. | Leaderboard | H | ✅ |
| USER-003 | Which users are inactive/dormant? | Reclaim seats; churn signal. | Days since last activity | Re-engage or retire. | Recency table | H | ✅ |
| USER-004 | Do users keep using AI after first adoption? | Retention = truest value signal. | D1/D7/D30 retention | Fix the drop week. | Cohort curves | H | ✅ |
| USER-005 | What is the new vs returning user mix? | Adoption breadth. | New vs returning trend | Onboarding vs retention spend. | Stacked area | M | ✅ |
| USER-006 | What is the platform adoption rate vs headcount? | Penetration. | Adopters ÷ headcount | Set penetration target. | Gauge | H | ✅ |
| USER-007 | Who are our AI champions (power users)? | Playbook worth spreading. | Maturity/activity score | Stand up mentor program. | Ranked bar | H | ✅ |
| USER-008 | What is the workforce AI-maturity distribution? | Sizes the enablement gap. | Users per maturity level | Plan enablement. | Histogram | M | 🟡 |
| USER-009 | Who is at risk of disengaging? | Cheap early intervention. | Churn-risk user count | Trigger re-engagement. | Risk list | H | 🟡 |
| USER-010 | What is average session duration and active time? | Depth of engagement. | Avg session/active mins | Improve stickiness. | Histogram | M | ✅ |
| USER-011 | How many sessions per user per week? | Habit formation. | Sessions/user/week | Target habit-building. | Bar | M | ✅ |
| USER-012 | What is the login frequency distribution? | Engagement segmentation. | Logins/user histogram | Tier enablement. | Histogram | M | ✅ |
| USER-013 | Which users logged in but never generated/used tools? | Activation gap. | Login-no-action count | Fix activation. | Funnel | H | 🟡 |
| USER-014 | What is the time from account creation to first use? | Onboarding speed. | Days to first action | Speed onboarding. | Histogram | M | ✅ |
| USER-015 | Which users are consistently active (low variance)? | Reliable adopters. | Activity regularity | Recognise consistency. | Heatmap | L | ✅ |
| USER-016 | What is the idle/away time ratio during sessions? | Genuine engagement quality. | Idle ÷ session time | Understand real usage. | Bar | L | ✅ |
| USER-017 | Which users use multiple tools (breadth)? | Multi-tool adopters. | Tools used per user | Cross-sell tools. | Bar | M | 🟡 |
| USER-018 | What is the stickiness ratio (DAU/MAU)? | Engagement quality. | DAU ÷ MAU | Set stickiness target. | KPI + trend | M | ✅ |
| USER-019 | Who improved their AI usage the most recently? | Recognise growth. | Activity delta per user | Recognise & coach. | Slope | L | ✅ |
| USER-020 | Which users are over-reliant on off-hours usage? | Wellbeing/burnout signal. | Off-hours share per user | Wellbeing check. | Bar | M | ✅ |
| USER-021 | What is the retention curve by joining cohort? | Cohort health. | Retention by cohort | Fix weak cohorts. | Cohort heatmap | M | ✅ |
| USER-022 | Which users are approaching churn based on trend? | Predictive retention. | Declining-activity flag | Intervene. | Risk list | M | 🟡 |
| USER-023 | What is the ratio of AI-active to total employees by seniority? | Adoption by level. | Adoption by role/position | Targeted enablement. | Bar | L | 🟡 |
| USER-024 | Who are the fastest-growing new adopters? | Emerging champions. | Growth rate for new users | Fast-track mentoring. | Leaderboard | L | ✅ |
| USER-025 | What share of users are "activated" (hit value milestone)? | Activation health. | Activated ÷ signed-up | Improve onboarding. | Funnel | M | 🟡 |
| USER-026 | How many users are single-session (one-and-done)? | Early churn. | One-session user count | Re-engage. | KPI | M | ✅ |
| USER-027 | What is the engagement heatmap by user over weeks? | Consistency at a glance. | Active weeks per user | Spot fading users. | Heatmap | L | ✅ |
| USER-028 | Which employees generate the highest value per credit spent? | The management "who's worth it" question. | Output/value ÷ credits per user | Reward & replicate. | Sorted bar | H | 🟡 |

# LEVEL 3 — PRODUCTIVITY

## 5. Productivity & Business Value
*Primary persona: Mgr, Exec. Links AI usage to delivered work.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| PROD-001 | Do AI-active users complete more tasks than non-AI users? | The honest AI-value signal. | Cohort throughput delta | Justify & scale enablement. | Cohort bars | E | 🟡 |
| PROD-002 | How much work is completed, and how fast? | Business-outcome layer. | Completed + avg cycle time | Set throughput targets/SLAs. | KPI + trend | H | ✅ |
| PROD-003 | What is output per active user per day? | Throughput per head. | Output ÷ active days | Productivity targets. | Bar | H | 🟡 |
| PROD-004 | Which users deliver most output per credit? | Efficiency leaders. | Output ÷ credits | Replicate patterns. | Sorted bar | H | 🟡 |
| PROD-005 | What is the first-try success ratio (output ÷ attempts)? | Effort efficiency. | Successful ÷ attempts | Coach prompting. | Gauge | M | 🟡 |
| PROD-006 | How much rework (re-runs) per successful output? | Wasted effort. | Re-runs ÷ success | Reduce rework. | Bar | M | 🟡 |
| PROD-007 | Is productivity improving as users mature? | Learning-curve payoff. | Output/credit over tenure | Sustain enablement. | Trend by cohort | M | 🟡 |
| PROD-008 | Which teams turn AI usage into completed tasks best? | Usage→outcome conversion. | Tasks per unit AI usage | Reward conversion. | Bar | M | 🟡 |
| PROD-009 | What is the idle ratio (provisioned but unused)? | Reclaim waste. | Unused ÷ provisioned | Deprovision. | KPI | M | ✅ |
| PROD-010 | How does productivity vary by model/mode chosen? | Tool choice affects output. | Output/credit by model | Recommend best model. | Grouped bar | M | 🟡 |
| PROD-011 | What is the average tasks-per-user trend? | Workforce throughput. | Tasks/user over time | Capacity planning. | Trend | M | ✅ |
| PROD-012 | Which users are high-usage but low-output? | Efficiency coaching targets. | Usage vs output quadrant | Coach. | Quadrant | H | 🟡 |
| PROD-013 | Which users are low-usage but high-output (efficient)? | Best-practice source. | Usage vs output quadrant | Learn from them. | Quadrant | M | 🟡 |
| PROD-014 | What is throughput per working hour (peak productivity)? | When work actually gets done. | Output by hour | Schedule for peak. | Bar | L | ✅ |
| PROD-015 | How much output is produced per session? | Session productivity. | Output ÷ session | Understand patterns. | Histogram | L | 🟡 |
| PROD-016 | What is the ratio of interactive vs batch work? | Working-style insight. | Session-type split | Tooling & scheduling. | Donut | L | 🟡 |
| PROD-017 | Which departments convert credits to tasks most effectively? | Team efficiency. | Tasks ÷ credits by dept | Reward efficient teams. | Sorted bar | M | 🟡 |
| PROD-018 | Are AI-heavy periods correlated with higher delivery? | Value correlation. | AI usage vs task completion | Validate value. | Scatter | M | 🟡 |
| PROD-019 | What is the productivity gap between top and bottom quartile users? | Coaching opportunity size. | Q4 vs Q1 output | Target the gap. | Box plot | M | 🟡 |
| PROD-020 | Which users would benefit most from automation/nudges? | Enablement targeting. | Repetitive-pattern score | Deploy nudges. | Ranked list | L | 🔴 |
| PROD-021 | What is output per rupee at the org level over time? | Efficiency trajectory. | Output ÷ ₹ trend | Scale decision. | Trend | H | 🟡 |
| PROD-022 | How much time is lost to idle vs active in sessions? | Real productive time. | Active ÷ total session time | Improve focus/tooling. | Stacked bar | L | ✅ |

# LEVEL 3 — OPERATIONS

## 6. Operations & Monitoring
*Primary persona: Ops. Peaks, capture health, live monitoring.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| OPS-001 | What are the peak usage hours across the platform? | Capacity & support planning. | Activity by hour (IST) | Align capacity to peaks. | Bar | H | ✅ |
| OPS-002 | Is volume abnormally high/low right now vs baseline? | Live health signal. | Today vs rolling baseline | Investigate deviation. | KPI + control band | H | ✅ |
| OPS-003 | Is data-capture coverage dropping? | Protects all downstream analytics. | Captured ÷ observed trend | Fix pipeline. | Trend + alert | H | ✅ |
| OPS-004 | Which accounts/tools stopped reporting unexpectedly? | Detect breakage. | Recency alerts | Investigate. | Recency table | H | ✅ |
| OPS-005 | What are the top data-capture failure reasons? | Diagnose the capture gap. | pipelineMissingReasons breakdown | Prioritise pipeline fixes. | Pareto | M | 🟡 |
| OPS-006 | What is the click-to-generation capture ratio? | Capture completeness. | Clicks vs settled generations | Improve extension capture. | Funnel | M | ✅ |
| OPS-007 | Are there unusual off-hours activity bursts? | Security/misuse signal. | Off-hours spikes | Investigate. | Timeline + flags | M | ✅ |
| OPS-008 | What is the current backlog/queue depth? | Live congestion. | In-flight/pending count | Add capacity. | KPI | M | 🔴 |
| OPS-009 | What is the average render/generation time? | Speed → throughput & UX. | Queue→complete duration | Prioritise latency fixes. | Histogram | H | 🔴 |
| OPS-010 | What is p50/p90/p99 latency? | Tail latency hurts most. | Latency percentiles | Set SLOs. | Percentile bars | M | 🔴 |
| OPS-011 | What is the average queue/wait time before processing? | Congestion signal. | Avg queue time | Add peak capacity. | Line by hour | M | 🔴 |
| OPS-012 | What is the failed-generation count and rate? | Reliability ops KPI. | Failures + rate | Escalate. | Trend | H | 🔴 |
| OPS-013 | What is the retry rate and average retries? | Friction & waste. | Retry rate, avg retries | Fix root cause. | Bar | M | 🔴 |
| OPS-014 | What is the cancellation/abandon rate? | UX/quality issues. | Cancels ÷ attempts | Improve flow. | Trend | M | 🔴 |
| OPS-015 | How many assets are missing/failed to capture? | Catalog completeness. | Missing-asset count | Fix capture. | KPI | M | 🟡 |
| OPS-016 | Which hours/days need maintenance windows (quietest)? | Minimise disruption. | Lowest-load windows | Schedule maintenance. | Heatmap (inverse) | M | ✅ |
| OPS-017 | Is spend pacing ahead of budget this month? | Budget guardrail. | MTD ₹ vs pace | Throttle/approve. | Pace gauge | H | 🟡 |
| OPS-018 | Are credits about to deplete on any active account? | Prevent stoppage. | Low-balance alerts | Top-up. | Alert list | H | 🟡 |
| OPS-019 | What is the day×hour activity heatmap? | Pinpoint busy windows. | Count by (dow,hour) | Time launches/support. | Heatmap | H | ✅ |
| OPS-020 | What is the mean time to recovery after an incident? | Operational resilience. | MTTR | Improve on-call. | Timeline | L | 🔴 |
| OPS-021 | Are API failures/errors trending up? | Upstream reliability. | Error-status trend | Escalate to vendor. | Trend | M | 🔴 |
| OPS-022 | What is the system uptime/availability for capture? | Pipeline reliability SLA. | Capture uptime % | Report SLA. | Gauge | M | 🟡 |
| OPS-023 | Which accounts show settlement delays? | Reconciliation health. | Settle latency | Investigate. | Bar | L | 🟡 |
| OPS-024 | What is the weekend vs weekday operational load? | Staffing & licensing. | Load split | Plan coverage. | Stacked bar | L | ✅ |

# LEVEL 3 — RELIABILITY & QUALITY

## 7. Reliability & Quality
*Primary persona: Ops, AI. Success, failure, quality of output.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| REL-001 | What is the overall success vs failure rate? | Core reliability KPI. | Success/failure % | Escalate fixes. | Donut + trend | H | 🟡 |
| REL-002 | What are the top failure reasons? | Directs the fix. | Failures by reason | Fix biggest cause. | Pareto | H | 🔴 |
| REL-003 | How does reliability trend over time? | Regression detection. | Success % over time | Sustain/intervene. | Trend | H | 🟡 |
| REL-004 | How does success differ by model/mode? | Some models fail more. | Success % by model | Deprecate flaky models. | Grouped bar | M | 🟡 |
| REL-005 | What is the capture success rate (data completeness)? | Analytics trust. | Captured ÷ observed | Fix capture. | Gauge | H | ✅ |
| REL-006 | Which accounts have the worst reliability? | Account-level config issues. | Success % by account | Fix worst accounts. | Small multiples | M | 🟡 |
| REL-007 | What share of credits is lost to failures? | Quantifies waste. | Credits on failures | Fund reliability. | Stacked bar | M | 🔴 |
| REL-008 | What is the MTBF/MTTR for reliability incidents? | Resilience metrics. | MTBF, MTTR | Improve process. | Timeline | L | 🔴 |
| REL-009 | Is output quality consistent across accounts/models? | Quality governance. | Quality score by dim | Standardise. | Bar | M | 🔴 |
| REL-010 | What is the duplicate-generation rate? | Waste & quality. | Duplicate rate | De-dupe / coach. | Bar | M | 🔴 |
| REL-011 | Which prompts most often fail? | Prompt-level reliability. | Failure by prompt | Fix/coach. | Table | M | 🟡 |
| REL-012 | What is the first-pass yield (no rework)? | Quality efficiency. | Clean-output ratio | Improve quality. | Gauge | M | 🔴 |
| REL-013 | Are failures concentrated at specific hours? | Congestion-linked failures. | Failure rate by hour | Add peak capacity. | Heatmap | L | 🔴 |
| REL-014 | What is the SLA attainment (within-target completion)? | Service reliability promise. | % within SLA | Report reliability. | Gauge | H | 🔴 |
| REL-015 | How complete is our generated-asset catalog? | Output-inventory integrity. | Assets captured ÷ generated | Fix asset capture. | KPI | M | 🟡 |
| REL-016 | What is the error-status distribution by tool? | Cross-tool reliability. | Errors by tool/status | Prioritise fixes. | Bar | M | 🔴 |
| REL-017 | Is reliability better on newer vs older models? | Model lifecycle. | Success by model version | Migrate versions. | Bar | L | 🟡 |
| REL-018 | What share of generations produce a usable/kept asset? | Real-quality proxy. | Kept ÷ generated | Reduce waste. | Bar | M | 🔴 |
| REL-019 | Which capture stages lose the most data? | Pipeline weak points. | Loss by stage | Fix weakest stage. | Funnel | M | 🟡 |
| REL-020 | Are reliability issues correlated with specific accounts' settings? | Config root-cause. | Failure vs account config | Standardise config. | Table | L | 🔴 |
| REL-021 | What is the recovery success rate for missing data? | Recovery pipeline effectiveness. | Recovered ÷ missing | Improve recovery. | Gauge | M | 🟡 |
| REL-022 | Is the platform's data-quality score improving? | Trust trajectory. | Composite DQ score trend | Prioritise data fixes. | Scorecard | M | 🟡 |
| REL-023 | Which tools have the highest reliability? | Tool selection. | Success % by tool | Prefer reliable tools. | Bar | M | 🟡 |
| REL-024 | What is the trend in wasted spend from failures? | Enablement/reliability ROI. | Wasted ₹ trend | Continue/adjust program. | Trend | M | 🔴 |

# LEVEL 5 — AI TEAM

## 8. AI / Prompt / Model Intelligence
*Primary persona: AI. Prompt & model performance, mix, quality.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| AI-001 | What are the most-used prompts? | Dominant use-cases. | Top prompts by frequency | Build templates. | Ranked table | M | ✅ |
| AI-002 | Which prompts most often produce successful output? | Best prompts → templates. | Success rate by prompt | Promote to golden library. | Table + rate | H | 🟡 |
| AI-003 | Which prompts fail or get re-run most? | Friction hotspots. | Failure/re-run by prompt | Fix or coach. | Table | M | 🟡 |
| AI-004 | What is the average prompt length, and does it relate to success? | Prompting sophistication. | Length; length vs success | Coaching content. | Scatter | M | ✅ |
| AI-005 | How much prompt reuse vs unique prompts? | Standardisation opportunity. | Reuse rate | Build prompt library. | Donut | M | ✅ |
| AI-006 | Who are our best prompt engineers? | Who improves AI for all. | Prompt performance score | Recruit as champions. | Ranked bar | H | 🟡 |
| AI-007 | Are users getting better at prompting over time? | Enablement impact. | Success % over time | Sustain/adjust coaching. | Trend | M | 🟡 |
| AI-008 | What are our golden prompts, and who created them? | Institutional knowledge. | Uses × success rate | Publish shared library. | Table | H | 🟡 |
| AI-009 | Which model versions perform best? | Model selection. | Success/quality by model | Standardise model. | Grouped bar | H | 🟡 |
| AI-010 | What is the image vs video generation ratio? | Output-mix strategy. | Image ÷ video | Plan tooling/credits. | Donut | M | 🟡 |
| AI-011 | Which models are most cost-efficient (₹/output)? | Value routing. | ₹/output by model | Route to best value. | Sorted bar | H | 🟡 |
| AI-012 | What prompt themes/categories dominate? | Content strategy. | Share by theme | Guide strategy. | Bar | L | 🔴 |
| AI-013 | Are there near-duplicate prompts across users? | Dedup & shared templates. | Similarity clusters | Consolidate. | Cluster view | L | 🔴 |
| AI-014 | Which prompts consume the most credits? | Costly patterns. | Credits by prompt | Optimise expensive prompts. | Ranked bar | M | 🟡 |
| AI-015 | What is the model-mix shift over time? | Capability/cost drift. | Model share over time | Update routing policy. | Stacked area | M | 🟡 |
| AI-016 | What is the ChatGPT model mix (GPT versions)? | Conversational-AI policy. | Model share | Governance & routing. | Donut | M | ✅ |
| AI-017 | How deep are ChatGPT conversations (prompts per chat)? | Prompting sophistication. | Avg prompts/conversation | Target enablement. | Histogram | M | ✅ |
| AI-018 | What is the token usage per prompt/response? | Cost & efficiency (needs billing). | Tokens per unit | Optimise verbosity. | Histogram | M | 🔴 |
| AI-019 | Which prompt patterns generalise across teams? | Reusable playbooks. | Cross-team prompt reuse | Publish playbooks. | Network/graph | L | 🔴 |
| AI-020 | What is the output quality score by prompt/model? | Quality governance. | Quality score | Improve prompts/models. | Bar | M | 🔴 |
| AI-021 | Which prompts should become one-click templates? | Productivity leverage. | High-use × high-success | Build templates. | Ranked list | M | 🟡 |
| AI-022 | What is the longest/shortest prompt, and outliers? | Prompt hygiene. | Length extremes | Guidance. | Table | L | ✅ |
| AI-023 | How does prompt success vary by department/user? | Enablement targeting. | Success by cohort | Target coaching. | Bar | M | 🟡 |
| AI-024 | Which models are being retired/adopted (lifecycle)? | Model roadmap. | Version adoption curve | Plan migrations. | Area | L | 🟡 |
| AI-025 | What is the aspect-ratio/resolution demand mix? | Output-spec standardisation. | Share by spec | Set defaults. | Bar | L | 🟡 |
| AI-026 | Which prompts drive the most re-run loops (frustration)? | UX/quality signal. | Re-run chains per prompt | Fix root cause. | Table | M | 🔴 |
| AI-027 | What is the prompt-to-successful-asset conversion rate? | End-to-end prompt value. | Assets ÷ prompts | Improve prompting. | Funnel | M | 🔴 |
| AI-028 | How do prompt-quality scores trend as coaching runs? | Program effectiveness. | Quality trend | Sustain program. | Trend | L | 🔴 |

# LEVEL 3 — TIME INTELLIGENCE

## 9. Time & Usage Intelligence
*Primary persona: Ops, Mgr. Temporal patterns across the platform.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| TIME-001 | What are the peak generation/usage hours (IST)? | Capacity & support. | Activity by hour | Align capacity. | Bar | H | ✅ |
| TIME-002 | Which weekdays are busiest? | Scheduling & staffing. | Activity by day-of-week | Schedule around demand. | Bar | M | ✅ |
| TIME-003 | What does the day×hour heatmap show? | Exact busy windows. | Count by (dow,hour) | Time launches/maintenance. | Heatmap | H | ✅ |
| TIME-004 | Weekday vs weekend usage split? | Off-hours load. | Weekday/weekend split | Policy & capacity. | Stacked bar | M | ✅ |
| TIME-005 | How has the daily trend evolved? | Momentum. | Daily activity trend | Forecast base demand. | Line | H | ✅ |
| TIME-006 | What are the weekly and monthly trends? | Medium-term planning. | Weekly/monthly series | Budget & staffing. | Line | H | ✅ |
| TIME-007 | Is there intra-day seasonality? | Fine capacity tuning. | Hourly profile | Schedule batch vs interactive. | Area | L | ✅ |
| TIME-008 | When are the quietest windows? | Maintenance planning. | Lowest-load hours | Schedule maintenance. | Heatmap | M | ✅ |
| TIME-009 | What is the month-over-month growth rate? | Trajectory. | MoM growth % | Confirm scaling. | Trend + % | H | ✅ |
| TIME-010 | Are peak hours shifting over time? | Capacity re-planning. | Hourly profile over months | Re-time capacity. | Heatmap over periods | L | ✅ |
| TIME-011 | What is the busiest hour for each tool? | Per-tool capacity. | Peak hour by tool | Tool-specific capacity. | Small multiples | L | ✅ |
| TIME-012 | How does usage cluster around task deadlines? | Deadline-driven demand. | Usage vs deadline proximity | Smooth demand. | Line | L | 🟡 |
| TIME-013 | What is the average time between a user's sessions? | Habit cadence. | Inter-session gap | Habit programs. | Histogram | L | ✅ |
| TIME-014 | Is usage growing faster on any specific weekday? | Emerging patterns. | Per-weekday trend | Adjust support days. | Multi-line | L | ✅ |
| TIME-015 | What share of activity is in core business hours? | Workforce-pattern view. | Core-hours share | Capacity & policy. | Stacked bar | M | ✅ |
| TIME-016 | How seasonal is our usage (monthly index)? | Separate trend from noise. | Seasonal index | Plan steady-state. | Decomposition | L | 🔴 |
| TIME-017 | What is the first-hour-of-day ramp pattern? | Morning capacity. | Ramp curve | Pre-warm capacity. | Line | L | ✅ |
| TIME-018 | How does time-of-day usage differ by department? | Team working patterns. | Hourly profile by dept | Team-specific support. | Heatmap | L | 🟡 |

# LEVEL 3 — SECURITY & GOVERNANCE

## 10. Security, Abuse & Governance
*Primary persona: Sec. Access, credential risk, abuse, policy.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| SEC-001 | Are there unusual credit-spike events? | Cost-shock & misuse. | Credit z-score anomalies | Investigate spikes. | Control chart | H | 🟡 |
| SEC-002 | Is any account showing bot-like/automated patterns? | Abuse prevention. | Rate/regularity anomalies | Rate-limit / review. | Anomaly flags | M | 🔴 |
| SEC-003 | Are shared credentials used from inconsistent patterns? | Shared-login risk. | Session/device anomalies | Tighten policy. | Anomaly view | M | 🟡 |
| SEC-004 | Which accounts exceed fair-use thresholds? | Governance & caps. | Usage vs policy threshold | Enforce caps. | Threshold table | M | 🟡 |
| SEC-005 | Are prompts violating content/safety policy? | Compliance risk. | Flagged-prompt rate | Enforce policy. | Flag list | M | 🔴 |
| SEC-006 | Who accessed which tools/credentials, and when? | Auditability. | Access audit log | Compliance review. | Audit table | H | ✅ |
| SEC-007 | Are there off-hours or anomalous logins? | Intrusion signal. | Off-hours login anomalies | Investigate. | Timeline + flags | M | ✅ |
| SEC-008 | Which admin/privileged actions occurred? | Privileged-action oversight. | Admin audit events | Review privileged use. | Audit table | M | ✅ |
| SEC-009 | Are there sudden concentrations of spend in one account? | Cost/abuse risk. | Concentration spike | Diversify/review. | Pareto + alert | M | ✅ |
| SEC-010 | Which credentials are stale/unrotated? | Credential hygiene. | Credential age | Rotate credentials. | Table | M | ✅ |
| SEC-011 | Are there duplicate/near-duplicate generations at scale? | Waste & abuse. | Duplicate rate | De-dupe/coach. | Cluster | L | 🔴 |
| SEC-012 | Who edited tasks/records (change accountability)? | Change governance. | Edit-log events | Accountability. | Audit table | M | ✅ |
| SEC-013 | Are there failed-login / lockout patterns? | Account-security signal. | Failed-login trend | Security response. | Trend | M | 🟡 |
| SEC-014 | Which users have access they no longer use? | Least-privilege hygiene. | Access vs usage gap | Revoke unused access. | Table | M | 🟡 |
| SEC-015 | Is any user exfiltrating unusually high volumes? | Data-governance risk. | Volume anomaly per user | Investigate. | Anomaly flags | L | 🟡 |
| SEC-016 | What is the overall data-governance/anomaly score? | Governance posture. | Composite risk score | Prioritise fixes. | Scorecard | M | 🟡 |
| SEC-017 | Are credential assignments consistent with usage? | Shadow-usage detection. | Assignment vs activity | Correct assignments. | Table | L | 🟡 |
| SEC-018 | Which accounts should be de-provisioned for inactivity? | Attack-surface reduction. | Idle privileged accounts | Deprovision. | List | M | ✅ |

# LEVEL 1 — FORECASTING

## 11. Forecasting & Capacity Planning
*Primary persona: Fin, Exec, Ops. Forward-looking (mostly model-dependent).*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| FCST-001 | What is the forecast credit demand for 30/60/90 days? | Buy credits ahead of need. | Forecast credits + band | Time purchases. | Forecast line | E | 🔴 |
| FCST-002 | What is the forecast ₹ spend next quarter? | Budget certainty. | Forecast ₹ | Set budget. | Forecast line | E | 🔴 |
| FCST-003 | When will each account run out of credits? | Prevent stockouts. | Days-to-zero per account | Schedule top-ups. | Burn-down | H | 🟡 |
| FCST-004 | What is the forecast active-user growth? | Seat/plan planning. | Forecast active users | Plan seats. | Forecast line | M | 🔴 |
| FCST-005 | What peak capacity must we support? | Avoid throttling. | Peak load + headroom | Provision capacity. | Peak profile | M | ✅ |
| FCST-006 | What storage growth should we provision for? | Infra budgeting. | Forecast storage GB | Provision storage. | Forecast area | L | 🔴 |
| FCST-007 | What is the seasonality-adjusted baseline demand? | Separate trend from noise. | Deseasonalised baseline | Plan steady-state. | Decomposition | L | 🔴 |
| FCST-008 | What credit buffer avoids stockout at target SLA? | Safety-stock policy. | Recommended buffer | Set reorder point. | KPI + policy | M | 🟡 |
| FCST-009 | What is the forecast task/workload volume? | Workforce planning. | Forecast task volume | Staffing plan. | Forecast line | M | 🔴 |
| FCST-010 | What is the churn forecast (users at risk next month)? | Proactive retention. | Predicted churn count | Pre-empt churn. | Risk list | M | 🔴 |
| FCST-011 | What is the forecast cost per output (unit-economics trend)? | Scaling decision. | ₹/output projection | Scale or optimise. | Forecast line | M | 🔴 |
| FCST-012 | What is the adoption S-curve projection? | Transformation planning. | Adoption curve fit | Set milestones. | S-curve | M | 🔴 |
| FCST-013 | What is the forecast demand by tool? | Tool capacity planning. | Forecast by tool | Tool-specific capacity. | Small multiples | L | 🔴 |
| FCST-014 | What is the expected peak-hour load next month? | Peak provisioning. | Peak forecast | Pre-provision. | Forecast | L | 🔴 |
| FCST-015 | What is the budget variance forecast (over/under)? | Budget control. | Projected variance | Adjust budget. | Variance forecast | M | 🔴 |
| FCST-016 | When will we hit the next capacity ceiling? | Proactive scaling. | Time-to-ceiling | Plan expansion. | Projection | M | 🔴 |
| FCST-017 | What is the forecast department-level demand? | Dept capacity. | Forecast by dept | Allocate ahead. | Forecast | L | 🔴 |
| FCST-018 | What is the confidence/error band on our forecasts? | Forecast trust. | MAPE / band width | Trust the plan. | Band chart | L | 🔴 |
| FCST-019 | What is the scenario range (best/expected/worst) for spend? | Risk planning. | Scenario cost bands | Contingency budget. | Scenario fan | M | 🔴 |
| FCST-020 | What is the projected ROI trajectory? | Investment case. | ROI projection | Investment decision. | Forecast | E | 🔴 |

# LEVEL 1–5 — RECOMMENDATIONS

## 12. Recommendations & Next Actions
*Primary persona: All. Turns insight into decisions.*

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Pri | Ready |
|----|----------|----------------|-----------|-------------------|---------------|-----|-------|
| REC-001 | What are the highest-value next actions overall? | Insight → action. | Ranked recs + confidence | Fund top actions. | Ranked cards | E | 🟡 |
| REC-002 | How should we allocate/purchase credits next month? | Optimise spend & runway. | Recommended allocation | Approve purchase plan. | Allocation table | H | 🟡 |
| REC-003 | Which accounts/users should be capped, coached, or retired? | Cost & governance action. | Efficiency + usage tiers | Act per account. | Action matrix | H | 🟡 |
| REC-004 | Which model should be the default for best value? | Value routing. | ₹/output ranking | Set default model. | Ranked bar | M | 🟡 |
| REC-005 | Where can we cut cost without losing output? | Protect margin. | Waste % + cost outliers | Route/cap/renegotiate. | Waterfall | E | 🟡 |
| REC-006 | Which departments need an enablement drive? | Directs enablement. | Adoption gap vs org avg | Run targeted enablement. | Gap chart | H | ✅ |
| REC-007 | Which users should be nominated as champions/mentors? | Scale best practice. | Top maturity + output | Stand up mentor program. | List | M | 🟡 |
| REC-008 | Which users need re-engagement now? | Retention action. | Churn-risk list | Trigger outreach. | List | H | 🟡 |
| REC-009 | What is the single best reliability fix to cut waste? | Fastest ROI action. | Failure-cause × wasted ₹ | Fund top fix. | Pareto + ₹ | H | 🔴 |
| REC-010 | Which capture/instrumentation gaps most limit analytics? | Data-roadmap priority. | Gap → unlock impact | Fund instrumentation. | Impact/effort matrix | H | ✅ |
| REC-011 | Which accounts need a credit top-up now? | Continuity. | Low-runway list | Approve top-ups. | Alert list | H | 🟡 |
| REC-012 | Which prompts should be promoted to templates? | Productivity leverage. | High-use × high-success | Build templates. | Ranked list | M | 🟡 |
| REC-013 | Which tool should new adopters start with? | Onboarding guidance. | Success by first-tool | Guide onboarding. | Bar | L | 🟡 |
| REC-014 | Where should we set consumption guardrails/caps? | Cost governance. | Overspend hotspots | Set caps. | Table | M | 🟡 |
| REC-015 | Which teams should share their playbook org-wide? | Scale winners. | Top-efficiency teams | Publish playbook. | List | M | 🟡 |
| REC-016 | What is the recommended credit buffer/reorder point? | Avoid stockouts. | Buffer policy | Set policy. | KPI | M | 🟡 |
| REC-017 | Which underused features should we push? | Adoption of value features. | Low-use high-value features | Feature enablement. | Bar | L | 🔴 |
| REC-018 | Which idle accounts/seats should we reclaim? | Cost recovery. | Idle seat list | Deprovision. | List | M | ✅ |
| REC-019 | What is the recommended model-routing policy? | Cost/quality optimisation. | Model value ranking | Set routing rules. | Policy table | M | 🟡 |
| REC-020 | What is the prioritised analytics roadmap (next 90 days)? | Turn this library into a plan. | Ranked by value × effort | Approve roadmap. | Roadmap board | E | ✅ |

---

## Coverage & readiness roll-up

| Domain | Qs | Primary persona |
|--------|----|-----------------|
| Executive Overview | 24 | Exec |
| Finance & Cost | 28 | Fin |
| Department | 22 | Mgr/Exec |
| User & Adoption | 28 | User/Mgr |
| Productivity & Value | 22 | Mgr/Exec |
| Operations & Monitoring | 24 | Ops |
| Reliability & Quality | 24 | Ops/AI |
| AI / Prompt / Model | 28 | AI |
| Time Intelligence | 18 | Ops/Mgr |
| Security & Governance | 18 | Sec |
| Forecasting & Capacity | 20 | Fin/Exec |
| Recommendations | 20 | All |
| **Total** | **276** | |

### Readiness distribution (grounded in current capture)
- **✅ Available now (~45%)** — platform user activity (DAU/WAU/MAU, retention, sessions), tasks/throughput, Kling per-**account** usage & ₹ cost, ChatGPT usage/model mix, time intelligence, audit/security basics, prompt-text analytics.
- **🟡 Needs capture (~35%)** — anything needing **per-employee/department AI attribution** (Kling under shared logins), **real success/failure status** (currently all `active`), model/duration/quality labels, per-project cost, churn/risk scoring inputs.
- **🔴 Future (~20%)** — latency/queue/retry/cancellation, asset lifecycle & storage, token billing, all forecasts, anomaly/abuse ML, prompt similarity/quality scoring.

### The instrumentation roadmap that unlocks the most (ranked)
1. **Per-employee attribution at capture** → converts the largest block of 🟡 (Department, per-user AI cost/value, Productivity) to ✅.
2. **Structured generation status + failure reason** → unlocks Reliability, waste, and success-rate questions across domains.
3. **Latency/queue/retry telemetry** → unlocks Generation Performance & most of Operations reliability.
4. **Asset lifecycle + storage events** → unlocks Asset analytics & storage forecasting.
5. **Token/billing integration (ChatGPT) + forecasting/anomaly models** → unlocks Finance token cost, Forecasting, and Security anomaly domains.

## UI surfacing guidance (Report Builder)
- Group the library by the **12 domains** above (not one flat list); default the browser to the user's **persona**.
- **Filter to ✅ by default** so users only see questions that currently return data; expose 🟡/🔴 under a "Roadmap / coming soon" toggle so the ambition is visible without producing empty reports.
- Carry `readiness` and `pri` as first-class fields so the UI can badge and sort. Recommended schema extension: `{ id, cat, persona, q, why, metric, decision, viz, pri, readiness }`.
