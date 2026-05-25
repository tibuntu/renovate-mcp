import { describe, it, expect } from "vitest";
import { serializeConfig } from "../../src/lib/configWriter.js";

describe("serializeConfig — fresh-write path", () => {
  it("returns mode=fresh-write and byte-identical output to JSON.stringify for a representative config", () => {
    const nextConfig = {
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      extends: ["config:recommended"],
      packageRules: [{ matchPackageNames: ["lodash"], enabled: false }],
    };
    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig,
      existing: undefined,
    });

    expect(result).toEqual({
      mode: "fresh-write",
      bytes: JSON.stringify(nextConfig, null, 2) + "\n",
    });
  });

  it("returns `{}\\n` for an empty config", () => {
    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: {},
      existing: undefined,
    });

    expect("refuse" in result).toBe(false);
    if ("refuse" in result) return;
    expect(result.mode).toBe("fresh-write");
    expect(result.bytes).toBe("{}\n");
    expect(result.bytes).toBe(JSON.stringify({}, null, 2) + "\n");
  });

  it("preserves caller-supplied key insertion order (no alphabetization on the fresh-write path)", () => {
    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: { b: 1, a: 2 },
      existing: undefined,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    // `b` must appear before `a` — matches JSON.stringify's insertion-order
    // contract, which the fresh-write branch deliberately inherits.
    const bIdx = result.bytes.indexOf('"b"');
    const aIdx = result.bytes.indexOf('"a"');
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeLessThan(aIdx);
    expect(result.bytes).toBe(JSON.stringify({ b: 1, a: 2 }, null, 2) + "\n");
  });

  it("ignores targetPath on the fresh-write path (different extensions ⇒ identical bytes)", () => {
    const nextConfig = { extends: ["config:recommended"] };
    const a = serializeConfig({
      targetPath: "renovate.json",
      nextConfig,
      existing: undefined,
    });
    const b = serializeConfig({
      targetPath: ".github/renovate.json",
      nextConfig,
      existing: undefined,
    });

    if ("refuse" in a || "refuse" in b) throw new Error("unexpected refusal");
    expect(a.bytes).toBe(b.bytes);
  });

  it("matches an inline snapshot for the representative config (review-readability anchor)", () => {
    const nextConfig = {
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      extends: ["config:recommended"],
      packageRules: [{ matchPackageNames: ["lodash"], enabled: false }],
    };
    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig,
      existing: undefined,
    });
    if ("refuse" in result) throw new Error("unexpected refusal");

    expect(result.bytes).toMatchInlineSnapshot(`
      "{
        "$schema": "https://docs.renovatebot.com/renovate-schema.json",
        "extends": [
          "config:recommended"
        ],
        "packageRules": [
          {
            "matchPackageNames": [
              "lodash"
            ],
            "enabled": false
          }
        ]
      }
      "
    `);
  });
});

describe("serializeConfig — round-trip path", () => {
  it("preserves top-of-file and above-key comments when editing a TOP-LEVEL key", () => {
    // The edit targets `schedule` (a top-level key), NOT something inside
    // packageRules — this test is independent of array-element semantics.
    const existing = [
      "// extends a hardened preset",
      "{",
      '  "extends": ["config:recommended"],',
      "  // dedupe with security tooling",
      '  "packageRules": [',
      '    { "matchPackageNames": ["lodash"], "enabled": false }',
      "  ],",
      '  "schedule": ["before 5am"]',
      "}",
      "",
    ].join("\n");

    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: {
        extends: ["config:recommended"],
        packageRules: [{ matchPackageNames: ["lodash"], enabled: false }],
        schedule: ["before 9am on Monday"],
      },
      existing,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    expect(result.mode).toBe("round-trip");
    // Both comments survive verbatim.
    expect(result.bytes).toContain("// extends a hardened preset");
    expect(result.bytes).toContain("// dedupe with security tooling");
    // The new schedule value is present, old value is not.
    expect(result.bytes).toContain("before 9am on Monday");
    expect(result.bytes).not.toContain("before 5am");
  });

  it("is a no-op when nextConfig is structurally equal (key reorder included)", () => {
    const existing = [
      "{",
      '  "extends": ["config:recommended"],',
      '  "packageRules": [{ "matchPackageNames": ["lodash"] }],',
      '  "schedule": ["before 5am"]',
      "}",
      "",
    ].join("\n");

    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: {
        // Caller-supplied key order is different from `existing`:
        schedule: ["before 5am"],
        extends: ["config:recommended"],
        packageRules: [{ matchPackageNames: ["lodash"] }],
      },
      existing,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    expect(result.mode).toBe("round-trip");
    // No edits were needed → bytes equal existing verbatim.
    expect(result.bytes).toBe(existing);
  });

  it("adds a top-level key without disturbing existing content", () => {
    const existing = '{ "extends": ["config:recommended"] }\n';

    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: {
        extends: ["config:recommended"],
        schedule: ["before 9am on Monday"],
      },
      existing,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    expect(result.mode).toBe("round-trip");
    expect(result.bytes).toContain('"extends"');
    expect(result.bytes).toContain('"config:recommended"');
    expect(result.bytes).toContain('"schedule"');
    expect(result.bytes).toContain("before 9am on Monday");
  });

  it("removes a top-level key, leaving siblings intact", () => {
    const existing = [
      "{",
      '  "extends": ["config:recommended"],',
      '  "schedule": ["before 5am"]',
      "}",
      "",
    ].join("\n");

    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: { extends: ["config:recommended"] },
      existing,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    expect(result.mode).toBe("round-trip");
    expect(result.bytes).not.toContain('"schedule"');
    expect(result.bytes).toContain('"extends"');
    expect(result.bytes).toContain('"config:recommended"');
  });

  it("renames a key (remove + add) without leaving the old key behind", () => {
    const existing = [
      "{",
      '  "automerge": true',
      "}",
      "",
    ].join("\n");

    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: { automergeType: "branch" },
      existing,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    expect(result.mode).toBe("round-trip");
    expect(result.bytes).toContain('"automergeType"');
    expect(result.bytes).toContain('"branch"');
    // Old key gone (match the standalone key, not a substring).
    expect(result.bytes).not.toMatch(/"automerge"\s*:/);
  });

  it("preserves the comment ABOVE an array when the array's contents change (atomic-array semantics)", () => {
    // Array-element edit: the algorithm treats arrays as atomic, so the whole
    // `packageRules` array is replaced. The comment ABOVE `packageRules` is
    // outside the edited region and MUST survive. Comments INSIDE the array
    // element are NOT guaranteed to survive — see the source comment in
    // configWriter.ts on array semantics.
    const existing = [
      "{",
      "  // package-specific overrides",
      '  "packageRules": [',
      '    { "matchPackageNames": ["lodash"] }',
      "  ]",
      "}",
      "",
    ].join("\n");

    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: {
        packageRules: [{ matchPackageNames: ["lodash"], enabled: false }],
      },
      existing,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    expect(result.mode).toBe("round-trip");
    expect(result.bytes).toContain("// package-specific overrides");
    expect(result.bytes).toContain('"matchPackageNames"');
    expect(result.bytes).toContain('"enabled"');
    expect(result.bytes).toContain("false");
  });

  it("refuses with a structured error when the existing text is not parseable as JSONC", () => {
    const result = serializeConfig({
      targetPath: "renovate.json5",
      nextConfig: { extends: ["config:recommended"] },
      existing: "{ unquoted: 'single' }",
    });

    expect("refuse" in result).toBe(true);
    if (!("refuse" in result)) return;
    expect(result.refuse).toBe(true);
    expect(result.reason).toBe("json5-not-jsonc-compatible");
    expect(result.hint).toContain("force=true");
  });

  it("preserves CRLF line endings when the existing file uses them", () => {
    const existing =
      "{\r\n" +
      '  "extends": ["config:recommended"],\r\n' +
      '  "schedule": ["before 5am"]\r\n' +
      "}\r\n";

    const result = serializeConfig({
      targetPath: "renovate.json",
      nextConfig: {
        extends: ["config:recommended"],
        schedule: ["before 9am on Monday"],
      },
      existing,
    });

    if ("refuse" in result) throw new Error("unexpected refusal");
    expect(result.mode).toBe("round-trip");
    // CRLF preserved on existing lines.
    expect(result.bytes).toContain("\r\n");
    // No bare LFs slipped in (every \n is preceded by \r).
    const lfPositions = [...result.bytes.matchAll(/\n/g)].map((m) => m.index!);
    for (const idx of lfPositions) {
      expect(result.bytes[idx - 1]).toBe("\r");
    }
  });
});
