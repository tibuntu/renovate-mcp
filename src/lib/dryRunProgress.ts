/**
 * Pure helpers for the dry_run tool's progress-notification pipeline. Kept in
 * their own module so the parsing + message-building logic can be unit-tested
 * without spawning an MCP server.
 *
 * The mapping from Renovate's JSON log output to progress messages is
 * intentionally best-effort — Renovate's log schema is not a stable API, so we
 * only read the `msg` field when present and fall back to an elapsed-time
 * message otherwise.
 */

/** Maximum length of a Renovate log `msg` copied into a progress update. */
export const DEFAULT_MAX_LOG_MSG_LEN = 160;

/**
 * Parse a single stdout line as a Renovate JSON log entry and return its
 * `msg` (trimmed and truncated) when present. Returns `undefined` for
 * non-JSON lines, lines without a string `msg`, or empty messages.
 */
export function extractRenovateLogMsg(
  line: string,
  maxLen: number = DEFAULT_MAX_LOG_MSG_LEN,
): string | undefined {
  if (!line) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const msgVal = (parsed as { msg?: unknown }).msg;
  if (typeof msgVal !== "string") return undefined;
  const trimmed = msgVal.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

/**
 * Build the message payload for a heartbeat-tick progress notification.
 * Includes elapsed time and, when available, the most recently observed
 * Renovate log `msg` so callers see *something* beyond "still running".
 */
export function buildDryRunHeartbeatMessage(
  elapsedMs: number,
  lastLogMsg: string | undefined,
): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  return lastLogMsg
    ? `Dry-run in progress (${seconds}s) — ${lastLogMsg}`
    : `Dry-run in progress (${seconds}s elapsed)`;
}
