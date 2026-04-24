export function toMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    const json = JSON.stringify(e);
    if (json !== undefined) return json;
  } catch {
    // fall through to String() below
  }
  return String(e);
}

export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(toMessage(e));
}
