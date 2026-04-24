import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";

// Resolve symlinks in `p`, walking up to the nearest existing ancestor when
// tail components don't exist yet (e.g. a new subdir we're about to mkdir).
// This matters for the escape check: `fs.rename` follows symlinks along the
// parent path, so the check must compare the same canonical tree.
async function resolveWithExistingAncestor(p: string): Promise<string> {
  const suffixes: string[] = [];
  let current = p;
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return suffixes.length ? path.join(resolved, ...suffixes) : resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      suffixes.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function registerWriteConfig(server: McpServer): void {
  server.registerTool(
    "write_config",
    {
      title: "Write Renovate config",
      description:
        "Write a Renovate config to disk. Runs renovate-config-validator first — refuses to write if validation fails unless force=true.",
      inputSchema: {
        repoPath: z.string().describe("Absolute path to the repository root"),
        config: z.record(z.string(), z.unknown()).describe("The Renovate config object"),
        filename: z
          .string()
          .default("renovate.json")
          .describe("Target filename relative to repoPath (default renovate.json)"),
        force: z
          .boolean()
          .default(false)
          .describe("Write even if validation fails"),
      },
    },
    async ({ repoPath, config, filename, force }) => {
      const repoAbs = path.resolve(repoPath);
      const target = path.resolve(repoAbs, filename);
      const rel = path.relative(repoAbs, target);

      const repoReal = await resolveWithExistingAncestor(repoAbs);
      const parentReal = await resolveWithExistingAncestor(path.dirname(target));
      const checkRel = path.relative(repoReal, parentReal);
      if (checkRel.startsWith("..") || path.isAbsolute(checkRel)) {
        return {
          isError: true,
          content: [{ type: "text", text: "filename escapes repoPath" }],
        };
      }

      const payload = JSON.stringify(config, null, 2) + "\n";
      const tmp = `${target}.renovate-mcp-tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(tmp, payload);

      try {
        let valid = false;
        let validationOutput = "";
        let validatorMissing = false;
        try {
          const bin = resolveRenovateTool("renovate-config-validator");
          const v = await run(bin, [tmp], { timeoutMs: 30_000 });
          validationOutput = (v.stdout + v.stderr).trim();
          valid = v.exitCode === 0;
        } catch (err) {
          validatorMissing = true;
          validationOutput = formatMissingBinaryError("renovate-config-validator", err);
        }

        if (!valid && !force) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    wrote: false,
                    reason: validatorMissing ? "validator-unavailable" : "validation-failed",
                    validationOutput,
                    hint: validatorMissing
                      ? "Install renovate-config-validator (or set RENOVATE_CONFIG_VALIDATOR_BIN), then retry. Pass force=true to skip validation entirely."
                      : "Pass force=true to write anyway.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        await fs.rename(tmp, target);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  wrote: true,
                  path: rel,
                  bytes: payload.length,
                  valid,
                  validationOutput: valid ? undefined : validationOutput,
                },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        // No-op when rename already moved tmp (ENOENT); otherwise cleans up on
        // validation failure or a mid-flight rename error (see #57).
        await fs.unlink(tmp).catch(() => undefined);
      }
    },
  );
}
