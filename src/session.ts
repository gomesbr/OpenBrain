import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { config } from "./config.js";
import { pool } from "./db.js";
import type { AuthSession, PrivacyMode } from "./types.js";

interface SessionState {
  token: string;
  userName: string;
  expiresAtMs: number;
  privacyMode: PrivacyMode;
  createdAtMs: number;
}

const sessions = new Map<string, SessionState>();

type AuthUserRow = {
  id: string;
  user_name: string;
  password_hash: string;
  is_active: boolean;
};

async function findAuthUserByName(normalizedUserName: string): Promise<AuthUserRow | null> {
  const rows = await pool.query<AuthUserRow>(
    `SELECT id, user_name, password_hash, is_active
       FROM auth_users
      WHERE LOWER(user_name) = LOWER($1)
      ORDER BY created_at ASC`,
    [normalizedUserName]
  );
  return rows.rows[0] || null;
}

function nowMs(): number {
  return Date.now();
}

function sessionTtlMs(): number {
  return Math.max(60, config.appSessionTtlSec) * 1000;
}

function buildToken(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeUserName(value: string): string {
  return value.trim().toLowerCase();
}

function bearerToken(req: Request): string {
  const auth = String(req.header("authorization") ?? "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function cleanupExpiredSessions(): void {
  const now = nowMs();
  for (const [token, state] of sessions.entries()) {
    if (state.expiresAtMs <= now) {
      sessions.delete(token);
    }
  }
}

export async function bootstrapAuthUser(): Promise<void> {
  const userName = normalizeUserName(config.appUser);
  if (!userName) {
    throw new Error("OPENBRAIN_APP_USER must not be empty");
  }
  if (!config.appPassword) {
    throw new Error("OPENBRAIN_APP_PASSWORD is required to bootstrap login user");
  }

  const existingRow = await findAuthUserByName(userName);

  if (existingRow) {
    if (normalizeUserName(existingRow.user_name) !== userName) {
      await pool.query(`UPDATE auth_users SET user_name = $1 WHERE id = $2`, [userName, existingRow.id]);
      existingRow.user_name = userName;
    }

    if (existingRow.is_active !== true) {
      await pool.query(`UPDATE auth_users SET is_active = true WHERE id = $1`, [existingRow.id]);
    }

    let passwordMatches = false;
    try {
      passwordMatches = await verify(existingRow.password_hash, config.appPassword);
    } catch {
      passwordMatches = false;
    }
    if (!passwordMatches) {
      const passwordHash = await hash(config.appPassword, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1
      });
      await pool.query(
        `UPDATE auth_users
           SET password_hash = $2,
               rotated_at = now()
         WHERE id = $1`,
        [existingRow.id, passwordHash]
      );
    }
    return;
  }

  const passwordHash = await hash(config.appPassword, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });

  await pool.query(
    `INSERT INTO auth_users (user_name, password_hash, is_active, rotated_at)
     VALUES ($1, $2, true, now())`,
    [userName, passwordHash]
  );
}

async function checkCredentials(password: string): Promise<string | null> {
  const userName = normalizeUserName(config.appUser);
  const row = await pool.query<{ user_name: string; password_hash: string; is_active: boolean }>(
    `SELECT user_name, password_hash, is_active
       FROM auth_users
      WHERE LOWER(user_name) = LOWER($1)
      ORDER BY is_active DESC, updated_at DESC
      LIMIT 1`,
    [userName]
  );

  const user = row.rows[0];
  if (!user || user.is_active !== true) return null;
  if (!password) return null;

  const ok = await verify(user.password_hash, password);
  return ok ? user.user_name : null;
}

export async function loginWithPassword(password: string): Promise<AuthSession | null> {
  cleanupExpiredSessions();
  const userName = await checkCredentials(password);
  if (!userName) return null;

  const token = buildToken();
  const ttlMs = sessionTtlMs();
  const expiresAtMs = nowMs() + ttlMs;

  sessions.set(token, {
    token,
    userName,
    expiresAtMs,
    privacyMode: "private",
    createdAtMs: nowMs()
  });

  return {
    ok: true,
    token,
    expiresInSec: Math.round(ttlMs / 1000),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

export function logoutSessionByToken(token: string): void {
  if (!token) return;
  sessions.delete(token);
}

export function getSession(token: string): SessionState | null {
  cleanupExpiredSessions();
  if (!token) return null;
  const state = sessions.get(token);
  if (!state) return null;
  if (state.expiresAtMs <= nowMs()) {
    sessions.delete(token);
    return null;
  }
  state.expiresAtMs = nowMs() + sessionTtlMs();
  sessions.set(token, state);
  return state;
}

export function setSessionPrivacyMode(token: string, mode: PrivacyMode): SessionState | null {
  const session = getSession(token);
  if (!session) return null;
  session.privacyMode = mode;
  sessions.set(token, session);
  return session;
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  const session = getSession(token);
  if (!session) {
    res.status(401).json({ ok: false, error: "Unauthorized session" });
    return;
  }

  res.locals.session = {
    token: session.token,
    userName: session.userName,
    privacyMode: session.privacyMode,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    createdAt: new Date(session.createdAtMs).toISOString()
  };
  next();
}

export function getRequestSession(req: Request): {
  token: string;
  userName: string;
  privacyMode: PrivacyMode;
  expiresAt: string;
  createdAt: string;
} | null {
  const token = bearerToken(req);
  const state = getSession(token);
  if (!state) return null;
  return {
    token: state.token,
    userName: state.userName,
    privacyMode: state.privacyMode,
    expiresAt: new Date(state.expiresAtMs).toISOString(),
    createdAt: new Date(state.createdAtMs).toISOString()
  };
}

export async function rotateUserPassword(
  userName: string,
  currentPassword: string,
  newPassword: string
): Promise<boolean> {
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return false;
  }

  const row = await pool.query<{ password_hash: string; is_active: boolean }>(
    `SELECT password_hash, is_active
       FROM auth_users
      WHERE LOWER(user_name) = LOWER($1)
      LIMIT 1`,
    [normalizeUserName(userName)]
  );
  const user = row.rows[0];
  if (!user || user.is_active !== true) return false;

  const ok = await verify(user.password_hash, currentPassword);
  if (!ok) return false;

  const nextHash = await hash(newPassword, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });

  await pool.query(
    `UPDATE auth_users
        SET password_hash = $2,
            rotated_at = now()
      WHERE LOWER(user_name) = LOWER($1)`,
    [normalizeUserName(userName), nextHash]
  );
  return true;
}

