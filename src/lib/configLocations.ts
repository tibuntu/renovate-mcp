import { promises as fs } from "node:fs";
import path from "node:path";
import JSON5 from "json5";

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
      const config: unknown =
        candidate.format === "json5" ? JSON5.parse(raw) : JSON.parse(raw);
      if (!isPlainObject(config)) {
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
      isPlainObject(pkg) &&
      "renovate" in pkg &&
      isPlainObject(pkg.renovate)
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
