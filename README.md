# OpenBrain

OpenBrain is a local-first memory service for CodexClaw and other agents:
- Postgres + pgvector source-of-truth
- REST API for capture/search/stats
- Remote MCP endpoint for agent tooling
- Bulk import pipelines (ChatGPT, Grok, WhatsApp, CodexClaw)

## 1) Windows-first quick start

1. Copy `.env.example` to `.env` and fill values.
2. Start full stack (DB + API):

```powershell
docker compose up -d
```

3. Optional: run API directly on host during development:

```powershell
npm install
npm run dev
```

Service defaults to `http://127.0.0.1:4301`.
OpenBrain 360 web app is served at `http://127.0.0.1:4301/`.

## 2) Endpoints

- `GET /v1/health`
- `POST /v1/auth/login`
- `POST /v1/auth/logout`
- `POST /v1/auth/rotate`
- `GET /v1/auth/session`
- `GET/POST /v1/privacy/mode`
- `POST /v1/memory/capture`
- `POST /v1/memory/batch`
- `POST /v1/memory/search`
- `GET /v1/memory/recent`
- `GET /v1/memory/stats`
- `POST /v1/brain/query`
- `GET /v1/brain/profile`
- `GET /v1/brain/graph`
- `GET /v1/brain/timeline`
- `GET /v1/brain/insights`
- `POST /v1/brain/feedback`
- `GET /v1/brain/jobs`
- `POST /v1/brain/jobs/rebuild`
- `POST /v1/brain/jobs/prune`
- `ALL /mcp` (MCP Streamable HTTP)

V2 endpoints:
- `POST /v2/brain/ask`
- `POST /v2/brain/ask/feedback`
- `GET /v2/capabilities`
- `POST /v2/retrieval/anchor_search`
- `POST /v2/retrieval/context_window`
- `POST /v2/retrieval/thread`
- `POST /v2/brain/search/facts`
- `POST /v2/brain/search/graph`
- `POST /v2/quality/evaluate`
- `POST /v2/quality/adjudicate`
- `GET /v2/quality/metrics`
- `POST /v2/quality/bootstrap`
- `POST /v2/benchmarks/generate`
- `POST /v2/benchmarks/run`
- `GET /v2/benchmarks/signal_profile`
- `POST /v2/benchmarks/activate_by_signal`
- `GET /v2/benchmarks/report`
- `POST /v2/services/register`
- `POST /v2/services/token`
- `GET /v2/services/audit`

`/v1/memory/*` and `/mcp` require `x-api-key`.
`/v1/brain/*` and `/v1/privacy/*` require a session bearer token from `/v1/auth/login`.
`/v2/*` accepts session auth, and optionally service auth (`x-service-token`) when `OPENBRAIN_V2_EXTERNAL_AGENT_ACCESS=1`.

## 3) Ingestion commands

### ChatGPT

```powershell
npm run import:chatgpt -- --input D:\AI_Brain_Imports\chatgpt_export.zip --namespace personal.main --account fabio
```

### Grok

```powershell
npm run import:grok -- --input D:\AI_Brain_Imports\grok_export.json --namespace personal.main --account fabio
```

### WhatsApp (text exports)

```powershell
npm run import:whatsapp -- --input D:\AI_Brain_Imports\whatsapp --namespace personal.main
# Weekly incremental mode (recent files only):
npm run import:whatsapp -- --input D:\AI_Brain_Imports\whatsapp --namespace personal.main --weekly
```

### CodexClaw backfill

```powershell
npm run import:codexclaw -- --db-path C:\Users\Fabio\Cursor AI projects\Projects\CodexClaw\store\db.sqlite --namespace-prefix codexclaw
```

## 4) Backup/restore

```powershell
./src/scripts/backup.ps1
./src/scripts/restore.ps1 -BackupFile .\backups\openbrain_YYYYMMDD_HHMMSS.sql
```

## 5) Robustness workflow (V2)

```powershell
# Re-extract metadata with conversation context (updates domain/trait/relationship signals)
npm run metadata:reextract -- --chat=personal.main --source=whatsapp --batch=200 --order=desc

# Refresh canonical + candidate layers
npm run v2:quality:bootstrap -- --canonical=5000 --candidates=5000

# Inspect domain signal coverage for benchmarking
npm run v2:bench:signal -- --mode=profile --set=signal_140 --chat=personal.main --min-score=0.28 --min-rows=20

# Activate only domains that currently have enough signal
npm run v2:bench:signal -- --mode=activate --set=signal_140 --chat=personal.main --min-score=0.28 --min-rows=20

# Run data-aware benchmark (local lexical/domain signal; does NOT call embedding APIs)
npm run v2:bench:run -- --set=signal_140 --limit=120 --chat=personal.main --data-aware --min-score=0.28 --min-rows=20
```

## 5.1) High-quality metadata acceleration (parallel queue)

Use this when you want model-quality metadata extraction with much higher throughput than single-thread `metadata:reextract`.

```powershell
# 1) Fill/reconcile queue with rows that still need v2.1 metadata (single source at a time)
npm run metadata:queue:fill -- --chat=personal.main --source=grok --retry-failed=1 --only-missing=1

# 2) Run multi-worker processing for that source (quality-preserving, lower host pressure defaults)
npm run metadata:queue:worker -- --chat=personal.main --source=grok --workers=2 --claim=4 --context=10 --strict-errors=1 --row-retries=3

# 3) Monitor queue + v2.1 coverage
npm run metadata:queue:progress -- --chat=personal.main --source=grok
```

Overnight sequential run (one source at a time):

```powershell
.\src\scripts\metadata_queue_run_sequence.ps1 `
  -ChatNamespace personal.main `
  -Sources grok,chatgpt,whatsapp `
  -Workers 2 `
  -Claim 4 `
  -Context 10 `
  -RetryFailed 1 `
  -OnlyMissing 1
```

Notes:
- `--strict-errors=1` keeps quality-first behavior: rows with model extraction errors are marked `failed` for retry (not silently accepted).
- `--row-retries` retries transient API failures before marking a row failed.
- Process one source at a time (`--source=...`) to avoid CPU contention on smaller hosts.
- Increase `--workers` gradually only if CPU/RAM headroom is available.

## 6) Runtime modes

- `OPENBRAIN_EMBEDDING_MODE=mock` (default): deterministic embeddings, no external keys needed.
- `OPENBRAIN_EMBEDDING_MODE=openai`: real embeddings + metadata extraction via OpenAI (`OPENAI_API_KEY` required).

V2 runtime flags:
- `OPENBRAIN_V2_ENABLED=0|1`
- `OPENBRAIN_V2_AGENT_MESH_ENABLED=0|1`
- `OPENBRAIN_V2_QUALITY_GATE_STRICT=0|1`
- `OPENBRAIN_V2_EXTERNAL_AGENT_ACCESS=0|1`
- `OPENBRAIN_V2_BENCHMARK_MODE=0|1`
- `OPENBRAIN_V2_SERVICE_TOKEN_TTL_SEC=3600`

## 7) MCP tools

Exposed tools:
- `capture_thought`
- `search_thoughts`
- `list_recent`
- `thought_stats`
- `capture_batch`
- `openbrain.ask`
- `openbrain.feedback`
- `openbrain.search_facts`
- `openbrain.search_graph`
- `openbrain.quality_metrics`

## 8) Security defaults

- API key required for write/read memory APIs and MCP endpoint.
- App login required on each refresh/open (token is memory-only in browser runtime).
- Optional CORS allowlist via `OPENBRAIN_ALLOWED_ORIGINS`.
- In-memory request rate limiting via `OPENBRAIN_RATE_LIMIT_PER_MIN`.

## 9) Validation / CI commands

```powershell
npm run build
npm run test
npm run check
```
