import { fileURLToPath } from "node:url";

export const SERVER_VERSION = "0.9.3"; // x-release-please-version

export type BuildMode = "local" | "released";

export interface VersionInfo {
  version: string;
  mode: BuildMode;
  scriptPath: string;
}

// "released" = the server is running from a `node_modules/` install (global
// `npm i -g`, project-local `npm i`, or `npx renovate-mcp`). Anything else —
// most commonly an MCP config of `{"command": "node", "args": [".../dist/index.js"]}`
// pointed at a checkout — is treated as a local/dev build.
function detectMode(scriptPath: string): BuildMode {
  return /[\\/]node_modules[\\/]/.test(scriptPath) ? "released" : "local";
}

export function getVersionInfo(entryUrl: string = import.meta.url): VersionInfo {
  const scriptPath = fileURLToPath(entryUrl);
  return {
    version: SERVER_VERSION,
    mode: detectMode(scriptPath),
    scriptPath,
  };
}

export function describeVersion(info: VersionInfo): string {
  const tag = info.mode === "local" ? " (local/dev build)" : "";
  return `renovate-mcp ${info.version}${tag}\nRunning from: ${info.scriptPath}`;
}
