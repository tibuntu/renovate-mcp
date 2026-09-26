/** Non-null, non-array object — the shape every config / report walker narrows to. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Cap `s` at `max` characters, ending in `…` (trailing whitespace trimmed) when cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
