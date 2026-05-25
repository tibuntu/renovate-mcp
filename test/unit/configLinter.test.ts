import { describe, it, expect } from "vitest";
import { lintConfig } from "../../src/lib/configLinter.js";

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
    it("flags leading '/' with no trailing '/'", () => {
      const findings = lintConfig({
        packageRules: [
          { matchPackageNames: ["/devops\\/pipelines\\/.+"] },
        ],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "dead-regex-missing-slash",
        path: "packageRules[0].matchPackageNames[0]",
        value: "/devops\\/pipelines\\/.+",
      });
    });

    it("flags trailing '/' with no leading '/'", () => {
      const findings = lintConfig({
        packageRules: [{ matchDepNames: ["foo.+/"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("dead-regex-missing-slash");
      expect(findings[0]!.path).toBe("packageRules[0].matchDepNames[0]");
    });

    it("accepts a well-formed '/.../' regex", () => {
      const findings = lintConfig({
        packageRules: [{ matchSourceUrls: ["/^https:\\/\\/github\\.com\\//"] }],
      });
      expect(findings).toEqual([]);
    });

    it("accepts negated regex '!/.../'", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["!/^@internal\\//"] }],
      });
      expect(findings).toEqual([]);
    });

    it("flags negated pattern with missing trailing slash '!/foo'", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["!/foo"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("dead-regex-missing-slash");
    });

    it("does not flag a single '/' (too short to be a malformed regex)", () => {
      const findings = lintConfig({
        packageRules: [{ matchSourceUrls: ["/"] }],
      });
      expect(findings).toEqual([]);
    });
  });

  describe("unwrapped-regex", () => {
    it("flags an unwrapped regex with '.+' quantifier", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["foo.+"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("unwrapped-regex");
      expect(findings[0]!.message).toContain("/foo.+/");
    });

    it("flags escape sequences like \\d", () => {
      const findings = lintConfig({
        packageRules: [{ matchCurrentVersion: ["1\\.\\d+"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("unwrapped-regex");
    });

    it("flags non-capturing groups", () => {
      const findings = lintConfig({
        packageRules: [{ matchDepNames: ["(?:foo|bar)"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("unwrapped-regex");
    });

    it("does not flag benign strings that contain a '.'", () => {
      const findings = lintConfig({
        packageRules: [
          {
            matchPackageNames: ["lodash.merge", "@types/node", "acme.inc/lib"],
          },
        ],
      });
      expect(findings).toEqual([]);
    });

    it("does not flag semver ranges on matchCurrentVersion", () => {
      const findings = lintConfig({
        packageRules: [
          { matchCurrentVersion: ["^1.0.0", ">=2.0.0", "<3.0.0", "1.2.3"] },
        ],
      });
      expect(findings).toEqual([]);
    });
  });

  describe("matchManagers-unknown-name", () => {
    it("does not flag known manager names on matchManagers", () => {
      const findings = lintConfig({
        packageRules: [
          {
            matchManagers: ["npm", "gomod", "docker-compose", "regex"],
          },
        ],
      });
      expect(findings).toEqual([]);
    });

    it("does not flag the 'custom.<name>' prefix form", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["custom.regex", "custom.jsonata"] }],
      });
      expect(findings).toEqual([]);
    });

    it("flags an unknown name and suggests the closest match", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["nmp"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "matchManagers-unknown-name",
        path: "packageRules[0].matchManagers[0]",
        value: "nmp",
      });
      expect(findings[0]!.message).toContain("'npm'");
    });

    it("flags a typo with an underscore variant", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["docker_compose"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("matchManagers-unknown-name");
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
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "matchManagers-unknown-name",
        path: "packageRules[0].excludeManagers[0]",
        value: "gommod",
      });
      expect(findings[0]!.message).toContain("'gomod'");
    });

    it("omits the suggestion hint when nothing is close enough", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["totally-made-up-thing"] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("matchManagers-unknown-name");
      expect(findings[0]!.message).not.toContain("Did you mean");
    });

    it("handles a string value (not array) on matchManagers", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: "npmm" }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe("matchManagers-unknown-name");
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
      });
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
      });
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
      });
      expect(findings[0]!.severity).toBe("error");
    });

    it("unwrapped-regex is severity 'warn'", () => {
      const findings = lintConfig({
        packageRules: [{ matchPackageNames: ["foo.+"] }],
      });
      expect(findings[0]!.severity).toBe("warn");
    });

    it("matchManagers-unknown-name is severity 'error'", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["nmp"] }],
      });
      expect(findings[0]!.severity).toBe("error");
    });

    it("deprecated-key is severity 'warn'", () => {
      const findings = lintConfig({ masterIssue: true });
      expect(findings[0]!.severity).toBe("warn");
    });

    it("matchManagers-unknown-name populates suggestion when a close match exists", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["nmp"] }],
      });
      expect(findings[0]!.suggestion).toBe("npm");
    });

    it("matchManagers-unknown-name omits suggestion when nothing is close enough", () => {
      const findings = lintConfig({
        packageRules: [{ matchManagers: ["totally-made-up-thing"] }],
      });
      expect(findings[0]!.suggestion).toBeUndefined();
    });

    it("deprecated-key populates suggestion with the migrated key name", () => {
      const findings = lintConfig({ masterIssue: true });
      expect(findings[0]!.suggestion).toBe("dependencyDashboard");
    });
  });
});
