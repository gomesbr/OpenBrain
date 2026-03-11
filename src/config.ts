import { config as loadEnv } from "dotenv";

loadEnv();

function readEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readNumber(name: string, fallback: number): number {
  const value = Number(readEnv(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readList(name: string): string[] {
  const raw = readEnv(name);
  if (!raw) return [];
  return raw.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

export const config = {
  host: readEnv("HOST", "127.0.0.1"),
  port: readNumber("PORT", 4301),

  postgresHost: readEnv("POSTGRES_HOST", "127.0.0.1"),
  postgresPort: readNumber("POSTGRES_PORT", 54329),
  postgresDb: readEnv("POSTGRES_DB", "openbrain"),
  postgresUser: readEnv("POSTGRES_USER", "openbrain"),
  postgresPassword: readEnv("POSTGRES_PASSWORD", "openbrain_dev_password"),

  apiKey: readEnv("OPENBRAIN_API_KEY", ""),
  allowedOrigins: readList("OPENBRAIN_ALLOWED_ORIGINS"),
  embeddingMode: readEnv("OPENBRAIN_EMBEDDING_MODE", "mock"),
  embeddingFallbackMode: readEnv("OPENBRAIN_EMBEDDING_FALLBACK_MODE", "mock"),
  openAiApiKey: readEnv("OPENAI_API_KEY", ""),
  openAiBaseUrl: readEnv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
  openRouterApiKey: readEnv("OPENROUTER_API_KEY", ""),
  embeddingModel: readEnv("OPENBRAIN_EMBEDDING_MODEL", "openai/text-embedding-3-small"),
  metadataProvider: readEnv("OPENBRAIN_METADATA_PROVIDER", "auto"),
  metadataModel: readEnv("OPENBRAIN_METADATA_MODEL", "openai/gpt-4o-mini"),
  metadataMaxTokens: readNumber("OPENBRAIN_METADATA_MAX_TOKENS", 768),
  metadataForceModel: readBool("OPENBRAIN_METADATA_FORCE_MODEL", false),
  metadataModelMinChars: readNumber("OPENBRAIN_METADATA_MODEL_MIN_CHARS", 120),
  metadataModelSourceAllowlist: readList("OPENBRAIN_METADATA_MODEL_SOURCE_ALLOWLIST"),
  requestTimeoutMs: readNumber("OPENBRAIN_REQUEST_TIMEOUT_MS", 15000),
  rateLimitPerMinute: readNumber("OPENBRAIN_RATE_LIMIT_PER_MIN", 240),
  appUser: readEnv("OPENBRAIN_APP_USER", "owner"),
  appPassword: readEnv("OPENBRAIN_APP_PASSWORD", "change_me"),
  appSessionTtlSec: readNumber("OPENBRAIN_APP_SESSION_TTL_SEC", 1800),
  ownerName: readEnv("OPENBRAIN_OWNER_NAME", "Fabio"),
  ownerAliases: readList("OPENBRAIN_OWNER_ALIASES"),
  pseudonymSeed: readEnv("OPENBRAIN_PSEUDONYM_SEED", "openbrain-demo-seed"),

  v2Enabled: readEnv("OPENBRAIN_V2_ENABLED", "1") === "1",
  v2AgentMeshEnabled: readEnv("OPENBRAIN_V2_AGENT_MESH_ENABLED", "1") === "1",
  v2QualityGateStrict: readEnv("OPENBRAIN_V2_QUALITY_GATE_STRICT", "1") === "1",
  v2BackgroundWorkerEnabled: readBool("OPENBRAIN_V2_BACKGROUND_WORKER_ENABLED", false),
  v2ExternalAgentAccess: readEnv("OPENBRAIN_V2_EXTERNAL_AGENT_ACCESS", "0") === "1",
  v2BenchmarkMode: readEnv("OPENBRAIN_V2_BENCHMARK_MODE", "0") === "1",
  v2ServiceTokenTtlSec: readNumber("OPENBRAIN_V2_SERVICE_TOKEN_TTL_SEC", 3600),

  smsEnabled: readBool("OPENBRAIN_SMS_ENABLED", false),
  smsProvider: readEnv("OPENBRAIN_SMS_PROVIDER", "twilio"),
  smsTo: readEnv("OPENBRAIN_SMS_TO", ""),
  twilioAccountSid: readEnv("TWILIO_ACCOUNT_SID", ""),
  twilioAuthToken: readEnv("TWILIO_AUTH_TOKEN", ""),
  twilioFromNumber: readEnv("TWILIO_FROM_NUMBER", "")
} as const;

export type Config = typeof config;
