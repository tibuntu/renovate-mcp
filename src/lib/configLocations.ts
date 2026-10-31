import { promises as fs } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { isRecord } from "./util.js";

export type ConfigFormat = "json" | "json5" | "package.json";

export interface LocatedConfig {
  absPath: string;
  relPath: string;
  format: ConfigFormat;
  raw: string;
  config: Record<string, unknown>;
}

// Renovate's own discovery order (`getConfigFileNames()` in
// renovate/dist/config/app-strings.js), minus the trailing package.json which
// is handled separately below. `.jsonc` reports format "json": that format
// already means "JSON, comments allowed" (see the parse note in locateConfig).
// A drift test in test/unit/allowListDrift.test.ts pins this list to Renovate's.
const CANDIDATES: Array<{ path: string; format: "json" | "json5" }> = [
  { path: "renovate.json", format: "json" },
  { path: "renovate.jsonc", format: "json" },
  { path: "renovate.json5", format: "json5" },
  { path: ".github/renovate.json", format: "json" },
  { path: ".github/renovate.jsonc", format: "json" },
  { path: ".github/renovate.json5", format: "json5" },
  { path: ".gitlab/renovate.json", format: "json" },
  { path: ".gitlab/renovate.jsonc", format: "json" },
  { path: ".gitlab/renovate.json5", format: "json5" },
  { path: ".renovaterc", format: "json" },
  { path: ".renovaterc.json", format: "json" },
  { path: ".renovaterc.jsonc", format: "json" },
  { path: ".renovaterc.json5", format: "json5" },
];

/** Every filename `locateConfig` checks, in priority order. */
export const CONFIG_FILE_NAMES: readonly string[] = Object.freeze([
  ...CANDIDATES.map((c) => c.path),
  "package.json",
]);

export async function locateConfig(repoPath: string): Promise<LocatedConfig | null> {
  for (const candidate of CANDIDATES) {
    const abs = path.join(repoPath, candidate.path);
    try {
      const raw = await fs.readFile(abs, "utf8");
      // Renovate parses every candidate JSONC-then-JSON5 regardless of
      // extension (and write_config round-trips comments into renovate.json);
      // JSON5 is a superset of JSONC, so one parser covers all of them.
      // A 0-length file reads as `{}`, as in Renovate's detectRepoFileConfig
      // (`if (!configFileRaw.length) configFileRaw = "{}"`). Length only: a
      // whitespace-only file still throws, as in Renovate. This intentionally
      // differs from configWriter.ts, which treats whitespace-only as absent.
      const config: unknown = raw.length === 0 ? {} : JSON5.parse(raw);
      if (!isRecord(config)) {
        throw new Error(`${candidate.path} does not contain a JSON object`);
      }
      return {
        absPath: abs,
        relPath: candidate.path,
        format: candidate.format,
        raw,
        config,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const pkgAbs = path.join(repoPath, "package.json");
  try {
    const raw = await fs.readFile(pkgAbs, "utf8");
    let pkg: unknown;
    try {
      pkg = JSON.parse(raw);
    } catch (err) {
      // Invalid JSON means no config, mirroring Renovate's `catch {}`. Other
      // read errors (EACCES etc.) still throw: a deliberate divergence.
      if (err instanceof SyntaxError) return null;
      throw err;
    }
    if (isRecord(pkg) && "renovate" in pkg) {
      const value = pkg.renovate;
      if (isRecord(value)) {
        return {
          absPath: pkgAbs,
          relPath: "package.json",
          format: "package.json",
          raw,
          config: value,
        };
      }
      // Renovate expands a string package.json#renovate to `extends`.
      if (typeof value === "string" && value.length > 0) {
        return {
          absPath: pkgAbs,
          relPath: "package.json",
          format: "package.json",
          raw,
          config: { extends: [value] },
        };
      }
      // An empty string or other non-object value (true, a number, an array)
      // is reported as no config. Deliberate divergence for these truthy
      // values: Renovate selects the file but ends up with no usable settings.
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return null;
}
