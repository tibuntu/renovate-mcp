import { describe, it, expect } from "vitest";
import { diffDryRunReports, collectProposedUpdates } from "../../src/lib/dryRunDiff.js";

function makeReport(upgrades: Array<Record<string, unknown>>): unknown {
  return {
    repositories: {
      "owner/repo": {
        branches: [{ branchName: "renovate/all", upgrades }],
      },
    },
  };
}

describe("collectProposedUpdates", () => {
  it("returns empty array for empty / malformed reports", () => {
    expect(collectProposedUpdates(null)).toEqual([]);
    expect(collectProposedUpdates({})).toEqual([]);
    expect(collectProposedUpdates({ repositories: {} })).toEqual([]);
    expect(collectProposedUpdates({ repositories: { r: { branches: [] } } })).toEqual([]);
  });

  it("walks repositories[*].branches[*].upgrades[]", () => {
    const report = {
      repositories: {
        "a/b": {
          branches: [
            {
              branchName: "renovate/lodash",
              upgrades: [
                { manager: "npm", packageFile: "package.json", depName: "lodash" },
              ],
            },
            {
              branchName: "renovate/axios",
              upgrades: [
                { manager: "npm", packageFile: "package.json", depName: "axios" },
              ],
            },
          ],
        },
        "c/d": {
          branches: [
            {
              branchName: "renovate/django",
              upgrades: [
                { manager: "pip_requirements", packageFile: "requirements.txt", depName: "django" },
              ],
            },
          ],
        },
      },
    };
    const updates = collectProposedUpdates(report);
    expect(updates.map((u) => u.depName).sort()).toEqual(["axios", "django", "lodash"]);
  });

  it("skips upgrade entries missing manager or depName", () => {
    const report = makeReport([
      { manager: "npm", depName: "lodash" }, // ok (packageFile defaults to "")
      { manager: "npm", packageFile: "package.json" }, // missing depName
      { packageFile: "package.json", depName: "lodash" }, // missing manager
    ]);
    const updates = collectProposedUpdates(report);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.depName).toBe("lodash");
  });
});

describe("diffDryRunReports", () => {
  it("classifies added / removed / unchanged correctly", () => {
    const before = makeReport([
      { manager: "npm", packageFile: "package.json", depName: "lodash", newVersion: "4.17.21" },
      { manager: "npm", packageFile: "package.json", depName: "axios", newVersion: "1.5.0" },
    ]);
    const after = makeReport([
      { manager: "npm", packageFile: "package.json", depName: "lodash", newVersion: "4.17.21" },
      { manager: "npm", packageFile: "package.json", depName: "react", newVersion: "18.2.0" },
    ]);

    const diff = diffDryRunReports(before, after);
    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 0, unchanged: 1 });
    expect(diff.added.map((u) => u.depName)).toEqual(["react"]);
    expect(diff.removed.map((u) => u.depName)).toEqual(["axios"]);
  });

  it("groups a version bump on the same dep as `changed`, not removed+added", () => {
    const before = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        currentVersion: "4.17.20",
        newVersion: "4.17.21",
        updateType: "patch",
      },
    ]);
    const after = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        currentVersion: "4.17.20",
        newVersion: "4.18.0",
        updateType: "minor",
      },
    ]);

    const diff = diffDryRunReports(before, after);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 });
    const change = diff.changed[0]!;
    expect(change.depName).toBe("lodash");
    expect(change.changes.map((c) => c.field).sort()).toEqual(["newVersion", "updateType"]);
  });

  it("treats moving the same dep between packageFiles as removed+added (packageFile is part of identity)", () => {
    const before = makeReport([
      { manager: "npm", packageFile: "apps/a/package.json", depName: "lodash", newVersion: "4.17.21" },
    ]);
    const after = makeReport([
      { manager: "npm", packageFile: "apps/b/package.json", depName: "lodash", newVersion: "4.17.21" },
    ]);

    const diff = diffDryRunReports(before, after);
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.changed).toBe(0);
  });

  it("flags branchName / groupName changes for the same dep as `changed`", () => {
    const before = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        newVersion: "4.17.21",
        branchName: "renovate/lodash-4.x",
        groupName: undefined,
      },
    ]);
    const after = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        newVersion: "4.17.21",
        branchName: "renovate/all-minor",
        groupName: "all minor updates",
      },
    ]);

    const diff = diffDryRunReports(before, after);
    expect(diff.summary.changed).toBe(1);
    const fields = diff.changed[0]!.changes.map((c) => c.field).sort();
    expect(fields).toEqual(["branchName", "groupName"]);
  });

  it("flags schedule changes via structural equality", () => {
    const before = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        newVersion: "4.17.21",
        schedule: ["before 6am on monday"],
      },
    ]);
    const after = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        newVersion: "4.17.21",
        schedule: ["before 6am on monday", "before 6am on thursday"],
      },
    ]);

    const diff = diffDryRunReports(before, after);
    expect(diff.summary.changed).toBe(1);
    expect(diff.changed[0]!.changes.map((c) => c.field)).toEqual(["schedule"]);
  });

  it("accepts the full dry_run tool summary (with `report` and other keys) on either side", () => {
    const wrap = (report: unknown): unknown => ({
      ok: true,
      exitCode: 0,
      hasReport: true,
      report,
    });
    const before = wrap(
      makeReport([{ manager: "npm", packageFile: "p.json", depName: "lodash", newVersion: "1" }]),
    );
    const after = wrap(
      makeReport([{ manager: "npm", packageFile: "p.json", depName: "lodash", newVersion: "2" }]),
    );

    const diff = diffDryRunReports(before, after);
    expect(diff.summary.changed).toBe(1);
    expect(diff.changed[0]!.changes[0]!.field).toBe("newVersion");
  });

  it("handles empty reports on either side", () => {
    const empty = { repositories: {} };
    const populated = makeReport([
      { manager: "npm", packageFile: "p.json", depName: "lodash", newVersion: "1" },
    ]);

    expect(diffDryRunReports(empty, populated).summary).toEqual({
      added: 1,
      removed: 0,
      changed: 0,
      unchanged: 0,
    });
    expect(diffDryRunReports(populated, empty).summary).toEqual({
      added: 0,
      removed: 1,
      changed: 0,
      unchanged: 0,
    });
    expect(diffDryRunReports(empty, empty).summary).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 0,
    });
  });

  it("produces stable, sorted output", () => {
    const before = makeReport([]);
    const after = makeReport([
      { manager: "npm", packageFile: "p.json", depName: "zod", newVersion: "1" },
      { manager: "npm", packageFile: "p.json", depName: "axios", newVersion: "1" },
      { manager: "npm", packageFile: "p.json", depName: "lodash", newVersion: "1" },
    ]);
    const diff = diffDryRunReports(before, after);
    expect(diff.added.map((u) => u.depName)).toEqual(["axios", "lodash", "zod"]);
  });

  describe("text rendering", () => {
    it("returns a friendly no-op message when both reports are empty", () => {
      const diff = diffDryRunReports({ repositories: {} }, { repositories: {} });
      expect(diff.text).toMatch(/No proposed updates/);
    });

    it("returns a 'no differences' message when reports match", () => {
      const r = makeReport([
        { manager: "npm", packageFile: "p.json", depName: "lodash", newVersion: "1" },
      ]);
      const diff = diffDryRunReports(r, r);
      expect(diff.text).toMatch(/No differences/);
      expect(diff.text).toMatch(/1 proposed update unchanged/);
    });

    it("renders added / removed / changed sections with arrows and update types", () => {
      const before = makeReport([
        {
          manager: "npm",
          packageFile: "package.json",
          depName: "lodash",
          currentVersion: "4.17.20",
          newVersion: "4.17.21",
          updateType: "patch",
        },
        { manager: "npm", packageFile: "package.json", depName: "axios", newVersion: "1.5.0" },
      ]);
      const after = makeReport([
        {
          manager: "npm",
          packageFile: "package.json",
          depName: "lodash",
          currentVersion: "4.17.20",
          newVersion: "4.18.0",
          updateType: "minor",
        },
        { manager: "npm", packageFile: "package.json", depName: "react", newVersion: "18.2.0" },
      ]);

      const diff = diffDryRunReports(before, after);
      expect(diff.text).toContain("1 added");
      expect(diff.text).toContain("1 removed");
      expect(diff.text).toContain("1 changed");
      expect(diff.text).toContain("Added:");
      expect(diff.text).toContain("react");
      expect(diff.text).toContain("Removed:");
      expect(diff.text).toContain("axios");
      expect(diff.text).toContain("Changed:");
      expect(diff.text).toContain("lodash");
      expect(diff.text).toMatch(/4\.17\.21.*→.*4\.18\.0/);
    });
  });
});
