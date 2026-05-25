/**
 * Detect drift between each committed `src/data/*.generated.ts` snapshot's
 * embedded `RENOVATE_VERSION` and the live `node_modules/renovate/package.json#version`.
 *
 * Hard architectural invariant (CLAUDE.md): this script MUST NOT import or
 * require the `renovate` package, and MUST NOT spawn the Renovate CLI. It only
 * reads JSON / generated TS as text. Build-time generator scripts may import
 * `renovate`; this drift-check is not a generator and must stay decoupled.
 *
 * Exit codes (from `main`):
 *   0 — all snapshots in sync with the live renovate version
 *   1 — drift detected (at least one snapshot stale)
 *   2 — internal error (renovate not installed, snapshot missing the constant, …)
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const SNAPSHOTS = Object.freeze([
  Object.freeze({
    file: "src/data/presets.generated.ts",
    regenerateCmd: "npm run generate:presets",
  }),
  Object.freeze({
    file: "src/data/managers.generated.ts",
    regenerateCmd: "npm run generate:managers",
  }),
  Object.freeze({
    file: "src/data/migrations.generated.ts",
    regenerateCmd: "npm run generate:migrations",
  }),
]);

const RENOVATE_VERSION_RE = /export const RENOVATE_VERSION\s*=\s*"([^"]+)";/;

/**
 * Extract the embedded `RENOVATE_VERSION` literal from a generated TS file's
 * source text. Throws if the constant is missing — that signals a generator
 * regression and must not silently pass.
 */
export function extractRenovateVersion(source) {
  const match = RENOVATE_VERSION_RE.exec(source);
  if (!match) {
    const snippet = source.slice(0, 120).replace(/\n/g, "\\n");
    throw new Error(`RENOVATE_VERSION not found in <snippet>: ${snippet}`);
  }
  return match[1];
}

/**
 * Pure: given a live renovate version string and an array of
 * `{ file, version, regenerateCmd }` snapshots, return an `{ ok, … }` report.
 */
export function checkSnapshotVersions({ liveVersion, snapshots }) {
  const stale = [];
  for (const snap of snapshots) {
    if (snap.version !== liveVersion) {
      stale.push({
        file: snap.file,
        snapshotVersion: snap.version,
        regenerateCmd: snap.regenerateCmd,
      });
    }
  }
  if (stale.length === 0) {
    return { ok: true, liveVersion };
  }
  return { ok: false, liveVersion, stale };
}

export async function loadSnapshots(repoRoot) {
  const out = [];
  for (const entry of SNAPSHOTS) {
    const abs = path.join(repoRoot, entry.file);
    const source = await readFile(abs, "utf8");
    let version;
    try {
      version = extractRenovateVersion(source);
    } catch (err) {
      // Re-throw with the file path so the user can find the offender.
      throw new Error(`${entry.file}: ${err.message}`);
    }
    out.push({ file: entry.file, version, regenerateCmd: entry.regenerateCmd });
  }
  return out;
}

export async function readLiveRenovateVersion(repoRoot) {
  const pkgPath = path.join(repoRoot, "node_modules/renovate/package.json");
  let text;
  try {
    text = await readFile(pkgPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        `Cannot read ${pkgPath}: the renovate package is not installed. Run \`npm ci\` (or \`npm install\`) and try again.`,
      );
    }
    throw err;
  }
  const parsed = JSON.parse(text);
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(
      `${pkgPath} does not contain a string "version" field — refusing to compare against an unknown live version.`,
    );
  }
  return parsed.version;
}

export async function main({ repoRoot, stdout, stderr }) {
  let liveVersion;
  let snapshots;
  try {
    liveVersion = await readLiveRenovateVersion(repoRoot);
    snapshots = await loadSnapshots(repoRoot);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  const report = checkSnapshotVersions({ liveVersion, snapshots });
  if (report.ok) {
    stdout.write(`snapshots in sync with renovate@${report.liveVersion}\n`);
    return 0;
  }

  const lines = [
    `Snapshot drift detected: live renovate is ${report.liveVersion}.`,
  ];
  for (const entry of report.stale) {
    lines.push(
      `  - ${entry.file}: snapshot is ${entry.snapshotVersion}, regenerate with \`${entry.regenerateCmd}\``,
    );
  }
  lines.push(
    "Re-run the listed npm script(s), commit the diff, and re-run `npm run check:snapshot-versions`.",
  );
  stderr.write(`${lines.join("\n")}\n`);
  return 1;
}

// CLI entry point — only runs when invoked directly via `node scripts/check-snapshot-versions.mjs`.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const code = await main({
    repoRoot,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
}
