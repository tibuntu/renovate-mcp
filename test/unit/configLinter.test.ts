import { describe, it, expect } from "vitest";
import {
  lintConfig,
  PACKAGE_RULE_ACTION_KEYS,
} from "../../src/lib/configLinter.js";

describe("lintConfig", () => {
  it("returns no findings for a clean config", () => {
    const findings = lintConfig({
      extends: ["config:recommended"],
      packageRules: [
        {
          matchPackageNames: ["lodash", "typescript"],
          matchDepNames: ["/^@acme\\//"],
          groupName: "deps",
        },
      ],
    });
    expect(findings).toEqual([]);
  });

  describe("dead-regex-missing-slash", () => {
    const RULE = "dead-regex-missing-slash";

    it("flags leading '/' with no trailing '/'", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["/devops\\/pipelines\\/.+"] },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        path: "packageRules[0].matchPackageNames[0]",
        value: "/devops\\/pipelines\\/.+",
      });
    });

    it("flags trailing '/' with no leading '/'", () => {
      const findings = lintConfig({
        packageRules: [{ matchDepNames: ["foo.+/"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[0].matchDepNames[0]");
    });

    it("accepts a well-formed '/.../' regex", () => {
      const findings = lintConfig({
        packageRules: [{ matchSourceUrls: ["/^https:\\/\\/github\\.com\\//"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("accepts negated regex '!/.../'", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["!/^@internal\\//"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("flags negated pattern with missing trailing slash '!/foo'", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["!/foo"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
    });

    it("does not flag a single '/' (too short to be a malformed regex)", () => {
      const findings = lintConfig({
        packageRules: [{ matchSourceUrls: ["/"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });
  });

  describe("unwrapped-regex", () => {
    const RULE = "unwrapped-regex";

    it("flags an unwrapped regex with '.+' quantifier", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["foo.+"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).toContain("/foo.+/");
    });

    it("flags escape sequences like \\d", () => {
      const findings = lintConfig({
        packageRules: [{ matchCurrentVersion: ["1\\.\\d+"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
    });

    it("flags non-capturing groups", () => {
      const findings = lintConfig({
        packageRules: [{ matchDepNames: ["(?:foo|bar)"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
    });

    it("does not flag benign strings that contain a '.'", () => {
      const findings = lintConfig({
        packageRules: [
          {
            matchPackageNames: ["lodash.merge", "@types/node", "acme.inc/lib"],
          },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not flag semver ranges on matchCurrentVersion", () => {
      const findings = lintConfig({
        packageRules: [
          { matchCurrentVersion: ["^1.0.0", ">=2.0.0", "<3.0.0", "1.2.3"] },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });
  });

  describe("matchManagers-unknown-name", () => {
    const RULE = "matchManagers-unknown-name";

    it("does not flag known manager names on matchManagers", () => {
      const findings = lintConfig({
        packageRules: [
          {
            matchManagers: ["npm", "gomod", "docker-compose", "regex"],
          },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not flag the 'custom.<name>' prefix form", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["custom.regex", "custom.jsonata"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("flags an unknown name and suggests the closest match", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["nmp"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        path: "packageRules[0].matchManagers[0]",
        value: "nmp",
      });
      expect(findings[0]!.message).toContain("'npm'");
    });

    it("flags a typo with an underscore variant", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["docker_compose"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).toContain("'docker-compose'");
    });

    it("mirrors the rule on excludeManagers", () => {
      const findings = lintConfig({
        packageRules: [
          {
            matchPackageNames: ["*"],
            excludeManagers: ["gommod"],
          },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        path: "packageRules[0].excludeManagers[0]",
        value: "gommod",
      });
      expect(findings[0]!.message).toContain("'gomod'");
    });

    it("omits the suggestion hint when nothing is close enough", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["totally-made-up-thing"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).not.toContain("Did you mean");
    });

    it("handles a string value (not array) on matchManagers", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: "npmm" }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[0].matchManagers");
    });
  });

  describe("path reporting", () => {
    it("reports nested paths correctly", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["ok"] },
          { matchPackageNames: ["ok", "/bad"] },
        ],
      }).filter((f) => f.ruleId === "dead-regex-missing-slash");
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[1].matchPackageNames[1]");
    });

    it("reports top-level regex fields", () => {
      const findings = lintConfig({ matchPackageNames: ["/bad"] });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("matchPackageNames[0]");
    });

    it("handles a string value (not array) on a regex-aware field", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: "/bad" }],
      }).filter((f) => f.ruleId === "dead-regex-missing-slash");
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[0].matchPackageNames");
    });
  });

  it("is robust to non-object inputs", () => {
    expect(lintConfig(null)).toEqual([]);
    expect(lintConfig("string")).toEqual([]);
    expect(lintConfig(42)).toEqual([]);
  });

  describe("deprecated-key rule", () => {
    it("flags a top-level deprecated key with the rename embedded in the message", () => {
      const findings = lintConfig({ masterIssue: true });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "deprecated-key",
        path: "masterIssue",
        value: "masterIssue",
      });
      expect(findings[0]!.message).toContain("dependencyDashboard");
      expect(findings[0]!.message).toContain("migrate_config");
    });

    it("flags a deprecated key inside packageRules[]", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["lodash"], versionScheme: "semver" }],
      });
      const dep = findings.filter((f) => f.ruleId === "deprecated-key");
      expect(dep).toHaveLength(1);
      expect(dep[0]).toMatchObject({
        ruleId: "deprecated-key",
        path: "packageRules[0].versionScheme",
        value: "versionScheme",
      });
      expect(dep[0]!.message).toContain("versioning");
    });

    it("flags a deprecated key inside hostRules[]", () => {
      const findings = lintConfig({
        hostRules: [{ masterIssue: true }],
      });
      const dep = findings.filter((f) => f.ruleId === "deprecated-key");
      expect(dep).toHaveLength(1);
      expect(dep[0]!.path).toBe("hostRules[0].masterIssue");
    });

    it("flags a deprecated key inside customManagers[]", () => {
      const findings = lintConfig({
        customManagers: [{ masterIssue: true }],
      });
      const dep = findings.filter((f) => f.ruleId === "deprecated-key");
      expect(dep).toHaveLength(1);
      expect(dep[0]!.path).toBe("customManagers[0].masterIssue");
    });

    it("does not flag a deprecated-key name nested inside a non-container object", () => {
      const findings = lintConfig({ someUserKey: { masterIssue: true } });
      expect(findings.filter((f) => f.ruleId === "deprecated-key")).toEqual([]);
    });

    it("does not crash on a malformed container entry", () => {
      const findings = lintConfig({ packageRules: ["a string element"] });
      expect(findings.filter((f) => f.ruleId === "deprecated-key")).toEqual([]);
    });

    it("returns no findings for a config with only modern keys", () => {
      const findings = lintConfig({
        extends: ["config:recommended"],
        dependencyDashboard: true,
        packageRules: [{ matchPackageNames: ["lodash"], versioning: "semver" }],
      });
      expect(findings.filter((f) => f.ruleId === "deprecated-key")).toEqual([]);
    });

    it("emits one finding per occurrence when multiple deprecated keys are present", () => {
      const findings = lintConfig({
        masterIssue: true,
        packageRules: [{ versionScheme: "semver" }],
      });
      const dep = findings.filter((f) => f.ruleId === "deprecated-key");
      expect(dep).toHaveLength(2);
      const paths = dep.map((f) => f.path).sort();
      expect(paths).toEqual(["masterIssue", "packageRules[0].versionScheme"]);
    });
  });

  describe("severity backfill", () => {
    it("dead-regex-missing-slash is severity 'error'", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["/devops\\/pipelines\\/.+"] }],
      }).filter((f) => f.ruleId === "dead-regex-missing-slash");
      expect(findings[0]!.severity).toBe("error");
    });

    it("unwrapped-regex is severity 'warn'", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["foo.+"] }],
      }).filter((f) => f.ruleId === "unwrapped-regex");
      expect(findings[0]!.severity).toBe("warn");
    });

    it("matchManagers-unknown-name is severity 'error'", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["nmp"] }],
      }).filter((f) => f.ruleId === "matchManagers-unknown-name");
      expect(findings[0]!.severity).toBe("error");
    });

    it("deprecated-key is severity 'warn'", () => {
      const findings = lintConfig({ masterIssue: true });
      expect(findings[0]!.severity).toBe("warn");
    });

    it("matchManagers-unknown-name populates suggestion when a close match exists", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["nmp"] }],
      }).filter((f) => f.ruleId === "matchManagers-unknown-name");
      expect(findings[0]!.suggestion).toBe("npm");
    });

    it("matchManagers-unknown-name omits suggestion when nothing is close enough", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["totally-made-up-thing"] }],
      }).filter((f) => f.ruleId === "matchManagers-unknown-name");
      expect(findings[0]!.suggestion).toBeUndefined();
    });

    it("deprecated-key populates suggestion with the migrated key name", () => {
      const findings = lintConfig({ masterIssue: true });
      expect(findings[0]!.suggestion).toBe("dependencyDashboard");
    });
  });

  describe("empty-extends", () => {
    const RULE = "empty-extends";

    it("flags root extends:[] with severity warn", () => {
      const findings = lintConfig({ extends: [] }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        severity: "warn",
        path: "extends",
        value: "[]",
      });
      expect(findings[0]!.suggestion).toBeUndefined();
    });

    it("does not flag root extends with at least one entry", () => {
      const findings = lintConfig({ extends: ["config:recommended"] }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not flag a config with no extends key", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["lodash"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("flags packageRules[0].extends:[]", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["lodash"], extends: [] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        severity: "warn",
        path: "packageRules[0].extends",
        value: "[]",
      });
    });

    it("emits two findings for root + packageRules[1] empty extends", () => {
      const findings = lintConfig({
        extends: [],
        packageRules: [
          { matchPackageNames: ["a"] },
          { matchPackageNames: ["b"], extends: [] },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(2);
      const paths = findings.map((f) => f.path).sort();
      expect(paths).toEqual(["extends", "packageRules[1].extends"]);
    });

    it("does not flag extends when it is a string (not an array)", () => {
      const findings = lintConfig({ extends: "config:recommended" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not flag extends:[''] (non-empty array of one empty string)", () => {
      const findings = lintConfig({ extends: [""] }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("is robust to non-object inputs", () => {
      expect(lintConfig(null)).toEqual([]);
      expect(lintConfig("string")).toEqual([]);
      expect(lintConfig(42)).toEqual([]);
    });
  });

  describe("automerge-without-automerge-type", () => {
    const RULE = "automerge-without-automerge-type";

    it("flags root automerge:true without automergeType", () => {
      const findings = lintConfig({ automerge: true }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        severity: "warn",
        path: "automerge",
        value: "true",
        suggestion: 'automergeType: "pr"',
      });
    });

    it("does not flag root automerge:true when automergeType is set", () => {
      const findings = lintConfig({
        automerge: true,
        automergeType: "pr",
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("flags packageRules[N].automerge:true without automergeType", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["lodash"], automerge: true },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        severity: "warn",
        path: "packageRules[0].automerge",
      });
    });

    it("does not flag a packageRules entry where automergeType is set", () => {
      const findings = lintConfig({
        packageRules: [
          { automerge: true, automergeType: "branch" },
          { automerge: true, automergeType: "pr" },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("emits findings for both root and packageRules in the same pass", () => {
      const findings = lintConfig({
        automerge: true,
        packageRules: [
          { matchPackageNames: ["a"] },
          { matchPackageNames: ["b"], automerge: true, automergeType: "pr" },
          { matchPackageNames: ["c"], automerge: true },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(2);
      const paths = findings.map((f) => f.path).sort();
      expect(paths).toEqual(["automerge", "packageRules[2].automerge"]);
    });

    it("does not flag automerge:false", () => {
      const findings = lintConfig({ automerge: false }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not flag automerge:true inside customManagers[]", () => {
      const findings = lintConfig({
        customManagers: [{ automerge: true }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not flag automerge:true inside an arbitrary user key", () => {
      const findings = lintConfig({
        someUserKey: { automerge: true },
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });
  });

  describe("PACKAGE_RULE_ACTION_KEYS allow-list", () => {
    it("is a non-empty ReadonlySet of strings", () => {
      expect(PACKAGE_RULE_ACTION_KEYS).toBeInstanceOf(Set);
      expect(PACKAGE_RULE_ACTION_KEYS.size).toBeGreaterThan(0);
    });

    it("includes the canonical action keys", () => {
      for (const key of [
        "enabled",
        "groupName",
        "automerge",
        "addLabels",
        "labels",
        "prPriority",
        "schedule",
        "allowedVersions",
        "replacementName",
        // Added after a real false positive: a packageRule whose only action
        // was `postUpgradeTasks` got flagged as "no action keys". These keys
        // are all valid in packageRules per Renovate's option metadata and
        // ARE meaningful actions, so they must not be treated as selectors.
        "postUpgradeTasks",
        "rebaseWhen",
        "rebaseLabel",
        "lockFileMaintenance",
        "bumpVersion",
        "additionalBranchPrefix",
        "milestone",
        "prTitle",
        "vulnerabilityAlerts",
        "platformAutomerge",
        "prBodyColumns",
        "prBodyNotes",
        "dependencyDashboardLabels",
        "stopUpdatingLabel",
        "keepUpdatedLabel",
        "reviewersFromCodeOwners",
        "assigneesFromCodeOwners",
      ]) {
        expect(PACKAGE_RULE_ACTION_KEYS.has(key)).toBe(true);
      }
    });

    it("excludes selectors and metadata", () => {
      for (const key of [
        "matchPackageNames",
        "matchDepNames",
        "matchUpdateTypes",
        "matchManagers",
        "excludePackageNames",
        "paths",
        "excludePaths",
        "description",
      ]) {
        expect(PACKAGE_RULE_ACTION_KEYS.has(key)).toBe(false);
      }
    });
  });

  describe("package-rule-without-action", () => {
    const RULE = "package-rule-without-action";

    it("flags a bare-selector entry (matchPackageNames only)", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["lodash"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        severity: "warn",
        path: "packageRules[0]",
        value: "matchPackageNames",
      });
      expect(findings[0]!.message).toMatch(/enabled|groupName|automerge|addLabels/);
      expect(findings[0]!.suggestion).toBeUndefined();
    });

    it("does not fire when selector is paired with groupName (action)", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["lodash"], groupName: "deps" },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not fire when selector is paired with enabled:false (action)", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["lodash"], enabled: false },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not fire when selector is paired with postUpgradeTasks (regression: was a false positive)", () => {
      const findings = lintConfig({
        packageRules: [
          {
            matchPackageNames: ["renovate"],
            postUpgradeTasks: {
              commands: ["npm ci"],
              fileFilters: ["src/data/*.ts"],
              executionMode: "branch",
            },
          },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("fires when entry has only selectors plus description (description is metadata, not an action)", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["lodash"], description: "just metadata" },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[0]");
    });

    it("fires when entry has matchUpdateTypes only (matchUpdateTypes is a selector, not an action)", () => {
      const findings = lintConfig({
        packageRules: [
          { matchDepNames: ["foo"], matchUpdateTypes: ["minor"] },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[0]");
      // value preview should mention both selector keys
      expect(findings[0]!.value).toContain("matchDepNames");
      expect(findings[0]!.value).toContain("matchUpdateTypes");
    });

    it("does not fire on a global-defaults entry (action only, zero selectors)", () => {
      const findings = lintConfig({
        packageRules: [{ groupName: "deps" }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("emits one finding per offending entry, leaving good entries alone", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["a"] }, // bare selector — fires
          { matchPackageNames: ["b"], groupName: "g" }, // OK
          { matchDepNames: ["c"] }, // bare selector — fires
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(2);
      const paths = findings.map((f) => f.path).sort();
      expect(paths).toEqual(["packageRules[0]", "packageRules[2]"]);
    });

    it("is robust to malformed packageRules entries", () => {
      expect(() =>
        lintConfig({
          packageRules: ["a string", null, 42, { matchPackageNames: ["x"] }],
        }),
      ).not.toThrow();
      const findings = lintConfig({
        packageRules: ["a string", null, 42, { matchPackageNames: ["x"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[3]");
    });

    it("does not fire when packageRules is absent", () => {
      const findings = lintConfig({ extends: ["config:recommended"] }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("treats paths/excludePaths as selectors (not actions)", () => {
      const findings = lintConfig({
        packageRules: [{ paths: ["packages/foo/**"] }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[0]");
    });
  });

  describe("invalid-schedule", () => {
    const RULE = "invalid-schedule";

    // Every value in Renovate's `schedule.preset.js` — these MUST all be
    // accepted as valid (regression coverage). Snapshotted inline so the test
    // is independent of the `renovate` install.
    const RENOVATE_PRESET_SCHEDULES = [
      "* 0-3 * * *",
      "* 0-3 * * 1",
      "* 0-3 1 * *",
      "* 0-4,22-23 * * 1-5",
      "* * * * 0,6",
      "* 8-17 * * 1-5",
      "* * 1 */3 *",
      "* * * * 1-5",
      "* * 1 */12 *",
    ];

    it("does not fire on plausibly-later-text 'every monday at lunchtime'", () => {
      const findings = lintConfig({
        schedule: "every monday at lunchtime",
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("flags an obvious garbage string", () => {
      const findings = lintConfig({ schedule: "potato" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        severity: "error",
        path: "schedule",
        value: "potato",
      });
      expect(findings[0]!.suggestion).toBeUndefined();
    });

    it("flags only the offending entry in a mixed array", () => {
      const findings = lintConfig({
        schedule: ["before 5am", "asdfqwer"],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("schedule[1]");
      expect(findings[0]!.value).toBe("asdfqwer");
    });

    it("flags a schedule inside packageRules[]", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["lodash"], schedule: "qwerty" },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[0].schedule");
    });

    it("does not fire on 'at any time'", () => {
      const findings = lintConfig({ schedule: "at any time" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not fire on empty string", () => {
      const findings = lintConfig({ schedule: "" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not fire on 'every weekend'", () => {
      const findings = lintConfig({ schedule: "every weekend" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not fire on 'before 5am every weekday'", () => {
      const findings = lintConfig({
        schedule: "before 5am every weekday",
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not fire on 'every month' (literal mapping)", () => {
      const findings = lintConfig({ schedule: "every month" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not fire on 'monthly' (literal mapping)", () => {
      const findings = lintConfig({ schedule: "monthly" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it.each(RENOVATE_PRESET_SCHEDULES)(
      "accepts the Renovate preset schedule %j",
      (value) => {
        const findings = lintConfig({ schedule: value }).filter(
          (f) => f.ruleId === RULE,
        );
        expect(findings).toEqual([]);
      },
    );

    it("flags cron with a non-'*' minutes field (Renovate itself rejects this)", () => {
      const findings = lintConfig({ schedule: "5 0-3 * * *" }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]!.value).toBe("5 0-3 * * *");
    });

    it("is robust to non-string schedule values", () => {
      expect(
        lintConfig({ schedule: 42 }).filter((f) => f.ruleId === RULE),
      ).toEqual([]);
      expect(
        lintConfig({ schedule: { foo: "bar" } }).filter(
          (f) => f.ruleId === RULE,
        ),
      ).toEqual([]);
      expect(
        lintConfig({ schedule: null }).filter((f) => f.ruleId === RULE),
      ).toEqual([]);
    });
  });

  describe("contradictory-disabled-with-package-rules", () => {
    const RULE = "contradictory-disabled-with-package-rules";

    it("flags root enabled:false with a single packageRule enabled:true", () => {
      const findings = lintConfig({
        enabled: false,
        packageRules: [{ matchPackageNames: ["lodash"], enabled: true }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE,
        severity: "error",
        path: "packageRules[0].enabled",
        value: "true",
      });
      expect(findings[0]!.message).toContain("packageRules[0].enabled: true");
      expect(findings[0]!.suggestion).toBeDefined();
    });

    it("emits one finding per offending packageRules entry", () => {
      const findings = lintConfig({
        enabled: false,
        packageRules: [
          { matchPackageNames: ["a"], enabled: true },
          { matchPackageNames: ["b"], enabled: true },
        ],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(2);
      const paths = findings.map((f) => f.path).sort();
      expect(paths).toEqual([
        "packageRules[0].enabled",
        "packageRules[1].enabled",
      ]);
    });

    it("does not fire when packageRule has enabled:false (consistent intent)", () => {
      const findings = lintConfig({
        enabled: false,
        packageRules: [{ matchPackageNames: ["lodash"], enabled: false }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not fire when root enabled is true even if packageRule enabled is true", () => {
      const findings = lintConfig({
        enabled: true,
        packageRules: [{ matchPackageNames: ["lodash"], enabled: true }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not fire when root enabled is absent", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["lodash"], enabled: true }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("does not fire when packageRules is absent", () => {
      const findings = lintConfig({ enabled: false }).filter(
        (f) => f.ruleId === RULE,
      );
      expect(findings).toEqual([]);
    });

    it("does not fire when root enabled is the string 'false' (type mismatch out of scope)", () => {
      const findings = lintConfig({
        enabled: "false",
        packageRules: [{ enabled: true }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toEqual([]);
    });

    it("is robust to malformed packageRules entries", () => {
      const findings = lintConfig({
        enabled: false,
        packageRules: ["a string", null, 42, { enabled: true }],
      }).filter((f) => f.ruleId === RULE);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("packageRules[3].enabled");
    });
  });
});
