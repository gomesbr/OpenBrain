import { config } from "./config.js";

const OPENAI_BASE = "https://api.openai.com/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function normalizeBaseUrl(value: string, fallback: string): string {
  const base = String(value ?? "").trim() || fallback;
  return base.replace(/\/+$/, "");
}

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

function fallbackWithError(text: string, reason: string): Record<string, unknown> {
  return {
    ...fallbackMetadata(text),
    metadata_extraction_error: reason.slice(0, 160)
  };
}

function resolveMetadataProvider(): "mock" | "openai" | "openrouter" {
  const raw = config.metadataProvider.toLowerCase();
  if (raw === "openai" || raw === "openrouter" || raw === "mock") {
    return raw;
  }

  const embeddingMode = config.embeddingMode.toLowerCase();
  if (embeddingMode === "openai") return "openai";
  if (embeddingMode === "openrouter") return "openrouter";
  return "mock";
}

function resolveMetadataModel(provider: "openai" | "openrouter", model: string): string {
  const trimmed = String(model ?? "").trim();
  if (provider === "openai") {
    return trimmed.replace(/^openai\//i, "") || "gpt-4o-mini";
  }
  return trimmed || "openai/gpt-4o-mini";
}

async function requestMetadata(params: {
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  text: string;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(`${params.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: config.metadataMaxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Extract metadata from a memory item. Return JSON with keys: people (array), action_items (array), dates_mentioned (array YYYY-MM-DD), topics (array 1-4), type (observation|task|idea|reference|person_note). Only include details present in text."
          },
          { role: "user", content: params.text }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return fallbackWithError(params.text, `${params.providerLabel.toLowerCase()}_http_${response.status}:${body.slice(0, 80)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return fallbackMetadata(params.text);
    }

    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : fallbackMetadata(params.text);
    } catch {
      return fallbackWithError(params.text, "invalid_json_content");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallbackWithError(params.text, `${params.providerLabel.toLowerCase()}_exception:${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const provider = resolveMetadataProvider();

  if (provider === "mock") {
    return fallbackMetadata(text);
  }

  if (provider === "openai") {
    if (!config.openAiApiKey) {
      return fallbackWithError(text, "missing_openai_api_key");
    }

    return requestMetadata({
      providerLabel: "OpenAI",
      baseUrl: normalizeBaseUrl(config.openAiBaseUrl, OPENAI_BASE),
      apiKey: config.openAiApiKey,
      model: resolveMetadataModel("openai", config.metadataModel),
      text
    });
  }

  if (!config.openRouterApiKey) {
    return fallbackWithError(text, "missing_openrouter_api_key");
  }

  return requestMetadata({
    providerLabel: "OpenRouter",
    baseUrl: OPENROUTER_BASE,
    apiKey: config.openRouterApiKey,
    model: resolveMetadataModel("openrouter", config.metadataModel),
    text
  });
}
