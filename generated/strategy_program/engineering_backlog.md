# OpenBrain Engineering Backlog

Updated: 2026-03-12

## Problem Theme

The current benchmark pipeline is not failing because the corpus is too small or the taxonomy is too broad. The remaining work is now narrower: keep the corpus semantics fresh, close the last unsupported taxonomy pairs, improve facet coverage, and eliminate the weak-grounding excluded slice.

## 1. Re-run corpus semantic refresh after row-level classifier changes

Reason:
- `memory_items` and `canonical_messages` metadata can become stale when `inferStructuredSignals(...)` improves.
- Support scan can compensate partially at runtime, but benchmark quality and ontology discovery are more accurate after a full semantic refresh + canonical sync.

When to do it:
- after material changes to `src/domain_inference.ts`
- after material changes to `src/metadata_provider.ts`

Recommended workflow:
- `npm run metadata:refresh:canonical -- --chat=personal.main --only-missing=0`
- rerun taxonomy support scan
- regenerate ontology candidates

## 2. Close the remaining unsupported taxonomy-v2 pairs after benchmark adapter expansion

Current state:
- `taxonomy_v2` support scan reached `541 / 559` supported pairs.
- The remaining unsupported set is concentrated in low-signal or thin-context classes.

Main blockers:
- low-signal anchors
- file/meta fragments
- thin causal/explanatory signal in some human/social domains
- thin temporal series for trend/outlier cases

Fix plan:
- inspect unsupported pairs by dominant failure reason
- tighten anchor selection for affected domains
- improve lens-aware context expansion where the failure is temporal/causal
- rerun taxonomy support scan

## 3. Improve metadata/facet benchmark coverage over the full published corpus

Current state:
- facet discovery is live across the full published corpus
- strong gap volume still exists in:
  - actor names
  - group labels
  - thread titles
  - month buckets

Reason:
- the benchmark understands these facets, but still under-samples them relative to corpus volume

Fix plan:
- add benchmark seeding pressure toward uncovered high-volume facets
- regenerate benchmark slices using facet coverage as an explicit target
- rerun facet coverage scan

## 4. Weak-grounding recovery plan for excluded calibration cases

Goal:
- eliminate the remaining excluded benchmark cases by fixing authoring and lens-fit behavior at the generator layer
- do not push weak cases into calibration as a workaround

Current state:
- some owner-pending cases remain excluded from calibration materialization
- they are blocked by `qualityGate.status = fail`
- dominant failure reason: `question_not_grounded_enough`

Failure families:
- `battery_range_planning | diagnostic`
- `battery_range_planning | predictive`
- `family_relationships | counterfactuals`
- `family_relationships | predictive`
- `family_relationships | thread_reconstruction`
- `romantic_relationship | counterfactuals`
- `romantic_relationship | timeline_reconstruction`
- `software_troubleshooting | actor_attribution`
- `work_execution | prescriptive`
- `work_execution | timeline_reconstruction`
- `financial_planning | confidence_scoring`

Fix plan:
- step 1: cluster excluded cases by failure family and inspect representative examples instead of one-off fixing
- step 2: require stronger support depth before higher-order lenses are generated
- step 3: add a downgrade path so weak higher-order variants fall back to simpler valid lenses
- step 4: suppress variants entirely when neither target nor downgraded lens is grounded enough
- step 5: regenerate only affected slices and rerun calibration materialization

Exit criteria:
- excluded slice materially shrinks
- regenerated cases pass quality gate
- calibration queue contains only grounded `clear` or `clarify_required` cases

## 5. Phase 2 backlog - conversational investigation workspace

Problem theme:
- the current graph can show structure, but it does not yet support a real answer-driven discovery journey
- the next capability is not "more graph nodes"; it is persistent scene-aware investigation grounded in the same evidence bundle that answered the question

Target experience:
- Ask remains the main entry point for memory questions
- after a grounded answer is returned, the user can open the answer in graph mode
- the graph becomes a persistent investigation session rather than a one-shot render
- follow-up questions operate on the active scene, not on the whole corpus from scratch

Investigation workspace requirements:
- maintain per-session scene state for:
  - active entities
  - active chats, groups, and threads
  - active evidence bundle
  - active time window
  - last answer object
  - ranked references such as `friend 1`, `friend 2`, `group X`
- add graph-chat follow-ups scoped to that active scene
- resolve contextual references such as:
  - `friend 3`
  - `that group`
  - `they`
  - `what each one said`
- every follow-up must return three coordinated outputs:
  - direct answer
  - scene update
  - evidence update

Required follow-up behaviors:
- relationship existence and path
- group co-membership
- compare and rank
- per-entity evidence summaries
- who-else and what-else exploration
- timeline branch-out from the current scene

Scene rules:
- keep the graph scoped to the current investigation scene instead of rebuilding from the whole universe on every turn
- preserve stable entity ordering so later references such as `friend 1` remain meaningful
- make the graph explanatory rather than exhaustive: show only the answer path plus the current investigation neighborhood

Guided exploration:
- add next-step suggestions based on the current scene, such as:
  - `See if these people know each other`
  - `Compare what each one said`
  - `Open the group where this happened`
  - `Show earlier mentions`

Evidence workspace:
- expand the bottom evidence reader into a multi-tab investigation surface with:
  - `Evidence`
  - `Thread`
  - `Context`
  - later `Timeline`
- make evidence navigation part of the scene workflow instead of only metadata on the side rail

Implementation note:
- Phase 2 should reuse the Phase 1 answer contract and scene seed
- do not create a separate graph retrieval engine
- keep Ask answer quality as the source of truth and treat graph investigation as a scoped continuation of that same grounded retrieval

## Implemented 2026-03-12

These capability upgrades were completed and removed from the active backlog:
- whole-corpus anchor quality upgrade
- statement ownership and speaker-target reasoning
- POV conversion
- structured extraction from long assistant answers
- evidence-family diversity control during generation
- whole-data benchmark mining in the authoring pool
