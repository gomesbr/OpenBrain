# OpenBrain Phase 2 Execution Checklist

## Goal
Upgrade from Phase 1 foundations to higher-quality Social + Behavior intelligence:
- Better entity and relationship extraction
- Better insight quality and scoring
- Better query answers with evidence and confidence consistency

This checklist is designed to run only after Phase 1 rebuild and baseline validation complete.

## 0) Go/No-Go Gate (Must Pass Before Phase 2)

1. Rebuild status:
- `brain_jobs` latest rebuild is `completed` or `partial`.
- `failedItems / queuedItems <= 1%`.

2. Baseline UX checks:
- `Insights` tab returns non-empty list.
- `People` graph shows connected nodes and edges.
- `Behavior` chart shows non-zero series data.
- `Ask` returns evidence snippets for at least 3 real questions.

3. Ops health:
- OpenBrain API responds `ok=true` on `/v1/health`.
- No repeated restart loop or auth failures in container logs.

## 1) Baseline Test Script (Before Any Phase 2 Code)

1. Authenticate:
```powershell
$base = "http://127.0.0.1:4301"
$password = "YOUR_PASSWORD"
$token = (Invoke-RestMethod -Method POST -Uri "$base/v1/auth/login" -ContentType "application/json" -Body (@{password=$password}|ConvertTo-Json)).token
```

2. Check latest jobs:
```powershell
Invoke-RestMethod -Method GET -Uri "$base/v1/brain/jobs?limit=5" -Headers @{Authorization="Bearer $token"} | ConvertTo-Json -Depth 8
```

3. Validate key endpoints:
```powershell
Invoke-RestMethod -Method GET -Uri "$base/v1/brain/profile?chatNamespace=personal.main&timeframe=30d" -Headers @{Authorization="Bearer $token"}
Invoke-RestMethod -Method GET -Uri "$base/v1/brain/graph?chatNamespace=personal.main&graphType=relationships" -Headers @{Authorization="Bearer $token"}
Invoke-RestMethod -Method GET -Uri "$base/v1/brain/insights?chatNamespace=personal.main&timeframe=30d" -Headers @{Authorization="Bearer $token"}
Invoke-RestMethod -Method POST -Uri "$base/v1/brain/query" -Headers @{Authorization="Bearer $token"} -ContentType "application/json" -Body (@{question="Who are my top contacts lately?";chatNamespace="personal.main"}|ConvertTo-Json)
```

## 2) Phase 2 Scope (Locked Implementation Order)

### 2.1 Entity Extraction Upgrade
1. Add stronger person/topic extraction:
- Use metadata fields + text heuristics + optional LLM extraction pass.
- Normalize aliases (first name, full name, known nickname mapping).

2. Improve entity confidence:
- Score by source consistency, repeated mentions, and recency.

3. Persist provenance:
- Keep source reason and extractor version in `brain_entities.metadata`.

### 2.2 Relationship Modeling Upgrade
1. Add richer edge types:
- `interaction`, `support`, `conflict`, `humor`, `work_collab`, `family`.

2. Update edge scoring:
- Weighted by frequency, sentiment proxy, and recency decay.

3. Add rolling summaries:
- Weekly and monthly social-change deltas.

### 2.3 Insights Upgrade (Social + Behavior)
1. Add insight templates:
- Closest circle changes
- Reciprocity imbalance
- Communication drift
- Habit stability and variance
- Stress/mood trigger candidates

2. Confidence rubric:
- High: repeated evidence across 3+ days and 2+ sources.
- Medium: repeated evidence in one source or short window.
- Low: sparse or conflicting evidence.

3. Action generation:
- One clear action per insight with expected impact statement.

### 2.4 Query Quality Upgrade
1. Query classifier:
- `lookup`, `pattern`, `diagnosis`, `prediction`, `recommendation`.

2. Retrieval orchestration:
- Blend raw memory matches + fact tables + relationship edges.

3. Answer composer:
- Structured output with summary + confidence + optional evidence drawer.

### 2.5 UI Upgrade
1. People screen:
- Add top contacts ranking list + filter by time window.

2. Insights screen:
- Add severity and confidence visual badges.

3. Ask screen:
- Add query type chip and evidence count summary.

## 3) Data Quality Checks (After Phase 2 Build)

1. Alias quality:
- Common variants map to same entity id.

2. Relationship sanity:
- No self-loop spam, no duplicate bidirectional inflation.

3. Insight correctness:
- Spot-check 20 insights with evidence grounding.

4. Question quality:
- Evaluate fixed query set (20 prompts) for relevance and confidence calibration.

## 4) Performance Targets

1. `/v1/brain/query` p95 under 500ms on current dataset.
2. `/v1/brain/graph` response under 1.5s with pagination/limits.
3. Worker keeps pending queue stable under normal ingestion load.

## 5) Safety and Privacy Targets

1. `share_safe` never leaks direct identifiers.
2. `demo` never emits real raw message snippets.
3. Medical and psychological responses include non-diagnostic guardrail text.

## 6) Rollout Plan

1. Build in feature-flag mode:
- `OPENBRAIN_PHASE2_ENABLED=0|1`.

2. Shadow mode:
- Compute upgraded insights without replacing current output for 24h.

3. Cutover:
- Enable Phase 2 output if quality checks pass.

4. Rollback:
- Disable `OPENBRAIN_PHASE2_ENABLED` to revert to current behavior.

## 7) Done Criteria

1. All baseline and phase-2 tests pass.
2. Social + Behavior insights are measurably richer and evidence-backed.
3. No privacy regressions in share-safe/demo modes.
4. Runtime stability maintained under long backfill and daily incremental updates.
