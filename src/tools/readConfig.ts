import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateConfig } from "../lib/configLocations.js";
import { pathString } from "../lib/inputLimits.js";

export function registerReadConfig(server: McpServer): void {
  server.registerTool(
    "read_config",
    {
      title: "Read Renovate config",
      description:
        "Locate and parse the Renovate configuration in a repository. Searches for renovate.json, renovate.json5, .renovaterc(.json|.json5), .github/renovate.json, .gitlab/renovate.json, and the 'renovate' field of package.json — in that priority order.",
      inputSchema: {
        repoPath: pathString("Absolute path to the repository root"),
      },
    },
    async ({ repoPath }) => {
      const located = await locateConfig(repoPath);
      if (!located) {
        return {
          content: [
            {
              type: "text",
              text: `No Renovate configuration found in ${repoPath}. Create one with write_config.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path: located.relPath,
                format: located.format,
                config: located.config,
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
