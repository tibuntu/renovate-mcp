import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  run,
  resolveRenovateTool,
  formatMissingBinaryError,
  formatTimeoutError,
  CommandTimeoutError,
  validatorTimeoutMs,
} from "../lib/renovateCli.js";
import { configRecord, pathString } from "../lib/inputLimits.js";
import { checkConfigFileInput, configPathFormatError, OFFLINE_READ_ONLY_ANNOTATIONS } from "../lib/toolInputs.js";

export function registerValidateConfig(server: McpServer): void {
  server.registerTool(
    "validate_config",
    {
      title: "Validate Renovate config",
      annotations: OFFLINE_READ_ONLY_ANNOTATIONS,
      description:
        "Validate a Renovate configuration against the official schema using renovate-config-validator. Pass either configPath (file on disk) or configContent (inline JSON object). Validates as a repo config by default; set configType to \"global\" for a self-hosted global config. Returns validation output and a boolean `valid`.",
      inputSchema: z.object({
        configPath: pathString("Absolute path to a config file to validate (.json, .json5, .jsonc, .yaml, .yml or .renovaterc)").optional(),
        configContent: configRecord(
          "Inline config object to validate (written to a temp file)",
        ).optional(),
        configType: z
          .enum(["repo", "global"])
          .default("repo")
          .describe(
            "Validate as a repo config (default) or as a self-hosted global config (platform, autodiscover, token, ...)",
          ),
        strict: z
          .boolean()
          .optional()
          .describe("Treat warnings as errors"),
      }),
    },
    async ({ configPath, configContent, configType, strict }) => {
      const inputError = checkConfigFileInput({ configPath, configContent });
      if (inputError) return { isError: true, content: [{ type: "text", text: inputError }] };

      const formatError = configPath !== undefined ? configPathFormatError(configPath) : null;
      if (formatError) return { isError: true, content: [{ type: "text", text: formatError }] };

      // Absolute (checked above): the validator runs in an empty scratch directory.
      let target: string | undefined = configPath;
      let cleanup: (() => Promise<void>) | undefined;
      if (target === undefined) {
        const tmp = path.join(tmpdir(), `renovate-mcp-${randomUUID()}.json`);
        await fs.writeFile(tmp, JSON.stringify(configContent, null, 2), {
          flag: "wx",
          mode: 0o600,
        });
        target = tmp;
        cleanup = async () => {
          await fs.unlink(tmp).catch(() => undefined);
        };
      }

      try {
        const tool = resolveRenovateTool("renovate-config-validator");
        const args: string[] = [];
        if (strict) args.push("--strict");
        // Positional files are treated as GLOBAL self-hosted config unless
        // --no-global is passed — without it, repo-forbidden options like
        // `token` validate clean. Kept after the file: fake validators in the
        // tests read argv[2] as the path.
        args.push(target);
        if (configType === "repo") args.push("--no-global");
        const result = await run(tool.cmd, [...tool.prefixArgs, ...args], {
          timeoutMs: validatorTimeoutMs(),
        });
        const valid = result.exitCode === 0;
        const output = (result.stdout + result.stderr).trim();
        const payload: Record<string, unknown> = { valid, output };
        if (result.runtimeWarnings.length > 0) {
          payload.warnings = result.runtimeWarnings;
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
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
              text:
                err instanceof CommandTimeoutError
                  ? formatTimeoutError("renovate-config-validator", err)
                  : formatMissingBinaryError("renovate-config-validator", err as Error),
            },
          ],
        };
      } finally {
        await cleanup?.();
      }
    },
  );
}
