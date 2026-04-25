// stderr-only logging for the MCP stdio server.
// stdout carries JSON-RPC frames — anything written there corrupts the next
// message the client receives, so error output must never go through console.log.

const PREFIX = "[renovate-mcp]";

function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

export function logError(message: string, reason?: unknown): void {
  const suffix = reason === undefined ? "" : `: ${formatReason(reason)}`;
  process.stderr.write(`${PREFIX} ${message}${suffix}\n`);
}
