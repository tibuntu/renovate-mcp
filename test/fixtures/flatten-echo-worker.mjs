// Test fixture for src/lib/presetFlattenWorker.ts: replies with the input
// config unchanged, as if the resolver had left it alone, so the wrapper's
// post-flatten checks can be exercised without Renovate.
import { parentPort, workerData } from "node:worker_threads";

parentPort.postMessage({
  ok: true,
  config: workerData.config,
  keptExtends: [],
  flattenedPresets: [],
  errors: [],
  warnings: ["Configuration Warning: echoed"],
});
