import { promises as fs } from "node:fs";
import path from "node:path";

// Input rules shared by every tool (documented under "Common input rules" in
// docs/tools.md). Each helper returns an error message rather than an MCP
// result so the tools keep one `{ isError, content }` shape at the call site.

/** Null when `repoPath` is an absolute path to an existing directory, else the error text. */
export async function assertRepoDir(repoPath: string): Promise<string | null> {
  const stat = path.isAbsolute(repoPath) ? await fs.stat(repoPath).catch(() => null) : null;
  return stat?.isDirectory()
    ? null
    : `repoPath must be an absolute path to an existing directory (got: ${repoPath})`;
}
