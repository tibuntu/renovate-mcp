import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import {
  collectSecrets,
  scrubSecrets,
  writeHostRulesConfig,
} from "../../src/lib/hostRulesConfig.js";

const createdPaths: string[] = [];

afterEach(async () => {
  while (createdPaths.length > 0) {
    const p = createdPaths.pop()!;
    await fs.unlink(p).catch(() => undefined);
  }
});

describe("writeHostRulesConfig", () => {
  it("writes a JSON file containing the hostRules array", async () => {
    const rules = [
      { matchHost: "repo.packagist.com", username: "u", password: "p" },
      { matchHost: "registry.acme.corp", token: "abc123" },
    ];
    const tmpPath = await writeHostRulesConfig(rules);
    createdPaths.push(tmpPath);

    const contents = JSON.parse(await fs.readFile(tmpPath, "utf8"));
    expect(contents).toEqual({ hostRules: rules });
  });

  it("creates the file inside os.tmpdir()", async () => {
    const tmpPath = await writeHostRulesConfig([{ matchHost: "x", token: "t" }]);
    createdPaths.push(tmpPath);
    expect(tmpPath.startsWith(os.tmpdir())).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "writes the file with mode 0600 on POSIX",
    async () => {
      const tmpPath = await writeHostRulesConfig([{ matchHost: "x", token: "t" }]);
      createdPaths.push(tmpPath);
      const stat = await fs.stat(tmpPath);
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );
});

describe("collectSecrets", () => {
  it("extracts token and password values", () => {
    const secrets = collectSecrets([
      { matchHost: "a", token: "tok-1" },
      { matchHost: "b", username: "u", password: "pw-1" },
    ]);
    expect(secrets.sort()).toEqual(["pw-1", "tok-1"]);
  });

  it("ignores usernames, matchHost, and other non-secret fields", () => {
    const secrets = collectSecrets([
      { matchHost: "a", username: "user-a", hostType: "docker" },
    ]);
    expect(secrets).toEqual([]);
  });

  it("deduplicates identical secrets across rules", () => {
    const secrets = collectSecrets([
      { matchHost: "a", token: "same" },
      { matchHost: "b", token: "same" },
    ]);
    expect(secrets).toEqual(["same"]);
  });

  it("skips empty-string secrets", () => {
    const secrets = collectSecrets([{ matchHost: "a", token: "" }]);
    expect(secrets).toEqual([]);
  });

  it("skips non-string secret values", () => {
    const secrets = collectSecrets([
      { matchHost: "a", token: 12345 as unknown as string },
      { matchHost: "b", password: null as unknown as string },
    ]);
    expect(secrets).toEqual([]);
  });
});

describe("scrubSecrets", () => {
  it("replaces every occurrence of each secret with [REDACTED]", () => {
    const out = scrubSecrets(
      "error: token=tok-1 failed; retrying with tok-1 — password pw-1 rejected",
      ["tok-1", "pw-1"],
    );
    expect(out).toBe(
      "error: token=[REDACTED] failed; retrying with [REDACTED] — password [REDACTED] rejected",
    );
  });

  it("returns input unchanged when secrets list is empty", () => {
    const input = "nothing to scrub here";
    expect(scrubSecrets(input, [])).toBe(input);
  });

  it("skips empty strings in the secrets list (does not redact everything)", () => {
    const input = "abcdef";
    expect(scrubSecrets(input, [""])).toBe(input);
  });

  it("prefers the longer secret when one is a substring of another", () => {
    // "tok" appears inside "tok-long". Without a length-desc sort, the shorter
    // secret could chew a prefix out of the longer one and leave a stray
    // suffix behind.
    const out = scrubSecrets("value=tok-long and also tok alone", ["tok", "tok-long"]);
    expect(out).toBe("value=[REDACTED] and also [REDACTED] alone");
  });

  it("treats regex metacharacters in secrets as literal text", () => {
    const secret = "a.b*c+?|$(d)";
    const out = scrubSecrets(`before ${secret} after`, [secret]);
    expect(out).toBe("before [REDACTED] after");
  });
});
