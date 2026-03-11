import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db.js";
import { formatStrategyMessage, isSmsConfigured, sendSmsNotification } from "../notify_sms.js";

type StrategyStatus = "queued" | "running" | "completed" | "failed" | "skipped";

interface WatchState {
  initialized: boolean;
  variantStatus: Record<string, StrategyStatus>;
  maxGroupSeen: number;
  notifiedGroupFailed: number[];
  notifiedResearchStart: number[];
  notifiedGroupCreated: number[];
  notifiedFirstRunning: number[];
  processStopNotified: boolean;
  deliveredNotificationIds: string[];
  pendingNotifications: Record<string, {
    message: string;
    attempts: number;
    createdAt: string;
    lastAttemptAt: string;
    lastReason: string;
  }>;
}

function arg(name: string, fallback = ""): string {
  return process.argv.find((x) => x.startsWith(`${name}=`))?.split("=")[1] ?? fallback;
}

function toInt(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseStrategyNumber(strategyId: string): number {
  const m = String(strategyId ?? "").match(/^S(\d+)$/i);
  if (!m) return -1;
  return Number(m[1]);
}

function toGroup(strategyId: string, config: Record<string, unknown>): number {
  const g = Number((config ?? {}).groupId);
  if (Number.isFinite(g) && g > 0) return Math.trunc(g);
  const n = parseStrategyNumber(strategyId);
  if (n < 0) return 1;
  if (n <= 15) return 1;
  return Math.floor((n - 16) / 10) + 2;
}

async function existsLoopProcess(experimentId: string): Promise<boolean> {
  const processCheck = await import("node:child_process");
  const output = await new Promise<string>((resolve) => {
    processCheck.exec(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'v2_strategy_loop|v2:strategy:loop|${experimentId}' } | Select-Object -First 1 ProcessId | ConvertTo-Json -Compress"`,
      { windowsHide: true },
      (_err, stdout) => resolve(String(stdout ?? "").trim())
    );
  });
  const hasLocal = output.length > 0 && output !== "null" && output !== "{}";
  return hasLocal;
}

async function loadState(file: string): Promise<WatchState> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as WatchState;
    return {
      initialized: Boolean(parsed.initialized),
      variantStatus: parsed.variantStatus ?? {},
      maxGroupSeen: Number(parsed.maxGroupSeen ?? 1),
      notifiedGroupFailed: Array.isArray(parsed.notifiedGroupFailed) ? parsed.notifiedGroupFailed.map(Number) : [],
      notifiedResearchStart: Array.isArray(parsed.notifiedResearchStart) ? parsed.notifiedResearchStart.map(Number) : [],
      notifiedGroupCreated: Array.isArray(parsed.notifiedGroupCreated) ? parsed.notifiedGroupCreated.map(Number) : [],
      notifiedFirstRunning: Array.isArray(parsed.notifiedFirstRunning) ? parsed.notifiedFirstRunning.map(Number) : [],
      processStopNotified: Boolean(parsed.processStopNotified),
      deliveredNotificationIds: Array.isArray(parsed.deliveredNotificationIds) ? parsed.deliveredNotificationIds.map(String) : [],
      pendingNotifications: parsed.pendingNotifications ?? {}
    };
  } catch {
    return {
      initialized: false,
      variantStatus: {},
      maxGroupSeen: 1,
      notifiedGroupFailed: [],
      notifiedResearchStart: [],
      notifiedGroupCreated: [],
      notifiedFirstRunning: [],
      processStopNotified: false,
      deliveredNotificationIds: [],
      pendingNotifications: {}
    };
  }
}

async function saveState(file: string, state: WatchState): Promise<void> {
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

async function logLine(file: string, message: string): Promise<void> {
  await appendFile(file, `${nowIso()} | ${message}\n`, "utf8");
}

async function sendOrQueue(
  state: WatchState,
  options: { eventId: string; message: string; toPhone: string; logPath: string; tag: string }
): Promise<void> {
  if (state.deliveredNotificationIds.includes(options.eventId)) return;
  const sent = await sendSmsNotification(options.message, options.toPhone);
  await logLine(options.logPath, `sms ${options.tag} id=${options.eventId} ok=${sent.ok} reason=${sent.reason ?? ""}`);
  if (sent.ok) {
    state.deliveredNotificationIds.push(options.eventId);
    delete state.pendingNotifications[options.eventId];
    return;
  }
  const now = nowIso();
  const current = state.pendingNotifications[options.eventId];
  state.pendingNotifications[options.eventId] = {
    message: options.message,
    attempts: (current?.attempts ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    lastAttemptAt: now,
    lastReason: sent.reason ?? "unknown"
  };
}

async function flushPending(state: WatchState, toPhone: string, logPath: string): Promise<void> {
  const ids = Object.keys(state.pendingNotifications);
  for (const eventId of ids) {
    if (state.deliveredNotificationIds.includes(eventId)) {
      delete state.pendingNotifications[eventId];
      continue;
    }
    const pending = state.pendingNotifications[eventId];
    const sent = await sendSmsNotification(pending.message, toPhone);
    const now = nowIso();
    await logLine(logPath, `sms retry id=${eventId} ok=${sent.ok} reason=${sent.reason ?? ""}`);
    if (sent.ok) {
      state.deliveredNotificationIds.push(eventId);
      delete state.pendingNotifications[eventId];
    } else {
      pending.attempts += 1;
      pending.lastAttemptAt = now;
      pending.lastReason = sent.reason ?? "unknown";
      state.pendingNotifications[eventId] = pending;
    }
  }
}

async function main(): Promise<void> {
  const experimentId = arg("--id");
  if (!experimentId) throw new Error("Missing --id=<experimentId>");
  const pollSec = Math.max(5, toInt(arg("--poll", "15"), 15));
  const toPhone = arg("--to", "");

  const dir = path.resolve(process.cwd(), "generated/strategy_program");
  await mkdir(dir, { recursive: true });
  const statePath = path.join(dir, `sms_state_${experimentId}.json`);
  const logPath = path.join(dir, `sms_watch_${experimentId}.log`);
  let state = await loadState(statePath);

  const smsStatus = isSmsConfigured(toPhone);
  await logLine(logPath, `watcher started smsEnabled=${smsStatus.enabled} reason=${smsStatus.reason ?? "ok"}`);

  while (true) {
    await flushPending(state, toPhone, logPath);

    const runRows = await pool.query<{
      status: string;
      winner_variant_id: string | null;
      notes: string | null;
    }>(
      `SELECT status, winner_variant_id, notes
       FROM experiment_runs
       WHERE id = $1::uuid`,
      [experimentId]
    );
    if (runRows.rows.length === 0) {
      await logLine(logPath, "experiment not found, watcher exiting");
      return;
    }
    const run = runRows.rows[0];

    const strategyRows = await pool.query<{
      strategy_id: string;
      variant_id: string;
      status: StrategyStatus;
      config: Record<string, unknown>;
      position: number;
    }>(
      `SELECT strategy_id, variant_id, status, config, position
       FROM experiment_strategies
       WHERE experiment_id = $1::uuid
       ORDER BY position ASC`,
      [experimentId]
    );

    const grouped = new Map<number, typeof strategyRows.rows>();
    let maxGroup = 1;
    for (const row of strategyRows.rows) {
      const g = toGroup(row.strategy_id, row.config ?? {});
      if (!grouped.has(g)) grouped.set(g, []);
      grouped.get(g)!.push(row);
      if (g > maxGroup) maxGroup = g;
    }

    if (!state.initialized) {
      for (const row of strategyRows.rows) {
        state.variantStatus[row.variant_id] = row.status;
      }
      state.maxGroupSeen = maxGroup;
      state.initialized = true;
      await saveState(statePath, state);
      await logLine(logPath, "state initialized");
    }

    if (maxGroup > state.maxGroupSeen) {
      for (let g = state.maxGroupSeen + 1; g <= maxGroup; g += 1) {
        const rows = grouped.get(g) ?? [];
        if (!state.notifiedResearchStart.includes(g)) {
          const msg = `New research for strategies for group ${g} started`;
          await sendOrQueue(state, {
            eventId: `research_start_g${g}`,
            message: msg,
            toPhone,
            logPath,
            tag: `research_start group=${g}`
          });
          state.notifiedResearchStart.push(g);
        }
        if (!state.notifiedGroupCreated.includes(g)) {
          const msg = `${rows.length} new strategies were created for group ${g}`;
          await sendOrQueue(state, {
            eventId: `group_created_g${g}`,
            message: msg,
            toPhone,
            logPath,
            tag: `group_created group=${g} count=${rows.length}`
          });
          state.notifiedGroupCreated.push(g);
        }
      }
      state.maxGroupSeen = maxGroup;
    }

    for (const row of strategyRows.rows) {
      const prev = state.variantStatus[row.variant_id];
      const curr = row.status;
      const g = toGroup(row.strategy_id, row.config ?? {});
      if (prev && prev !== curr) {
        if (curr === "failed") {
          const msg = formatStrategyMessage({ group: g, strategyId: row.strategy_id, variantId: row.variant_id, success: false });
          await sendOrQueue(state, {
            eventId: `strategy_failed_${row.variant_id}`,
            message: msg,
            toPhone,
            logPath,
            tag: `strategy_failed variant=${row.variant_id} group=${g}`
          });
        } else if (curr === "completed") {
          const msg = formatStrategyMessage({ group: g, strategyId: row.strategy_id, variantId: row.variant_id, success: true });
          await sendOrQueue(state, {
            eventId: `strategy_success_${row.variant_id}`,
            message: msg,
            toPhone,
            logPath,
            tag: `strategy_success variant=${row.variant_id} group=${g}`
          });
        }
      }
      state.variantStatus[row.variant_id] = curr;
    }

    for (const [g, rows] of grouped.entries()) {
      const running = rows.find((r) => r.status === "running");
      if (running && g > 1 && !state.notifiedFirstRunning.includes(g)) {
        const num = parseStrategyNumber(running.strategy_id);
        const msg = `First strategy of group ${g} started`;
        await sendOrQueue(state, {
          eventId: `first_running_g${g}`,
          message: msg,
          toPhone,
          logPath,
          tag: `first_running group=${g} strategy=S${num}`
        });
        state.notifiedFirstRunning.push(g);
      }
      const allTerminal = rows.every((r) => ["failed", "completed", "skipped"].includes(r.status));
      const hasCompleted = rows.some((r) => r.status === "completed");
      if (allTerminal && !hasCompleted && !state.notifiedGroupFailed.includes(g)) {
        const msg = `All strategies of group ${g} failed`;
        await sendOrQueue(state, {
          eventId: `all_failed_g${g}`,
          message: msg,
          toPhone,
          logPath,
          tag: `all_failed group=${g}`
        });
        state.notifiedGroupFailed.push(g);
      }
    }

    const loopAlive = await existsLoopProcess(experimentId);
    if (!loopAlive && ["queued", "running"].includes(run.status) && !state.processStopNotified) {
      const msg = "Process stopped due to: strategy loop exited unexpectedly";
      await sendOrQueue(state, {
        eventId: "process_stopped_unexpected",
        message: msg,
        toPhone,
        logPath,
        tag: "process_stopped_unexpected"
      });
      state.processStopNotified = true;
    }

    if (["failed", "completed"].includes(run.status) && !run.winner_variant_id && !state.processStopNotified) {
      const reason = (run.notes ?? "").trim() || `experiment status=${run.status}`;
      const msg = `Process stopped due to: ${reason.slice(0, 120)}`;
      await sendOrQueue(state, {
        eventId: "process_stopped_status",
        message: msg,
        toPhone,
        logPath,
        tag: `process_stopped_status status=${run.status}`
      });
      state.processStopNotified = true;
    }

    await saveState(statePath, state);
    await new Promise((resolve) => setTimeout(resolve, pollSec * 1000));
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const dir = path.resolve(process.cwd(), "generated/strategy_program");
  await mkdir(dir, { recursive: true });
  const logPath = path.join(dir, `sms_watch_fatal.log`);
  await appendFile(logPath, `${nowIso()} | fatal=${message}\n`, "utf8");
  process.exit(1);
});
