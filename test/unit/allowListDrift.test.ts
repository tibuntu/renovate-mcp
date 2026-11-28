import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getConfigFileNames } from "renovate/dist/config/app-strings.js";
import { removedPresets } from "renovate/dist/config/presets/common.js";

import { LATER_TEXT_ANCHOR_TOKENS } from "../../src/lib/configLinter.js";
import { CONFIG_FILE_NAMES } from "../../src/lib/configLocations.js";
import { parsePreset } from "../../src/lib/presetResolver.js";
import { PRESETS, REMOVED_PRESETS } from "../../src/data/presets.generated.js";
import { OPTIONS } from "../../src/data/options.generated.js";
import { BRANCH_RESULT_HINTS, SKIP_HINTS } from "../../src/lib/dependencyExplainer.js";

// Drift guards for the hand-maintained allow-lists in src/lib that mirror Renovate
// (or one of its dependencies) without importing it at runtime — the same role the
// facet guard in presetSuggester.test.ts plays for suggest_presets. Each describe
// compares one list against the *installed* renovate, so a dependency bump (or the
// nightly renovate@latest run) fails here instead of shipping a silently incomplete
// lint rule or explainer.

const require = createRequire(import.meta.url);
const renovatePkg = require.resolve("renovate/package.json");

describe("LATER_TEXT_ANCHOR_TOKENS vs @breejs/later's text grammar", () => {
  // Renovate's own copy of later, resolved from its package so a non-hoisted install
  // still finds it. No type declarations ship with it, hence the `any`.
  const later = createRequire(renovatePkg)("@breejs/later");
  const parses = (text: string): boolean => later.parse.text(text).error === -1;
  // A bare token never parses on its own, so each is embedded in the smallest phrase
  // later accepts for that kind of token; it counts as recognised if any shape parses.
  const SHAPES: ReadonlyArray<(t: string) => string> = [
    (t) => `on ${t}`, // day names
    (t) => `of ${t}`, // month names
    (t) => `every ${t}`, // weekday / weekend
    (t) => `every 2 ${t}`, // time periods
    (t) => `${t} 10:00am`, // at / before / after
    (t) => `at 10:00${t}`, // am / pm
    (t) => `${t} weekday`, // every
    (t) => `${t} monday`, // on
    (t) => `every 2 minutes ${t} 1 and 5`, // between
  ];
  const recognised = (token: string): boolean => SHAPES.some((shape) => parses(shape(token)));

  it("every anchor token is one later's parser recognises", () => {
    for (const token of LATER_TEXT_ANCHOR_TOKENS) {
      expect(recognised(token), token).toBe(true);
    }
  });

  it("does not recognise an arbitrary word (control)", () => {
    expect(recognised("purple")).toBe(false);
  });
});

describe("BRANCH_RESULT_HINTS vs Renovate's BranchResult union", () => {
  const dts = readFileSync(path.join(path.dirname(renovatePkg), "dist/workers/types.d.ts"), "utf8");
  const union =
    dts.replace(/\/\*[\s\S]*?\*\//g, "").match(/export type BranchResult =([^;]*);/)?.[1] ?? "";
  const results = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

  // If this fails after a bump, the declaration's shape changed: fix the extraction.
  it("extracted the union from the declaration file (sanity)", () => {
    expect(results).toContain("pending");
    expect(results.length).toBeGreaterThan(10);
  });

  it("every hint key is a real BranchResult", () => {
    for (const key of Object.keys(BRANCH_RESULT_HINTS)) {
      expect(results, key).toContain(key);
    }
  });

  it("every camelCase option a hint names is a real Renovate option", () => {
    const named = Object.values(BRANCH_RESULT_HINTS).flatMap((h) =>
      [...h.matchAll(/`([a-z]+[A-Z][A-Za-z]*)`|`([a-z]+[A-Z][A-Za-z]*):/g)].map((m) => (m[1] ?? m[2])!),
    );
    expect(named).toContain("minimumReleaseAge");
    for (const name of new Set(named)) expect(Object.hasOwn(OPTIONS, name), name).toBe(true);
  });

  it("the results without a hint are exactly the ones that do not hold a PR back", () => {
    // A new result after a bump lands here: hint it in src/lib/dependencyExplainer.ts if it
    // holds a branch or PR back, otherwise add it to this list.
    const unhinted = results.filter((r) => !Object.hasOwn(BRANCH_RESULT_HINTS, r)).sort();
    expect(unhinted).toEqual([
      "already-existed",
      "automerged",
      "done",
      "error",
      "no-work",
      "pr-created",
      "pr-edited",
      "rebase",
    ]);
  });
});

describe("SKIP_HINTS vs Renovate's SkipReason union", () => {
  // SkipReason is a pure type, so pull the string literals out of its declaration file
  // (doc comments stripped first so an apostrophe in one can't pass for a literal).
  const dts = readFileSync(
    path.join(path.dirname(renovatePkg), "dist/types/skip-reason.d.ts"),
    "utf8",
  );
  const union =
    dts.replace(/\/\*[\s\S]*?\*\//g, "").match(/export type SkipReason =([^;]*);/)?.[1] ?? "";
  const skipReasons = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

  // If this fails after a bump, the declaration's shape changed (say, the union became an
  // `as const` array): fix the extraction above, not SKIP_HINTS.
  it("extracted the union from the declaration file (sanity)", () => {
    expect(skipReasons).toContain("ignored");
    expect(skipReasons.length).toBeGreaterThan(30);
  });

  it("every hint key is a real SkipReason", () => {
    for (const key of Object.keys(SKIP_HINTS)) {
      expect(skipReasons, key).toContain(key);
    }
  });

  it("the SkipReasons without a specific hint are exactly the known ones", () => {
    // SKIP_HINTS deliberately covers the common reasons only; everything below gets the
    // generic hint. A Renovate bump that adds a reason shows up in this diff: write a hint
    // for it in src/lib/dependencyExplainer.ts, or add it here if the generic one will do.
    const unhinted = skipReasons.filter((r) => !Object.hasOwn(SKIP_HINTS, r)).sort();
    expect(unhinted).toEqual([
      "empty",
      "file",
      "file-dependency",
      "git-dependency",
      "git-plugin",
      "inherited-dependency",
      "internal-error",
      "invalid-dependency-specification",
      "invalid-name",
      "invalid-sha256",
      "invalid-url",
      "local",
      "local-chart",
      "lockfile-only",
      "malicious-version-in-use",
      "missing-depname",
      "multiple-constraint-dep",
      "name-placeholder",
      "no-repository",
      "no-source",
      "no-source-match",
      "non-hex-dep-types",
      "not-a-version",
      "path-dependency",
      "placeholder-url",
      "recursive-placeholder",
      "unknown-engines",
      "unknown-volta",
      "unsupported",
      "unsupported-chart-type",
      "unsupported-remote",
      "unsupported-url",
      "unversioned-reference",
      "version-placeholder",
    ]);
  });
});

describe("CONFIG_FILE_NAMES vs Renovate's config-file discovery", () => {
  it("checks exactly the filenames Renovate checks, in the same priority order", () => {
    // No platform argument: locateConfig has no platform input, and Renovate only
    // adds per-platform directories (e.g. .forgejo/renovate.json) when one is set.
    expect(CONFIG_FILE_NAMES).toEqual(getConfigFileNames());
  });
});

describe("REMOVED_PRESETS vs Renovate's removedPresets", () => {
  // Renamed targets that exist nowhere in Renovate itself (upstream typos).
  const KNOWN_DANGLING = new Set(["monorepo:hotchocolate", "group:hotchocolateMonorepo"]);

  it("is a verbatim snapshot", () => {
    expect(REMOVED_PRESETS).toEqual(removedPresets);
  });

  it("every chain end is null, a catalogued preset, or a known-dangling target", () => {
    const dangling = new Set<string>();
    for (const start of Object.keys(REMOVED_PRESETS)) {
      let cur: string = start;
      const seen = new Set<string>();
      while (Object.hasOwn(REMOVED_PRESETS, cur) && REMOVED_PRESETS[cur]) {
        expect(seen.has(cur), `cycle at ${cur}`).toBe(false);
        seen.add(cur);
        cur = REMOVED_PRESETS[cur] as string;
      }
      if (Object.hasOwn(REMOVED_PRESETS, cur)) continue; // null: removed
      const key = parsePreset(cur).key;
      if (!(key in PRESETS)) dangling.add(key);
    }
    expect([...dangling].sort()).toEqual([...KNOWN_DANGLING].sort());
  });
});
