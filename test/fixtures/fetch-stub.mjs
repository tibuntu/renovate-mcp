// Test fixture: network stub preloaded with `NODE_OPTIONS=--import=<file-url>`
// (see test/helpers/fetchStub.ts). Node runs `--import` preloads in every
// thread, so it also covers the Renovate workers the MCP server spawns, and
// every child that inherits NODE_OPTIONS (the fake renovate binary included).
//
// RENOVATE_MCP_TEST_FETCH_ROUTES is a JSON object mapping an exact request URL
// to `{ status?, body?, headers? }`; `body` may be a string or JSON. With the
// variable unset, the stub does nothing. With it set, every https request
// (`globalThis.fetch` and `https.request`, which Renovate's got client uses)
// is answered from the table, and an unlisted URL gets a 404: tests never
// reach the network. RENOVATE_MCP_TEST_FETCH_LOG, when set, names a file that
// receives one JSON line per request: `{ url, method, authorization }`.
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { Duplex } from "node:stream";

const rawRoutes = process.env.RENOVATE_MCP_TEST_FETCH_ROUTES;
if (rawRoutes) {
  const routes = JSON.parse(rawRoutes);
  const logPath = process.env.RENOVATE_MCP_TEST_FETCH_LOG;

  const answer = (url, method, headers) => {
    const lower = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (logPath) {
      const authorization = lower.authorization ?? lower["private-token"] ?? null;
      appendFileSync(logPath, `${JSON.stringify({ url, method, authorization })}\n`);
    }
    const route = routes[url] ?? { status: 404, body: "" };
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? "");
    return { status: route.status ?? 200, body, headers: { "content-type": "application/json", ...route.headers } };
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
    const { status, body, headers: resHeaders } = answer(url, init.method ?? "GET", headers);
    return new Response(status === 204 || status === 304 ? null : body, { status, headers: resHeaders });
  };

  // A socket that answers the first request written to it with a canned HTTP
  // response, so node:http parses it like a real server reply.
  const cannedSocket = (res) => {
    const reason = http.STATUS_CODES[res.status] ?? "Unknown";
    const head = [
      `HTTP/1.1 ${res.status} ${reason}`,
      ...Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`),
      `content-length: ${Buffer.byteLength(res.body)}`,
      "connection: close",
      "",
      "",
    ].join("\r\n");
    let answered = false;
    const socket = new Duplex({
      read() {},
      write(_chunk, _enc, cb) {
        if (!answered) {
          answered = true;
          setImmediate(() => {
            socket.push(head + res.body);
            socket.push(null);
          });
        }
        cb();
      },
    });
    for (const m of ["setTimeout", "setNoDelay", "setKeepAlive", "ref", "unref"]) socket[m] = () => socket;
    socket.remoteAddress = "127.0.0.1";
    return socket;
  };

  https.request = function stubRequest(...args) {
    const cb = typeof args.at(-1) === "function" ? args.pop() : undefined;
    const [first, second] = args;
    const base = typeof first === "string" || first instanceof URL ? new URL(first) : undefined;
    const options = base ? { ...second } : { ...first };
    const url = base
      ? base.href
      : `https://${options.hostname ?? options.host}${options.port ? `:${options.port}` : ""}${options.path ?? "/"}`;
    const parsed = new URL(url);
    const res = answer(url, options.method ?? "GET", options.headers);
    return http.request(
      {
        method: options.method ?? "GET",
        headers: options.headers,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        createConnection: () => cannedSocket(res),
      },
      cb,
    );
  };
}
