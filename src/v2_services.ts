import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { pool } from "./db.js";
import type { V2Principal } from "./v2_types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function serviceTokenFromRequest(req: Request): string {
  const header = String(req.header("x-service-token") ?? "").trim();
  if (header) return header;
  const auth = String(req.header("authorization") ?? "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function matchesNamespace(pattern: string, namespace: string): boolean {
  const p = String(pattern ?? "").trim();
  if (!p || p === "*") return true;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}$`, "i");
  return re.test(namespace);
}

export async function registerServiceIdentity(params: {
  serviceName: string;
  description?: string;
  permissions: Array<{ namespacePattern: string; domain: string; operation: string }>;
  metadata?: Record<string, unknown>;
}): Promise<{ serviceId: string }> {
  const serviceName = String(params.serviceName ?? "").trim();
  if (!serviceName) {
    throw new Error("serviceName is required");
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO service_identities (service_name, description, is_active, metadata)
     VALUES ($1, $2, true, $3::jsonb)
     ON CONFLICT (service_name)
     DO UPDATE SET description = EXCLUDED.description, metadata = EXCLUDED.metadata, is_active = true
     RETURNING id`,
    [serviceName, params.description ?? null, JSON.stringify(params.metadata ?? {})]
  );

  const serviceId = inserted.rows[0]?.id;
  if (!serviceId) {
    throw new Error("Failed to register service identity");
  }

  await pool.query(`DELETE FROM service_permissions WHERE service_id = $1`, [serviceId]);
  for (const permission of params.permissions ?? []) {
    await pool.query(
      `INSERT INTO service_permissions (service_id, namespace_pattern, domain, operation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [serviceId, permission.namespacePattern || "*", permission.domain || "*", permission.operation || "*"]
    );
  }

  return { serviceId };
}

export async function issueServiceToken(params: { serviceId: string; ttlSec?: number }): Promise<{ token: string; expiresAt: string }> {
  const serviceId = String(params.serviceId ?? "").trim();
  if (!serviceId) throw new Error("serviceId is required");

  const service = await pool.query<{ id: string; service_name: string; is_active: boolean }>(
    `SELECT id, service_name, is_active FROM service_identities WHERE id = $1 LIMIT 1`,
    [serviceId]
  );
  const row = service.rows[0];
  if (!row || row.is_active !== true) {
    throw new Error("Unknown or inactive service");
  }

  const ttlSec = Number.isFinite(Number(params.ttlSec)) ? Math.max(60, Math.min(7 * 86400, Number(params.ttlSec))) : 3600;
  const rawSecret = randomBytes(24).toString("base64url");
  const token = `obsvc_${serviceId.slice(0, 8)}_${rawSecret}`;
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  await pool.query(
    `INSERT INTO service_tokens (service_id, token_hash, expires_at)
     VALUES ($1, $2, $3::timestamptz)`,
    [serviceId, tokenHash, expiresAt]
  );

  return { token, expiresAt };
}

export async function authenticateService(req: Request): Promise<V2Principal | null> {
  const token = serviceTokenFromRequest(req);
  if (!token) return null;
  const tokenHash = sha256(token);
  const result = await pool.query<{ service_id: string; service_name: string }>(
    `SELECT t.service_id, s.service_name
       FROM service_tokens t
       JOIN service_identities s ON s.id = t.service_id
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND t.expires_at > now()
        AND s.is_active = true
      LIMIT 1`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    kind: "service",
    serviceId: row.service_id,
    serviceName: row.service_name
  };
}

export async function serviceHasPermission(params: {
  serviceId: string;
  namespace: string;
  domain: string;
  operation: string;
}): Promise<boolean> {
  const rows = await pool.query<{ namespace_pattern: string; domain: string; operation: string }>(
    `SELECT namespace_pattern, domain, operation
       FROM service_permissions
      WHERE service_id = $1`,
    [params.serviceId]
  );
  return rows.rows.some((row) => {
    const opOk = row.operation === "*" || row.operation === params.operation;
    const domainOk = row.domain === "*" || row.domain === params.domain;
    const nsOk = matchesNamespace(row.namespace_pattern, params.namespace);
    return opOk && domainOk && nsOk;
  });
}

export async function logApiAuditEvent(params: {
  traceId: string;
  serviceId?: string | null;
  sessionActor?: string | null;
  method: string;
  path: string;
  statusCode: number;
  operation?: string;
  namespace?: string;
  requestJson?: Record<string, unknown>;
  responseJson?: Record<string, unknown>;
  errorText?: string | null;
  durationMs?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO api_audit_events (
       trace_id,
       service_id,
       session_actor,
       method,
       path,
       status_code,
       operation,
       namespace,
       request_json,
       response_json,
       error_text,
       duration_ms,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, now())`,
    [
      params.traceId,
      params.serviceId ?? null,
      params.sessionActor ?? null,
      params.method,
      params.path,
      params.statusCode,
      params.operation ?? null,
      params.namespace ?? null,
      JSON.stringify(params.requestJson ?? {}),
      JSON.stringify(params.responseJson ?? {}),
      params.errorText ?? null,
      Number.isFinite(Number(params.durationMs)) ? Number(params.durationMs) : null
    ]
  );
}

export async function listApiAudit(params: { limit: number }): Promise<Array<Record<string, unknown>>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(500, Number(params.limit))) : 100;
  const rows = await pool.query(
    `SELECT
       e.id,
       e.trace_id,
       e.service_id,
       s.service_name,
       e.session_actor,
       e.method,
       e.path,
       e.status_code,
       e.operation,
       e.namespace,
       e.duration_ms,
       e.error_text,
       e.created_at
     FROM api_audit_events e
     LEFT JOIN service_identities s ON s.id = e.service_id
     ORDER BY e.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.rows.map((row: any) => ({
    id: row.id,
    traceId: row.trace_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    sessionActor: row.session_actor,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    operation: row.operation,
    namespace: row.namespace,
    durationMs: row.duration_ms,
    errorText: row.error_text,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso()
  }));
}
