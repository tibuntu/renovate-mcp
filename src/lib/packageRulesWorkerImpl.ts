import { parentPort, workerData } from "node:worker_threads";
import type {
  MatcherResult,
  PerContextResult,
  PerRuleResult,
  RenderedNames,
} from "./packageRulesWorker.js";
import { isRecord } from "./util.js";

/**
 * Worker entry point for faithful `packageRules` matching used by
 * `test_package_rules` and `annotate_dry_run`. Imports Renovate's real matcher
 * registry (`renovate/dist/util/package-rules/matchers.js`) plus the merge
 * helpers `applyPackageRules` itself uses, and **replicates `applyPackageRules`'
 * loop** (it does NOT call the function as a black box) — because Renovate's
 * `matchesRule` returns only a boolean and exposes no per-rule / per-matcher
 * provenance, which is exactly what these tools surface (see ADR-0006).
 *
 * The replicated loop reproduces Renovate's exact merge (removeMatchers +
 * overrides applied via compile, mid-loop, + mergeChildConfig), so
 * `mergedConfig` is bit-identical to `applyPackageRules` for
 * matchConfidence-free configs — a
 * property pinned by the parity oracle test. Unlike Renovate's loop we do NOT
 * short-circuit `matchesRule`: every matcher is evaluated so the caller sees the
 * full per-matcher verdict vector, and a matcher that throws (e.g.
 * `matchConfidence` with no merge-confidence credentials) is caught per-matcher
 * as `"threw"` instead of aborting the whole context.
 *
 * Kept deliberately narrow: no logger, no shared state, single request/response.
 * `packageRulesWorker.ts` is the only caller; do not import this from anywhere
 * in the main process.
 */

interface WorkerData {
  packageRules: Record<string, unknown>[];
  contexts: Record<string, unknown>[];
  /** See `RunPackageRulesOptions.renderBase`. */
  renderBase?: Record<string, unknown>;
}

interface Matcher {
  matches: (
    config: Record<string, unknown>,
    rule: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}

const { packageRules, contexts, renderBase } = workerData as WorkerData;

/** Mirror of Renovate's `removeMatchers` (dist/util/package-rules/index.js). */
function removeMatchers(rule: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(rule)) {
    if (key.startsWith("match") || key.startsWith("exclude")) delete rule[key];
  }
  return rule;
}

type Compile = (template: string, config: Record<string, unknown>) => string;
type Merge = (parent: Record<string, unknown>, child: unknown) => Record<string, unknown>;
// Renovate's own update config is loosely typed; the mirror below reads and
// writes the same ad-hoc fields, so it keeps the same looseness.
type Upgrade = Record<string, any>;

/**
 * Build the renderer behind `test_package_rules`' `rendered` block. It mirrors
 * what Renovate does to ONE update between lookup and PR creation —
 * `applyUpdateConfig` in updates/flatten.ts (`is<UpdateType>`,
 * `depNameSanitized`, the real `generateBranchName`) and the single-upgrade path
 * of `generateBranchConfig` in updates/generate.ts (the pretty- and display-
 * fields, semantic prefix, `compileCommitMessage`, `compilePrTitle`). Only the leaf
 * helpers are imported: `generateBranchConfig` and `applyUpdateConfig` themselves
 * side-effect-import config/index.js, which loads every manager and datasource
 * (+5–11 s cold) — branch-name.js and defaults.js cost nothing measurable. Loaded
 * only when `renderBase` is supplied, so the other packageRules tools never pay.
 *
 * The result is a preview by construction: templates reference post-lookup
 * fields (newMajor, prettyNewVersion, …) the caller may not have supplied. The
 * renderer derives what it can and reports the rest in
 * `missingTemplateVariables`, found by rendering a second time with a sentinel
 * in every unset post-lookup field — only sentinels that reach the output are
 * reported, so variables in untaken `{{#if}}` branches stay silent.
 */
async function loadRenderer(
  base: Record<string, unknown>,
  mergeChildConfig: Merge,
  compile: Compile,
): Promise<(mergedConfig: Record<string, unknown>) => RenderedNames> {
  const { generateBranchName } = await import(
    "renovate/dist/workers/repository/updates/branch-name.js"
  );
  const { getConfig } = (await import("renovate/dist/config/defaults.js")) as unknown as {
    getConfig: () => Upgrade;
  };
  const { getOptions } = (await import("renovate/dist/config/options/index.js")) as unknown as {
    getOptions: () => Array<{ name: string; globalOnly?: boolean }>;
  };
  const { get: getVersioning } = (await import(
    "renovate/dist/modules/versioning/index.js"
  )) as unknown as {
    /** Undefined selects Renovate's default versioning (semver). */
    get: (versioning: string | undefined) => {
      isVersion: (v: string) => boolean;
      isSingleVersion: (v: string) => boolean;
      getMajor: (v: string) => number | null;
      getMinor: (v: string) => number | null;
      getPatch: (v: string) => number | null;
    };
  };
  const { withoutUrlCredentials, parseUrl } = (await import("renovate/dist/util/url.js")) as unknown as {
    withoutUrlCredentials: (s: string) => string;
    parseUrl: (s: string) => URL | null;
  };
  const { allowedFields } = await import("renovate/dist/util/template/index.js");
  const { CommitMessage } = await import(
    "renovate/dist/workers/repository/model/commit-message.js"
  );

  // Every Renovate update starts from the full option defaults; global-only
  // options exist only in the self-hosted config and would just mislead here.
  const defaults = getConfig();
  for (const o of getOptions()) if (o.globalOnly) delete defaults[o.name];
  const renderBaseConfig = mergeChildConfig(defaults, base);

  const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const prettifyVersion = (v: string) => (/^\d/.test(v) ? `v${v}` : v);
  /** Mirror of `sanitizeDepName` in updates/flatten.ts (importing it loads every manager). */
  const sanitizeDepName = (depName: string) =>
    withoutUrlCredentials(depName)
      .replace(/\$\{[^}]+\}\/?/g, "")
      .replace(/[${}]/g, "")
      .replace("@types/", "")
      .replace("@", "")
      .replace(/\//g, "-")
      .replace(/\s+/g, "-")
      .replace(/:/g, "-")
      .replace(/-+/, "-")
      .toLowerCase();

  /**
   * Fill the post-lookup / pre-branch fields Renovate would have computed from
   * what the caller supplied (lookup/generate.ts, updates/flatten.ts). `??=`
   * throughout: an explicit value — or a probe sentinel — is never overwritten.
   */
  function derive(u: Upgrade): void {
    if (typeof u.updateType === "string") u[`is${upper(u.updateType)}`] ??= true;
    if (typeof u.depName === "string") u.depNameSanitized ??= sanitizeDepName(u.depName);
    if (typeof u.packageFile === "string") {
      const dir = u.packageFile.split("/").slice(0, -1);
      u.packageFileDir ??= dir.join("/");
      u.parentDir ??= dir.at(-1) ?? "";
    }
    if (typeof u.sourceUrl === "string") {
      const pathname = parseUrl(u.sourceUrl)?.pathname;
      if (pathname) {
        const sourceRepo = pathname.replace(/^\//, "");
        u.sourceRepoSlug ??= sourceRepo.replace(/\//g, "-").replace(/-+/g, "-");
        u.sourceRepo ??= sourceRepo;
        u.sourceRepoOrg ??= sourceRepo.replace(/\/.*/g, "");
        u.sourceRepoName ??= sourceRepo.replace(/.*\//g, "");
      }
    }
    const api = getVersioning(typeof u.versioning === "string" ? u.versioning : undefined);
    try {
      if (typeof u.newValue === "string") {
        u.isSingleVersion ??= api.isSingleVersion(u.newValue);
        // A range is never a version (the default semver-coerced versioning
        // would happily coerce "^5.0.0"); only a single version IS newVersion.
        if (u.newVersion == null && u.isSingleVersion) u.newVersion = u.newValue;
      }
      if (typeof u.newVersion === "string") {
        u.newMajor ??= api.getMajor(u.newVersion);
        u.newMinor ??= api.getMinor(u.newVersion);
        u.newPatch ??= api.getPatch(u.newVersion);
      }
    } catch {
      // Not parseable under this versioning (e.g. a probe sentinel): leave unset.
    }
  }

  /** Single-update mirror of updates/flatten.ts + updates/generate.ts. */
  function render(u: Upgrade): Omit<RenderedNames, "missingTemplateVariables"> {
    derive(u);
    generateBranchName(u); // compiles groupName/groupSlug and branchName in place

    if (typeof u.currentDigest === "string") {
      u.currentDigestShort ??= u.currentDigest.replace("sha256:", "").substring(0, 7);
    }
    if (typeof u.newDigest === "string") {
      u.newDigestShort ??= u.newDigest.replace("sha256:", "").substring(0, 7);
    }
    if (u.isDigest || u.isPinDigest) {
      u.displayFrom = u.currentDigestShort;
      u.displayTo = u.newDigestShort;
    } else if (u.isLockfileUpdate) {
      u.displayFrom = u.currentVersion;
      u.displayTo = u.newVersion;
    } else if (!u.isLockFileMaintenance) {
      u.displayFrom = u.currentValue;
      u.displayTo = u.newValue;
    }
    u.displayFrom ??= "";
    u.displayTo ??= "";
    u.displayPending = "";
    if (u.newVersion) u.prettyNewVersion = prettifyVersion(String(u.newVersion));
    if (u.newMajor) u.prettyNewMajor = `v${u.newMajor}`;
    u.prettyDepType = u.prettyDepType ?? u.depType ?? "dependency";

    const groupName: string | undefined = typeof u.groupName === "string" ? u.groupName : undefined;
    if (groupName) {
      // ponytail: one synthetic dependency, but a groupName exists to hold
      // several — render as the multi-update group Renovate names from `group`
      // (a group that ends up holding a single update is only named this way
      // with groupSingleUpdates: true).
      u = mergeChildConfig(u, u.group);
      u.isGroup = true;
      delete u.commitMessageExtra;
    }
    delete u.group;

    // compileCommitMessage
    if (u.semanticCommits === "enabled" && !u.commitMessagePrefix) {
      let semanticPrefix: string = u.semanticCommitType;
      if (u.semanticCommitScope) semanticPrefix += `(${compile(u.semanticCommitScope, u)})`;
      u.commitMessagePrefix = CommitMessage.formatPrefix(semanticPrefix);
      u.toLowerCase = !/[A-Z]/.test(u.semanticCommitType) && !u.semanticCommitType.startsWith(":");
    }
    let commitMessage = compile(u.commitMessage ?? "", u);
    commitMessage = compile(commitMessage, u);
    commitMessage = withoutUrlCredentials(compile(commitMessage, u));
    commitMessage = commitMessage
      .trim()
      .replace(/\s+/g, " ")
      .replace(/to vv(?<digit>\d)/, "to v$<digit>");
    const lower = Boolean(u.toLowerCase) && u.commitMessageLowerCase !== "never";
    if (lower) {
      const lines = commitMessage.split(/\r?\n/);
      lines[0] = lines[0]!.toLowerCase();
      commitMessage = lines.join("\n");
    }
    u.commitMessage = commitMessage;

    // compilePrTitle
    let prTitle: string;
    if (u.prTitle) {
      prTitle = compile(u.prTitle, u);
      prTitle = compile(prTitle, u);
      prTitle = withoutUrlCredentials(compile(prTitle, u).trim().replace(/\s+/g, " "));
      if (lower) prTitle = prTitle.toLowerCase();
    } else {
      prTitle = commitMessage.split(/\r?\n/)[0]!;
    }
    if (!u.prTitleStrict) {
      prTitle += u.hasBaseBranches ? " ({{baseBranch}})" : "";
      // Renovate adds these only when commitMessageExtra is not a version; the
      // group path above always deletes commitMessageExtra, so it never is.
      if (u.isGroup) {
        prTitle += u.updateType === "major" && u.separateMajorMinor ? " (major)" : "";
        prTitle += u.updateType === "minor" && u.separateMinorPatch ? " (minor)" : "";
        prTitle += u.updateType === "patch" && u.separateMinorPatch ? " (patch)" : "";
      }
    }
    prTitle = withoutUrlCredentials(compile(prTitle, u));

    return {
      branchName: u.branchName,
      commitMessage,
      prTitle,
      ...(groupName !== undefined ? { groupName } : {}),
    };
  }

  // Sentinel probe for missingTemplateVariables. Letters only, so the marker
  // survives cleanBranchName / slugify / sanitizeDepName (which lower-case it;
  // the map restores the canonical spelling). Only Renovate's runtime
  // `allowedFields` are probed — never the config options in its separate
  // `exposedConfigOptions` list (commitMessagePrefix, groupName, prTitle, …):
  // an unset option is legitimate, and several of them select a render path,
  // so marking one would make the probe render a different branch than the
  // real pass. Fields render() always fills itself are never "missing".
  const ALWAYS_FILLED = new Set([
    "depNameSanitized",
    "prettyDepType",
    "displayFrom",
    "displayTo",
    "displayPending",
    "versioning",
    "recreateClosed",
  ]);
  const probeFields = Object.keys(allowedFields).filter(
    (k) => !/^(is|has)[A-Z]/.test(k) && !ALWAYS_FILLED.has(k),
  );
  const canonical = new Map(probeFields.map((k) => [k.toLowerCase(), k]));
  const SENTINEL = /zqmissingzq([a-z]+)zqendzq/gi;

  function missingIn(names: Record<string, string | undefined>): string[] {
    const found = new Set<string>();
    for (const text of Object.values(names)) {
      for (const hit of (text ?? "").matchAll(SENTINEL)) {
        const name = canonical.get(hit[1]!.toLowerCase());
        if (name) found.add(name);
      }
    }
    return [...found].sort();
  }

  return (mergedConfig) => {
    const input: Upgrade = mergeChildConfig(renderBaseConfig, mergedConfig);
    delete input.packageRules;
    derive(input); // so only what is NOT derivable gets a sentinel
    const real = render({ ...input });
    const probe: Upgrade = { ...input };
    for (const k of probeFields) if (probe[k] == null) probe[k] = `zqmissingzq${k}zqendzq`;
    // render() runs derive() on the probe too — deliberately: `??=` never
    // overwrites a sentinel, and a sentinel source propagates into the fields
    // derived from it (depName → depNameSanitized, newMajor → prettyNewMajor),
    // so the probe reports the supplyable field. A letters-only sentinel is
    // never a version, and newVersion already holds its own sentinel, so the
    // versioning branch cannot assign one sentinel over another.
    return { ...real, missingTemplateVariables: missingIn(render(probe)) };
  };
}

try {
  const matchers = (
    (await import("renovate/dist/util/package-rules/matchers.js")) as {
      default: Matcher[];
    }
  ).default;
  const { mergeChildConfig } = await import("renovate/dist/config/utils.js");
  const { compile } = (await import("renovate/dist/util/template/index.js")) as {
    compile: (template: string, config: Record<string, unknown>) => string;
  };
  const slugify = (
    (await import("slugify")) as {
      default: (input: string, opts?: { lower?: boolean }) => string;
    }
  ).default;

  const renderNames = renderBase
    ? await loadRenderer(renderBase, mergeChildConfig as Merge, compile)
    : undefined;

  const results: PerContextResult[] = [];

  for (const context of contexts) {
    // Renovate's applyPackageRules reads `config.packageRules` off the input.
    let config: Record<string, unknown> = { ...context, packageRules };
    const rules: PerRuleResult[] = [];

    for (const rule of packageRules) {
      const matcherResults: MatcherResult[] = [];
      let anyFalse = false;
      let anyThrew = false;

      for (const matcher of matchers) {
        const name = matcher.constructor.name;
        try {
          const verdict = await matcher.matches(config, rule);
          if (verdict === null || verdict === undefined) {
            matcherResults.push({ name, result: "null" });
          } else if (verdict) {
            matcherResults.push({ name, result: "true" });
          } else {
            matcherResults.push({ name, result: "false" });
            anyFalse = true;
          }
        } catch (err) {
          matcherResults.push({
            name,
            result: "threw",
            error: err instanceof Error ? err.message : String(err),
          });
          anyThrew = true;
        }
      }

      const matched = !anyFalse && !anyThrew;
      let contributedConfig: Record<string, unknown> | undefined;

      if (matched) {
        // Replicate the merge in dist/util/package-rules/index.js exactly so
        // `mergedConfig` matches applyPackageRules. Overrides mutate `config`
        // mid-loop, so a later rule sees an earlier rule's overrides.
        const toApply = removeMatchers({ ...rule });
        const force = isRecord(toApply.force) ? toApply.force : undefined;

        if (config.groupSlug && rule.groupName && !rule.groupSlug) {
          toApply.groupSlug = slugify(String(rule.groupName), { lower: true });
        }
        if (
          force?.enabled === false ||
          (toApply.enabled === false && config.enabled !== false)
        ) {
          config.skipReason = "package-rules";
        }
        if (force?.enabled || toApply.enabled) {
          delete config.skipReason;
          delete config.skipStage;
        }
        if (
          typeof toApply.overrideDatasource === "string" &&
          toApply.overrideDatasource !== config.datasource
        ) {
          config.datasource = toApply.overrideDatasource;
        }
        if (
          typeof toApply.overrideDepName === "string" &&
          toApply.overrideDepName !== config.depName
        ) {
          config.depName = compile(toApply.overrideDepName, config);
        }
        if (
          typeof toApply.overridePackageName === "string" &&
          toApply.overridePackageName !== config.packageName
        ) {
          config.packageName = compile(toApply.overridePackageName, config);
        }
        if (typeof toApply.sourceUrl === "string") {
          toApply.sourceUrl = compile(toApply.sourceUrl, config);
        }
        delete toApply.overrideDatasource;
        delete toApply.overrideDepName;
        delete toApply.overridePackageName;

        contributedConfig = structuredClone(toApply);
        config = mergeChildConfig(config, toApply);
      }

      rules.push({
        matched,
        matchers: matcherResults,
        ...(contributedConfig ? { contributedConfig } : {}),
      });
    }

    const result: PerContextResult = { mergedConfig: config, rules };
    if (renderNames) {
      // A broken user template (Handlebars parse error, …) must not degrade
      // the faithful match results to the preview fallback.
      try {
        result.rendered = renderNames(config);
      } catch (err) {
        result.renderError = err instanceof Error ? err.message : String(err);
      }
    }
    results.push(result);
  }

  parentPort!.postMessage({ ok: true, results });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ ok: false, error: message });
}
