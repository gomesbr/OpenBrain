import { Pool } from "pg";
import { config } from "../config.js";
import { DEFAULT_MAX_FUTURE_MINUTES, DEFAULT_MIN_YEAR } from "../time.js";

interface SourceAuditRow {
  source_system: string;
  total_rows: string;
  null_ts: string;
  future_ts: string;
  pre_min_year_ts: string;
  min_ts: string | null;
  max_ts: string | null;
}

interface OutlierRow {
  id: string;
  source_system: string;
  source_conversation_id: string | null;
  source_timestamp: string | null;
}

function parseArgs(argv: string[]): { asJson: boolean; futureMinutes: number; minYear: number } {
  let asJson = false;
  let futureMinutes = DEFAULT_MAX_FUTURE_MINUTES;
  let minYear = DEFAULT_MIN_YEAR;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--json") {
      asJson = true;
      continue;
    }
    if (token === "--future-minutes") {
      const parsed = Number(next ?? "");
      if (Number.isFinite(parsed) && parsed > 0) {
        futureMinutes = Math.trunc(parsed);
      }
      i += 1;
      continue;
    }
    if (token === "--min-year") {
      const parsed = Number(next ?? "");
      if (Number.isFinite(parsed) && parsed >= 1900) {
        minYear = Math.trunc(parsed);
      }
      i += 1;
    }
  }

  return { asJson, futureMinutes, minYear };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({
    host: config.postgresHost,
    port: config.postgresPort,
    database: config.postgresDb,
    user: config.postgresUser,
    password: config.postgresPassword,
    max: 3
  });

  try {
    const audit = await pool.query<SourceAuditRow>(
      `SELECT
         source_system,
         COUNT(*)::text AS total_rows,
         COUNT(*) FILTER (WHERE source_timestamp IS NULL)::text AS null_ts,
         COUNT(*) FILTER (WHERE source_timestamp > now() + make_interval(mins => $1))::text AS future_ts,
         COUNT(*) FILTER (WHERE source_timestamp < make_timestamptz($2, 1, 1, 0, 0, 0, 'UTC'))::text AS pre_min_year_ts,
         MIN(source_timestamp)::text AS min_ts,
         MAX(source_timestamp)::text AS max_ts
       FROM memory_items
       GROUP BY source_system
       ORDER BY source_system`,
      [args.futureMinutes, args.minYear]
    );

    const totals = audit.rows.reduce(
      (acc, row) => {
        acc.total += Number(row.total_rows ?? 0);
        acc.nullTs += Number(row.null_ts ?? 0);
        acc.futureTs += Number(row.future_ts ?? 0);
        acc.preMinYearTs += Number(row.pre_min_year_ts ?? 0);
        return acc;
      },
      { total: 0, nullTs: 0, futureTs: 0, preMinYearTs: 0 }
    );

    const anomalyCount = totals.nullTs + totals.futureTs + totals.preMinYearTs;

    const outliers =
      anomalyCount > 0
        ? await pool.query<OutlierRow>(
            `SELECT id::text, source_system, source_conversation_id, source_timestamp::text
               FROM memory_items
              WHERE source_timestamp IS NULL
                 OR source_timestamp > now() + make_interval(mins => $1)
                 OR source_timestamp < make_timestamptz($2, 1, 1, 0, 0, 0, 'UTC')
              ORDER BY source_timestamp NULLS FIRST
              LIMIT 40`,
            [args.futureMinutes, args.minYear]
          )
        : { rows: [] as OutlierRow[] };

    const payload = {
      ok: anomalyCount === 0,
      minYear: args.minYear,
      futureMinutes: args.futureMinutes,
      totals,
      bySource: audit.rows.map((row) => ({
        sourceSystem: row.source_system,
        totalRows: Number(row.total_rows),
        nullTs: Number(row.null_ts),
        futureTs: Number(row.future_ts),
        preMinYearTs: Number(row.pre_min_year_ts),
        minTs: row.min_ts,
        maxTs: row.max_ts
      })),
      outliers: outliers.rows
    };

    if (args.asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          "Date sanity check",
          `ok: ${payload.ok}`,
          `minYear: ${payload.minYear}`,
          `futureMinutes: ${payload.futureMinutes}`,
          `totals: total=${totals.total}, null_ts=${totals.nullTs}, future_ts=${totals.futureTs}, pre_min_year_ts=${totals.preMinYearTs}`,
          ""
        ].join("\n")
      );

      for (const row of payload.bySource) {
        process.stdout.write(
          [
            `${row.sourceSystem}:`,
            `  totalRows=${row.totalRows}`,
            `  nullTs=${row.nullTs}`,
            `  futureTs=${row.futureTs}`,
            `  preMinYearTs=${row.preMinYearTs}`,
            `  minTs=${row.minTs ?? "null"}`,
            `  maxTs=${row.maxTs ?? "null"}`
          ].join("\n") + "\n"
        );
      }

      if (payload.outliers.length > 0) {
        process.stdout.write("\nOutliers (up to 40):\n");
        for (const row of payload.outliers) {
          process.stdout.write(
            `  id=${row.id} source=${row.source_system} convo=${row.source_conversation_id ?? "null"} ts=${row.source_timestamp ?? "null"}\n`
          );
        }
      }
    }

    if (!payload.ok) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Date sanity check failed: ${String((error as Error)?.message ?? error)}\n`);
  process.exit(1);
});
