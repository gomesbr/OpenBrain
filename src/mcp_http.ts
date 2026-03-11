import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { batchCapture, captureMemory, getStats, listRecent, searchMemory } from "./db.js";
import { askV2, submitAskFeedback } from "./v2_ask.js";
import { getQualityMetrics } from "./v2_quality.js";
import { searchPublishedFacts, searchPublishedGraph } from "./v2_search.js";

export async function mountMcpHttp(app: Express, path = "/mcp"): Promise<void> {
  const mcpServer = new McpServer({
    name: "openbrain",
    version: "1.0.0"
  });

  mcpServer.registerTool(
    "openbrain.ask",
    {
      title: "OpenBrain Ask V2",
      description: "Ask OpenBrain V2 with multi-agent reasoning and quality gate contract.",
      inputSchema: {
        question: z.string().min(2),
        chatNamespace: z.string().optional(),
        timeframe: z.enum(["7d", "30d", "90d", "365d", "all"]).optional(),
        mode: z.enum(["lookup", "pattern", "diagnosis", "prediction", "recommendation"]).optional(),
        maxLoops: z.number().int().min(1).max(3).optional(),
        conversationId: z.string().optional(),
        context: z.record(z.unknown()).optional()
      }
    },
    async (input) => {
      const result = await askV2(input as any, { kind: "service", serviceName: "mcp", serviceId: "mcp" });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  mcpServer.registerTool(
    "openbrain.feedback",
    {
      title: "OpenBrain Feedback V2",
      description: "Submit yes/no/correction feedback for a V2 answer run.",
      inputSchema: {
        answerRunId: z.string().min(1),
        verdict: z.enum(["yes", "no", "partial"]),
        correction: z.string().optional(),
        correctedValue: z.record(z.unknown()).optional(),
        asOfDate: z.string().optional(),
        scope: z.string().optional()
      }
    },
    async (input) => {
      const result = await submitAskFeedback(input as any);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  mcpServer.registerTool(
    "openbrain.search_facts",
    {
      title: "OpenBrain Search Facts",
      description: "Search published facts/canonical fact candidates.",
      inputSchema: {
        query: z.string().min(2),
        chatNamespace: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async (input) => {
      const result = await searchPublishedFacts(input as any);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  mcpServer.registerTool(
    "openbrain.search_graph",
    {
      title: "OpenBrain Search Graph",
      description: "Fetch published relationship graph payload.",
      inputSchema: {
        chatNamespace: z.string().optional(),
        limit: z.number().int().min(10).max(500).optional()
      }
    },
    async (input) => {
      const result = await searchPublishedGraph(input as any);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  mcpServer.registerTool(
    "openbrain.quality_metrics",
    {
      title: "OpenBrain Quality Metrics",
      description: "Get quality gate metrics across artifact types.",
      inputSchema: {
        days: z.number().int().min(1).max(3650).optional()
      }
    },
    async (input) => {
      const result = await getQualityMetrics(input.days ?? 30);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );

  mcpServer.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description: "Save a memory item into Open Brain.",
      inputSchema: {
        content: z.string().min(1),
        source: z.string().optional(),
        role: z.enum(["user", "assistant", "system", "event"]).optional(),
        namespace: z.string().optional(),
        sourceConversationId: z.string().optional(),
        sourceMessageId: z.string().optional(),
        sourceTimestamp: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        idempotencyKey: z.string().optional()
      }
    },
    async (input) => {
      const result = await captureMemory({
        content: input.content,
        role: input.role ?? "user",
        sourceSystem: (input.source ?? "manual") as any,
        sourceConversationId: input.sourceConversationId,
        sourceMessageId: input.sourceMessageId,
        sourceTimestamp: input.sourceTimestamp,
        chatNamespace: input.namespace,
        metadata: input.metadata,
        idempotencyKey: input.idempotencyKey
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description: "Semantic search over Open Brain memory.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        threshold: z.number().min(0).max(1).optional(),
        namespace: z.string().optional(),
        source: z.string().optional(),
        role: z.enum(["user", "assistant", "system", "event"]).optional()
      }
    },
    async (input) => {
      const result = await searchMemory({
        query: input.query,
        limit: input.limit,
        threshold: input.threshold,
        chatNamespace: input.namespace,
        sourceSystem: input.source as any,
        role: input.role
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "list_recent",
    {
      title: "List Recent",
      description: "List recent memory items.",
      inputSchema: {
        namespace: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        source: z.string().optional(),
        role: z.enum(["user", "assistant", "system", "event"]).optional()
      }
    },
    async (input) => {
      const result = await listRecent({
        chatNamespace: input.namespace,
        limit: input.limit,
        sourceSystem: input.source,
        role: input.role
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "thought_stats",
    {
      title: "Thought Stats",
      description: "Get memory statistics for a namespace and time window.",
      inputSchema: {
        namespace: z.string().optional(),
        days: z.number().int().min(1).max(3650).optional()
      }
    },
    async (input) => {
      const result = await getStats(input.namespace ?? null, input.days ?? 30);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "capture_batch",
    {
      title: "Capture Batch",
      description: "Bulk insert memories with idempotent dedupe semantics.",
      inputSchema: {
        sourceSystem: z.string(),
        inputRef: z.string().optional(),
        dryRun: z.boolean().optional(),
        items: z.array(
          z.object({
            content: z.string().min(1),
            role: z.enum(["user", "assistant", "system", "event"]),
            sourceSystem: z.string(),
            sourceConversationId: z.string().optional(),
            sourceMessageId: z.string().optional(),
            sourceTimestamp: z.string().optional(),
            chatNamespace: z.string().optional(),
            metadata: z.record(z.unknown()).optional(),
            idempotencyKey: z.string().optional(),
            skipMetadataExtraction: z.boolean().optional(),
            itemKey: z.string().optional()
          })
        )
      }
    },
    async (input) => {
      const result = await batchCapture(input as any);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    }
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await mcpServer.connect(transport);

  app.all(path, async (req: Request, res: Response) => {
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
    }

    await transport.handleRequest(req as any, res as any, req.body);
  });
}
