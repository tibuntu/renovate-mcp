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
});
