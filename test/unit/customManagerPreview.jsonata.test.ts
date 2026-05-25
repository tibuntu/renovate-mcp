import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStructured,
  runEvaluateJsonataInWorker,
} from "../../src/lib/customManagerPreview.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

describe("parseStructured", () => {
  it("parses JSON content", async () => {
    const res = await parseStructured('{"a":1}', "json");
    expect(res).toEqual({ ok: true, value: { a: 1 } });
  });

  it("parses YAML content (lazy-imports yaml)", async () => {
    const res = await parseStructured("a: 1\n", "yaml");
    expect(res).toEqual({ ok: true, value: { a: 1 } });
  });

  it("parses TOML content (lazy-imports smol-toml)", async () => {
    const res = await parseStructured("a = 1\n", "toml");
    expect(res).toEqual({ ok: true, value: { a: 1 } });
  });

  it("returns ok:false with error message on malformed JSON", async () => {
    const res = await parseStructured("{", "json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeTruthy();
  });

  it("returns ok:false on malformed YAML", async () => {
    // Inconsistent indentation under a sequence is a yaml.parse throw.
    const res = await parseStructured("a:\n  - b\n - c\n", "yaml");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeTruthy();
  });

  it("returns ok:false on malformed TOML", async () => {
    const res = await parseStructured("a =\n", "toml");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeTruthy();
  });

  it("returns ok:false on unsupported fileFormat (defensive)", async () => {
    // @ts-expect-error — intentionally probing the defensive branch.
    const res = await parseStructured("x", "xml");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unsupported fileFormat: xml/);
  });
});

describe("runEvaluateJsonataInWorker", () => {
  it("evaluates a trivial root expression", async () => {
    const res = await runEvaluateJsonataInWorker("$", { x: 1 }, 5000);
    expect(res).toEqual({ timedOut: false, ok: true, result: { x: 1 } });
  });

  it("evaluates a structural projection over an array", async () => {
    const res = await runEvaluateJsonataInWorker(
      'packages.{ "depName": name }',
      { packages: [{ name: "lodash" }, { name: "axios" }] },
      5000,
    );
    expect(res.timedOut).toBe(false);
    if (!res.timedOut && res.ok) {
      // toEqual on the deep array can mismatch in vitest pretty-print due to
      // structuredClone metadata; compare via JSON serialization for stability.
      expect(JSON.stringify(res.result)).toBe(
        JSON.stringify([{ depName: "lodash" }, { depName: "axios" }]),
      );
    } else {
      throw new Error("expected ok:true result");
    }
  });

  it("returns ok:false (not throws) on a compile error", async () => {
    const res = await runEvaluateJsonataInWorker("((", {}, 5000);
    expect(res.timedOut).toBe(false);
    if (!res.timedOut) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBeTruthy();
    }
  });
});

describe("jsonata pin matches Renovate's pin", () => {
  it("our jsonata dep version equals Renovate's jsonata dep version", async () => {
    const ours = JSON.parse(
      await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    );
    const theirs = JSON.parse(
      await readFile(
        path.join(PROJECT_ROOT, "node_modules/renovate/package.json"),
        "utf8",
      ),
    );
    const ourPin: string | undefined = ours.dependencies?.jsonata;
    const theirPin: string | undefined = theirs.dependencies?.jsonata;
    expect(ourPin, "renovate-mcp package.json missing dependencies.jsonata").toBeTruthy();
    expect(theirPin, "renovate package.json missing dependencies.jsonata").toBeTruthy();
    expect(
      ourPin,
      `Renovate's jsonata pin drifted from ${ourPin} to ${theirPin}; ` +
        `update our package.json dependencies.jsonata to match and re-run ` +
        `parity tests against any new fixtures.`,
    ).toBe(theirPin);
  });
});
