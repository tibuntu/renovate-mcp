import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PRESETS,
  PRESET_NAMES,
  RENOVATE_VERSION,
} from "../data/presets.generated.js";

interface NamespaceEntry {
  name: string;
  description: string | null;
}

const BY_NAMESPACE: Map<string, NamespaceEntry[]> = (() => {
  const map = new Map<string, NamespaceEntry[]>();
  for (const name of PRESET_NAMES) {
    const preset = PRESETS[name]!;
    const bucket = map.get(preset.namespace) ?? [];
    bucket.push({ name, description: preset.description });
    map.set(preset.namespace, bucket);
  }
  return map;
})();

const NAMESPACES: string[] = Array.from(BY_NAMESPACE.keys()).sort();

export function registerPresetResources(server: McpServer): void {
  server.registerResource(
    "renovate-presets",
    "renovate://presets",
    {
      title: "Renovate built-in preset namespace index",
      description: `Thin markdown index of the ${NAMESPACES.length} namespaces covering all ${PRESET_NAMES.length} built-in Renovate presets (from renovate v${RENOVATE_VERSION}). Fetch renovate://presets/{namespace} for one namespace's preset list, or renovate://preset/{name} for a single preset's expanded JSON.`,
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "renovate://presets",
          mimeType: "text/markdown",
          text: renderNamespaceIndex(),
        },
      ],
    }),
  );

  server.registerResource(
    "renovate-presets-namespace",
    new ResourceTemplate("renovate://presets/{namespace}", {
      list: async () => ({
        resources: NAMESPACES.map((ns) => ({
          uri: `renovate://presets/${ns}`,
          name: `renovate-presets-${ns}`,
          description: `Markdown listing of the ${BY_NAMESPACE.get(ns)!.length} built-in presets in the \`${ns}\` namespace.`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Renovate built-in presets — single namespace",
      description:
        "Markdown listing of every built-in Renovate preset in a single namespace (e.g. `config`, `docker`, `default`). Fetch renovate://presets for the namespace index.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const raw = variables.namespace;
      const ns = typeof raw === "string" ? decodeURIComponent(raw) : "";
      const bucket = BY_NAMESPACE.get(ns);
      if (!bucket) {
        throw new Error(
          `Unknown preset namespace: ${ns}. Fetch renovate://presets for the list of namespaces.`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: renderNamespace(ns, bucket),
          },
        ],
      };
    },
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

function renderNamespaceIndex(): string {
  const lines: string[] = [
    "# Renovate built-in presets",
    "",
    `Snapshot from renovate v${RENOVATE_VERSION} — **${PRESET_NAMES.length} presets** across ${NAMESPACES.length} namespaces.`,
    "",
    "Fetch `renovate://presets/<namespace>` for the full list of presets in one namespace, or `renovate://preset/<name>` for a single preset's expanded JSON.",
    "",
    "| Namespace | Presets | Resource |",
    "| --- | ---: | --- |",
  ];
  for (const ns of NAMESPACES) {
    const count = BY_NAMESPACE.get(ns)!.length;
    lines.push(`| \`${ns}\` | ${count} | \`renovate://presets/${ns}\` |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderNamespace(ns: string, bucket: NamespaceEntry[]): string {
  const lines: string[] = [
    `# Renovate \`${ns}\` presets`,
    "",
    `Snapshot from renovate v${RENOVATE_VERSION} — **${bucket.length} preset${bucket.length === 1 ? "" : "s"}** in the \`${ns}\` namespace.`,
    "",
    "Reference any of these in the `extends` array of your config. Fetch `renovate://preset/<name>` for the expanded JSON of a single preset.",
    "",
  ];
  for (const { name, description } of bucket) {
    lines.push(description ? `- \`${name}\` — ${description}` : `- \`${name}\``);
  }
  lines.push("");
  return lines.join("\n");
}
