import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStructured,
  previewCustomManager,
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

describe("previewCustomManager (jsonata branch — end-to-end)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(
      path.join(tmpdir(), `rmcp-jsonata-e2e-${process.pid}-`),
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("JSON happy path: extracts deps from a package.json-style fixture", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        dependencies: { lodash: "^4.17.0", axios: "^1.6.0" },
      }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^package\\.json$"],
      matchStrings: [
        '$each(dependencies, function($v, $k) { { "depName": $k, "currentValue": $v, "datasource": "npm" } })',
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.filesMatched).toEqual(["package.json"]);
    expect(result.extractedDeps).toHaveLength(2);
    const names = result.extractedDeps.map((d) => d.depName).sort();
    expect(names).toEqual(["axios", "lodash"]);
    for (const dep of result.extractedDeps) {
      expect(dep.datasource).toBe("npm");
      expect(dep.line).toBe(1);
      expect(dep.file).toBe("package.json");
    }
    expect(result.hits).toEqual([]);
  });

  it("YAML happy path: extracts deps from a Chart.yaml-style fixture", async () => {
    await writeFile(
      path.join(repo, "Chart.yaml"),
      [
        "dependencies:",
        "  - name: postgresql",
        "    version: 14.0.0",
        "    repository: https://charts.bitnami.com/bitnami",
        "  - name: redis",
        "    version: 17.0.0",
        "    repository: https://charts.bitnami.com/bitnami",
        "",
      ].join("\n"),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "yaml",
      fileMatch: ["Chart\\.yaml$"],
      matchStrings: [
        'dependencies.{ "depName": name, "currentValue": version, "registryUrl": repository, "datasource": "helm" }',
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toHaveLength(2);
    expect(result.extractedDeps[0]).toMatchObject({
      depName: "postgresql",
      currentValue: "14.0.0",
      registryUrl: "https://charts.bitnami.com/bitnami",
      datasource: "helm",
    });
    expect(result.extractedDeps[1]).toMatchObject({
      depName: "redis",
      currentValue: "17.0.0",
    });
  });

  it("TOML happy path: extracts deps from a Cargo.toml-style fixture", async () => {
    await writeFile(
      path.join(repo, "Cargo.toml"),
      [
        "[dependencies]",
        'serde = "1.0.0"',
        'tokio = "1.30.0"',
        "",
      ].join("\n"),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "toml",
      fileMatch: ["Cargo\\.toml$"],
      matchStrings: [
        '$each(dependencies, function($v, $k) { { "depName": $k, "currentValue": $v, "datasource": "crate" } })',
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toHaveLength(2);
    const names = result.extractedDeps.map((d) => d.depName).sort();
    expect(names).toEqual(["serde", "tokio"]);
  });

  it("bare-object wrap: a single-object JSONata result becomes one dep (QueryResultZod parity)", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.17.21" } }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^package\\.json$"],
      matchStrings: [
        '{ "depName": "lodash", "currentValue": dependencies.lodash, "datasource": "npm" }',
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toHaveLength(1);
    expect(result.extractedDeps[0]).toMatchObject({
      depName: "lodash",
      currentValue: "^4.17.21",
      datasource: "npm",
    });
  });

  it("numeric value stringification: number flows through template as string", async () => {
    await writeFile(
      path.join(repo, "data.json"),
      JSON.stringify({ x: 1 }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^data\\.json$"],
      matchStrings: [
        '{ "depName": "foo", "currentValue": 1.2, "datasource": "npm" }',
      ],
      currentValueTemplate: "{{currentValue}}-pinned",
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toHaveLength(1);
    expect(result.extractedDeps[0]?.currentValue).toBe("1.2-pinned");
  });

  it("numeric value stringification: direct read path coerces to string", async () => {
    await writeFile(
      path.join(repo, "data.json"),
      JSON.stringify({ x: 1 }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^data\\.json$"],
      matchStrings: [
        '{ "depName": "foo", "currentValue": 1.2, "datasource": "npm" }',
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps[0]?.currentValue).toBe("1.2");
  });

  it("object/array values are skipped from the groups bag (no [object Object])", async () => {
    await writeFile(
      path.join(repo, "data.json"),
      JSON.stringify({ x: 1 }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^data\\.json$"],
      matchStrings: [
        '{ "depName": "foo", "currentValue": "1.0.0", "meta": { "nested": true }, "datasource": "npm" }',
      ],
      datasourceTemplate: "{{meta}}-skip",
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toHaveLength(1);
    // `meta` is an object → skipped from groups → template substitutes to "".
    expect(result.extractedDeps[0]?.datasource).toBe("-skip");
  });

  it("template overlay: datasourceTemplate populates missing field", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.17.0", axios: "^1.6.0" } }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^package\\.json$"],
      matchStrings: [
        '$each(dependencies, function($v, $k) { { "depName": $k, "currentValue": $v } })',
      ],
      datasourceTemplate: "npm",
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toHaveLength(2);
    for (const dep of result.extractedDeps) {
      expect(dep.datasource).toBe("npm");
    }
  });

  it("{{groupName}}-style template substitution works for jsonata", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.17.0" } }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^package\\.json$"],
      matchStrings: [
        '$each(dependencies, function($v, $k) { { "depName": $k, "currentValue": $v } })',
      ],
      datasourceTemplate: "{{depName}}-meta",
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps[0]?.datasource).toBe("lodash-meta");
  });

  it("output-shape mismatch (primitive): emits warning naming typeof", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.17.0" } }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^package\\.json$"],
      matchStrings: ["dependencies.lodash"],
    });
    expect(result.extractedDeps).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/must return an array of objects or a single object/);
    expect(result.warnings[0]).toMatch(/typeof === 'string'/);
  });

  it("output-shape mismatch (array of non-object): emits warning", async () => {
    await writeFile(
      path.join(repo, "config.json"),
      JSON.stringify({ names: ["a", "b", "c"] }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^config\\.json$"],
      matchStrings: ["names"],
    });
    expect(result.extractedDeps).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/array of non-object/);
  });

  it("empty array result is silent (no warnings, no deps)", async () => {
    await writeFile(
      path.join(repo, "data.json"),
      JSON.stringify({ packages: [] }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^data\\.json$"],
      matchStrings: ['packages.{ "depName": name }'],
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toEqual([]);
  });

  it("null result (no path match) is silent", async () => {
    await writeFile(
      path.join(repo, "data.json"),
      JSON.stringify({ x: 1 }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^data\\.json$"],
      matchStrings: ["nonexistent.field"],
    });
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toEqual([]);
  });

  it("compile error: surfaces JSONata error as a warning, no deps", async () => {
    await writeFile(
      path.join(repo, "data.json"),
      JSON.stringify({ x: 1 }),
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "json",
      fileMatch: ["^data\\.json$"],
      matchStrings: ["(("],
    });
    expect(result.extractedDeps).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/JSONata compile\/evaluation error/);
  });

  it("per-file parse failure is scoped to that file; other files still process", async () => {
    await writeFile(
      path.join(repo, "bad.yaml"),
      "a:\n  - b\n - c\n", // inconsistent indent → yaml.parse throws
    );
    await writeFile(
      path.join(repo, "good.yaml"),
      "packages:\n  - name: lodash\n    version: 4.17.0\n",
    );
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileFormat: "yaml",
      fileMatch: ["\\.yaml$"],
      matchStrings: ['packages.{ "depName": name, "currentValue": version }'],
    });
    expect(result.filesMatched.sort()).toEqual(["bad.yaml", "good.yaml"]);
    expect(result.extractedDeps).toHaveLength(1);
    expect(result.extractedDeps[0]).toMatchObject({
      depName: "lodash",
      currentValue: "4.17.0",
      file: "good.yaml",
    });
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => /bad\.yaml.*failed to parse/.test(w))).toBe(true);
  });

  it("missing fileFormat at the lib level returns a warning + empty result", async () => {
    const result = await previewCustomManager(repo, {
      customType: "jsonata",
      fileMatch: ["x"],
      matchStrings: ["$"],
      // fileFormat intentionally omitted
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/requires a fileFormat/);
    expect(result.filesWalked).toBe(0);
    expect(result.filesMatched).toEqual([]);
    expect(result.extractedDeps).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  it("sanity check: regex path still works after refactor", async () => {
    await writeFile(
      path.join(repo, "Dockerfile"),
      "FROM alpine:3.19\n",
    );
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["(^|/)Dockerfile$"],
      matchStrings: ["FROM (?<depName>[^:\\s]+):(?<currentValue>\\S+)"],
      datasourceTemplate: "docker",
    });
    expect(result.filesMatched).toEqual(["Dockerfile"]);
    expect(result.extractedDeps[0]).toMatchObject({
      depName: "alpine",
      currentValue: "3.19",
      datasource: "docker",
    });
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
