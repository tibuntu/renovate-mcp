// Renovate doesn't ship .d.ts for most of its individual subpath exports. We
// only reach into these specific entry points from worker threads (and, for
// `package-rules/index.js`, from the parity oracle test), each gated by an ADR:
//   - `dist/config/migration.js`            — ADR-0001 (migrate_config)
//   - `dist/util/package-rules/matchers.js` — ADR-0006 (packageRules worker)
//   - `dist/util/template/index.js`         — ADR-0006 (override* compilation,
//                                              template rendering)
//   - `dist/util/package-rules/index.js`    — ADR-0006 parity test oracle only
//   - `dist/workers/repository/updates/branch-name.js`
//     `dist/workers/repository/model/commit-message.js`
//                                           — ADR-0006 addendum (test_package_rules
//                                              `rendered` block)
//   - `dist/workers/repository/updates/flatten.js`
//     `dist/workers/repository/updates/generate.js`
//                                           — rendering parity test oracle only
//   - `dist/workers/repository/update/branch/schedule.js`
//                                           — ADR-0007 (schedule worker;
//                                             `isScheduledNow` is the parity
//                                             test oracle only)
//   - `dist/config/app-strings.js`         — config-filename drift test
//                                             oracle only (configLocations.ts)
//   - `dist/config/presets/common.js`      — removed-presets drift test oracle
//                                             (generate-presets.mjs reads it too)
//   - `dist/config/presets/index.js`, `dist/config/presets/parse.js`,
//     `dist/config/massage.js`, `dist/config/validation.js`,
//     `dist/modules/platform/gitea/utils.js`
//                                           — ADR-0009 (dry_run preset
//                                             flattening worker)
// These shims give `tsc` typed signatures for those entry points.
declare module "renovate/dist/config/migration.js" {
  export function migrateConfig(
    config: Record<string, unknown>,
    parentKey?: string,
  ): {
    isMigrated: boolean;
    migratedConfig: Record<string, unknown>;
  };
  /** Rewrites `4am`-style hours into the form `@breejs/later` parses. */
  export function fixShortHours(input: string): string;
}

declare module "renovate/dist/workers/repository/update/branch/schedule.js" {
  export function hasValidSchedule(schedule: string[]): [true] | [false, string];
  export function hasValidTimezone(timezone: string): [true] | [false, string];
  /** `now` is a luxon DateTime (structurally typed: luxon ships no types here). */
  export function cronMatches(cron: string, now: object, timezone?: string): boolean;
  export function isScheduledNow(
    config: { schedule?: string | string[]; timezone?: string },
    scheduleKey?: string,
  ): boolean;
}

declare module "renovate/dist/util/package-rules/matchers.js" {
  interface PackageRuleMatcher {
    matches(
      config: Record<string, unknown>,
      rule: Record<string, unknown>,
    ): unknown | Promise<unknown>;
  }
  const matchers: PackageRuleMatcher[];
  export default matchers;
}

declare module "renovate/dist/util/template/index.js" {
  export function compile(
    template: string,
    config: Record<string, unknown>,
    filterFields?: boolean,
  ): string;
  /** Runtime-computed template variables (name → description), e.g. `newMajor`. */
  export const allowedFields: Record<string, string>;
}

declare module "renovate/dist/workers/repository/updates/branch-name.js" {
  /** Compiles groupName/groupSlug and branchName on `update` in place. */
  export function generateBranchName(update: Record<string, unknown>): void;
}

declare module "renovate/dist/workers/repository/model/commit-message.js" {
  export class CommitMessage {
    static formatPrefix(prefix: string): string;
  }
}

declare module "renovate/dist/workers/repository/updates/flatten.js" {
  export function applyUpdateConfig(
    input: Record<string, unknown>,
  ): Record<string, unknown>;
}

declare module "renovate/dist/workers/repository/updates/generate.js" {
  export function generateBranchConfig(
    upgrades: Record<string, unknown>[],
  ): Record<string, unknown>;
}

declare module "renovate/dist/util/package-rules/index.js" {
  export function applyPackageRules(
    config: Record<string, unknown>,
    stageName?: string,
  ): Promise<Record<string, unknown>>;
}

declare module "renovate/dist/config/app-strings.js" {
  /** Config filenames Renovate checks, in priority order. */
  export function getConfigFileNames(platform?: string): string[];
}

declare module "renovate/dist/config/presets/common.js" {
  export const removedPresets: Record<string, string | null>;
}

declare module "renovate/dist/config/presets/index.js" {
  export function resolveConfigPresets(
    inputConfig: Record<string, unknown>,
  ): Promise<{
    config: Record<string, unknown>;
    visitedPresets: { merged: string[]; unmerged: string[] };
  }>;
}

declare module "renovate/dist/config/presets/parse.js" {
  export function parsePreset(input: string): { presetSource: string };
}

declare module "renovate/dist/config/massage.js" {
  export function massageConfig(config: Record<string, unknown>): Record<string, unknown>;
}

declare module "renovate/dist/config/validation.js" {
  export function validateConfig(
    configType: "global" | "inherit" | "repo",
    config: Record<string, unknown>,
  ): Promise<{
    errors: Array<{ topic?: string; message?: string }>;
    warnings: Array<{ topic?: string; message?: string }>;
  }>;
}

declare module "renovate/dist/modules/platform/gitea/utils.js" {
  export function trimTrailingApiPath(url: string): string;
}
