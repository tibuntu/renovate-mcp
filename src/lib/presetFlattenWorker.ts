import { validateEndpoint } from "./endpointValidator.js";
import { classifyRemoteHost, parseRemoteUrl, readOriginRemote, type HostedPlatform } from "./gitRemote.js";
import { homeScope, matchesHost, PUBLIC_HOST, type TokenScope } from "./hostTokens.js";
import { DEFAULT_WORKER_TIMEOUT_MS, runRenovateWorker } from "./renovateWorker.js";
import { isLocalPreset } from "./presetResolver.js";
import { isRecord } from "./util.js";

/**
 * `dry_run`'s local-preset flattening (ADR-0009). Under `--platform=local`
 * Renovate cannot resolve `local>` presets, so the tool resolves them first
 * with Renovate's own `resolveConfigPresets` in a worker thread, routed through
 * the derived platform/endpoint, and the spawned Renovate gets the result.
 *
 * Same worker-isolation invariant as the other carve-outs: the main process
 * never imports `renovate`. No preview fallback: a worker failure is a refusal.
 */

// Renovate's `parsePreset` source detection, shared with resolve_config so
// both tools agree on which entries are local presets.
export { isLocalPreset };

/** Keys whose object values Renovate's resolver does not descend into. */
const UNRESOLVED_KEYS = ["content", "onboardingConfig"];

/**
 * Every local preset in `config`, at the places `resolveConfigPresets` resolves
 * `extends`: the top level, objects in arrays (`packageRules[]`), and nested
 * objects other than `content` / `onboardingConfig`. A string `extends` counts
 * as a one-entry list, as Renovate's `ExtendsMigration` makes it.
 */
export function findLocalPresets(config: unknown): string[] {
  const found: string[] = [];
  const walk = (node: Record<string, unknown>): void => {
    const list = typeof node.extends === "string" ? [node.extends] : node.extends;
    if (Array.isArray(list)) {
      for (const entry of list) if (typeof entry === "string" && isLocalPreset(entry)) found.push(entry);
    }
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        for (const element of value) if (isRecord(element)) walk(element);
      } else if (isRecord(value) && !UNRESOLVED_KEYS.includes(key)) {
        walk(value);
      }
    }
  };
  if (isRecord(config)) walk(config);
  return found;
}

export interface FlattenOptions {
  /** Where `local>` presets live; Renovate's global `platform`. */
  platform: HostedPlatform;
  /** Renovate's global `endpoint`; unset means the platform's public API. */
  endpoint?: string;
  /** Host rules the resolver's requests use, in Renovate's order. */
  hostRules: Array<Record<string, unknown>>;
  timeoutMs?: number;
}

export type FlattenResult =
  | {
      ok: true;
      /** The repo config to hand the spawned Renovate. */
      config: Record<string, unknown>;
      /** The leading built-in presets left in `extends`. */
      keptExtends: string[];
      /** Every preset the resolver merged, nested ones included. */
      flattenedPresets: string[];
      /** Renovate's repo-config validation warnings for `config`. */
      warnings: string[];
    }
  | { ok: false; reason: string };

interface WorkerReply {
  config: Record<string, unknown>;
  keptExtends: string[];
  flattenedPresets: string[];
  errors: string[];
  warnings: string[];
}

/** Overridable like the other worker entries; see `mergeWorker.ts`. */
function workerEntry(): string | URL {
  return (
    process.env.RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY ??
    new URL("./presetFlattenWorkerImpl.js", import.meta.url)
  );
}

/**
 * Resolve every preset from the first non-built-in `extends` entry on, plus
 * the nested `extends` of the config's own keys, with Renovate's resolver.
 * Refuses when Renovate throws (its `validationError` is the reason), when
 * the result fails Renovate's repo-config validation, or when a local preset
 * is still left in it.
 */
export async function flattenLocalPresets(
  config: Record<string, unknown>,
  options: FlattenOptions,
): Promise<FlattenResult> {
  let reply: WorkerReply;
  try {
    reply = await runRenovateWorker<WorkerReply>(
      workerEntry(),
      { config, platform: options.platform, endpoint: options.endpoint, hostRules: options.hostRules },
      { timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS, label: "preset flattening" },
    );
  } catch (err) {
    // "Renovate preset flattening failed: <Renovate's validationError>", or the
    // driver's exit / timeout message.
    return { ok: false, reason: (err as Error).message };
  }
  if (reply.errors.length) {
    return {
      ok: false,
      reason: `The flattened config fails Renovate's repo-config validation: ${reply.errors.join("; ")}. A platform run would accept this config: it only logs such errors in resolved preset content at debug level (security errors and \`configValidationError: true\` aside). dry_run cannot, because the spawned Renovate reads the flattened result as the repo's own config and would stop with \`config-validation\`. Fix the preset, or run remotely (\`platform\` + \`repository\`).`,
    };
  }
  const left = findLocalPresets(reply.config);
  if (left.length) {
    return { ok: false, reason: `Local presets are left after flattening: ${left.join(", ")}.` };
  }
  return {
    ok: true,
    config: reply.config,
    keptExtends: reply.keptExtends,
    flattenedPresets: reply.flattenedPresets,
    warnings: reply.warnings,
  };
}

const NESTED_PRESET_ERROR = /Preset caused unexpected error \((.*?)\)(?:\. Note:|$)/;

/**
 * A hint for a run that failed on a local preset Renovate met inside another
 * preset: under `--platform=local` it throws "does not support local presets",
 * which surfaces as "Preset caused unexpected error (<preset>)". The tool only
 * flattens on its own when the repo config itself names a local preset.
 */
export function nestedLocalPresetHint(reportErrors: Array<Record<string, unknown>>): string | undefined {
  for (const problem of reportErrors) {
    const preset =
      typeof problem.validationError === "string" ? NESTED_PRESET_ERROR.exec(problem.validationError)?.[1] : undefined;
    if (preset && isLocalPreset(preset)) {
      return `\`${preset}\` is a local preset that another preset pulls in, and Renovate cannot resolve local presets under \`platform=local\`. Pass \`presetPlatform\` (plus \`endpoint\` for a self-hosted host) to have dry_run flatten every preset after the leading built-ins with Renovate's resolver first.`;
    }
  }
  return undefined;
}

export type LocalPresetRoute =
  | { ok: true; scope: TokenScope & { platform: HostedPlatform } }
  | { ok: false; reason: string };

/**
 * Where `local>` presets of a local run are fetched from (ADR-0008). Routing
 * only: env tokens never follow it. `presetPlatform`, else the platform of the repo's
 * origin remote (a hosted platform, or the flavour of a self-hosted host),
 * with the endpoint of `homeScope` for that platform. A hosted Gitea / Forgejo
 * other than the public one (codeberg.org) gets `https://<host>/api/v1`.
 * For an origin-derived platform `RENOVATE_ENDPOINT` applies only when it is
 * on the origin's host (or a subdomain, api.github.com for github.com): the
 * env endpoint names where the env platform lives, not where this repo does.
 * Refuses an origin it cannot classify, a self-hosted origin without an
 * endpoint, Bitbucket, and an endpoint the validator blocks.
 */
export async function resolveLocalPresetRoute(
  repoPath: string,
  input: { presetPlatform?: HostedPlatform; endpoint?: string },
  env: Record<string, string | undefined> = process.env,
): Promise<LocalPresetRoute> {
  let platform = input.presetPlatform;
  let derivedEndpoint: string | undefined;
  let selfHostedHost: string | undefined;
  let originHost: string | undefined;
  if (!platform) {
    const url = await readOriginRemote(repoPath);
    const remote = url ? parseRemoteUrl(url) : null;
    const classified = remote ? classifyRemoteHost(remote.host) : null;
    if (!remote || !classified || classified.flavor === "unknown") {
      const what = remote ? `the origin host \`${remote.host}\` could not be classified` : "the repository has no parseable origin remote";
      return {
        ok: false,
        reason: `The config extends local presets, which dry_run flattens before a local run, but ${what}. Pass \`presetPlatform\` (github, gitlab, gitea or forgejo) plus \`endpoint\` for a self-hosted host.`,
      };
    }
    originHost = remote.host;
    if (classified.classified === "self-hosted") {
      platform = classified.flavor as HostedPlatform;
      selfHostedHost = remote.host;
    } else {
      platform = classified.classified as HostedPlatform;
      if ((platform === "gitea" || platform === "forgejo") && remote.host !== PUBLIC_HOST[platform]) {
        derivedEndpoint = `https://${remote.host}/api/v1`;
      }
    }
  }
  if (platform === "bitbucket") {
    return {
      ok: false,
      reason:
        "dry_run cannot flatten Bitbucket local presets: Renovate reads them through its initialised Bitbucket platform client, which a local run does not have. Reference them with a supported source or run Renovate against Bitbucket itself.",
    };
  }
  const scoped = homeScope({ platform, endpoint: input.endpoint }, env).endpoint;
  const envOnOtherHost = !input.endpoint && originHost && scoped && !matchesHost(originHost, scoped);
  const endpoint = (envOnOtherHost ? undefined : scoped) ?? derivedEndpoint;
  if (!endpoint && selfHostedHost) {
    return {
      ok: false,
      reason: `The origin \`${selfHostedHost}\` is a self-hosted ${platform}, but no API endpoint is known for its local presets. Pass \`endpoint\` (for example \`https://${selfHostedHost}/api/v4\` for GitLab), or set \`RENOVATE_PLATFORM=${platform}\` and \`RENOVATE_ENDPOINT\` on the MCP server.`,
    };
  }
  if (endpoint) {
    const blocked = validateEndpoint(endpoint);
    if (blocked) return { ok: false, reason: blocked };
  }
  return { ok: true, scope: endpoint ? { platform, endpoint } : { platform } };
}
