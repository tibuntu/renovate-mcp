import type { McpServer } from "@modelcontextprotocol/server";
import { describeVersion, getVersionInfo } from "../lib/version.js";
import { OFFLINE_READ_ONLY_ANNOTATIONS } from "../lib/toolInputs.js";
import { z } from "zod";

export function registerGetVersion(server: McpServer): void {
  server.registerTool(
    "get_version",
    {
      title: "Get renovate-mcp version",
      annotations: OFFLINE_READ_ONLY_ANNOTATIONS,
      description:
        "Report the renovate-mcp server version and whether it's a released build (running from node_modules) or a local/dev build (typically launched via `command: node` against a checkout). Useful when the user asks which version is wired up.",
      inputSchema: z.object({}),
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
