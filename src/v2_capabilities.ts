export interface OpenBrainCapability {
  name: string;
  description: string;
  inputs: string[];
  output: string;
}

export const OPENBRAIN_CAPABILITIES: OpenBrainCapability[] = [
  {
    name: "anchor_search",
    description: "Hybrid retrieval over published canonical messages (vector + lexical/trigram).",
    inputs: ["query", "chatNamespace", "filters", "k"],
    output: "ranked anchors with actor/timestamp/provenance"
  },
  {
    name: "context_window",
    description: "Fetch bounded chronological context around an anchor in a conversation.",
    inputs: ["conversationId", "anchorMessageId", "beforeN", "afterN", "chatNamespace"],
    output: "ordered message window"
  },
  {
    name: "thread",
    description: "Fetch reply-chain continuity up/down around a message.",
    inputs: ["messageId", "direction", "depth", "chatNamespace"],
    output: "ordered thread slice"
  },
  {
    name: "temporal_filtering",
    description: "Apply relative and absolute time constraints (today, yesterday, month, year).",
    inputs: ["timeframe", "hardRange"],
    output: "time-filtered evidence list"
  },
  {
    name: "quality_gate",
    description: "Restrict trusted outputs to published artifacts only.",
    inputs: ["artifact_state"],
    output: "candidate|published quality isolation"
  },
  {
    name: "iterative_refinement",
    description: "Run bounded follow-up retrieval rounds when sufficiency is low.",
    inputs: ["initialEvidence", "maxLoops"],
    output: "refined evidence set"
  },
  {
    name: "provenance_trace",
    description: "Persist full ask run trace and evidence lineage.",
    inputs: ["traceId", "answerRunId"],
    output: "auditable answer steps and evidence links"
  }
];

export function getOpenBrainCapabilities(): OpenBrainCapability[] {
  return OPENBRAIN_CAPABILITIES.map((cap) => ({ ...cap }));
}
