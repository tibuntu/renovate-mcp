import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Verify that the generate-* scripts refuse to overwrite a symlink at their
// destination (defense-in-depth against a working tree where the generated
// file has been swapped for a link). The check is implemented near the top of
// each script — before the heavy `renovate` import — so this test can run
// without Renovate being installable in the temp tree.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

interface ScriptCase {
  scriptName: string;
  outputName: string;
}

const SCRIPTS: ScriptCase[] = [
  { scriptName: "generate-presets.mjs", outputName: "presets.generated.ts" },
  { scriptName: "generate-managers.mjs", outputName: "managers.generated.ts" },
];

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "renovate-mcp-symlink-guard-"));
  await fs.mkdir(path.join(tempRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "data"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe.each(SCRIPTS)(
  "scripts/$scriptName refuses to overwrite a symlink",
  ({ scriptName, outputName }) => {
    it("exits non-zero when destination is a symlink, without following it", async () => {
      // Copy the script into a temp tree that mirrors the real layout so it
      // resolves OUT_PATH to a path we control.
      const scriptSrc = path.join(REPO_ROOT, "scripts", scriptName);
      const scriptDst = path.join(tempRoot, "scripts", scriptName);
      await fs.copyFile(scriptSrc, scriptDst);

      // Point the symlink at a sentinel file that we'll watch. If the script
      // followed the link, it would clobber this file's contents.
      const sentinelPath = path.join(tempRoot, "sentinel.txt");
      const sentinelContent = "must-not-be-overwritten";
      await fs.writeFile(sentinelPath, sentinelContent);

      const linkPath = path.join(tempRoot, "src", "data", outputName);
      await fs.symlink(sentinelPath, linkPath);

      const result = spawnSync(process.execPath, [scriptDst], {
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/refusing to write/);
      expect(result.stderr).toContain(outputName);

      // The symlink itself should still be a symlink (not replaced by a file)
      // and the sentinel should be untouched.
      const linkStat = await fs.lstat(linkPath);
      expect(linkStat.isSymbolicLink()).toBe(true);
      const sentinelAfter = await fs.readFile(sentinelPath, "utf8");
      expect(sentinelAfter).toBe(sentinelContent);
    });
  },
);
