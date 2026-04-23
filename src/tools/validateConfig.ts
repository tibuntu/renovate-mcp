import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";

export function registerValidateConfig(server: McpServer): void {
  server.registerTool(
    "validate_config",
    {
      title: "Validate Renovate config",
      description:
        "Validate a Renovate configuration against the official schema using renovate-config-validator. Pass either configPath (file on disk) or configContent (inline JSON object). Returns validation output and a boolean `valid`.",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe("Absolute path to a config file to validate"),
        configContent: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Inline config object to validate (written to a temp file)"),
        strict: z
          .boolean()
          .optional()
          .describe("Treat warnings as errors"),
      },
    },
    async ({ configPath, configContent, strict }) => {
      if (!configPath && !configContent) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Provide either configPath or configContent." },
          ],
        };
      }

      let target = configPath;
      let cleanup: (() => Promise<void>) | undefined;
      if (!target) {
        const tmp = path.join(tmpdir(), `renovate-mcp-${randomUUID()}.json`);
        await fs.writeFile(tmp, JSON.stringify(configContent, null, 2));
        target = tmp;
        cleanup = async () => {
          await fs.unlink(tmp).catch(() => undefined);
        };
      }

      try {
        const bin = resolveRenovateTool("renovate-config-validator");
        const args: string[] = [];
        if (strict) args.push("--strict");
        args.push(target);
        const result = await run(bin, args, { timeoutMs: 30_000 });
        const valid = result.exitCode === 0;
        const output = (result.stdout + result.stderr).trim();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ valid, output }, null, 2),
            },
          ],
          isError: !valid,
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: formatMissingBinaryError("renovate-config-validator", err as Error),
            },
          ],
        };
      } finally {
        await cleanup?.();
      }
    },
  );
}
