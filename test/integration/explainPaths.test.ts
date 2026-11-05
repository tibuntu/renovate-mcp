import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let session: McpSession;
let repo: string;

afterEach(async () => {
  if (session) await session.close();
  if (repo) await rm(repo, { recursive: true, force: true });
});

type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(args: Record<string, unknown>): Promise<CallResult> {
  const res = await session.request<CallResult>("tools/call", { name: "explain_paths", arguments: args });
  return res.result!;
}

describe("explain_paths", () => {
  it("evaluates the repo's own config against git ls-files", async () => {
    repo = await mkdtemp(path.join(tmpdir(), "explain-paths-int-"));
    await mkdir(path.join(repo, "examples"));
    await writeFile(path.join(repo, "package.json"), "{}\n");
    await writeFile(path.join(repo, "examples/package.json"), "{}\n");
    await writeFile(path.join(repo, "renovate.json"), JSON.stringify({ ignorePaths: ["examples", "old/**"] }));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });

    session = await startServer({}, { requestTimeoutMs: 60_000 });
    const result = await call({ repoPath: repo });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.path).toBe("renovate.json");
    expect(body.summary).toMatchObject({ fileListSource: "git", totalFiles: 3, keptCount: 2 });
    expect(body.deadPatterns).toEqual([{ field: "ignorePaths", index: 1, pattern: "old/**", source: "<own>" }]);
    expect(body.substringOnlyHits[0]).toMatchObject({ file: "examples/package.json", suggestedGlob: "**/examples/**" });
  });

  it("errors when the repo has no config and no configContent is given", async () => {
    repo = await mkdtemp(path.join(tmpdir(), "explain-paths-int-"));
    session = await startServer();
    const result = await call({ repoPath: repo });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No Renovate configuration found/);
  });
});
