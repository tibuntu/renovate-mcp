import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker entry point for the faithful config merge used by `resolve_config` and
 * `explain_config`. Imports Renovate's real `mergeChildConfig` inside the worker
 * thread — see `docs/adrs/0004-worker-isolated-faithful-config-merge.md`. Kept
 * deliberately narrow: no logger, no shared state, single request/response.
 *
 * `mergeWorker.ts` is the only caller; do not import this from anywhere in the
 * main process.
 */

interface WorkerData {
  configs: Record<string, unknown>[];
  withSteps: boolean;
}

const { configs, withSteps } = workerData as WorkerData;

try {
  const { mergeChildConfig } = (await import(
    "renovate/dist/config/utils.js"
  )) as {
    mergeChildConfig: (
      parent: Record<string, unknown>,
      child: Record<string, unknown>,
    ) => Record<string, unknown>;
  };

  let acc: Record<string, unknown> = {};
  const snapshots: Record<string, unknown>[] = [];
  for (const config of configs) {
    acc = mergeChildConfig(acc, config);
    if (withSteps) snapshots.push(structuredClone(acc));
  }

  parentPort!.postMessage(
    withSteps
      ? { ok: true, merged: acc, snapshots }
      : { ok: true, merged: acc },
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ ok: false, error: message });
}
