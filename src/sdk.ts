export interface OpenBrainClientOptions {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  serviceToken?: string;
  timeoutMs?: number;
}

async function requestJson<T>(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const json = (await response.json()) as T;
    if (!response.ok) {
      throw new Error(`OpenBrain request failed (${response.status})`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export class OpenBrainClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: OpenBrainClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 15000;
    this.headers = {
      "content-type": "application/json"
    };
    if (options.apiKey) this.headers["x-api-key"] = options.apiKey;
    if (options.bearerToken) this.headers.authorization = `Bearer ${options.bearerToken}`;
    if (options.serviceToken) this.headers["x-service-token"] = options.serviceToken;
  }

  async ask(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v2/brain/ask`, input, this.headers, this.timeoutMs);
  }

  async capture(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v1/memory/capture`, input, this.headers, this.timeoutMs);
  }

  async feedback(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v2/brain/ask/feedback`, input, this.headers, this.timeoutMs);
  }

  async capabilities(): Promise<Record<string, unknown>> {
    return requestJson("GET", `${this.baseUrl}/v2/capabilities`, null, this.headers, this.timeoutMs);
  }

  async anchorSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v2/retrieval/anchor_search`, input, this.headers, this.timeoutMs);
  }

  async fetchContextWindow(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v2/retrieval/context_window`, input, this.headers, this.timeoutMs);
  }

  async fetchThread(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v2/retrieval/thread`, input, this.headers, this.timeoutMs);
  }

  async searchFacts(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v2/brain/search/facts`, input, this.headers, this.timeoutMs);
  }

  async searchGraph(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestJson("POST", `${this.baseUrl}/v2/brain/search/graph`, input, this.headers, this.timeoutMs);
  }

  async qualityMetrics(days = 30): Promise<Record<string, unknown>> {
    return requestJson("GET", `${this.baseUrl}/v2/quality/metrics?days=${days}`, null, this.headers, this.timeoutMs);
  }
}
