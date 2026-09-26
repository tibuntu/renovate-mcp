import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkSetup, describeSetup } from "../lib/setupCheck.js";
import { pathString } from "../lib/inputLimits.js";

export function registerCheckSetup(server: McpServer): void {
  server.registerTool(
    "check_setup",
    {
      title: "Check Renovate MCP setup",
      description:
        "Report whether the Renovate CLI and config validator are reachable, their versions, and any env overrides in effect. Pass an optional `repoPath` to also diagnose the target repo's environment: parses the `.git/config` origin remote, reads any `endpoint`/`platform` in the repo's renovate config, probes endpoint reachability (using the same `https://`-only public-host allowlist as `dry_run`), and cross-references all three with token presence — surfaces actionable hints like 'set GITHUB_TOKEN before running dry_run'. The probe sends no credentials. Call this first when other tools fail with a spawn error or unexpected validation output.",
      inputSchema: {
        repoPath: pathString(
          "Absolute path to a repository root. When set, the tool also returns a `repoContext` block diagnosing the repo's git origin, config endpoint/platform, endpoint reachability, and token coverage.",
        ).optional(),
      },
    },
    async ({ repoPath }) => {
      const status = await checkSetup(repoPath ? { repoPath } : {});
      const summary = describeSetup(status);
      const payload = JSON.stringify(status, null, 2);
      // Never isError: an incomplete setup is a successful diagnosis (see `ok`).
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${payload}`,
          },
        ],
      };
    },
  );
}
