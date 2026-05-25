import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewCustomManager } from "../../src/lib/customManagerPreview.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_ROOT = path.join(PROJECT_ROOT, "test/fixtures/jsonata");

// Oracle: Renovate's own extractPackageFile. The module re-exports the
// `extractPackageFile` member under the `jsonata_exports` namespace (see
// `node_modules/renovate/dist/modules/manager/custom/jsonata/index.js`).
// Importing `renovate` is allowed in `test/` per CLAUDE.md (the rule scopes
// to `src/`, where it would couple our runtime to Renovate's library API).
type ExtractPackageFile = (
  content: string,
  packageFile: string,
  config: Record<string, unknown>,
) => Promise<{ deps: Array<Record<string, unknown>> } | null>;

async function loadOracle(): Promise<ExtractPackageFile> {
  const mod = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — runtime import; renovate ships .d.ts but the namespace
    // export shape (`jsonata_exports`) is not surfaced in its public types.
    "renovate/dist/modules/manager/custom/jsonata/index.js"
  );
  const ns = (mod as { jsonata_exports?: { extractPackageFile?: ExtractPackageFile } }).jsonata_exports;
  if (!ns?.extractPackageFile) {
    throw new Error(
      "renovate/dist/modules/manager/custom/jsonata/index.js does not expose jsonata_exports.extractPackageFile — Renovate's internal layout changed; update the parity test loader.",
    );
  }
  return ns.extractPackageFile;
}

// Dep-shape key set we emit. Renovate may carry extra metadata (managerData,
// replaceString, etc.) which we drop before comparison.
const DEP_SHAPE_KEYS = [
  "depName",
  "packageName",
  "currentValue",
  "currentDigest",
  "datasource",
  "versioning",
  "extractVersion",
  "depType",
  "registryUrl",
] as const;

/**
 * Project a dep to the shared key set. Renovate emits `registryUrls: string[]`
 * (plural, array — see `updateDependency` in
 * `renovate/dist/modules/manager/custom/jsonata/utils.js`); we emit
 * `registryUrl: string` (singular). The projection collapses Renovate's
 * `registryUrls[0]` onto our singular key so the comparison is apples-to-apples.
 */
function projectDep(dep: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DEP_SHAPE_KEYS) {
    const v = dep[k];
    if (typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  // Collapse Renovate's plural to our singular.
  if (out.registryUrl === undefined) {
    const urls = dep.registryUrls;
    if (Array.isArray(urls) && typeof urls[0] === "string" && urls[0].length > 0) {
      out.registryUrl = urls[0];
    }
  }
  return out;
}

function sortDeps(deps: Array<Record<string, string>>): Array<Record<string, string>> {
  return [...deps].sort((a, b) => {
    const dn = (a.depName ?? "").localeCompare(b.depName ?? "");
    if (dn !== 0) return dn;
    return (a.depType ?? "").localeCompare(b.depType ?? "");
  });
}

describe("customManagerPreview jsonata parity against Renovate's extractPackageFile", () => {
  let oracle: ExtractPackageFile;
  let repo: string;

  beforeEach(async () => {
    oracle = await loadOracle();
    repo = await mkdtemp(
      path.join(tmpdir(), `rmcp-jsonata-parity-${process.pid}-`),
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("JSON fixture: package.json-style deps map matches Renovate output", async () => {
    const fixturePath = path.join(FIXTURE_ROOT, "json/package-deps.json");
    const content = await readFile(fixturePath, "utf8");
    const destName = "package.json";
    await writeFile(path.join(repo, destName), content);

    const matchStrings = [
      "$each(dependencies, function($v, $k) { { 'depName': $k, 'currentValue': $v, 'datasource': 'npm', 'depType': 'dependencies' } })",
      "$each(devDependencies, function($v, $k) { { 'depName': $k, 'currentValue': $v, 'datasource': 'npm', 'depType': 'devDependencies' } })",
    ];
    const manager = {
      customType: "jsonata" as const,
      fileFormat: "json" as const,
      fileMatch: ["^package\\.json$"],
      matchStrings,
    };

    const ourPreview = await previewCustomManager(repo, manager);
    const renovateResult = await oracle(content, destName, {
      customType: "jsonata",
      fileFormat: "json",
      matchStrings,
    });

    expect(ourPreview.warnings).toEqual([]);
    const ours = sortDeps(ourPreview.extractedDeps.map((d) => projectDep(d as unknown as Record<string, unknown>)));
    const theirs = sortDeps((renovateResult?.deps ?? []).map(projectDep));
    expect(ours).toEqual(theirs);
    expect(ourPreview.extractedDeps).toHaveLength(theirs.length);

    // Readability anchor — fails fast and points at the failing entry.
    expect(theirs).toContainEqual({
      depName: "lodash",
      currentValue: "^4.17.21",
      datasource: "npm",
      depType: "dependencies",
    });
    expect(ours).toContainEqual({
      depName: "lodash",
      currentValue: "^4.17.21",
      datasource: "npm",
      depType: "dependencies",
    });
  });

  it("YAML fixture: Helm Chart.yaml-style array matches Renovate output", async () => {
    const fixturePath = path.join(FIXTURE_ROOT, "yaml/helm-chart.yaml");
    const content = await readFile(fixturePath, "utf8");
    const destName = "Chart.yaml";
    await writeFile(path.join(repo, destName), content);

    const matchStrings = [
      "dependencies.{ 'depName': name, 'currentValue': version, 'registryUrl': repository, 'datasource': 'helm' }",
    ];
    const manager = {
      customType: "jsonata" as const,
      fileFormat: "yaml" as const,
      fileMatch: ["^Chart\\.yaml$"],
      matchStrings,
    };

    const ourPreview = await previewCustomManager(repo, manager);
    const renovateResult = await oracle(content, destName, {
      customType: "jsonata",
      fileFormat: "yaml",
      matchStrings,
    });

    expect(ourPreview.warnings).toEqual([]);
    const ours = sortDeps(ourPreview.extractedDeps.map((d) => projectDep(d as unknown as Record<string, unknown>)));
    const theirs = sortDeps((renovateResult?.deps ?? []).map(projectDep));
    expect(ours).toEqual(theirs);

    expect(theirs).toContainEqual({
      depName: "postgresql",
      currentValue: "14.0.0",
      datasource: "helm",
      registryUrl: "https://charts.bitnami.com/bitnami",
    });
  });

  it("TOML fixture: Cargo.toml-style dependencies table matches Renovate output", async () => {
    const fixturePath = path.join(FIXTURE_ROOT, "toml/cargo.toml");
    const content = await readFile(fixturePath, "utf8");
    const destName = "Cargo.toml";
    await writeFile(path.join(repo, destName), content);

    const matchStrings = [
      "$each(dependencies, function($v, $k) { { 'depName': $k, 'currentValue': $v, 'datasource': 'crate' } })",
    ];
    const manager = {
      customType: "jsonata" as const,
      fileFormat: "toml" as const,
      fileMatch: ["^Cargo\\.toml$"],
      matchStrings,
    };

    const ourPreview = await previewCustomManager(repo, manager);
    const renovateResult = await oracle(content, destName, {
      customType: "jsonata",
      fileFormat: "toml",
      matchStrings,
    });

    expect(ourPreview.warnings).toEqual([]);
    const ours = sortDeps(ourPreview.extractedDeps.map((d) => projectDep(d as unknown as Record<string, unknown>)));
    const theirs = sortDeps((renovateResult?.deps ?? []).map(projectDep));
    expect(ours).toEqual(theirs);

    expect(theirs).toContainEqual({
      depName: "serde",
      currentValue: "1.0.197",
      datasource: "crate",
    });
  });

  it("template-overlay numeric-stringification: documented divergence from oracle", async () => {
    // The oracle (Renovate) drops dependencies whose `currentValue` is not a
    // non-empty string at `checkIsValidDependency` (see
    // `renovate/dist/modules/manager/custom/utils.js` — `isValidDependency`
    // checks `isNonEmptyStringAndNotWhitespace(currentValue)`). When a JSONata
    // expression yields a numeric `currentValue: 1.2`, Renovate's createDependency
    // populates the dep with a number, isValidDependency rejects it, and
    // extractPackageFile returns null.
    //
    // Our preview, in contrast, stringifies numeric values at the
    // `stringifyGroups` boundary (see `src/lib/customManagerPreview.ts`) so the
    // template substitution path stays sane. This produces a stringified value
    // BEFORE any validation gate would have run.
    //
    // This is an intentional divergence: the preview tool's job is to surface
    // what the user's expression yielded, with friendly stringification so
    // {{currentValue}}-pinned doesn't render "[object Object]"-style garbage.
    // The user is expected to run `dry_run` afterwards for the production
    // pipeline's full-fidelity validation (which Renovate runs end-to-end).
    //
    // We assert OUR behavior and confirm the oracle's null return, surfacing
    // the divergence in the test record rather than hiding it.
    const destName = "data.json";
    await writeFile(path.join(repo, destName), JSON.stringify({}));

    const matchStrings = [
      "{ 'depName': 'foo', 'currentValue': 1.2, 'datasource': 'npm' }",
    ];
    const config = {
      customType: "jsonata" as const,
      fileFormat: "json" as const,
      fileMatch: ["^data\\.json$"],
      matchStrings,
      currentValueTemplate: "{{currentValue}}-pinned",
    };

    const ourPreview = await previewCustomManager(repo, config);
    const renovateResult = await oracle(JSON.stringify({}), destName, {
      customType: "jsonata",
      fileFormat: "json",
      matchStrings,
      currentValueTemplate: "{{currentValue}}-pinned",
    });

    // Our behavior: numeric coerced to string, then template substituted.
    expect(ourPreview.warnings).toEqual([]);
    expect(ourPreview.extractedDeps).toHaveLength(1);
    expect(ourPreview.extractedDeps[0]?.currentValue).toBe("1.2-pinned");

    // Oracle behavior: dep dropped at validation. Documented, not asserted as
    // a parity equality — the divergence is the point.
    expect(renovateResult).toBeNull();
  });

  it("oracle import sanity: extractPackageFile is callable", async () => {
    // Belt-and-braces: if Renovate's internal layout changes (e.g. the
    // `jsonata_exports` namespace shape goes away), the loader throws and
    // every parity test fails with a clear "renovate internal layout"
    // message. This standalone assertion makes that mode obvious.
    expect(typeof oracle).toBe("function");
    const r = await oracle("{}", "noop.json", {
      customType: "jsonata",
      fileFormat: "json",
      matchStrings: ["$"],
    });
    expect(r).toBeNull(); // root-object input → projection yields object → bare wrap → 1 dep but it has no fields → checkIsValidDependency rejects → null
  });
});

