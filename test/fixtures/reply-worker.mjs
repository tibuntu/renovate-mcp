// Test fixture for the shared worker driver (src/lib/renovateWorker.ts):
// replies according to workerData.mode so one file covers the success, error
// and never-replies paths. See test/unit/renovateWorker.test.ts.
import { parentPort, workerData } from "node:worker_threads";

if (workerData.mode === "ok") {
  parentPort.postMessage({ ok: true, echo: workerData.payload });
} else if (workerData.mode === "error") {
  parentPort.postMessage({ ok: false, error: workerData.error });
} else {
  // "hang": stay alive without ever posting.
  setInterval(() => {}, 1000);
}
