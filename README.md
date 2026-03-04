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

`/v1/memory/*` and `/mcp` require `x-api-key`.
`/v1/brain/*` and `/v1/privacy/*` require a session bearer token from `/v1/auth/login`.

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
pwsh ./src/scripts/backup.ps1
pwsh ./src/scripts/restore.ps1 -BackupFile .\backups\openbrain_YYYYMMDD_HHMMSS.sql
```

## 5) Runtime modes

- `OPENBRAIN_EMBEDDING_MODE=mock` (default): deterministic embeddings, no external keys needed.
- `OPENBRAIN_EMBEDDING_MODE=openrouter`: real embeddings + metadata extraction via OpenRouter (`OPENROUTER_API_KEY` required).

## 6) MCP tools

Exposed tools:
- `capture_thought`
- `search_thoughts`
- `list_recent`
- `thought_stats`
- `capture_batch`

## 7) Security defaults

- API key required for write/read memory APIs and MCP endpoint.
- App login required on each refresh/open (token is memory-only in browser runtime).
- Optional CORS allowlist via `OPENBRAIN_ALLOWED_ORIGINS`.
- In-memory request rate limiting via `OPENBRAIN_RATE_LIMIT_PER_MIN`.

## 8) Validation / CI commands

```powershell
npm run build
npm run test
npm run check
```
