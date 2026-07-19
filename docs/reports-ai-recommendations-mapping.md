# Reports Module — Analytics Mapping: AI Recommendations

**Scope:** Design spec for the AI Recommendations slice — the decision-intelligence
layer that converts every prior signal into **evidence-backed, confidence-scored actions.**
Each recommendation type traces
**Recommendation Type → Data Sources → Signals Used → Scoring Logic → Confidence Calculation → Visualization → Business Decision.**

**Design stance (non-negotiable):**
- **Rules-based & transparent** — a documented heuristic engine, not an ML black box.
- **Evidence-first** — every card shows the data points behind it.
- **No causation claims** — recommendations are *evidence-based suggestions*, never "this will cause +30%."
- **Confidence is explicit** — a heuristic score (data volume × effect size), labelled as such, not a statistical p-value.

---

## Data availability & honesty constraints (read first)

| Signal | Captured? | Source | Treatment |
|---|---|---|---|
| Tool efficiency (success, cost/output) | ✅ | `generation_records` | Real — Tool & Cost recs |
| Model success | ✅ | `generation_records.model_label` + `capture_status` | Real — model-routing recs |
| Golden prompts | ✅ | normalized `prompt_text` + success | Real — Prompt recs |
| User AI maturity, tool diversity | ✅ | generations + activity + conversations | Real — User/Training recs |
| Department adoption | ✅ | AI ownership vs `users` headcount | Real — Department recs |
| Churn risk | ✅ | `user_activities` recency | Real — re-engagement recs |
| AI↔productivity link | ⚠️ correlation only | cohort comparison (Task Intelligence) | Used **only** as supporting correlation evidence, labelled |
| **Recommendation acceptance / outcome** | ❌ **Not stored** | — | **Future architecture** (see below). v1 does not persist or claim outcomes. |

### Future architecture (documented, NOT built in v1)

To measure whether recommendations work, a future table is required:

```
recommendation_events
  id, recommendation_key, type, target_kind, target_id,
  user_id (actor), shown_at, accepted_at, dismissed_at,
  snapshot_json (evidence at time shown), impact_metric_before, impact_metric_after
```

This unlocks **acceptance rate**, **recommendation accuracy**, and **post-acceptance impact**.
Until it exists, v1 ships **stateless, evidence-based recommendations** and the UI's
accept/dismiss is session-local only (clearly not persisted).

---

## Confidence model (shared, transparent)

Every recommendation's confidence is a **heuristic 0–99 score**, not a statistical interval:

```
confidence = clamp(10 + volumeFactor + effectFactor, 0, 99)
  volumeFactor = min(45, 15 · log10(sampleSize + 1))     # more observations → more trust
  effectFactor = min(45, effect · 45)                     # effect ∈ [0,1], magnitude of the opportunity
Band: ≥75 High · 50–74 Medium · <50 Low
```

`sampleSize` and `effect` are defined per rule (below). This makes confidence **reproducible and explainable** — the exact inputs are returned with each card.

---

## New API endpoint

`GET /api/reports/recommendations?start=&end=&department=&type=` (faculty-gated)
→ `{ recommendations: [ ... ], summary: { byType, total, highConfidence } }`

Each recommendation object:
```
{ id, type, title, action, reason:[…evidence strings…], evidence:{…},
  expectedImpact: "High|Medium|Low", confidence: int, confidenceBand,
  targets: "Marketing" | "12 users", priority }
```

---

## Recommendation types

### 1. Tool Recommendations
| Field | Detail |
|---|---|
| Data Sources | `generation_records` (provider, capture_status, credits) |
| Signals | success rate & cost/output per tool; usage share |
| Scoring Logic | Recommend standardising toward the tool with best success **and** lowest cost/output; flag the worst-value tool for review |
| Confidence | sampleSize = generations on the tool; effect = success/cost gap vs alternatives |
| Visualization | Recommendation card + evidence (success %, cr/output) | 
| Decision | Route work / renegotiate / retire |

### 2. Prompt Recommendations
| Field | Detail |
|---|---|
| Data Sources | `generation_records.prompt_text` + `capture_status` (golden aggregation) |
| Signals | golden prompts (uses ≥3, success ≥80%), their top department |
| Scoring Logic | Promote top golden prompts org-wide and to the team that already relies on them |
| Confidence | sampleSize = uses; effect = successRate/100 |
| Visualization | Card with prompt preview, creator, success, uses |
| Decision | Publish to shared library / push to teams |

### 3. Department Recommendations
| Field | Detail |
|---|---|
| Data Sources | AI ownership (`generation_records`/`conversation_records`) vs `users` headcount; Task cohort correlation |
| Signals | department AI-adoption %; org-average adoption; correlation throughput delta |
| Scoring Logic | Recommend enablement for departments materially below org-average adoption (min headcount) |
| Confidence | sampleSize = dept headcount; effect = adoption gap vs org avg |
| Visualization | Card: adoption %, gap, supporting correlation |
| Decision | Run targeted enablement |

### 4. User Recommendations
| Field | Detail |
|---|---|
| Data Sources | maturity computation (generations, activity, conversations); retention recency |
| Signals | single-tool high-volume users; AI Champions; churn-risk users |
| Scoring Logic | (a) introduce a 2nd tool to single-tool power users; (b) deploy Champions as mentors; (c) re-engage at-risk users |
| Confidence | sampleSize = affected users; effect = magnitude (share of base / risk) |
| Visualization | Card with target count + rationale |
| Decision | Nudge / mentor program / win-back |

### 5. Training Recommendations
| Field | Detail |
|---|---|
| Data Sources | prompt-engineer success; maturity components |
| Signals | active users with low prompt success; Explorers near Practitioner threshold |
| Scoring Logic | Prompt-craft training for low-success active users; targeted coaching to advance Explorers |
| Confidence | sampleSize = candidate users; effect = success gap / proximity to next level |
| Visualization | Card with candidate count + weakest component |
| Decision | Schedule enablement cohorts |

### 6. Cost Optimization
| Field | Detail |
|---|---|
| Data Sources | `generation_records.credits_burned` + `capture_status` |
| Signals | wasted credits on failures; cost/output outliers; model cost-efficiency |
| Scoring Logic | Recommend reliability fixes where waste is high; route to cheaper model where success is comparable |
| Confidence | sampleSize = generations; effect = wasted % / cost gap |
| Visualization | Card with wasted credits, cost/output |
| Decision | Fund reliability / cap / re-route |

---

## UI composition
- **AI Recommendations** (`recommendations`): a summary strip (total, high-confidence count, by-type) + **type filter chips** (All · Tool · Prompt · Department · User · Training · Cost) + a ranked list of **recommendation cards**.
- Each card: type tag, title, **confidence band + score**, expected-impact chip, evidence bullet list, target, and a **session-local Accept/Dismiss** (explicitly "not yet persisted — acceptance tracking is the next dependency").
- Cards sorted by confidence × priority; brand-neutral, token-driven, consistent with every prior slice.

_Analytics & BI Office — Reports module, slice 6 (final of the core stack)._
