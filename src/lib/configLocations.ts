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

const CANDIDATES: Array<{ path: string; format: "json" | "json5" }> = [
  { path: "renovate.json", format: "json" },
  { path: "renovate.json5", format: "json5" },
  { path: ".github/renovate.json", format: "json" },
  { path: ".github/renovate.json5", format: "json5" },
  { path: ".gitlab/renovate.json", format: "json" },
  { path: ".gitlab/renovate.json5", format: "json5" },
  { path: ".renovaterc", format: "json" },
  { path: ".renovaterc.json", format: "json" },
  { path: ".renovaterc.json5", format: "json5" },
];

export async function locateConfig(repoPath: string): Promise<LocatedConfig | null> {
  for (const candidate of CANDIDATES) {
    const abs = path.join(repoPath, candidate.path);
    try {
      const raw = await fs.readFile(abs, "utf8");
      // Renovate parses every candidate JSONC-then-JSON5 regardless of
      // extension (and write_config round-trips comments into renovate.json);
      // JSON5 is a superset of JSONC, so one parser covers all of them.
      const config: unknown = JSON5.parse(raw);
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
    const pkg: unknown = JSON.parse(raw);
    if (
      isRecord(pkg) &&
      "renovate" in pkg &&
      isRecord(pkg.renovate)
    ) {
      return {
        absPath: pkgAbs,
        relPath: "package.json",
        format: "package.json",
        raw,
        config: pkg.renovate,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return null;
}
