import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

type Bucket = { count: number; resetAt: number };

const rateBuckets = new Map<string, Bucket>();

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (config.allowedOrigins.length === 0) return true;
  return config.allowedOrigins.includes(origin);
}

export function applyCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  if (origin && originAllowed(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }

  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type, x-api-key, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    res.status(503).json({ ok: false, error: "OPENBRAIN_API_KEY is not configured." });
    return;
  }

  const token = String(req.header("x-api-key") ?? "").trim();
  if (!token || token !== config.apiKey) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  next();
}

export function applyRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60_000;

  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > config.rateLimitPerMinute) {
    res.status(429).json({ ok: false, error: "Rate limit exceeded" });
    return;
  }

  next();
}
