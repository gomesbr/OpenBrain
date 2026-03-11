import { config } from "./config.js";
import { runCanonicalBootstrap } from "./v2_quality.js";
import { applyUniversalQualityGate, materializeCandidates } from "./v2_pipeline.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runCanonicalBootstrap(500);
    await materializeCandidates(500);
    if (config.v2QualityGateStrict) {
      await applyUniversalQualityGate();
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[openbrain-v2] background tick failed:", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

export function startV2Worker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, 60_000);
  timer.unref?.();
  void tick();
}
