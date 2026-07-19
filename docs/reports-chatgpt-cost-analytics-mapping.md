# Reports Module — Analytics Mapping: ChatGPT Intelligence & Cost Intelligence

**Scope:** Design specification for the next Reports slice. Every report card is
traced end to end: **Business Question → Data Source → API → Metric → Visualization → Decision.**

**Architecture:** identical to the shipped Executive + Kling slice — faculty-gated
aggregation endpoints under `/api/reports/*` reading existing SQLAlchemy models,
rendered through the shared Reports primitives (`KpiCard`, `ChartFrame`, `DataTable`,
`InsightBanner`) with token-driven Recharts.

---

## Data availability & honesty constraints (read first)

| Signal | Captured? | Source | How we treat it |
|---|---|---|---|
| ChatGPT conversations, prompts, responses | ✅ Yes | `conversation_records.prompt_count`, `.response_count` | Real volume metrics |
| ChatGPT model / GPT version | ✅ Yes | `conversation_records.model_label`, `.gpt_version` | Real model-mix metrics |
| ChatGPT **billed tokens / $ cost** | ❌ **No** | — | **Not metered.** "Token Analysis" reports *message volume* + a clearly-labelled character-based **estimate**, never a billed figure. True token cost needs a provider-billing integration (flagged on the card). |
| Generation credits (Kling & records) | ✅ Yes | `generation_records.credits_burned` | Real cost proxy — the platform's primary spend signal |
| Dollar ROI baseline | ❌ No | — | ROI % renders as **"Baseline required"** until a pre-AI / cost baseline is configured |

**Success semantics:** `capture_status ∈ {active, completed}` = success; else counted as failure/waste.
**Provider filter:** ChatGPT = `provider = 'chatgpt'`; credits come from `generation_records` (Kling and other providers).

---

## New API endpoints (to build)

| Endpoint | Purpose |
|---|---|
| `GET /api/reports/chatgpt/summary` | ChatGPT KPI block (users, conversations, prompts, responses, avg depth) + Δ vs prior period |
| `GET /api/reports/chatgpt/trends` | Daily volume, model mix, by-department, by-hour |
| `GET /api/reports/chatgpt/users` | ChatGPT user leaderboard (conversations, prompts, top model) |
| `GET /api/reports/cost/summary` | Cost KPI block: total credits, cost/successful output, wasted credits, Δ |
| `GET /api/reports/cost/breakdown` | Credits by department, by provider/tool, daily trend, top spenders |

All accept `?start=&end=&department=` and are gated by `require_faculty`.

---

## 1. ChatGPT Analytics

### 1a. Adoption & Volume
| # | Business Question | Data Source | API | Metric / KPI | Visualization | Decision |
|---|---|---|---|---|---|---|
| CG-01 | How many people actively use ChatGPT, and is it growing? | `conversation_records.owner_user_id` (distinct), `.created_at`; `users` | `chatgpt/summary` | Unique ChatGPT users + MoM Δ% | KPI card + sparkline | Expand/scale seat provisioning |
| CG-02 | How much conversational AI work are we running? | `conversation_records` count; `sum(prompt_count)`, `sum(response_count)` | `chatgpt/summary` | Conversations · Prompts · Responses | KPI row | Size support & capacity |
| CG-03 | Is ChatGPT usage accelerating or plateauing? | `conversation_records.created_at` daily | `chatgpt/trends.daily` | Daily conversation trend | Area chart | Confirm adoption trajectory |
| CG-04 | How does ChatGPT compare to Kling in usage? | `conversation_records` vs `generation_records` daily | `chatgpt/trends` + `kling/trends` | Usage share by tool | Dual-line / share | Balance tool investment |

### 1b. Model Intelligence
| # | Business Question | Data Source | API | Metric / KPI | Visualization | Decision |
|---|---|---|---|---|---|---|
| CG-05 | Which GPT models does the org actually use? | `conversation_records.model_label` / `.gpt_version`, group by | `chatgpt/trends.byModel` | Model mix % (share) | Donut / ranked bar | Model routing & governance |
| CG-06 | Which departments lean on premium vs standard models? | `model_label` × `users.department` | `chatgpt/trends.byModel` (+dept) | Model share by department | Stacked bar | Cost & policy governance |

### 1c. Prompt Activity
| # | Business Question | Data Source | API | Metric / KPI | Visualization | Decision |
|---|---|---|---|---|---|---|
| CG-07 | How deep are conversations (prompts per chat)? | `avg(prompt_count)` | `chatgpt/summary` | Avg prompts / conversation | KPI card | Prompting-skill enablement |
| CG-08 | When is ChatGPT used most (peak hours)? | `conversation_records.created_at` hour buckets | `chatgpt/trends.byHour` | Conversations by hour of day | Bar (24h) | Support & change-window timing |
| CG-09 | Which teams generate the most conversational AI work? | `conversation_records` × `users.department` | `chatgpt/trends.byDepartment` | Conversations by department | Horizontal bar | Target enablement / recognition |

### 1d. ChatGPT Users
| # | Business Question | Data Source | API | Metric / KPI | Visualization | Decision |
|---|---|---|---|---|---|---|
| CG-10 | Who are the ChatGPT power users? | group by `owner_user_id`: count conv, sum prompts | `chatgpt/users` | Conversations, prompts, top model per user | Ranked table → user drill | Convert to internal champions |
| CG-11 | Which users only lightly use ChatGPT? | per-user conversation counts (long tail) | `chatgpt/users` | Low-usage segment | Table (ascending) | Targeted activation nudges |

---

## 2. Cost Intelligence

### 2a. Credit Usage
| # | Business Question | Data Source | API | Metric / KPI | Visualization | Decision |
|---|---|---|---|---|---|---|
| CO-01 | What is total AI cost (credits) and is it under control? | `sum(generation_records.credits_burned)` + daily | `cost/summary` + `cost/breakdown.daily` | Total credits + Δ% | KPI + area trend | Set consumption guardrails |
| CO-02 | Which departments drive spend? | `credits_burned` × `users.department` | `cost/breakdown.byDepartment` | Credit share by department | Horizontal bar / treemap | Allocate budgets & caps |
| CO-03 | Which tools/providers consume the most credits? | `credits_burned` × `provider` | `cost/breakdown.byProvider` | Credit share by tool | Donut | Renegotiate / rationalise tools |
| CO-04 | Who are the top credit spenders? | `credits_burned` × `owner_user_id` | `cost/breakdown.topUsers` | Credits per user | Ranked table → drill | Review or cap heavy users |
| CO-05 | How much spend is wasted on failed generations? | `credits_burned` where `capture_status ∉ success` | `cost/summary.wastedCredits` | Wasted credits + % | KPI + success/waste split | Fund reliability fixes |

### 2b. Token / Message Analysis *(volume + estimate — tokens not billed)*
| # | Business Question | Data Source | API | Metric / KPI | Visualization | Decision |
|---|---|---|---|---|---|---|
| CO-06 | What is ChatGPT message throughput? | `sum(prompt_count + response_count)` | `chatgpt/summary` | Total messages · avg/conversation | KPI cards | Capacity planning |
| CO-07 | What is the cost per successful output? | `credits_burned` ÷ successful `generation_records` | `cost/summary.costPerOutput` | Cost per successful output | KPI card | Model/prompt efficiency |
| CO-08 | *(Estimate)* Approx. token intensity | char length of `content_parts_json` ÷ 4 *(labelled estimate)* | `chatgpt/summary.estTokens` *(flagged)* | Est. tokens — directional only | KPI with "estimate" tag | Prioritise a billing integration |

### 2c. ROI Analysis
| # | Business Question | Data Source | API | Metric / KPI | Visualization | Decision |
|---|---|---|---|---|---|---|
| CO-09 | Is cost growing slower than output? | daily `credits` vs daily `generations` | `cost/breakdown.daily` | Cost-to-output ratio trend | Dual-axis line | Intervene if cost outpaces value |
| CO-10 | What is ROI-adjusted cost per department? | dept credits vs dept output volume | `cost/breakdown.byDepartment` | Credits per output by dept | Quadrant / bar | Reallocate to high-return teams |
| CO-11 | What is net ROI %? | requires $ value baseline | `cost/summary.roi` | **Baseline required** | KPI (baseline state) | Configure baseline before reporting |

---

## UI composition

- **ChatGPT Analytics** (`section = chatgpt`): Insight banner → 5 KPIs (users, conversations, prompts, responses, avg depth) → charts (daily trend, model-mix donut, by-department bar, peak-hour bar) → user leaderboard with drill-down.
- **Cost Intelligence** (`section = credit-usage | token-analysis | roi-analysis`): one `CostIntelligence` component with a `view` prop:
  - `credit-usage` → cost KPIs + credit trend + by-department + by-provider + top-spender table
  - `token-analysis` → ChatGPT message volume + cost-per-output + estimate card (flagged)
  - `roi-analysis` → cost-to-output ratio + ROI-adjusted dept view + ROI baseline card
- Reuses every shared primitive and the theme-aware chart palette; no new design language.

_Analytics & BI Office — Reports module, slice 2._
