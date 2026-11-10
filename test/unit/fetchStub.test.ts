import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchStubEnv, readFetchLog, repoFileRoute } from "../helpers/fetchStub.js";

// Renovate's own HTTP client; resolved from the repo since the probe runs in a temp dir.
const GOT_URL = pathToFileURL(path.resolve("node_modules/got/dist/source/index.js")).href;

// The stub runs inside child processes and workers, so it is tested the same
// way: a real node child with the stub preloaded through NODE_OPTIONS.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rmcp-fetchstub-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runProbe(source: string, env: Record<string, string | undefined>) {
  const probe = path.join(dir, "probe.mjs");
  await writeFile(probe, source);
  // A file worker, like the Renovate workers: preloads run in it too.
  await writeFile(
    path.join(dir, "worker.mjs"),
    `import { parentPort } from "node:worker_threads";\nparentPort.postMessage(await (await fetch("https://gitlab.example.com/a")).json());\n`,
  );
  const child = spawnSync(process.execPath, [probe], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(child.stderr).toBe("");
  return JSON.parse(child.stdout) as unknown;
}

const PROBE = `
import got from "${GOT_URL}";
import { Worker } from "node:worker_threads";
const out = {};
const r1 = await fetch("https://gitlab.example.com/a", { headers: { "PRIVATE-TOKEN": "glpat-x" } });
out.fetchRouted = [r1.status, await r1.json()];
const r2 = await fetch(new URL("https://gitlab.example.com/missing"), { method: "HEAD", headers: new Headers({ Authorization: "Bearer y" }) });
out.fetchMissing = r2.status;
const r3 = await fetch({ url: "https://gitlab.example.com/empty" });
out.fetchEmpty = [r3.status, await r3.text()];
const g1 = await got("https://api.github.com/repos/acme/widgets/contents/default.json?ref=HEAD", { headers: { authorization: "token ghp-z" } }).json();
out.got = g1;
const g2 = await got("https://api.github.com/nope", { throwHttpErrors: false });
out.gotMissing = g2.statusCode;
const g3 = await got("https://gitea.example.com/text", { headers: {} });
out.gotText = [g3.statusCode, g3.body, g3.headers["x-stub"]];
const https = (await import("node:https")).default;
out.optionsForm = await new Promise((resolve) => {
  https.request({ hostname: "gitea.example.com", port: 8443, path: "/opt" }, (res) => resolve(res.statusCode)).end();
});
out.hostForm = await new Promise((resolve) => {
  const req = https.request({ host: "gitea.example.com", method: "GET" });
  req.on("response", (res) => resolve(res.statusCode));
  req.end();
});
out.urlOptionsForm = await new Promise((resolve) => {
  https.request("https://gitea.example.com/text", { method: "GET" }, (res) => resolve(res.statusCode)).end();
});
out.worker = await new Promise((resolve) => {
  const w = new Worker(new URL("./worker.mjs", import.meta.url));
  w.once("message", (m) => { resolve(m); w.terminate(); });
});
console.log(JSON.stringify(out));
`;

describe("fetch stub preload", () => {
  it("answers fetch, got and https.request from the routes table, 404s the rest, and logs every request", async () => {
    const log = path.join(dir, "requests.log");
    const out = await runProbe(
      PROBE,
      fetchStubEnv(
        {
          "https://gitlab.example.com/a": { body: { ok: 1 } },
          "https://gitlab.example.com/empty": { status: 204 },
          "https://api.github.com/repos/acme/widgets/contents/default.json?ref=HEAD": repoFileRoute({ automerge: true }),
          "https://gitea.example.com/text": { body: "plain", headers: { "x-stub": "yes" } },
          "https://gitea.example.com:8443/opt": { status: 201 },
          "https://gitea.example.com/": { status: 202 },
        },
        log,
      ),
    );
    expect(out).toEqual({
      fetchRouted: [200, { ok: 1 }],
      fetchMissing: 404,
      fetchEmpty: [204, ""],
      got: { content: Buffer.from(JSON.stringify({ automerge: true })).toString("base64") },
      gotMissing: 404,
      gotText: [200, "plain", "yes"],
      optionsForm: 201,
      hostForm: 202,
      urlOptionsForm: 200,
      worker: { ok: 1 },
    });
    const requests = await readFetchLog(log);
    expect(requests.map((r) => [r.url, r.method, r.authorization])).toEqual([
      ["https://gitlab.example.com/a", "GET", "glpat-x"],
      ["https://gitlab.example.com/missing", "HEAD", "Bearer y"],
      ["https://gitlab.example.com/empty", "GET", null],
      ["https://api.github.com/repos/acme/widgets/contents/default.json?ref=HEAD", "GET", "token ghp-z"],
      ["https://api.github.com/nope", "GET", null],
      ["https://gitea.example.com/text", "GET", null],
      ["https://gitea.example.com:8443/opt", "GET", null],
      ["https://gitea.example.com/", "GET", null],
      ["https://gitea.example.com/text", "GET", null],
      ["https://gitlab.example.com/a", "GET", null],
    ]);
  });

  it("does nothing without a routes table, and logs nothing without a log path", async () => {
    const out = await runProbe(
      `import https from "node:https"; console.log(JSON.stringify({ fetchIsNative: fetch.name === "fetch", requestIsNative: https.request.name === "request" }));`,
      { ...fetchStubEnv({}), RENOVATE_MCP_TEST_FETCH_ROUTES: undefined },
    );
    expect(out).toEqual({ fetchIsNative: true, requestIsNative: true });
    const quiet = await runProbe(
      `const r = await fetch("https://gitlab.example.com/a"); console.log(JSON.stringify(r.status));`,
      fetchStubEnv({ "https://gitlab.example.com/a": {} }),
    );
    expect(quiet).toBe(200);
    expect(await readFetchLog(path.join(dir, "absent.log"))).toEqual([]);
  });
});
