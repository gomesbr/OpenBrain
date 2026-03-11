import { experimentFailures, experimentLeaderboard, experimentStatus } from "../v2_experiments.js";

function readArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1];
}

function sortByCreatedAt<T extends { created_at?: string }>(rows: T[], order: "asc" | "desc"): T[] {
  const dir = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ta = Date.parse(String(a.created_at ?? ""));
    const tb = Date.parse(String(b.created_at ?? ""));
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return (ta - tb) * dir;
  });
}

async function main(): Promise<void> {
  const experimentId = readArg("--id=");
  if (!experimentId) {
    throw new Error("Missing --id=<experimentId>");
  }
  const variantId = readArg("--variant=");
  const orderArg = readArg("--order=")?.toLowerCase();
  const order: "asc" | "desc" = orderArg === "desc" ? "desc" : "asc";
  const status = await experimentStatus(experimentId);
  const leaderboard = await experimentLeaderboard(experimentId) as Record<string, unknown>;
  const failures = await experimentFailures({ experimentId, variantId, limit: 300 }) as Record<string, unknown>;

  const leaderboardRows = Array.isArray(leaderboard.leaderboard)
    ? sortByCreatedAt(leaderboard.leaderboard as Array<{ created_at?: string }>, order)
    : leaderboard.leaderboard;

  const failureRows = Array.isArray(failures.failures)
    ? sortByCreatedAt(failures.failures as Array<{ created_at?: string }>, order)
    : failures.failures;

  const statusStrategies = (status as Record<string, unknown>).strategies;
  const orderedStrategies = Array.isArray(statusStrategies)
    ? [...statusStrategies]
      .sort((a, b) => {
        const pa = Number((a as { position?: number }).position ?? Number.MAX_SAFE_INTEGER);
        const pb = Number((b as { position?: number }).position ?? Number.MAX_SAFE_INTEGER);
        return order === "asc" ? pa - pb : pb - pa;
      })
    : statusStrategies;

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    status: { ...(status as Record<string, unknown>), strategies: orderedStrategies },
    leaderboard: { ...leaderboard, leaderboard: leaderboardRows },
    failures: { ...failures, failures: failureRows },
    order
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 strategy report failed:", error);
  process.exit(1);
});
