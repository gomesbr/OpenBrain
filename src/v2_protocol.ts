import { z } from "zod";

export const v2AgentRequestEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  messageId: z.string().min(1),
  traceId: z.string().min(1),
  conversationId: z.string().min(1),
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),
  messageType: z.string().min(1),
  intent: z.string().min(1),
  payload: z.record(z.unknown()),
  constraints: z.record(z.unknown()),
  context: z.record(z.unknown()),
  createdAt: z.string().datetime()
});

export const v2AgentResponseEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  messageId: z.string().min(1),
  traceId: z.string().min(1),
  inReplyTo: z.string().min(1),
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),
  messageType: z.string().min(1),
  status: z.enum(["ok", "retry", "failed"]),
  decision: z.enum(["promote", "hold", "reject", "retry", "deprecate"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  outputs: z.record(z.unknown()),
  qualitySignals: z.record(z.unknown()),
  createdAt: z.string().datetime()
});

export type V2AgentRequestEnvelopeParsed = z.infer<typeof v2AgentRequestEnvelopeSchema>;
export type V2AgentResponseEnvelopeParsed = z.infer<typeof v2AgentResponseEnvelopeSchema>;

export function validateV2RequestEnvelope(value: unknown): V2AgentRequestEnvelopeParsed {
  return v2AgentRequestEnvelopeSchema.parse(value);
}

export function validateV2ResponseEnvelope(value: unknown): V2AgentResponseEnvelopeParsed {
  return v2AgentResponseEnvelopeSchema.parse(value);
}
