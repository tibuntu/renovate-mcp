import type { McpServer } from "@modelcontextprotocol/server";
import { runMigration } from "../lib/migrationWorker.js";
import { configRecord, pathString } from "../lib/inputLimits.js";
import { loadConfigFile, OFFLINE_READ_ONLY_ANNOTATIONS } from "../lib/toolInputs.js";
import { z } from "zod";

export function registerMigrateConfig(server: McpServer): void {
  server.registerTool(
    "migrate_config",
    {
      title: "Migrate Renovate config to current schema",
      annotations: OFFLINE_READ_ONLY_ANNOTATIONS,
      description:
        "Apply Renovate's built-in config migrations (deprecated key renames, template-variable rewrites, packageRules consolidation, host-rules unification, etc.) to a config and return the migrated result. Pass either configPath (file on disk, JSON or JSON5) or configContent (inline JSON object). Returns { isMigrated, migrated, diff }. Does not write — chain with write_config to persist. First call has higher latency than other tools (Renovate's migration library cold-loads in a worker thread).",
      inputSchema: z.object({
        configPath: pathString("Absolute path to a config file to migrate").optional(),
        configContent: configRecord(
          "Inline config object to migrate",
        ).optional(),
      }),
    },
    async ({ configPath, configContent }) => {
      const loaded = await loadConfigFile({ configPath, configContent });
      if (!loaded.ok) {
        return { isError: true, content: [{ type: "text", text: loaded.error }] };
      }
      const input = loaded.config;

      try {
        const { isMigrated, migratedConfig } = await runMigration(input);
        const before = JSON.stringify(input, null, 2);
        const after = JSON.stringify(migratedConfig, null, 2);
        const diff = isMigrated ? unifiedDiff(before, after) : "";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { isMigrated, migrated: migratedConfig, diff },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Renovate migration failed: ${(err as Error).message}`,
            },
          ],
        };
      }
    },
  );
}

/**
 * Compact line-diff using shared-prefix/suffix trimming. Realistic Renovate
 * migrations touch one to a handful of keys, so a full Myers diff would be
 * overkill — this produces unified-style output with two lines of context.
 */
function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const out: string[] = [];
  const ctx = 2;
  for (let i = Math.max(0, prefix - ctx); i < prefix; i++) {
    out.push(` ${a[i]}`);
  }
  for (let i = prefix; i < a.length - suffix; i++) out.push(`-${a[i]}`);
  for (let i = prefix; i < b.length - suffix; i++) out.push(`+${b[i]}`);
  const endCtxStart = a.length - suffix;
  for (let i = endCtxStart; i < Math.min(a.length, endCtxStart + ctx); i++) {
    out.push(` ${a[i]}`);
  }
  return out.join("\n");
}
