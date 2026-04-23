import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkSetup, describeSetup } from "../lib/setupCheck.js";

export function registerCheckSetup(server: McpServer): void {
  server.registerTool(
    "check_setup",
    {
      title: "Check Renovate MCP setup",
      description:
        "Report whether the Renovate CLI and config validator are reachable, their versions, and any env overrides in effect. Call this first when other tools fail with a spawn error or unexpected validation output.",
      inputSchema: {},
    },
    async () => {
      const status = await checkSetup();
      const summary = describeSetup(status);
      const payload = JSON.stringify(status, null, 2);
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${payload}`,
          },
        ],
        isError: !status.ok,
      };
    },
  );
}
