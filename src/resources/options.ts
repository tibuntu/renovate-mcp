import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  OPTIONS,
  OPTION_NAMES,
  RENOVATE_VERSION as OPTIONS_RENOVATE_VERSION,
  type GeneratedOption,
} from "../data/options.generated.js";
import {
  ALL_MANAGERS,
  CUSTOM_MANAGERS,
  RENOVATE_VERSION as MANAGERS_RENOVATE_VERSION,
} from "../data/managers.generated.js";

const REPO_OPTION_NAMES: string[] = OPTION_NAMES.filter(
  (name) => !OPTIONS[name]!.globalOnly,
);
const GLOBAL_OPTION_NAMES: string[] = OPTION_NAMES.filter(
  (name) => OPTIONS[name]!.globalOnly,
);

export function registerOptionResources(server: McpServer): void {
  server.registerResource(
    "renovate-options",
    "renovate://options",
    {
      title: "Renovate config options index",
      description: `Thin markdown index of all ${OPTION_NAMES.length} Renovate config options (from renovate v${OPTIONS_RENOVATE_VERSION}), split into repository-config and global/self-hosted-only sections. Fetch renovate://option/{name} for one option's full definition as JSON.`,
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "renovate://options",
          mimeType: "text/markdown",
          text: renderOptionsIndex(),
        },
      ],
    }),
  );

  server.registerResource(
    "renovate-option",
    new ResourceTemplate("renovate://option/{name}", {
      list: async () => ({
        resources: OPTION_NAMES.map((name) => {
          const opt = OPTIONS[name]!;
          return {
            uri: `renovate://option/${name}`,
            name,
            description: opt.description,
            mimeType: "application/json",
          };
        }),
      }),
    }),
    {
      title: "Renovate config option (definition JSON)",
      description:
        "Full definition of a single Renovate config option — type, default, allowedValues, whether it's globalOnly, etc.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.name;
      const name = typeof raw === "string" ? decodeURIComponent(raw) : "";
      const entry = getOptionEntry(name);
      if (!entry) {
        throw new Error(
          `Unknown option: ${name}. Fetch renovate://options for the full list.`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(entry, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "renovate-managers",
    "renovate://managers",
    {
      title: "Renovate manager names",
      description: `Markdown list of all ${ALL_MANAGERS.length} manager names (including ${CUSTOM_MANAGERS.length} custom managers) accepted by \`matchManagers\` / \`excludeManagers\` (from renovate v${MANAGERS_RENOVATE_VERSION}).`,
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "renovate://managers",
          mimeType: "text/markdown",
          text: renderManagersIndex(),
        },
      ],
    }),
  );
}

/** Look up a single option's snapshot by name, with `name` folded back in. */
export function getOptionEntry(
  name: string,
): (GeneratedOption & { name: string }) | undefined {
  const opt = OPTIONS[name];
  if (!opt) return undefined;
  return { name, ...opt };
}

const DESCRIPTION_TRUNCATE_LENGTH = 120;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function renderOptionLine(name: string): string {
  const opt = OPTIONS[name]!;
  const type = opt.type ?? "unknown";
  const description = truncate(opt.description ?? "", DESCRIPTION_TRUNCATE_LENGTH);
  const tags: string[] = [];
  if (opt.deprecationMsg) tags.push("[deprecated]");
  if (opt.experimental) tags.push("[experimental]");
  const suffix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
  return `- \`${name}\` (${type}) — ${description}${suffix}`;
}

export function renderOptionsIndex(): string {
  const lines: string[] = [
    "# Renovate config options",
    "",
    `Snapshot from renovate v${OPTIONS_RENOVATE_VERSION} — **${OPTION_NAMES.length} options** (${REPO_OPTION_NAMES.length} repository-config, ${GLOBAL_OPTION_NAMES.length} global/self-hosted-only).`,
    "",
    "Fetch `renovate://option/<name>` for a single option's full definition as JSON.",
    "",
    "## Repository config options",
    "",
  ];
  for (const name of REPO_OPTION_NAMES) lines.push(renderOptionLine(name));
  lines.push("", "## Global / self-hosted-only options", "");
  for (const name of GLOBAL_OPTION_NAMES) lines.push(renderOptionLine(name));
  lines.push("");
  return lines.join("\n");
}

export function renderManagersIndex(): string {
  const lines: string[] = [
    "# Renovate managers",
    "",
    `Snapshot from renovate v${MANAGERS_RENOVATE_VERSION} — **${ALL_MANAGERS.length} managers** (${CUSTOM_MANAGERS.length} of which are custom managers, also referenceable with a \`custom.\` prefix).`,
    "",
    "Reference any of these in the `matchManagers` / `excludeManagers` fields of a `packageRules` entry.",
    "",
    "## Managers",
    "",
  ];
  for (const name of ALL_MANAGERS) lines.push(`- \`${name}\``);
  lines.push("", "## Custom managers", "");
  for (const name of CUSTOM_MANAGERS) {
    lines.push(`- \`${name}\` (also \`custom.${name}\`)`);
  }
  lines.push("");
  return lines.join("\n");
}
