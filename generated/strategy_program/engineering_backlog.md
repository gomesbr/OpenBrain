# OpenBrain Engineering Backlog

Updated: 2026-03-10

1. Re-run corpus semantic refresh after row-level classifier changes
Reason:
- `memory_items` and `canonical_messages` metadata can become stale when `inferStructuredSignals(...)` improves.
- Support scan can compensate partially at runtime, but benchmark quality and ontology discovery will be more accurate after a full semantic refresh + canonical sync.
When to do it:
- after material changes to `src/domain_inference.ts`
- after material changes to `src/metadata_provider.ts`
Recommended workflow:
- `npm run metadata:refresh:canonical -- --chat=personal.main --only-missing=0`
- then rerun taxonomy support scan
- then regenerate ontology candidates

2. Close the remaining unsupported taxonomy-v2 pairs after benchmark adapter expansion
Current state:
- `taxonomy_v2` support scan now reaches `541 / 559` supported pairs.
- The remaining unsupported set is concentrated in a small number of low-signal or thin-context classes.
Main blockers:
- low-signal anchors
- file/meta fragments
- thin causal/explanatory signal in some human/social domains
- thin temporal series for a few trend/outlier cases
Recommended workflow:
- inspect unsupported pairs by dominant failure reason
- tighten anchor selection for the affected domains
- improve lens-aware context expansion where the failure is temporal/causal
- rerun taxonomy support scan

3. Improve metadata/facet benchmark coverage over the published corpus
Current state:
- facet discovery is now live across the full published corpus
- `taxonomy_v2` facet coverage currently shows strong gap volume in:
  - actor names
  - group labels
  - thread titles
  - month buckets
Reason:
- the benchmark now understands these facets, but it still under-samples them relative to corpus volume
Recommended workflow:
- add benchmark seeding pressure toward uncovered high-volume facets
- regenerate the benchmark
- rerun facet coverage scan
