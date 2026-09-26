import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runWorker } from "../../src/lib/customManagerPreview.js";

/**
 * The JSONata worker is an `eval: true` worker whose source `require()`s
 * jsonata. Node resolves `require` in eval workers relative to `process.cwd()`,
 * so a preview run from a cwd outside the package (any real MCP client) found
 * no `jsonata` and silently produced zero deps. Reproduce by running the built
 * module from a child process whose cwd is the OS temp dir.
 *
 * The probe is a `.mjs` file rather than `--input-type=module -e`: workers
 * inherit the parent's execArgv, and that flag would turn the eval worker
 * itself into an ES module (no `require` at all), masking the bug under test.
 */
describe("customManagerPreview JSONata worker — cwd independence", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), `rmcp-worker-cwd-${process.pid}-`));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("extracts JSONata deps when the process cwd is os.tmpdir()", async () => {
    const repo = path.join(work, "repo");
    await mkdir(repo);
    await writeFile(
      path.join(repo, "Chart.yaml"),
      "dependencies:\n  - name: foo\n    version: 1.2.3\n",
    );

    const distModule = path.resolve(process.cwd(), "dist/lib/customManagerPreview.js");
    // Built by `pretest`; a direct `vitest run` needs `npm run build` first.
    expect(existsSync(distModule)).toBe(true);

    const manager = {
      customType: "jsonata",
      fileFormat: "yaml",
      fileMatch: ["Chart\\.yaml$"],
      matchStrings: ['dependencies.{ "depName": name, "currentValue": version }'],
    };
    const probe = path.join(work, "probe.mjs");
    await writeFile(
      probe,
      [
        `import { previewCustomManager } from ${JSON.stringify(pathToFileURL(distModule).href)};`,
        `const result = await previewCustomManager(${JSON.stringify(repo)}, ${JSON.stringify(manager)});`,
        "console.log(JSON.stringify(result));",
        "",
      ].join("\n"),
    );

    const child = spawnSync(process.execPath, [probe], { cwd: tmpdir(), encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);

    const result = JSON.parse(child.stdout.trim());
    expect(result.warnings).toEqual([]);
    expect(result.extractedDeps).toHaveLength(1);
    expect(result.extractedDeps[0]).toMatchObject({ depName: "foo", currentValue: "1.2.3" });
  });
});

describe("runWorker — exit before message", () => {
  it("rejects promptly instead of waiting for matchTimeoutMs", async () => {
    const t0 = Date.now();
    // An unknown mode falls through every branch of the worker source: no
    // message is posted and the thread exits 0.
    await expect(runWorker({ mode: "nope" } as never, 5000)).rejects.toThrow(
      /exited \(code 0\) before returning a result/,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
