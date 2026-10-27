import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getOptions } from "renovate/dist/config/options/index.js";

import {
  LATER_TEXT_ANCHOR_TOKENS,
  PACKAGE_RULE_ACTION_KEYS,
} from "../../src/lib/configLinter.js";
import { SKIP_HINTS } from "../../src/lib/dependencyExplainer.js";

// Drift guards for the hand-maintained allow-lists in src/lib that mirror Renovate
// (or one of its dependencies) without importing it at runtime — the same role the
// facet guard in presetSuggester.test.ts plays for suggest_presets. Each describe
// compares one list against the *installed* renovate, so a dependency bump (or the
// nightly renovate@latest run) fails here instead of shipping a silently incomplete
// lint rule or explainer.

const require = createRequire(import.meta.url);
const renovatePkg = require.resolve("renovate/package.json");
const isSelector = (key: string): boolean => /^(match|exclude)/.test(key);

describe("PACKAGE_RULE_ACTION_KEYS vs Renovate's option registry", () => {
  const options = new Map(getOptions().map((o) => [o.name, o]));

  it("every entry is a real, non-global option that Renovate honours inside packageRules", () => {
    for (const key of PACKAGE_RULE_ACTION_KEYS) {
      const option = options.get(key);
      expect(option, key).toBeDefined();
      expect(option?.globalOnly, key).toBeFalsy();
      expect(isSelector(key), key).toBe(false);
      // `scopes` is where Renovate declares an option's valid locations (renovate#43020,
      // still being rolled out): absent means "anywhere", present must name packageRules.
      const scopes = option?.scopes ?? [];
      if (scopes.length > 0) {
        expect(
          scopes.some((s) => s === "packageRule" || s === "any"),
          `${key} scopes: ${scopes.join(", ")}`,
        ).toBe(true);
      }
    }
  });

  it("Renovate still declares `scopes` on its options (sanity: the check above is live)", () => {
    // vitest strips types, so a renamed field would make `option?.scopes` undefined for
    // every key and the scopes check would skip silently instead of failing.
    expect([...options.values()].some((o) => (o.scopes ?? []).length > 0)).toBe(true);
  });

  it("every packageRules-only option that is not a selector is an action key", () => {
    const expected = [...options.values()]
      .filter((o) => o.parents?.includes("packageRules") && !isSelector(o.name))
      .map((o) => o.name);
    expect(expected.length).toBeGreaterThan(0); // sanity: the oracle still has teeth
    for (const name of expected) {
      expect(PACKAGE_RULE_ACTION_KEYS.has(name), name).toBe(true);
    }
  });
});

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
