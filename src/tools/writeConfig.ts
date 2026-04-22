import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";

export function registerWriteConfig(server: McpServer): void {
  server.registerTool(
    "write_config",
    {
      title: "Write Renovate config",
      description:
        "Write a Renovate config to disk. Runs renovate-config-validator first — refuses to write if validation fails unless force=true.",
      inputSchema: {
        repoPath: z.string().describe("Absolute path to the repository root"),
        config: z.record(z.unknown()).describe("The Renovate config object"),
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
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return {
          isError: true,
          content: [{ type: "text", text: "filename escapes repoPath" }],
        };
      }

      const payload = JSON.stringify(config, null, 2) + "\n";
      const tmp = `${target}.renovate-mcp-tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(tmp, payload);

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
        validationOutput = formatMissingBinaryError("renovate-config-validator", err as Error);
      }

      if (!valid && !force) {
        await fs.unlink(tmp).catch(() => undefined);
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
    },
  );
}
