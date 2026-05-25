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

describe("serializeConfig — round-trip stub", () => {
  it("throws the documented sentinel error when `existing` is provided (plan 04-02 will implement)", () => {
    expect(() =>
      serializeConfig({
        targetPath: "renovate.json",
        nextConfig: {},
        existing: "{}\n",
      }),
    ).toThrow(/not implemented/);
  });
});
