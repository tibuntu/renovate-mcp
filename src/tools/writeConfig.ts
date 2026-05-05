import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";
import type { RuntimeWarning } from "../lib/runtimeWarnings.js";
import { configRecord, filenameString, pathString } from "../lib/inputLimits.js";

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

const FORCE_CONFIRMATION_TOKEN = "YES_OVERRIDE_VALIDATION";

export function registerWriteConfig(server: McpServer): void {
  server.registerTool(
    "write_config",
    {
      title: "Write Renovate config",
      description:
        "Write a Renovate config to disk. Runs renovate-config-validator first — refuses to write if validation fails unless force=true (which additionally requires confirmForce).",
      inputSchema: {
        repoPath: pathString("Absolute path to the repository root"),
        config: configRecord("The Renovate config object"),
        filename: filenameString(
          "Target filename relative to repoPath (default renovate.json)",
        ).default("renovate.json"),
        force: z
          .boolean()
          .default(false)
          .describe("Write even if validation fails. Requires confirmForce."),
        confirmForce: z
          .literal(FORCE_CONFIRMATION_TOKEN)
          .optional()
          .describe(
            `Must be set to the literal '${FORCE_CONFIRMATION_TOKEN}' when force is true. The unusual literal exists to make accidental overrides harder under prompt-injected tool calls.`,
          ),
      },
    },
    async ({ repoPath, config, filename, force, confirmForce }) => {
      if (force && confirmForce !== FORCE_CONFIRMATION_TOKEN) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  wrote: false,
                  reason: "force-confirmation-missing",
                  hint: `force=true requires confirmForce='${FORCE_CONFIRMATION_TOKEN}'. This guard exists to make accidental overrides harder under prompt-injected tool calls.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

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
      // Randomize the suffix so two concurrent writes don't collide, and use
      // `flag: "wx"` (O_CREAT|O_EXCL) so a pre-existing symlink at the temp
      // path is refused with EEXIST instead of silently followed (issue #129).
      const tmp = `${target}.renovate-mcp-tmp-${randomUUID()}`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(tmp, payload, { flag: "wx", mode: 0o600 });

      try {
        let valid = false;
        let validationOutput = "";
        let validatorMissing = false;
        let runtimeWarnings: RuntimeWarning[] = [];
        try {
          const bin = resolveRenovateTool("renovate-config-validator");
          const v = await run(bin, [tmp], { timeoutMs: 30_000 });
          validationOutput = (v.stdout + v.stderr).trim();
          valid = v.exitCode === 0;
          runtimeWarnings = v.runtimeWarnings;
        } catch (err) {
          validatorMissing = true;
          validationOutput = formatMissingBinaryError("renovate-config-validator", err as Error);
        }

        if (!valid && !force) {
          const failPayload: Record<string, unknown> = {
            wrote: false,
            reason: validatorMissing ? "validator-unavailable" : "validation-failed",
            validationOutput,
            hint: validatorMissing
              ? "Install renovate-config-validator (or set RENOVATE_CONFIG_VALIDATOR_BIN), then retry. Pass force=true to skip validation entirely."
              : "Pass force=true to write anyway.",
          };
          if (runtimeWarnings.length > 0) failPayload.warnings = runtimeWarnings;
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(failPayload, null, 2),
              },
            ],
          };
        }

        await fs.rename(tmp, target);
        const okPayload: Record<string, unknown> = {
          wrote: true,
          path: rel,
          bytes: payload.length,
          valid,
          validationOutput: valid ? undefined : validationOutput,
        };
        if (runtimeWarnings.length > 0) okPayload.warnings = runtimeWarnings;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(okPayload, null, 2),
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
