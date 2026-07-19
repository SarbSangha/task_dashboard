# Reports Module — Analytics Mapping: Prompt Intelligence

**Scope:** Design spec for the Prompt Intelligence slice — *Prompt Performance,
Golden Prompt Library, Prompt Leaderboard, Prompt Evolution.* Every card traces
**Business Question → Data Source → Available Fields → Metric Formula → Visualization → Business Decision.**

**Why this slice matters:** it closes the flywheel — Power Users (already identified) →
their prompts → winning patterns → a Golden Prompt Library → the future recommendation engine.

**Architecture:** identical to shipped slices — faculty-gated `/api/reports/*`
aggregations over existing models, rendered through the shared Reports primitives. No mock data.

---

## Data availability & honesty constraints (read first)

| Signal | Captured? | Source & fields | Treatment |
|---|---|---|---|
| Generation prompt text | ✅ Yes | `generation_records.prompt_text` | Real — grouping key for reuse/golden |
| **Prompt → output success** | ✅ **Yes** | `generation_records.capture_status ∈ {active,completed}` | **Real** — the core prompt-effectiveness signal |
| Prompt reuse | ✅ Derivable | normalized `prompt_text` repeated | Real — exact/whitespace-normalized match |
| Prompt owner / creator | ✅ Yes | `generation_records.owner_user_id`, earliest `created_at` | Real |
| Prompt category / theme | ✅ Yes | `generation_tags.normalized_tag`, `model_label` | Real — tags as themes, model as type |
| ChatGPT prompts | ✅ Yes | `conversation_prompts.prompt_text`, `.prompt_length`, `.created_at` → conversation → owner | Real for **volume/length/reuse only** — no success signal |
| **Prompt "quality" score** | ❌ No | — | **Not stored.** Replaced by a documented **Prompt Performance Score** (success + adoption + volume + uniqueness). Never labelled "quality". |
| Semantic prompt classification | ❌ No | — | Not attempted — themes come from real tags only |

> **Normalization** for reuse/golden: `lower(trim(collapse_whitespace(prompt_text)))`, truncated to 400 chars. **A prompt is "successful"** when its generation `capture_status ∈ {active, completed}`.

---

## Derived score (transparent, from real signals only)

**Prompt Performance Score** — 0–100, never called "quality":

| Component | Weight | Formula (real data) |
|---|---|---|
| Success | 50% | `successful_generations ÷ total_generations × 100` |
| Volume / adoption | 30% | `min(100, prompts^0.6 × 8)` (log-shaped) |
| Uniqueness | 20% | `distinct_normalized_prompts ÷ total_prompts × 100` (creativity, not repetition) |

`Score = 0.5·Success + 0.3·Volume + 0.2·Uniqueness` — used to rank prompt engineers.

**Golden prompt** = a normalized prompt with `uses ≥ 3` **and** `successRate ≥ 80%`, ranked by `uses × successRate`.

---

## New API endpoints (to build)

| Endpoint | Purpose |
|---|---|
| `GET /api/reports/prompts/summary` | Total prompts, successful-prompt %, reuse rate, unique prompts, avg length + Δ |
| `GET /api/reports/prompts/trends` | Daily prompt volume + success-rate over time, top themes (tags), success by model |
| `GET /api/reports/prompts/golden` | Golden Prompt Library — reused, high-success prompts with creator, category, uses, success, recommended-for |
| `GET /api/reports/prompts/engineers` | Top prompt engineers — prompts, success rate, uniqueness, Prompt Performance Score |

Params: `?start=&end=&department=`.

---

## 1. Prompt Performance
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| PP-01 | How many prompts are we running? | `generation_records` + `conversation_prompts` | `prompt_text`, `created_at` | count(gen prompts) + count(chat prompts) | KPI + sparkline | Capacity / enablement sizing |
| PP-02 | Which prompts generate successful outputs? | `generation_records` | `prompt_text`, `capture_status` | `successful ÷ total × 100` | KPI + success trend | Promote what works |
| PP-03 | How much do we reuse prompts vs reinvent? | `generation_records` | normalized `prompt_text` | `1 − distinct_norm ÷ total` | KPI | Push templating / libraries |
| PP-04 | What prompt themes dominate? | `generation_tags` | `normalized_tag` | count by tag (top N) | Horizontal bar | Focus templates on top themes |
| PP-05 | Which models yield the best prompt success? | `generation_records` | `model_label`, `capture_status` | success rate by model | Bar | Model routing guidance |
| PP-06 | How long/complex are prompts? | `conversation_prompts` / `generation_records` | `prompt_length`, `length(prompt_text)` | avg length | KPI | Coaching on prompt structure |

## 2. Golden Prompt Library
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| GP-01 | What are our proven, reusable prompts? | `generation_records` | normalized `prompt_text`, `capture_status` | uses ≥ 3 AND success ≥ 80%, ranked by `uses×success` | **Golden prompt cards** | Publish to shared library |
| GP-02 | Who created each golden prompt? | earliest record owner | `owner_user_id`, `created_at` | first-seen owner | Card "Created by" | Credit & mentor sourcing |
| GP-03 | What category is it, and who should use it? | `model_label`, `users.department` | model + dominant department | modal department among users | Card "Category / Recommended for" | Targeted rollout |
| GP-04 | How proven is it? | `generation_records` | uses, success | success rate + use count | Card metrics | Confidence to standardise |

## 3. Prompt Leaderboard (Top Prompt Engineers)
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| PL-01 | Who are our best prompt engineers? | `generation_records` per owner | `prompt_text`, `capture_status` | Prompt Performance Score (above) | Leaderboard → drill | Recruit champions / mentors |
| PL-02 | Who writes the most reliable prompts? | per owner | `capture_status` | success rate | Table col | Recognition |
| PL-03 | Who is most inventive vs repetitive? | per owner | distinct norm ÷ total | uniqueness % | Table col | Balance novelty vs templating |
| PL-04 | How does this map to AI Champions? | join to power-users | maturityScore | side-by-side ranking | Shared with User Intelligence | Unified champion view |

## 4. Prompt Evolution
| # | Business Question | Data Source | Available Fields | Metric Formula | Visualization | Decision |
|---|---|---|---|---|---|---|
| PE-01 | Are users getting better at prompting? | `generation_records` over time | `created_at`, `capture_status` | success rate per day/week | Line trend | Measure enablement impact |
| PE-02 | Is prompt volume growing? | `generation_records` | `created_at` | prompts per day | Area | Adoption momentum |
| PE-03 | Are prompts getting more sophisticated? | `prompt_length` over time | `length(prompt_text)` | avg length trend | Line | Coaching effectiveness |

> **Honest framing of "getting better":** we show **real prompt success-rate over time** and average length — not a fabricated 62→84 "quality" curve. Success rate is a measured outcome; a semantic quality model does not exist and is not invented.

---

## UI composition
- **Prompt Performance** (`prompt-performance`): 5 KPIs (Total Prompts, Successful %, Reuse Rate, Unique Prompts, Avg Length) → success-rate trend + volume area + top-themes bar + success-by-model bar.
- **Golden Prompt Library** (`golden-prompts`): searchable **golden prompt cards** — #, creator, category/model, success rate, uses, recommended-for; sortable by uses/success.
- **Prompt Leaderboard** (`prompt-leaderboard`): top prompt engineers table (Performance Score, success, prompts, uniqueness) with drill-down; champion badges shared with User Intelligence.
- **Prompt Evolution** (`prompt-evolution`): success-rate line + volume area + avg-length line, with an "are we improving?" insight.

_Analytics & BI Office — Reports module, slice 4._
