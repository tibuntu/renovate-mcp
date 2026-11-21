import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { isRecord } from "./util.js";

type Loaded = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Read + JSON-parse a dry_run report from disk (the `reportPath` input shared
 * by annotate_dry_run and explain_dependency). Pair with `dry_run`'s
 * `reportOutputPath` to round-trip large reports without hitting MCP
 * response-content caps.
 */
export async function readReportPath(reportPath: string): Promise<Loaded> {
  let raw: string;
  try {
    raw = await fs.readFile(reportPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not read reportPath (\`${reportPath}\`): ${msg}.` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `reportPath (\`${reportPath}\`) is not valid JSON: ${msg}.` };
  }
}

const PACKAGE_FILES_MSG = "packageFiles with updates";
const BRANCHES_MSG = "branches info extended";

const LOG_HINT =
  "Run Renovate with `LOG_LEVEL=debug` and `LOG_FORMAT=json` so it emits the `packageFiles with updates` and `branches info extended` debug lines; a log in another format is not supported.";

/**
 * Fill in `manager` on branch upgrades. Renovate's `branches info extended`
 * line is `filterDependencyDashboardData`'s output, which drops `manager`;
 * `dry_run_diff` and `annotate_dry_run` key on it, so recover it from the
 * extracted deps (same `packageFile` + `depName`).
 */
function backfillManagers(repo: Record<string, unknown>): void {
  const { packageFiles, branches } = repo;
  if (!isRecord(packageFiles) || !Array.isArray(branches)) return;
  const managerOf = new Map<string, string>();
  for (const [manager, files] of Object.entries(packageFiles)) {
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (!isRecord(file) || !Array.isArray(file.deps)) continue;
      for (const dep of file.deps) {
        if (isRecord(dep) && typeof dep.depName === "string") {
          managerOf.set(`${String(file.packageFile)}\0${dep.depName}`, manager);
        }
      }
    }
  }
  for (const branch of branches) {
    if (!isRecord(branch) || !Array.isArray(branch.upgrades)) continue;
    for (const upgrade of branch.upgrades) {
      if (!isRecord(upgrade) || upgrade.manager !== undefined) continue;
      const manager = managerOf.get(`${String(upgrade.packageFile)}\0${String(upgrade.depName)}`);
      if (manager) upgrade.manager = manager;
    }
  }
}

/**
 * Stream a Renovate JSON-lines debug log (`LOG_FORMAT=json LOG_LEVEL=debug`)
 * and rebuild the report from the two lines that carry it:
 *  - `packageFiles with updates` (`config` = the extracted packageFiles) →
 *    `repositories[repo].packageFiles`. One line per base branch; the last
 *    wins, as in Renovate's own report (`addExtractionStats` overwrites).
 *  - `branches info extended` (`branchesInformation`) → `.branches`.
 * Logs reach hundreds of MB, so lines are read one at a time and only lines
 * naming one of the two messages are parsed; nothing else is retained.
 */
export async function readLogPath(logPath: string): Promise<Loaded> {
  const repositories: Record<string, Record<string, unknown>> = {};
  let found = false;
  try {
    const rl = createInterface({ input: createReadStream(logPath, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      const isPackageFiles = line.includes(PACKAGE_FILES_MSG);
      if (!isPackageFiles && !line.includes(BRANCHES_MSG)) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(rec)) continue;
      const repo = (repositories[typeof rec.repository === "string" ? rec.repository : "unknown"] ??= {
        problems: [],
        branches: [],
      });
      if (rec.msg === PACKAGE_FILES_MSG && isRecord(rec.config)) {
        repo.packageFiles = rec.config;
        found = true;
      } else if (rec.msg === BRANCHES_MSG && Array.isArray(rec.branchesInformation)) {
        repo.branches = rec.branchesInformation;
        found = true;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not read logPath (\`${logPath}\`): ${msg}.` };
  }
  if (!found) {
    return {
      ok: false,
      error: `logPath (\`${logPath}\`) has neither a \`${PACKAGE_FILES_MSG}\` nor a \`${BRANCHES_MSG}\` debug line. ${LOG_HINT}`,
    };
  }
  for (const repo of Object.values(repositories)) backfillManagers(repo);
  return { ok: true, value: { repositories } };
}

export type ReportSource = "inline" | "reportPath" | "logPath";

/**
 * The report input shared by annotate_dry_run and explain_dependency: exactly
 * one of an inline `report`, a `reportPath` or a `logPath`.
 */
export async function resolveReportInput(input: {
  report?: unknown;
  reportPath?: string;
  logPath?: string;
}): Promise<{ ok: true; value: unknown; source: ReportSource } | { ok: false; error: string }> {
  const given = (["report", "reportPath", "logPath"] as const).filter((k) => input[k] !== undefined && input[k] !== "");
  if (given.length === 0) {
    return {
      ok: false,
      error:
        "Provide either report or reportPath (run dry_run first), or logPath (a Renovate debug log from a real run).",
    };
  }
  if (given.length === 2) return { ok: false, error: `Pass either ${given[0]} or ${given[1]}, not both.` };
  if (given.length > 2) return { ok: false, error: "Pass only one of report, reportPath or logPath." };
  const loaded = input.logPath
    ? await readLogPath(input.logPath)
    : input.reportPath
      ? await readReportPath(input.reportPath)
      : { ok: true as const, value: input.report };
  if (!loaded.ok) return loaded;
  return { ok: true, value: loaded.value, source: input.logPath ? "logPath" : input.reportPath ? "reportPath" : "inline" };
  return { ok: true, value: input.report, source: "inline" };
}
