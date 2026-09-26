// Resource-template variables arrive percent-encoded (`config%3Arecommended`).
// A malformed sequence (`%E0%A4%A`) makes decodeURIComponent throw a URIError
// that would surface raw through the SDK; fall back to the undecoded string so
// the lookup fails the same way an unknown name does.
export function decodeUriVariable(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
