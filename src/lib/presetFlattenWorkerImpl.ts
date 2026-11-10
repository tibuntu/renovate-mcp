import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker entry point for `dry_run`'s local-preset flattening (ADR-0009). Runs
 * Renovate's own preset resolver (`resolveConfigPresets`) with the global
 * platform/endpoint set to the derived `local>` route and the scoped host
 * rules registered, the way a real platform run would resolve the repo
 * config, then checks the result with Renovate's repo-config validator.
 *
 * Imported modules are the resolver and what it needs anyway (parse, global
 * config, host rules, migration, massage, template compile) plus the
 * validator. Not `config/index.js` or `workers/*`, and no platform is
 * initialised: the github / gitlab / gitea / forgejo preset sources read files
 * through their own Http clients with the endpoint passed per call.
 *
 * `presetFlattenWorker.ts` is the only caller; do not import this from anywhere
 * in the main process.
 */

interface WorkerData {
  config: Record<string, unknown>;
  platform: string;
  endpoint?: string;
  hostRules: Array<Record<string, unknown>>;
}

interface ValidationMessage {
  topic?: string;
  message?: string;
}

const { config, platform, endpoint, hostRules } = workerData as WorkerData;

const format = (m: ValidationMessage) => `${m.topic ?? "Configuration Error"}: ${m.message ?? ""}`;

try {
  const { GlobalConfig } = await import("renovate/dist/config/global.js");
  const hostRulesApi = await import("renovate/dist/util/host-rules.js");
  const { resolveConfigPresets } = await import("renovate/dist/config/presets/index.js");
  const { parsePreset } = await import("renovate/dist/config/presets/parse.js");
  const { migrateConfig } = await import("renovate/dist/config/migration.js");
  const { massageConfig } = await import("renovate/dist/config/massage.js");
  const { compile } = await import("renovate/dist/util/template/index.js");
  const { trimTrailingApiPath } = await import("renovate/dist/modules/platform/gitea/utils.js");
  const { validateConfig } = await import("renovate/dist/config/validation.js");

  // A real run's initPlatform trims a Gitea/Forgejo endpoint to its base URL
  // before it lands in the global config; the preset source adds `/api/v1`.
  const globalEndpoint =
    endpoint && (platform === "gitea" || platform === "forgejo") ? trimTrailingApiPath(endpoint) : endpoint;
  GlobalConfig.set({ platform: platform as never, endpoint: globalEndpoint });
  for (const rule of hostRules) hostRulesApi.add(rule as Parameters<typeof hostRulesApi.add>[0]);

  // Renovate migrates and massages the repo config before resolving presets.
  const input = massageConfig(migrateConfig(config).migratedConfig);
  const extendsList = Array.isArray(input.extends) ? (input.extends as unknown[]) : [];

  // The cut: the leading run of built-in presets stays in `extends` for the
  // spawned Renovate to expand; everything from the first other entry on is
  // resolved here. "Built-in" is Renovate's own parse, after the same
  // template compile its resolver applies.
  const isInternal = (entry: unknown): boolean => {
    if (typeof entry !== "string") return false;
    try {
      return parsePreset(compile(entry, {})).presetSource === "internal";
    } catch {
      return false;
    }
  };
  let cut = extendsList.findIndex((entry) => !isInternal(entry));
  if (cut < 0) cut = extendsList.length;
  // In one pass Renovate resolves a nested object's `extends` after merging
  // that object across every preset, kept built-ins included. Resolved from
  // the cut on, the object would be merged over the built-ins' instead, so
  // their values would lose to its presets: flatten everything then.
  const ownNestedExtends = (node: Record<string, unknown>): boolean =>
    Object.entries(node).some(
      ([key, value]) =>
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        key !== "content" &&
        key !== "onboardingConfig" &&
        ("extends" in value || ownNestedExtends(value as Record<string, unknown>)),
    );
  if (ownNestedExtends(input)) cut = 0;
  const keptExtends = extendsList.slice(0, cut) as string[];
  const rootIgnore = Array.isArray(input.ignorePresets) ? input.ignorePresets : [];

  const suffix: Record<string, unknown> = { ...input, extends: extendsList.slice(cut) };
  const { config: resolved, visitedPresets } = await resolveConfigPresets(suffix);
  const migrated = migrateConfig(resolved).migratedConfig;

  // Renovate drops ignorePresets after resolving; the kept built-ins still
  // need the root list when the spawned Renovate expands them.
  const flattened: Record<string, unknown> = {
    ...(keptExtends.length ? { extends: keptExtends } : {}),
    ...(keptExtends.length && rootIgnore.length ? { ignorePresets: rootIgnore } : {}),
    ...migrated,
  };

  // The spawned Renovate reads this as its repo config and runs
  // migrateAndValidate on it: validate it the same way first.
  const { errors, warnings } = await validateConfig("repo", massageConfig(migrateConfig(flattened).migratedConfig));

  parentPort!.postMessage({
    ok: true,
    config: flattened,
    keptExtends,
    flattenedPresets: visitedPresets.merged,
    errors: errors.map(format),
    warnings: warnings.map(format),
  });
} catch (err) {
  const e = err as { validationError?: string; message?: string };
  parentPort!.postMessage({ ok: false, error: e.validationError ?? e.message ?? String(err) });
}
