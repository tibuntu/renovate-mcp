import { describe, it, expect } from "vitest";
import { explainDependency } from "../../src/lib/dependencyExplainer.js";

interface FixtureOptions {
  manager?: string;
  packageFile?: string;
  problems?: Array<Record<string, unknown>>;
  repoProblems?: Array<Record<string, unknown>>;
}

/** A minimal `--report-type=file` report: one repo, one manager, one package file. */
function report(deps: Array<Record<string, unknown>>, opts: FixtureOptions = {}): unknown {
  const manager = opts.manager ?? "npm";
  return {
    problems: opts.problems ?? [],
    repositories: {
      "owner/repo": {
        problems: opts.repoProblems ?? [],
        branches: [],
        packageFiles: {
          [manager]: [{ packageFile: opts.packageFile ?? "package.json", deps }],
        },
      },
    },
  };
}

const LODASH_UP_TO_DATE = {
  depName: "lodash",
  packageName: "lodash",
  currentValue: "^4.17.21",
  currentVersion: "4.17.21",
  datasource: "npm",
  depType: "dependencies",
  updates: [],
  warnings: [],
};

describe("explainDependency — matching", () => {
  it("matches depName exactly and case-insensitively by default", () => {
    const rep = report([LODASH_UP_TO_DATE, { ...LODASH_UP_TO_DATE, depName: "lodash-es", packageName: "lodash-es" }]);
    const out = explainDependency(rep, { depName: "LODASH" });
    expect(out.depName).toBe("LODASH");
    expect(out.hits.map((h) => h.depName)).toEqual(["lodash"]);
  });

  it("partial: true switches to substring matching", () => {
    const rep = report([LODASH_UP_TO_DATE, { ...LODASH_UP_TO_DATE, depName: "lodash-es", packageName: "lodash-es" }]);
    const out = explainDependency(rep, { depName: "lodash", partial: true });
    expect(out.hits.map((h) => h.depName).sort()).toEqual(["lodash", "lodash-es"]);
  });

  it("also matches on packageName", () => {
    const rep = report(
      [{ depName: "node", packageName: "docker.io/library/node", currentValue: "20", updates: [] }],
      { manager: "dockerfile", packageFile: "Dockerfile" },
    );
    const out = explainDependency(rep, { depName: "docker.io/library/node" });
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]).toMatchObject({
      repository: "owner/repo",
      manager: "dockerfile",
      packageFile: "Dockerfile",
      depName: "node",
      packageName: "docker.io/library/node",
    });
  });

  it("filters by manager when given", () => {
    const rep = {
      repositories: {
        "owner/repo": {
          packageFiles: {
            npm: [{ packageFile: "package.json", deps: [LODASH_UP_TO_DATE] }],
            "github-actions": [
              { packageFile: ".github/workflows/ci.yml", deps: [{ depName: "lodash", updates: [] }] },
            ],
          },
        },
      },
    };
    expect(explainDependency(rep, { depName: "lodash" }).hits).toHaveLength(2);
    const filtered = explainDependency(rep, { depName: "lodash", manager: "npm" });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]!.manager).toBe("npm");
  });

  it("unwraps a full dry_run summary ({ report })", () => {
    const out = explainDependency({ ok: true, report: report([LODASH_UP_TO_DATE]) }, { depName: "lodash" });
    expect(out.hits).toHaveLength(1);
  });

  it("tolerates malformed input", () => {
    expect(explainDependency(null, { depName: "x" }).hits).toEqual([]);
    expect(explainDependency({ repositories: { r: { packageFiles: { npm: "nope" } } } }, { depName: "x" }).hits).toEqual([]);
  });
});

describe("explainDependency — verdicts", () => {
  it("not found in report, with coverage hints", () => {
    const out = explainDependency(report([LODASH_UP_TO_DATE]), { depName: "left-pad" });
    expect(out.hits).toEqual([]);
    expect(out.verdict).toBe("not found in report");
    const joined = out.hints.join("\n");
    expect(joined).toMatch(/enabledManagers/);
    expect(joined).toMatch(/managerFilePatterns/);
    expect(joined).toMatch(/ignorePaths/);
    expect(joined).toMatch(/dryRunMode: "extract"/);
  });

  it("up to date", () => {
    const out = explainDependency(report([LODASH_UP_TO_DATE]), { depName: "lodash" });
    expect(out.verdict).toBe("up to date");
    expect(out.hits[0]!.updates).toEqual([]);
  });

  it("N update(s) available, lifting the update fields", () => {
    const dep = {
      ...LODASH_UP_TO_DATE,
      currentVersion: "4.0.0",
      updates: [
        { newVersion: "4.17.21", newValue: "^4.17.21", updateType: "minor", branchName: "renovate/lodash-4.x", extra: 1 },
        { newVersion: "5.0.0", newValue: "^5.0.0", updateType: "major", branchName: "renovate/lodash-5.x" },
      ],
    };
    const out = explainDependency(report([dep]), { depName: "lodash" });
    expect(out.verdict).toBe("2 updates available");
    expect(out.hits[0]!.updates).toEqual([
      { newVersion: "4.17.21", newValue: "^4.17.21", updateType: "minor", branchName: "renovate/lodash-4.x" },
      { newVersion: "5.0.0", newValue: "^5.0.0", updateType: "major", branchName: "renovate/lodash-5.x" },
    ]);
    expect(explainDependency(report([{ ...dep, updates: [dep.updates[0]] }]), { depName: "lodash" }).verdict).toBe(
      "1 update available",
    );
  });

  it("skipped: <skipReason> with a remedy hint", () => {
    const out = explainDependency(
      report([{ depName: "lodash", skipReason: "ignored", skipStage: "pre-lookup", updates: [] }]),
      { depName: "lodash" },
    );
    expect(out.verdict).toBe("skipped: ignored");
    expect(out.hits[0]).toMatchObject({ skipReason: "ignored", skipStage: "pre-lookup" });
    expect(out.hints.join("\n")).toMatch(/ignoreDeps/);
  });

  it("lists differing skip reasons per hit and falls back to a generic hint for unknown reasons", () => {
    const rep = {
      repositories: {
        "owner/repo": {
          packageFiles: {
            npm: [
              { packageFile: "package.json", deps: [{ depName: "lodash", skipReason: "disabled" }] },
              { packageFile: "packages/a/package.json", deps: [{ depName: "lodash", skipReason: "some-new-reason" }] },
            ],
          },
        },
      },
    };
    const out = explainDependency(rep, { depName: "lodash" });
    expect(out.verdict).toBe("skipped: disabled; skipped: some-new-reason");
    const joined = out.hints.join("\n");
    expect(joined).toMatch(/enabled: false/);
    expect(joined).toMatch(/some-new-reason/);
  });

  it("hints that no lookup ran when a hit carries no updates array at all", () => {
    const out = explainDependency(report([{ depName: "lodash", currentValue: "^4.0.0" }]), { depName: "lodash" });
    expect(out.verdict).toBe("up to date");
    expect(out.hints.join("\n")).toMatch(/extract/);
  });

  it("carries dependency warnings through", () => {
    const out = explainDependency(
      report([{ ...LODASH_UP_TO_DATE, warnings: [{ topic: "Lookup Error", message: "lodash: boom", extra: true }] }]),
      { depName: "lodash" },
    );
    expect(out.hits[0]!.warnings).toEqual([{ topic: "Lookup Error", message: "lodash: boom" }]);
  });
});

describe("explainDependency — relatedProblems", () => {
  it("collects report-level and repo-level problems that mention the dependency", () => {
    const rep = report([LODASH_UP_TO_DATE], {
      problems: [
        { level: 30, msg: "Failed to look up npm package lodash" },
        { level: 30, msg: "Unrelated" },
      ],
      repoProblems: [
        { level: 40, msg: "Lookup failed", depName: "lodash" },
        { level: 40, msg: "Lookup failed", depName: "axios" },
      ],
    });
    const out = explainDependency(rep, { depName: "lodash" });
    expect(out.relatedProblems).toEqual([
      { level: 30, msg: "Failed to look up npm package lodash" },
      { repository: "owner/repo", level: 40, msg: "Lookup failed", depName: "lodash" },
    ]);
  });
});
