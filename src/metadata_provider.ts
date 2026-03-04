import { config } from "./config.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function fallbackMetadata(text: string): Record<string, unknown> {
  const topics = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
    .slice(0, 3);

  return {
    topics: topics.length > 0 ? topics : ["uncategorized"],
    type: "observation",
    people: [],
    action_items: [],
    dates_mentioned: []
  };
}

export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  if (config.embeddingMode !== "openrouter") {
    return fallbackMetadata(text);
  }

  if (!config.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required for openrouter metadata mode");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.openRouterApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.metadataModel,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Extract metadata from a memory item. Return JSON with keys: people (array), action_items (array), dates_mentioned (array YYYY-MM-DD), topics (array 1-4), type (observation|task|idea|reference|person_note). Only include details present in text."
          },
          { role: "user", content: text }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenRouter metadata failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return fallbackMetadata(text);
    }

    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : fallbackMetadata(text);
    } catch {
      return fallbackMetadata(text);
    }
  } finally {
    clearTimeout(timeout);
  }
}
