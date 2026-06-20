import { describe, it, expect } from "vitest";
import { diffResolvedConfigs, stableStringify } from "../../src/lib/resolveConfigDiff.js";

describe("stableStringify", () => {
  it("is insensitive to object key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("sorts keys recursively but preserves array order", () => {
    expect(stableStringify({ x: { b: 1, a: 2 }, list: [3, 1, 2] })).toBe(
      '{"list":[3,1,2],"x":{"a":2,"b":1}}',
    );
  });
});

describe("diffResolvedConfigs", () => {
  it("reports no differences for identical configs", () => {
    const diff = diffResolvedConfigs({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 });
    expect(diff.summary).toEqual({
      fieldsChanged: 0,
      arraysChanged: 0,
      arrayItemsAdded: 0,
      arrayItemsRemoved: 0,
    });
    expect(diff.text).toMatch(/No differences/);
  });

  it("detects a scalar change", () => {
    const diff = diffResolvedConfigs({ prHourlyLimit: 2 }, { prHourlyLimit: 0 });
    expect(diff.summary.fieldsChanged).toBe(1);
    expect(diff.fieldChanges).toEqual([{ key: "prHourlyLimit", before: 2, after: 0 }]);
  });

  it("detects a nested-object change as a whole-field change", () => {
    const diff = diffResolvedConfigs(
      { lockFileMaintenance: { enabled: false } },
      { lockFileMaintenance: { enabled: true } },
    );
    expect(diff.summary.fieldsChanged).toBe(1);
    expect(diff.fieldChanges[0]).toEqual({
      key: "lockFileMaintenance",
      before: { enabled: false },
      after: { enabled: true },
    });
  });

  it("reports a key present on only one side with undefined on the missing side", () => {
    const added = diffResolvedConfigs({}, { semanticCommits: "enabled" });
    expect(added.fieldChanges).toEqual([
      { key: "semanticCommits", before: undefined, after: "enabled" },
    ]);
    const removed = diffResolvedConfigs({ semanticCommits: "enabled" }, {});
    expect(removed.fieldChanges).toEqual([
      { key: "semanticCommits", before: "enabled", after: undefined },
    ]);
  });

  it("set-diffs packageRules: removed, added, and a tweaked rule as one of each", () => {
    const before = {
      packageRules: [
        { matchUpdateTypes: ["minor", "patch"], automerge: true },
        { matchDepNames: ["left-pad"], enabled: false },
      ],
    };
    const after = {
      packageRules: [
        { matchUpdateTypes: ["minor", "patch"], automerge: false }, // tweaked
        { groupName: "all", matchPackageNames: ["/foo/"] }, // added
      ],
    };
    const diff = diffResolvedConfigs(before, after);
    expect(diff.summary.arraysChanged).toBe(1);
    // tweaked rule + removed enabled:false rule
    expect(diff.arrayChanges.packageRules!.removed).toHaveLength(2);
    // tweaked rule (new form) + brand-new group rule
    expect(diff.arrayChanges.packageRules!.added).toHaveLength(2);
    expect(diff.summary.arrayItemsRemoved).toBe(2);
    expect(diff.summary.arrayItemsAdded).toBe(2);
  });

  it("treats a reordered array as no change", () => {
    const before = { packageRules: [{ a: 1 }, { b: 2 }] };
    const after = { packageRules: [{ b: 2 }, { a: 1 }] };
    const diff = diffResolvedConfigs(before, after);
    expect(diff.summary.arraysChanged).toBe(0);
  });

  it("treats array members with reordered keys as equal", () => {
    const before = { packageRules: [{ matchManagers: ["npm"], automerge: true }] };
    const after = { packageRules: [{ automerge: true, matchManagers: ["npm"] }] };
    const diff = diffResolvedConfigs(before, after);
    expect(diff.summary.arraysChanged).toBe(0);
  });

  it("generalizes the set-diff to any top-level array key", () => {
    const diff = diffResolvedConfigs(
      { addLabels: ["deps"] },
      { addLabels: ["deps", "renovate"] },
    );
    expect(diff.arrayChanges.addLabels).toEqual({ added: ["renovate"], removed: [] });
    expect(diff.summary.arraysChanged).toBe(1);
  });

  it("set-diffs a key that is an array on only one side", () => {
    const diff = diffResolvedConfigs({}, { ignorePaths: ["dist/**"] });
    expect(diff.arrayChanges.ignorePaths).toEqual({ added: ["dist/**"], removed: [] });
  });

  it("treats array-vs-non-array as a field change, not a set diff", () => {
    const diff = diffResolvedConfigs({ foo: [1, 2] }, { foo: "bar" });
    expect(diff.summary.arraysChanged).toBe(0);
    expect(diff.fieldChanges).toEqual([{ key: "foo", before: [1, 2], after: "bar" }]);
  });

  it("renders a text body with field and array sections", () => {
    const diff = diffResolvedConfigs(
      { prHourlyLimit: 2, packageRules: [{ a: 1 }] },
      { prHourlyLimit: 0, packageRules: [{ a: 1 }, { b: 2 }] },
    );
    expect(diff.text).toContain("Changed fields:");
    expect(diff.text).toContain("prHourlyLimit: OLD=2  NEW=0");
    expect(diff.text).toContain("packageRules:");
    expect(diff.text).toContain('+ {"b":2}');
  });
});
