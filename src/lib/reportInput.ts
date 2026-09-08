import { promises as fs } from "node:fs";

/**
 * Read + JSON-parse a dry_run report from disk (the `reportPath` input shared
 * by annotate_dry_run and explain_dependency). Pair with `dry_run`'s
 * `reportOutputPath` to round-trip large reports without hitting MCP
 * response-content caps.
 */
export async function readReportPath(
  reportPath: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
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
