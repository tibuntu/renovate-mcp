import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PRESETS,
  PRESET_NAMES,
  RENOVATE_VERSION,
} from "../data/presets.generated.js";

export function registerPresetResources(server: McpServer): void {
  server.registerResource(
    "renovate-presets",
    "renovate://presets",
    {
      title: "Renovate built-in preset index",
      description: `Markdown index of all ${PRESET_NAMES.length} built-in Renovate presets (from renovate v${RENOVATE_VERSION}). Grouped by namespace. Fetch renovate://preset/{name} for a single preset's expanded JSON.`,
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "renovate://presets",
          mimeType: "text/markdown",
          text: renderIndex(),
        },
      ],
    }),
  );

  server.registerResource(
    "renovate-preset",
    new ResourceTemplate("renovate://preset/{name}", {
      list: async () => ({
        resources: PRESET_NAMES.map((name) => {
          const preset = PRESETS[name]!;
          return {
            uri: `renovate://preset/${name}`,
            name,
            description: preset.description ?? undefined,
            mimeType: "application/json",
          };
        }),
      }),
    }),
    {
      title: "Renovate preset (expanded JSON)",
      description:
        "Expanded JSON of a single built-in Renovate preset — its description and body (extends, packageRules, etc.).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.name;
      const name = typeof raw === "string" ? decodeURIComponent(raw) : "";
      const preset = PRESETS[name];
      if (!preset) {
        throw new Error(
          `Unknown preset: ${name}. Fetch renovate://presets for the full list.`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                name,
                namespace: preset.namespace,
                description: preset.description,
                body: preset.body,
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

function renderIndex(): string {
  const byNamespace = new Map<string, Array<{ name: string; description: string | null }>>();
  for (const name of PRESET_NAMES) {
    const preset = PRESETS[name]!;
    const bucket = byNamespace.get(preset.namespace) ?? [];
    bucket.push({ name, description: preset.description });
    byNamespace.set(preset.namespace, bucket);
  }
  const namespaces = Array.from(byNamespace.keys()).sort();
  const lines: string[] = [
    "# Renovate built-in presets",
    "",
    `Snapshot from renovate v${RENOVATE_VERSION} — **${PRESET_NAMES.length} presets** across ${namespaces.length} namespaces.`,
    "",
    "Reference any of these in the `extends` array of your config. Fetch `renovate://preset/<name>` for the expanded JSON of a single preset.",
    "",
  ];
  for (const ns of namespaces) {
    const items = byNamespace.get(ns)!;
    lines.push(`## \`${ns}\` (${items.length})`, "");
    for (const { name, description } of items) {
      lines.push(description ? `- \`${name}\` — ${description}` : `- \`${name}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}
