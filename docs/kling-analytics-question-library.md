# Kling Analytics — Question Library & Specification

**Author:** Senior Data Analyst (BI)
**Purpose:** The complete business-question library for Kling usage analytics, structured for direct import into the Report Builder Question Library.
**Ordering:** Executive → Usage/User/Dept → Cost/Credit → Performance/Reliability → Time/Prompt/Asset → Productivity/Trend/Capacity → Operational/Anomaly → Recommendations.

## How to read this

Every question carries: **Why it matters · Metric(s) · Business Decision · Recommended Visualization · Priority · Data-Readiness**.

**Priority** — `Exec` (board/CxO), `High` (dept head / ops lead), `Med` (analyst / manager), `Low` (nice-to-have).

**Data-Readiness** — grounded in the *actual* captured data (`generation_records`, `it_portal_tool_usage_events`, `tool_credit_rates`, `user_activities`):
- **● Now** — answerable today from captured fields.
- **◐ Partial** — answerable but limited (sparse labels, or a dimension that is currently degenerate, e.g. all activity under one shared login / one department).
- **○ Capture** — needs new instrumentation (retries, queue/render time, asset lifecycle, storage) or a model (forecast/anomaly).

> **Standing caveat (affects the whole library):** Kling is currently captured under a small set of **shared account logins** (e.g. `Deepak@…`, `Kling@…`), all under a single platform user in the `ADMIN` department. Therefore **per-*account* analytics are real and rich, but per-*employee* and per-*department* cuts are degenerate until capture attributes each generation to the individual who made it.** Questions that depend on that are marked ◐/○ accordingly.

---

## 1. Executive Overview

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-001 | How many Kling generations did we produce this period, and is it growing? | Headline output signal for the primary video engine. | Total generations + MoM/WoW growth % | Set credit capacity and rollout pace. | KPI card + trend line | Exec | ● |
| KL-002 | What did Kling cost us this period (₹), and is it under control? | Ties usage to real money for the board. | Total ₹ cost + cost trend | Set consumption guardrails/budget. | KPI card + area trend | Exec | ● |
| KL-003 | What is our cost per successful generation (₹)? | Unit economics decide whether to scale. | ₹ / generation | Optimise accounts, models, prompts. | KPI card + benchmark line | Exec | ● |
| KL-004 | Which accounts/users drive the majority of Kling value and spend? | Concentration guides budget and governance. | Top-N share of generations & ₹ | Focus enablement/caps on the vital few. | Pareto bar | Exec | ● |
| KL-005 | Is Kling adoption broadening or concentrating in a few hands? | Distinguishes durable rollout from key-person risk. | Active accounts trend + Gini/HHI | De-risk single-account dependence. | Trend + concentration index | Exec | ◐ |
| KL-006 | What is the overall generation success rate? | Reliability drains credits, time and trust. | Success vs failure % | Escalate reliability fixes. | Gauge / donut | Exec | ◐ |
| KL-007 | How much money is wasted on failed/unused generations? | Waste is the fastest cost to recover. | Wasted ₹ + % of spend | Fund reliability / cleanup. | Stacked bar (productive vs wasted) | Exec | ◐ |
| KL-008 | Are we getting more output per rupee over time? | Efficiency, not vanity volume, is the ROI signal. | Generations per ₹ over time | Confirm scaling is efficient. | Dual-axis trend | Exec | ● |
| KL-009 | What is the 30/60/90-day forecast for Kling demand and cost? | Plan budget and capacity before it bites. | Forecast generations + ₹ with band | Pre-approve budget / capacity. | Forecast line + confidence band | Exec | ○ |
| KL-010 | What is our credit runway across all Kling accounts? | Avoid mid-campaign stockouts. | Remaining credits ÷ burn rate = days left | Time the next credit purchase. | KPI + burn-down | Exec | ◐ |

## 2. Usage Analytics

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-011 | How many videos vs images were generated? | Output mix drives capacity and cost mix. | Count by generation type | Right-size model/credit plans. | Donut + trend | High | ◐ |
| KL-012 | How many total generations per day/week/month? | Base demand curve. | Generations by grain | Staffing and capacity cadence. | Multi-grain line | High | ● |
| KL-013 | What is the average number of generations per active account? | Intensity of use per login. | Avg generations / active account | Spot under/over-utilised accounts. | Bar + benchmark | Med | ● |
| KL-014 | Which Kling models/features are used most (motion control, image 3.0, video 3.0…)? | Model mix guides cost and capability policy. | Generation share by model_label | Standardise on best-value models. | Ranked bar | High | ◐ |
| KL-015 | What generation modes dominate (image / video / motion)? | Mode mix informs tooling and training. | Share by generationMode | Target enablement on heavy modes. | Donut | Med | ◐ |
| KL-016 | What aspect ratios / resolutions are requested most? | Downstream storage & delivery planning. | Share by aspectRatio / resolution | Standardise output specs. | Bar | Low | ◐ |
| KL-017 | How many generations came via UI clicks vs network-observed? | Reveals capture coverage and true volume. | Clicks vs network_generation counts | Fix capture gaps. | Funnel | Med | ● |
| KL-018 | What share of generations are re-runs of a similar request? | Re-runs inflate cost and signal friction. | Repeat-within-session rate | Reduce rework; coach prompting. | Bar | Med | ◐ |
| KL-019 | How many generations are produced per session? | Session productivity signal. | Avg generations / session | Understand working patterns. | Histogram | Low | ◐ |
| KL-020 | What is the busiest single day on record, and why? | Understand demand spikes. | Max daily volume + context | Plan for repeat peaks. | Annotated line | Med | ● |
| KL-021 | How does this month compare to last month and same-month-last-quarter? | Seasonality and momentum. | Period-over-period deltas | Separate spikes from trend. | Comparison bars | High | ● |
| KL-022 | What proportion of generations occur inside vs outside office hours? | Signals workload spread and off-hours load. | In/after-hours split | Capacity & policy decisions. | Stacked bar | Med | ● |

## 3. User / Account Analytics

> Each Kling account label is a login (usually an email), so this is the closest per-user cut the capture supports.

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-023 | Who are the top Kling accounts/creators by generations? | Identify champions and heavy usage. | Generations per account | Recognise & scale best practice. | Leaderboard | High | ● |
| KL-024 | Who burns the most credits/₹ — and is it justified by output? | Cost accountability per account. | ₹ & credits per account + ₹/gen | Coach or cap heavy burners. | Ranked bar + efficiency overlay | High | ● |
| KL-025 | Which accounts are most credit-efficient (lowest ₹/generation)? | Surfaces best operating patterns. | ₹ / successful generation by account | Replicate efficient behaviour. | Sorted bar | Med | ● |
| KL-026 | Which accounts are inactive or dormant? | Reclaim seats/credits; spot churn. | Days since last generation | Reassign or retire accounts. | Table + recency heat | Med | ● |
| KL-027 | What is the new vs returning account mix over time? | Adoption breadth signal. | New vs returning counts | Guide onboarding vs retention spend. | Stacked area | Med | ◐ |
| KL-028 | Which accounts are approaching their credit limit? | Prevent mid-work stockouts. | currentCredits vs burn rate | Top-up before depletion. | Burn-down per account | High | ◐ |
| KL-029 | How concentrated is usage (top 3 accounts’ share)? | Key-person / key-account risk. | Top-3 share of volume & ₹ | Diversify or formalise ownership. | Pareto | High | ● |
| KL-030 | What is each account’s success/failure profile? | Reliability differs by account/config. | Success % per account | Fix the worst-performing accounts. | Small-multiples bar | Med | ◐ |
| KL-031 | Who are the power users vs occasional users? | Segment enablement. | Usage-tier distribution | Tailor training by tier. | Histogram / tiers | Med | ● |
| KL-032 | Which real employees are behind each shared account? | Restore accountability. | Account → owner mapping coverage % | Prioritise per-user attribution. | Coverage table | High | ○ |
| KL-033 | What is each account’s generations-per-active-day? | Normalises heavy vs steady use. | Gens ÷ active days | Balance workload across accounts. | Bar | Low | ● |
| KL-034 | Which accounts show a sudden change in behaviour? | Early signal of misuse or issue. | WoW change in volume/₹ per account | Investigate outliers. | Trend + flags | Med | ◐ |

## 4. Department Analytics

> Currently degenerate — all Kling activity sits in the `ADMIN` department until per-user attribution exists. Kept for readiness planning.

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-035 | Which departments generate the most Kling content? | Shows where video work concentrates. | Generations by department | Allocate credits to heavy teams. | Ranked bar | High | ○ |
| KL-036 | Which departments spend the most (₹) on Kling? | Departmental cost ownership. | ₹ by department | Chargeback / budget allocation. | Bar | High | ○ |
| KL-037 | Which department is most credit-efficient? | Benchmark teams fairly. | ₹ / output by department | Spread efficient practice. | Sorted bar + benchmark | Med | ○ |
| KL-038 | Which departments are under-adopting Kling? | Find enablement gaps. | Adoption vs headcount | Run targeted enablement. | Gap chart | Med | ○ |
| KL-039 | How is department usage trending? | Detect rising/declining teams. | Dept generations over time | Rebalance capacity. | Multi-line | Med | ○ |
| KL-040 | What is cost-per-employee by department? | Normalised spend comparison. | ₹ ÷ dept headcount | Fair budgeting. | Bar | Low | ○ |
| KL-041 | Which departments produce the most *successful* output? | Quality-adjusted contribution. | Successful gens by dept | Reward and scale. | Bar | Low | ○ |
| KL-042 | How concentrated is spend across departments? | Governance of budget spread. | Dept share of ₹ (HHI) | Set caps where concentrated. | Treemap | Med | ○ |

## 5. Credit Consumption

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-043 | How many total credits were consumed? | Core resource-consumption number. | Sum credits_burned | Track against purchased credits. | KPI + trend | High | ● |
| KL-044 | What is the average credit burn per generation? | Efficiency baseline. | Avg credits / generation | Detect expensive patterns. | KPI + distribution | High | ● |
| KL-045 | What is the credit-burn distribution (buckets 0–5, 5–20, 20+)? | Reveals cost-shape and outliers. | Histogram of credits/gen | Investigate the heavy tail. | Histogram | Med | ● |
| KL-046 | What were the highest single-generation credit burns? | Outlier control. | Top-N credits/gen with context | Review costly generations. | Ranked table | Med | ● |
| KL-047 | How do credits burn by model/mode? | Model choice drives cost. | Credits by model_label | Route to cheaper equivalent models. | Bar | High | ◐ |
| KL-048 | How is credit consumption trending (daily/weekly)? | Demand-side of budgeting. | Credits by grain | Forecast top-ups. | Line | High | ● |
| KL-049 | Which accounts consume credits fastest (burn rate)? | Runway management. | Credits/day per account | Prioritise top-ups/caps. | Burn-down | High | ◐ |
| KL-050 | How many credits are consumed per successful vs failed generation? | Quantifies waste. | Credits by outcome | Fund reliability. | Stacked bar | Med | ◐ |
| KL-051 | What share of credits goes to re-runs? | Rework cost. | Credits on repeat requests | Reduce rework. | Bar | Med | ◐ |
| KL-052 | Are credits being consumed faster than purchased? | Prevents stockouts / overspend. | Burn vs top-up balance | Adjust purchasing cadence. | Balance line | High | ◐ |

## 6. Cost Analytics (₹)

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-053 | What is total Kling ₹ cost and where does it go? | You can’t optimise unseen cost. | Total ₹ + breakdown | Target the biggest buckets. | Treemap / stacked bar | Exec | ● |
| KL-054 | What is cost per account (₹)? | Account-level accountability. | ₹ by account | Chargeback / caps. | Ranked bar | High | ● |
| KL-055 | What is cost per successful output (₹)? | Unit economics. | ₹ / successful gen | Scale or optimise. | KPI + benchmark | High | ◐ |
| KL-056 | How does ₹/credit differ across accounts (package pricing)? | Different accounts bought at different rates. | rate_per_credit by account | Buy future credits on cheapest plan. | Bar | High | ● |
| KL-057 | What is the cost trend and is it accelerating? | Early warning on runaway spend. | ₹ over time + slope | Trigger guardrails. | Trend + slope | Exec | ● |
| KL-058 | How much ₹ is wasted (failed/unused)? | Recoverable cost. | Wasted ₹ + % | Fund fixes. | Stacked bar | High | ◐ |
| KL-059 | What is projected monthly/annual ₹ at current run-rate? | Budget planning. | Run-rate projection | Set annual budget. | Projection line | Exec | ● |
| KL-060 | Which model/mode gives the best cost-per-output? | Value-based routing. | ₹/output by model | Prefer best-value model. | Sorted bar | Med | ◐ |
| KL-061 | What would a 10% price change per account do to total cost? | Scenario planning. | Sensitivity of ₹ to rate | Negotiate/renew smartly. | Tornado / what-if | Med | ● |
| KL-062 | What is cost per active day / per working hour? | Operational cost intensity. | ₹ ÷ active period | Capacity budgeting. | KPI | Low | ● |

## 7. Generation Performance

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-063 | What is the average generation (render) time? | Speed affects throughput and UX. | Avg queue→complete duration | Prioritise latency fixes. | Histogram | High | ○ |
| KL-064 | What is the p50/p90/p99 generation latency? | Tail latency hurts most. | Latency percentiles | Set performance SLOs. | Percentile bars | Med | ○ |
| KL-065 | What was the longest / fastest generation? | Bound the experience. | Max/min duration + context | Investigate extremes. | Table | Low | ○ |
| KL-066 | How does latency vary by model/resolution? | Guides model/spec choice. | Latency by model | Route for speed when needed. | Grouped bar | Med | ○ |
| KL-067 | What is the average queue/wait time before processing? | Congestion signal. | Avg queue time | Add capacity at peaks. | Line by hour | Med | ○ |
| KL-068 | How does performance vary across accounts? | Config/plan differences. | Latency by account | Standardise best config. | Small multiples | Low | ○ |
| KL-069 | Is generation performance improving or degrading over time? | Regression detection. | Latency trend | Escalate regressions. | Trend | Med | ○ |
| KL-070 | What share of generations complete within target time? | SLA attainment. | % within SLA | Report reliability. | Gauge | High | ○ |

## 8. Success, Failure & Reliability

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-071 | What is the overall success vs failure rate? | Core reliability KPI. | Success / failure % | Escalate fixes. | Donut + trend | High | ◐ |
| KL-072 | What are the top failure reasons? | Directs the fix. | Failures by reason | Fix the biggest cause. | Pareto | High | ○ |
| KL-073 | What is the retry rate and average retries per generation? | Retries mean friction and waste. | Retry rate, avg retries | Reduce root cause. | Bar | Med | ○ |
| KL-074 | What is the cancellation/abandon rate? | Signals UX or quality issues. | Cancels ÷ attempts | Improve flow/quality. | Trend | Med | ○ |
| KL-075 | What is the capture success rate (data completeness)? | Analytics trust depends on it. | Captured ÷ observed | Fix capture pipeline. | Gauge | High | ● |
| KL-076 | Which capture/pipeline reasons cause missing data? | Diagnose the capture gap. | pipelineMissingReasons breakdown | Prioritise pipeline fixes. | Pareto | Med | ◐ |
| KL-077 | How does success rate differ by model/mode? | Some models fail more. | Success % by model | Deprecate flaky models. | Grouped bar | Med | ◐ |
| KL-078 | How does reliability trend over time? | Detect regressions/improvements. | Success % over time | Sustain or intervene. | Trend | High | ◐ |
| KL-079 | What share of settled generations had a preceding captured click? | Capture-coverage health. | Click-capture % | Improve extension capture. | KPI + funnel | Med | ● |
| KL-080 | What is the mean time to recovery after a failure spike? | Operational resilience. | MTTR on reliability incidents | Improve on-call/process. | Incident timeline | Low | ○ |

## 9. Time Analytics

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-081 | What are the peak generation hours (IST)? | Capacity and support planning. | Generations by hour | Align capacity to peaks. | Bar | High | ● |
| KL-082 | Which weekdays are busiest? | Staffing and scheduling. | Generations by day-of-week | Schedule around demand. | Bar | Med | ● |
| KL-083 | What does the day×hour heatmap look like? | Pinpoints exact busy windows. | Count by (dow,hour) | Time launches & maintenance. | Heatmap | High | ● |
| KL-084 | Weekday vs weekend usage split? | Off-hours load & licensing. | Weekday/weekend counts | Policy & capacity. | Stacked bar | Med | ● |
| KL-085 | How has the daily trend evolved over the period? | Momentum. | Daily generations trend | Forecast base demand. | Line | High | ● |
| KL-086 | What is the weekly and monthly trend? | Medium-term planning. | Weekly/monthly series | Budget & staffing cadence. | Line | High | ● |
| KL-087 | Is there intra-day seasonality (morning vs evening)? | Fine capacity tuning. | Hourly profile | Schedule batch vs interactive. | Area | Low | ● |
| KL-088 | When are the quietest windows (best for maintenance)? | Minimise disruption. | Lowest-load hours | Schedule maintenance. | Heatmap (inverse) | Med | ● |
| KL-089 | How long between an account’s first and latest generation (tenure)? | Lifecycle understanding. | Account active span | Lifecycle programs. | Timeline | Low | ● |
| KL-090 | What is the growth rate month-over-month? | Trajectory. | MoM growth % | Confirm scaling. | Trend + % | High | ● |

## 10. Prompt Analytics

> ~78% of events carry `prompt_text`, so prompt analytics are largely available now (text-based; embeddings/similarity need a model).

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-091 | What are the most-used prompts? | Reveals dominant use-cases. | Top prompts by frequency | Build templates for common needs. | Ranked table | Med | ● |
| KL-092 | Which prompts most often produce successful output? | Best prompts become templates. | Success rate by prompt | Promote to golden library. | Table + rate | High | ◐ |
| KL-093 | Which prompts fail or get re-run most? | Friction & waste hotspots. | Failure/re-run by prompt | Fix or coach. | Table | Med | ◐ |
| KL-094 | What is the average prompt length, and does length relate to success? | Prompting sophistication. | Avg length; length vs success | Coaching content. | Scatter | Med | ● |
| KL-095 | How much prompt reuse vs unique prompts is there? | Standardisation opportunity. | Reuse rate | Build a prompt library. | Donut | Med | ● |
| KL-096 | What prompt themes/categories dominate (product, fashion, motion…)? | Content-strategy insight. | Share by theme | Guide asset strategy. | Bar (post-classification) | Low | ○ |
| KL-097 | Which prompts consume the most credits? | Costly patterns. | Credits by prompt | Optimise expensive prompts. | Ranked bar | Med | ◐ |
| KL-098 | Are there near-duplicate prompts across accounts? | Dedup & shared templates. | Similarity clusters | Consolidate into templates. | Cluster view | Low | ○ |
| KL-099 | What are the longest / shortest prompts? | Range and outliers. | Max/min length | Prompt-hygiene guidance. | Table | Low | ● |
| KL-100 | How is prompt success trending over time? | Enablement impact. | Success % over time | Sustain or change coaching. | Trend | Med | ◐ |

## 11. Asset Analytics

> Asset lifecycle (download/save/delete/storage) is largely un-instrumented today.

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-101 | How many generated assets were captured/stored? | Output inventory. | Asset count captured | Storage & catalog planning. | KPI + trend | Med | ◐ |
| KL-102 | What is the asset download rate? | Measures usefulness of output. | Downloads ÷ generations | Improve output quality. | Gauge | Med | ○ |
| KL-103 | What is the asset save/keep rate? | Signals output value. | Saved ÷ generated | Reduce wasted generations. | Bar | Med | ○ |
| KL-104 | What is the asset deletion/discard rate? | Waste signal. | Deleted ÷ generated | Coaching / model change. | Bar | Low | ○ |
| KL-105 | What is total storage consumed and its growth? | Infra cost & planning. | Storage GB + growth | Provision storage. | Area | Med | ○ |
| KL-106 | What is the average asset size by type/resolution? | Storage cost driver. | Avg MB by type | Set output-spec policy. | Bar | Low | ○ |
| KL-107 | How many assets are missing/failed to capture? | Data-completeness of the catalog. | Missing-asset count | Fix capture. | KPI | Med | ◐ |
| KL-108 | Which accounts produce the most stored assets? | Storage attribution. | Assets by account | Storage chargeback. | Ranked bar | Low | ◐ |

## 12. Productivity

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-109 | How many successful outputs per active account per day? | Real throughput per login. | Successful gens ÷ active days | Set productivity targets. | Bar | Med | ◐ |
| KL-110 | What is the output-to-attempt ratio (first-try success)? | Efficiency of effort. | Successful ÷ attempts | Coach prompting. | Gauge | Med | ◐ |
| KL-111 | How much rework (re-runs) per successful output? | Wasted effort. | Re-runs ÷ success | Reduce rework. | Bar | Med | ◐ |
| KL-112 | Which accounts deliver most output per credit? | Efficiency leaders. | Output ÷ credits | Replicate their patterns. | Sorted bar | High | ● |
| KL-113 | Is productivity improving as accounts mature? | Learning-curve signal. | Output/credit over tenure | Sustain enablement. | Trend by cohort | Med | ◐ |
| KL-114 | What is the ratio of interactive vs batch usage? | Working-style insight. | Session-based split | Tooling & scheduling. | Donut | Low | ◐ |
| KL-115 | How does productivity vary by model/mode chosen? | Tool choice affects output. | Output per credit by model | Recommend best-value model. | Grouped bar | Med | ◐ |
| KL-116 | What is the idle ratio (accounts provisioned but unused)? | Reclaim waste. | Unused ÷ provisioned accounts | Deprovision idle accounts. | KPI | Med | ● |

## 13. Trend Analysis

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-117 | What is the generation growth rate (WoW / MoM)? | Trajectory of demand. | Growth % | Confirm scaling pace. | Trend + % | High | ● |
| KL-118 | Is credit/₹ spend growing faster than output? | Efficiency erosion warning. | Δ cost vs Δ output | Intervene on efficiency. | Dual-axis trend | High | ● |
| KL-119 | How is the model mix shifting over time? | Capability/cost drift. | Model share over time | Update routing policy. | Stacked area | Med | ◐ |
| KL-120 | Are peak hours shifting over time? | Capacity re-planning. | Hourly profile over months | Re-time capacity. | Heatmap over periods | Low | ● |
| KL-121 | Is the active-account base expanding or contracting? | Adoption health. | Active accounts trend | Adjust rollout. | Line | Med | ● |
| KL-122 | What is the trend in success/reliability? | Quality trajectory. | Success % trend | Sustain or fix. | Trend | High | ◐ |
| KL-123 | What is the trend in cost per output? | Unit-economics trajectory. | ₹/output over time | Scale decision. | Trend | High | ◐ |
| KL-124 | Are re-run/waste rates trending down? | Enablement effectiveness. | Waste % trend | Continue/adjust coaching. | Trend | Med | ◐ |

## 14. Capacity Planning & Forecasting

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-125 | What is the forecast credit demand for next 30/60/90 days? | Buy credits ahead of need. | Forecast credits + band | Time purchases. | Forecast line | Exec | ○ |
| KL-126 | What is the forecast ₹ spend next quarter? | Budget certainty. | Forecast ₹ | Set budget. | Forecast line | Exec | ○ |
| KL-127 | When will each account run out of credits? | Prevent stockouts. | Days-to-zero per account | Schedule top-ups. | Burn-down per account | High | ◐ |
| KL-128 | What peak capacity must we support (concurrent load)? | Avoid throttling at peaks. | Peak hourly load + headroom | Provision capacity. | Peak profile | Med | ● |
| KL-129 | What is the forecast active-account growth? | Seat/plan planning. | Forecast active accounts | Plan account purchases. | Forecast line | Med | ○ |
| KL-130 | What storage growth should we provision for? | Infra budgeting. | Forecast storage GB | Provision storage. | Forecast area | Low | ○ |
| KL-131 | What credit buffer avoids stockout at target service level? | Safety-stock policy. | Recommended buffer | Set reorder point. | KPI + policy | Med | ◐ |
| KL-132 | What is the seasonality-adjusted baseline demand? | Separate trend from noise. | Deseasonalised baseline | Plan steady-state. | Decomposition | Low | ○ |

## 15. Operational Monitoring

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-133 | Is generation volume abnormally high/low right now vs baseline? | Live health signal. | Today vs rolling baseline | Investigate deviation. | KPI + control band | High | ● |
| KL-134 | Are any accounts silent (stopped generating unexpectedly)? | Detect breakage / offboarding. | Recency alert per account | Investigate/act. | Recency table | Med | ● |
| KL-135 | Is capture coverage dropping (data pipeline health)? | Protects all downstream analytics. | Captured ÷ observed trend | Fix pipeline. | Trend + alert | High | ● |
| KL-136 | Is spend pacing ahead of budget this month? | Budget guardrail. | MTD ₹ vs budget pace | Throttle or approve. | Pace gauge | High | ● |
| KL-137 | Are credits about to deplete on any active account? | Prevent work stoppage. | Low-balance alerts | Top-up. | Alert list | High | ◐ |
| KL-138 | Is success/reliability below threshold today? | Live SLA monitoring. | Success % vs SLO | Escalate. | Gauge + alert | Med | ◐ |
| KL-139 | Are there unusual off-hours generation bursts? | Security/misuse signal. | Off-hours volume spike | Investigate. | Timeline + flags | Med | ● |
| KL-140 | What is the current queue/backlog depth? | Live congestion. | In-flight/pending count | Add capacity. | KPI | Low | ○ |

## 16. Anomaly, Abuse & Governance

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-141 | Are there unusual credit-spike events? | Cost-shock and misuse detection. | Credit z-score anomalies | Investigate spikes. | Control chart | High | ◐ |
| KL-142 | Is any account showing bot-like / automated patterns? | Abuse prevention. | Rate/regularity anomalies | Rate-limit / review. | Anomaly flags | Med | ○ |
| KL-143 | Are there duplicate/near-duplicate generations at scale? | Waste & abuse. | Duplicate rate | De-dupe / coach. | Cluster view | Med | ○ |
| KL-144 | Which accounts exceed fair-use thresholds? | Governance & caps. | Usage vs policy threshold | Enforce caps. | Threshold table | Med | ◐ |
| KL-145 | Are prompts violating content/safety policy? | Compliance risk. | Flagged-prompt rate | Enforce policy. | Flag list | Med | ○ |
| KL-146 | Is there sudden concentration of spend in one account? | Key-account/cost risk. | Concentration spike | Diversify / review. | Pareto + alert | Med | ● |
| KL-147 | Are there sign-in/usage patterns inconsistent with a single owner? | Shared-credential risk. | Session/device anomalies | Tighten credential policy. | Anomaly view | Low | ○ |
| KL-148 | What is the overall data-quality/anomaly score for Kling analytics? | Trust in the numbers. | Composite DQ score | Prioritise data fixes. | Scorecard | Med | ◐ |

## 17. Recommendations

| ID | Question | Why it matters | Metric(s) | Business Decision | Visualization | Priority | Ready |
|----|----------|----------------|-----------|-------------------|---------------|----------|-------|
| KL-149 | What are the highest-value next actions for Kling cost/usage? | Turns insight into action. | Ranked recommendations + confidence | Fund highest-confidence actions. | Ranked cards | Exec | ◐ |
| KL-150 | How should we allocate/purchase credits across accounts next month? | Optimises spend & runway. | Recommended per-account allocation | Approve purchase plan. | Allocation table | High | ◐ |
| KL-151 | Which accounts should be capped, coached, or retired? | Cost & governance action. | Efficiency + usage tiers | Act per account. | Action matrix | High | ● |
| KL-152 | Which model/mode should be the default for best value? | Value-based routing. | ₹/output by model ranking | Set default model. | Ranked bar | Med | ◐ |
| KL-153 | Where can we cut Kling cost without losing output? | Protect margin. | Waste % + cost outliers | Route/cap/renegotiate. | Waterfall | Exec | ◐ |
| KL-154 | Which accounts need a credit top-up now to avoid stoppage? | Continuity. | Low-runway list | Approve top-ups. | Alert list | High | ◐ |
| KL-155 | What capture/instrumentation gaps most limit our analytics, ranked by unlock? | Prioritise the data roadmap. | Gap → unlock impact | Fund instrumentation. | Impact/effort matrix | High | ● |
| KL-156 | What is the single best reliability fix to reduce wasted spend? | Fastest ROI action. | Failure-cause × wasted ₹ | Fund the top fix. | Pareto + ₹ | High | ○ |

---

## Readiness roll-up (what to fund to unlock the rest)

| Bucket | Approx. share | Notes |
|--------|---------------|-------|
| **● Now** | ~40% | Account/user, cost (₹), credit, time, prompt (text), operational-volume questions. |
| **◐ Partial** | ~35% | Blocked by: single-login capture (per-employee/dept), all-`active` status (no real failure signal yet), sparse model/duration/resolution labels, per-account credit balance. |
| **○ Capture / Model** | ~25% | Needs new instrumentation (retries, queue/render latency, cancellation, asset lifecycle, storage) or models (forecast, anomaly, prompt similarity/classification). |

**Top 4 instrumentation unlocks, ranked by analytics value:**
1. **Per-employee attribution at capture** — turns all ◐ per-account cuts into true per-user *and* per-department analytics (Sections 3, 4, 12).
2. **Structured generation status + failure reason** — currently everything is `active`; unlocks real success/failure, reliability, waste (Sections 8, most of 7).
3. **Timing/latency capture (queue → render → complete)** — unlocks all of Generation Performance (Section 7).
4. **Asset lifecycle events (download/save/delete/size)** — unlocks Asset Analytics (Section 11) and storage forecasting.
