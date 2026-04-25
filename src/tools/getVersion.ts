import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeVersion, getVersionInfo } from "../lib/version.js";

export function registerGetVersion(server: McpServer): void {
  server.registerTool(
    "get_version",
    {
      title: "Get renovate-mcp version",
      description:
        "Report the renovate-mcp server version and whether it's a released build (running from node_modules) or a local/dev build (typically launched via `command: node` against a checkout). Useful when the user asks which version is wired up.",
      inputSchema: {},
    },
    async () => {
      const info = getVersionInfo();
      return {
        content: [
          {
            type: "text",
            text: `${describeVersion(info)}\n\n${JSON.stringify(info, null, 2)}`,
          },
        ],
      };
    },
  );
}
