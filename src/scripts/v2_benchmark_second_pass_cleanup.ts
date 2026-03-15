import { secondPassCleanupBenchmarkCases } from "../v2_experiments.js";

const experimentId = process.argv[2] || "53761995-3341-4ca2-9af1-b63b9bace516";

(async () => {
  const result = await secondPassCleanupBenchmarkCases({
    experimentId,
    targetNegativeShare: 0.2
  });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
