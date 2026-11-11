import { describe, it, expect } from "vitest";
import {
  HOST_TOKENS_ENV,
  PLATFORM_TOKEN_ENV,
  PUBLIC_HOST,
  buildHostTokenRules,
  homeScope,
  matchesHost,
  parseHostTokens,
  selectToken,
  tokenHost,
} from "../../src/lib/hostTokens.js";
import { HOST_RULES_MAX_ITEMS } from "../../src/lib/inputLimits.js";

const hostTokens = (entries: unknown) => ({ [HOST_TOKENS_ENV]: JSON.stringify(entries) });

describe("constants", () => {
  it("name one token var and one public host per hosted platform", () => {
    expect(PLATFORM_TOKEN_ENV).toEqual({
      github: "GITHUB_TOKEN",
      gitlab: "GITLAB_TOKEN",
      gitea: "GITEA_TOKEN",
      forgejo: "FORGEJO_TOKEN",
      bitbucket: "BITBUCKET_TOKEN",
    });
    expect(PUBLIC_HOST).toEqual({
      github: "github.com",
      gitlab: "gitlab.com",
      gitea: "gitea.com",
      forgejo: "code.forgejo.org",
      bitbucket: "bitbucket.org",
    });
    expect(HOST_TOKENS_ENV).toBe("RENOVATE_MCP_HOST_TOKENS");
  });
});

describe("parseHostTokens", () => {
  const entry = { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ACME_GITLAB" };

  it("returns no entries when the var is unset or blank", () => {
    expect(parseHostTokens({})).toEqual({ ok: true, entries: [] });
    expect(parseHostTokens({ [HOST_TOKENS_ENV]: "  " })).toEqual({ ok: true, entries: [] });
  });

  it("accepts bare hosts, leading-dot hosts and https URL prefixes", () => {
    const entries = [
      entry,
      { matchHost: ".example.com", hostType: "npm", tokenEnv: "_NPM1" },
      { matchHost: "https://gitlab.example.com/api/v4/projects/acme", hostType: "gitlab-tags", tokenEnv: "T" },
    ];
    expect(parseHostTokens(hostTokens(entries))).toEqual({ ok: true, entries });
  });

  it.each([
    ["invalid JSON", "{nope", /not valid JSON/],
    ["a non-array", JSON.stringify(entry), /must be a JSON array/],
    ["a non-object entry", JSON.stringify(["x"]), /\[0\] must be an object/],
    ["a null entry", JSON.stringify([null]), /\[0\] must be an object/],
    ["an array entry", JSON.stringify([[]]), /\[0\] must be an object/],
    ["an extra key", JSON.stringify([{ ...entry, token: "x" }]), /\[0\] must be an object with exactly/],
    ["a missing key", JSON.stringify([{ matchHost: "a.com", hostType: "npm" }]), /\[0\] must be an object with exactly/],
    ["a non-string field", JSON.stringify([{ ...entry, hostType: 1 }]), /\[0\]\.hostType/],
    ["an empty tokenEnv", JSON.stringify([{ ...entry, tokenEnv: "" }]), /\[0\]\.tokenEnv/],
    ["a tokenEnv that is not a var name", JSON.stringify([{ ...entry, tokenEnv: "1BAD" }]), /\[0\]\.tokenEnv/],
    ["an uppercase hostType", JSON.stringify([{ ...entry, hostType: "GitLab" }]), /\[0\]\.hostType/],
    ["an uppercase matchHost", JSON.stringify([{ ...entry, matchHost: "GitLab.com" }]), /\[0\]\.matchHost/],
    ["an http URL matchHost", JSON.stringify([{ ...entry, matchHost: "http://gitlab.example.com" }]), /\[0\]\.matchHost/],
    ["a URL matchHost with userinfo", JSON.stringify([{ ...entry, matchHost: "https://u:p@gitlab.example.com" }]), /\[0\]\.matchHost/],
    ["an unparseable https matchHost", JSON.stringify([{ ...entry, matchHost: "https://" }]), /\[0\]\.matchHost/],
    ["a matchHost with a path but no scheme", JSON.stringify([{ ...entry, matchHost: "gitlab.com/x" }]), /\[0\]\.matchHost/],
  ])("rejects %s", (_name, raw, message) => {
    const result = parseHostTokens({ [HOST_TOKENS_ENV]: raw });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(message);
      expect(result.error).toMatch(new RegExp(`^${HOST_TOKENS_ENV}( |\\[)`));
    }
  });

  it("names the failing index of a later entry", () => {
    const result = parseHostTokens(hostTokens([entry, { ...entry, tokenEnv: "a-b" }]));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/\[1\]\.tokenEnv/) });
  });

  it("rejects more entries than the host rule cap", () => {
    const many = Array.from({ length: HOST_RULES_MAX_ITEMS + 1 }, () => entry);
    expect(parseHostTokens(hostTokens(many))).toMatchObject({
      ok: false,
      error: expect.stringMatching(new RegExp(`limit is ${HOST_RULES_MAX_ITEMS}`)),
    });
  });

  it("never echoes the raw value into the error", () => {
    const result = parseHostTokens({ [HOST_TOKENS_ENV]: "glpat-secret-value" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("glpat-secret-value");
  });
});

describe("matchesHost (mirrors Renovate's host-rules matchesHost)", () => {
  it.each([
    ["gitlab.com", "https://gitlab.com/api/v4/x", true],
    ["github.com", "https://api.github.com/repos/a/b", true],
    [".example.com", "https://a.example.com/", true],
    ["gitlab.com", "https://evilgitlab.com/api/v4", false],
    ["gitlab.com", "https://gitlab.com.evil.example/", false],
    ["https://gitlab.example.com/api/v4/", "https://gitlab.example.com/api/v4/projects/1", true],
    ["https://gitlab.example.com/api/v4/", "https://gitlab.example.com/api/v4", true],
    ["https://gitlab.example.com/api/v4", "https://gitlab.example.com/api/v4/projects", true],
    ["https://gitlab.example.com/other", "https://gitlab.example.com/api/v4", false],
    ["gitlab.com", "https://gitlab.com./api/v4", false],
    ["gitlab.com", "https://GitLab.COM:8443/api/v4", true],
    ["gitlab.com", "https://gitlab.com@evil.example/", false],
    ["https://gitlab.example.com/api/v4/", "https://GITLAB.example.com:443/api/v4/x", true],
    ["https://gitlab.example.com/api/v4/", "https://gitlab.example.com:8443/api/v4/x", false],
    ["https://gitlab.example.com/api/v4/", "https://gitlab.example.com@evil.example/api/v4/x", false],
    ["gitlab.com", "not a url", false],
    ["gitlab.com", "mailto:someone@gitlab.com", false],
  ])("%s vs %s -> %s", (matchHost, url, expected) => {
    expect(matchesHost(matchHost, url)).toBe(expected);
  });
});

describe("homeScope", () => {
  const env = { RENOVATE_PLATFORM: "gitea", RENOVATE_ENDPOINT: "https://gitea.example.com/api/v1" };

  it("takes platform and endpoint from the tool input", () => {
    expect(homeScope({ platform: "gitlab", endpoint: "https://gitlab.example.com/api/v4" }, env)).toEqual({
      platform: "gitlab",
      endpoint: "https://gitlab.example.com/api/v4",
    });
  });

  it("takes RENOVATE_ENDPOINT only when the platform input is unset or equals RENOVATE_PLATFORM", () => {
    expect(homeScope({ platform: "gitea" }, env)).toEqual({
      platform: "gitea",
      endpoint: "https://gitea.example.com/api/v1",
    });
    expect(homeScope({ endpoint: "https://gitea2.example.com/api/v1" }, env)).toEqual({
      platform: "gitea",
      endpoint: "https://gitea2.example.com/api/v1",
    });
  });

  it("ignores RENOVATE_ENDPOINT when the platform input names another platform than RENOVATE_PLATFORM", () => {
    expect(homeScope({ platform: "gitlab" }, env)).toEqual({ platform: "gitlab" });
    expect(homeScope({ platform: "gitlab" }, { RENOVATE_ENDPOINT: "https://gitea.example.com/api/v1" })).toEqual({
      platform: "gitlab",
    });
    expect(homeScope({ platform: "gitlab", endpoint: "https://gitlab.example.com/api/v4" }, env)).toEqual({
      platform: "gitlab",
      endpoint: "https://gitlab.example.com/api/v4",
    });
  });

  it("falls back to RENOVATE_PLATFORM / RENOVATE_ENDPOINT", () => {
    expect(homeScope({}, env)).toEqual({ platform: "gitea", endpoint: "https://gitea.example.com/api/v1" });
    expect(homeScope({}, { RENOVATE_PLATFORM: "gitlab" })).toEqual({ platform: "gitlab" });
  });

  it("has no home when nothing names a platform, even with an endpoint", () => {
    expect(homeScope({}, {})).toEqual({});
    expect(homeScope({}, { RENOVATE_ENDPOINT: "https://ghe.example.com/api/v3" })).toEqual({});
    expect(homeScope({ endpoint: "https://ghe.example.com/api/v3" }, {})).toEqual({});
    expect(homeScope({ platform: "", endpoint: "" }, { RENOVATE_PLATFORM: "", RENOVATE_ENDPOINT: "" })).toEqual({});
  });

  it("has no home for a platform that is not hosted, and an input one is not overridden by env", () => {
    expect(homeScope({}, { RENOVATE_PLATFORM: "azure", RENOVATE_ENDPOINT: "https://dev.azure.example/" })).toEqual({});
    expect(homeScope({ platform: "local" }, { RENOVATE_PLATFORM: "gitlab" })).toEqual({});
  });

  it("defaults to process.env", () => {
    expect(homeScope({ platform: "local" })).toEqual({});
  });
});

describe("selectToken (Renovate's hostRules find() over the emitted rule list)", () => {
  const gh = "https://api.github.com/repos/a/b/contents/default.json";
  const gl = "https://gitlab.com/api/v4/projects/a%2Fb/repository/files/default.json/raw";
  const selfGl = "https://gitlab.example.com/api/v4/projects/a%2Fb/repository/files/default.json/raw";
  /** The env scope that binds tokens to the self-hosted GitLab. */
  const selfHome = { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4" };

  it("GITHUB_COM_TOKEN is appended after the file rules, so it wins the github.com tie", () => {
    const env = { GITHUB_COM_TOKEN: "com", GITHUB_TOKEN: "plat", RENOVATE_TOKEN: "rnv", RENOVATE_PLATFORM: "github" };
    expect(selectToken(gh, "github", env)).toMatchObject({
      envVar: "GITHUB_COM_TOKEN",
      token: "com",
      triedVars: ["GITHUB_COM_TOKEN", "RENOVATE_TOKEN", "GITHUB_TOKEN"],
    });
  });

  it("GITHUB_COM_TOKEN loses to a longer host-token matchHost", () => {
    const env = {
      ...hostTokens([{ matchHost: "api.github.com", hostType: "github", tokenEnv: "API_GH" }]),
      API_GH: "api",
      GITHUB_COM_TOKEN: "com",
    };
    expect(selectToken(gh, "github", env).envVar).toBe("API_GH");
    // github.com itself is outside api.github.com, so the entry does not match there.
    expect(selectToken("https://github.com/a/b", "github", env).envVar).toBe("GITHUB_COM_TOKEN");
  });

  it("GITHUB_COM_TOKEN never reaches another host", () => {
    const env = { GITHUB_COM_TOKEN: "com", RENOVATE_PLATFORM: "github" };
    expect(selectToken("https://ghe.example.com/api/v3/x", "github", env).token).toBeUndefined();
  });

  it("can leave GITHUB_COM_TOKEN out (the platform token of a spawned Renovate is not a find() result)", () => {
    const env = { GITHUB_COM_TOKEN: "com", GITHUB_TOKEN: "plat", RENOVATE_PLATFORM: "github" };
    expect(selectToken(gh, "github", env, { githubComToken: false })).toMatchObject({
      envVar: "GITHUB_TOKEN",
      triedVars: ["RENOVATE_TOKEN", "GITHUB_TOKEN"],
    });
  });

  it("the longest matchHost wins, whichever list it comes from", () => {
    const env = {
      ...selfHome,
      ...hostTokens([
        { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "SAME" },
        { matchHost: "https://gitlab.example.com/api/v4/projects/a", hostType: "gitlab", tokenEnv: "LONG" },
        { matchHost: ".example.com", hostType: "gitlab", tokenEnv: "SHORT" },
      ]),
      SAME: "same",
      LONG: "long",
      SHORT: "short",
      GITLAB_TOKEN: "plat",
    };
    expect(selectToken(selfGl, "gitlab", env)).toMatchObject({
      envVar: "LONG",
      triedVars: ["LONG", "SAME", "RENOVATE_TOKEN", "GITLAB_TOKEN", "SHORT"],
    });
  });

  it("a host-token entry is written after the platform rules, so it wins an equal-length tie", () => {
    const env = {
      ...selfHome,
      ...hostTokens([{ matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ENTRY" }]),
      ENTRY: "entry",
      RENOVATE_TOKEN: "rnv",
    };
    expect(selectToken(selfGl, "gitlab", env).envVar).toBe("ENTRY");
  });

  it("the home token on its endpoint host beats a shorter host-token entry", () => {
    const env = {
      ...selfHome,
      ...hostTokens([{ matchHost: ".example.com", hostType: "gitlab", tokenEnv: "WIDE" }]),
      WIDE: "wide",
      GITLAB_TOKEN: "plat",
    };
    expect(selectToken(selfGl, "gitlab", env).envVar).toBe("GITLAB_TOKEN");
  });

  it("a later entry wins a tie on matchHost length", () => {
    const env = {
      ...hostTokens([
        { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "FIRST" },
        { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "SECOND" },
      ]),
      FIRST: "1",
      SECOND: "2",
    };
    expect(selectToken(selfGl, "gitlab", env).envVar).toBe("SECOND");
  });

  it("skips rules of another hostType, of another host, and whose var is unset", () => {
    const env = {
      ...hostTokens([
        { matchHost: "gitlab.example.com", hostType: "gitlab-tags", tokenEnv: "TAGS" },
        { matchHost: "other.example.com", hostType: "gitlab", tokenEnv: "OTHER" },
        { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "UNSET" },
      ]),
      TAGS: "t",
      OTHER: "o",
    };
    const cred = selectToken(selfGl, "gitlab", env);
    expect(cred.token).toBeUndefined();
    expect(cred.triedVars).toEqual(["UNSET"]);
  });

  it("ignores a malformed host-token var (callers refuse it before fetching)", () => {
    const env = { [HOST_TOKENS_ENV]: "{", GITLAB_TOKEN: "plat" };
    expect(selectToken(gl, "gitlab", env).envVar).toBe("GITLAB_TOKEN");
  });

  it("binds the per-platform token to its public host when it is not the home platform", () => {
    const env = { GITLAB_TOKEN: "plat", RENOVATE_TOKEN: "rnv", RENOVATE_PLATFORM: "github" };
    expect(selectToken(gl, "gitlab", env)).toMatchObject({
      envVar: "GITLAB_TOKEN",
      token: "plat",
      triedVars: ["GITLAB_TOKEN"],
    });
  });

  it("RENOVATE_TOKEN wins over the per-platform token on the home host, as in Renovate", () => {
    const env = { GITLAB_TOKEN: "plat", RENOVATE_TOKEN: "rnv", RENOVATE_PLATFORM: "gitlab" };
    expect(selectToken(gl, "gitlab", env)).toMatchObject({
      envVar: "RENOVATE_TOKEN",
      triedVars: ["RENOVATE_TOKEN", "GITLAB_TOKEN"],
    });
    expect(selectToken(selfGl, "gitlab", { ...selfHome, GITLAB_TOKEN: "plat", RENOVATE_TOKEN: "rnv" }).envVar).toBe(
      "RENOVATE_TOKEN",
    );
  });

  it("RENOVATE_ENDPOINT of the home platform moves the binding to the endpoint host", () => {
    const env = { ...selfHome, GITLAB_TOKEN: "plat" };
    expect(selectToken(selfGl, "gitlab", env).envVar).toBe("GITLAB_TOKEN");
    expect(selectToken(gl, "gitlab", env).token).toBeUndefined();
  });

  it("an endpoint of another platform leaves the public binding alone", () => {
    const env = { GITLAB_TOKEN: "plat", RENOVATE_PLATFORM: "github", RENOVATE_ENDPOINT: "https://ghe.example.com/api/v3" };
    expect(selectToken(gl, "gitlab", env).envVar).toBe("GITLAB_TOKEN");
    expect(selectToken(selfGl, "gitlab", env).token).toBeUndefined();
  });

  it("an unparseable RENOVATE_ENDPOINT binds the home platform's tokens nowhere", () => {
    const env = { GITLAB_TOKEN: "plat", RENOVATE_TOKEN: "rnv", RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "::" };
    expect(selectToken(gl, "gitlab", env)).toEqual({ envVar: null, token: undefined, triedVars: [] });
  });

  it("bare-host binding matches subdomains but not look-alikes", () => {
    const env = { BITBUCKET_TOKEN: "bb" };
    expect(selectToken("https://api.bitbucket.org/2.0/x", "bitbucket", env).envVar).toBe("BITBUCKET_TOKEN");
    expect(selectToken("https://evilgitlab.com/api/v4", "gitlab", { GITLAB_TOKEN: "x" }).token).toBeUndefined();
  });

  it.each([
    ["a trailing dot", "https://gitlab.com./api/v4/x"],
    ["a look-alike suffix", "https://gitlab.com.evil.example/api/v4/x"],
    ["a look-alike prefix", "https://notgitlab.com/api/v4/x"],
    ["userinfo that names the host", "https://gitlab.com@evil.example/api/v4/x"],
  ])("sends no token to %s", (_name, url) => {
    expect(selectToken(url, "gitlab", { GITLAB_TOKEN: "x", RENOVATE_TOKEN: "r", RENOVATE_PLATFORM: "gitlab" }).token).toBeUndefined();
  });

  it("matches the bound host case-insensitively and on any port, like Renovate's hostname match", () => {
    const env = { GITLAB_TOKEN: "x" };
    expect(selectToken("https://GitLab.COM:443/api/v4/x", "gitlab", env).envVar).toBe("GITLAB_TOKEN");
    expect(selectToken("https://gitlab.com:8443/api/v4/x", "gitlab", env).envVar).toBe("GITLAB_TOKEN");
    expect(selectToken("https://user@gitlab.com/api/v4/x", "gitlab", env).envVar).toBe("GITLAB_TOKEN");
  });

  it("RENOVATE_TOKEN binds to the env home only", () => {
    const env = { RENOVATE_TOKEN: "rnv" };
    expect(selectToken(gl, "gitlab", { ...env, RENOVATE_PLATFORM: "gitlab" })).toMatchObject({
      envVar: "RENOVATE_TOKEN",
      token: "rnv",
    });
    expect(selectToken(gl, "gitlab", { ...env, RENOVATE_PLATFORM: "github" }).token).toBeUndefined();
    expect(selectToken(selfGl, "gitlab", { ...env, ...selfHome }).envVar).toBe("RENOVATE_TOKEN");
  });

  it("no env home means RENOVATE_TOKEN is never used, and no endpoint gets a platform token", () => {
    const env = { RENOVATE_TOKEN: "rnv", GITLAB_TOKEN: "plat" };
    expect(selectToken(gl, "gitlab", { RENOVATE_TOKEN: "rnv" })).toEqual({
      envVar: null,
      token: undefined,
      triedVars: ["GITLAB_TOKEN"],
    });
    // RENOVATE_ENDPOINT without RENOVATE_PLATFORM is no home either.
    const withEndpoint = { ...env, RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4" };
    expect(selectToken(selfGl, "gitlab", withEndpoint).token).toBeUndefined();
  });

  it("treats empty values as unset", () => {
    const env = { GITHUB_COM_TOKEN: "", GITHUB_TOKEN: "", RENOVATE_TOKEN: "rnv", RENOVATE_PLATFORM: "github" };
    expect(selectToken(gh, "github", env).envVar).toBe("RENOVATE_TOKEN");
  });

  it("returns no credential for an unparseable URL", () => {
    expect(selectToken("::", "github", { RENOVATE_TOKEN: "x", RENOVATE_PLATFORM: "github" })).toEqual({
      envVar: null,
      token: undefined,
      triedVars: [],
    });
  });

  it("defaults to process.env", () => {
    expect(selectToken("::", "github").triedVars).toEqual([]);
  });
});

describe("buildHostTokenRules", () => {
  it("binds each set per-platform token to its bare host and adds host-token entries last", () => {
    const env = {
      GITHUB_TOKEN: "gh",
      GITLAB_TOKEN: "gl",
      GITHUB_COM_TOKEN: "com",
      RENOVATE_PLATFORM: "gitlab",
      RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4",
      ...hostTokens([{ matchHost: "registry.example.com", hostType: "npm", tokenEnv: "NPM_X" }]),
      NPM_X: "npm",
    };
    const out = buildHostTokenRules(env);
    // GITHUB_COM_TOKEN is not written: Renovate turns it into its own rule from env.
    expect(out).toEqual({
      rules: [
        { hostType: "github", matchHost: "github.com", token: "gh" },
        { hostType: "gitlab", matchHost: "gitlab.example.com", token: "gl" },
        { hostType: "npm", matchHost: "registry.example.com", token: "npm" },
      ],
      secrets: ["gh", "gl", "npm"],
      warnings: [],
    });
  });

  it("puts RENOVATE_TOKEN on the env home host ahead of the home platform's own token", () => {
    expect(buildHostTokenRules({ RENOVATE_PLATFORM: "gitea", RENOVATE_TOKEN: "rnv" })).toMatchObject({
      rules: [{ hostType: "gitea", matchHost: "gitea.com", token: "rnv" }],
      secrets: ["rnv"],
    });
    expect(
      buildHostTokenRules({ RENOVATE_PLATFORM: "gitea", RENOVATE_TOKEN: "rnv", GITEA_TOKEN: "own" }).rules,
    ).toEqual([{ hostType: "gitea", matchHost: "gitea.com", token: "rnv" }]);
  });

  it("emits no RENOVATE_TOKEN rule without an env home", () => {
    expect(buildHostTokenRules({ RENOVATE_TOKEN: "rnv" }).rules).toEqual([]);
    expect(
      buildHostTokenRules({ RENOVATE_TOKEN: "rnv", RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4" }).rules,
    ).toEqual([]);
  });

  it("skips a platform token whose binding host cannot be derived", () => {
    expect(
      buildHostTokenRules({ RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "::", GITLAB_TOKEN: "gl" }).rules,
    ).toEqual([]);
  });

  it("leaves out rules whose hostType and matchHost are already covered", () => {
    const env = {
      GITHUB_TOKEN: "gh",
      GITLAB_TOKEN: "gl",
      ...hostTokens([{ matchHost: "registry.example.com", hostType: "npm", tokenEnv: "NPM_X" }]),
      NPM_X: "npm",
    };
    const out = buildHostTokenRules(env, [
      { hostType: "gitlab", matchHost: "gitlab.com" },
      { hostType: "npm", matchHost: "registry.example.com" },
      { hostType: "github", matchHost: "api.github.com" },
    ]);
    expect(out.rules).toEqual([{ hostType: "github", matchHost: "github.com", token: "gh" }]);
    expect(out.secrets).toEqual(["gh"]);
  });

  it("leaves out an env rule that would outrank or tie-beat a covering rule in Renovate's find()", () => {
    const env = { GITHUB_TOKEN: "gh", GITLAB_TOKEN: "gl", GITEA_TOKEN: "gt" };
    const left = (covered: Array<{ hostType?: string; matchHost?: string }>) =>
      buildHostTokenRules(env, covered).rules.map((r) => r.hostType);
    // No hostType: rank 2 against the env rule's 3, on the same host, a subdomain or a parent domain.
    expect(left([{ matchHost: "github.com" }])).toEqual(["gitlab", "gitea"]);
    expect(left([{ matchHost: "api.github.com" }])).toEqual(["gitlab", "gitea"]);
    expect(left([{ matchHost: "https://gitlab.com/api/v4/" }])).toEqual(["github", "gitea"]);
    // No matchHost: rank 1, covers every host of its hostType.
    expect(left([{ hostType: "gitea" }])).toEqual(["github", "gitlab"]);
    // Both, on a parent domain: the env rule's longer matchHost would win the tie.
    expect(left([{ hostType: "github", matchHost: "com" }])).toEqual(["gitlab", "gitea"]);
    // Both, on a subdomain: the covering rule is longer and wins without help.
    expect(left([{ hostType: "github", matchHost: "api.github.com" }])).toEqual(["github", "gitlab", "gitea"]);
    // Another hostType or an unrelated host covers nothing.
    expect(left([{ hostType: "npm", matchHost: "github.com" }, { matchHost: "example.com" }])).toEqual(["github", "gitlab", "gitea"]);
  });

  it("deduplicates secrets", () => {
    const env = { GITHUB_TOKEN: "same", GITLAB_TOKEN: "same" };
    expect(buildHostTokenRules(env).secrets).toEqual(["same"]);
  });

  it("skips an entry whose env var is unset, with a warning naming the var but no value", () => {
    const env = hostTokens([{ matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ACME_GL" }]);
    const out = buildHostTokenRules(env);
    expect(out.rules).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/ACME_GL/);
    expect(out.warnings[0]).toMatch(/gitlab\.example\.com/);
  });

  it("returns the parse error and no rules for a malformed var", () => {
    const out = buildHostTokenRules({ [HOST_TOKENS_ENV]: "[1]", GITHUB_TOKEN: "gh" });
    expect(out.rules).toEqual([]);
    expect(out.secrets).toEqual([]);
    expect(out.error).toMatch(/\[0\] must be an object/);
  });

  it("defaults to process.env", () => {
    expect(buildHostTokenRules().error).toBeUndefined();
  });
});

describe("tokenHost (where the env rule for a platform is bound)", () => {
  it("is the public host, or the env endpoint's host for the env home platform", () => {
    expect(tokenHost("github", {})).toBe("github.com");
    expect(tokenHost("gitlab", { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4" })).toBe(
      "gitlab.example.com",
    );
    expect(tokenHost("github", { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4" })).toBe(
      "github.com",
    );
    expect(tokenHost("gitlab", { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "::" })).toBeUndefined();
  });

  it("defaults to process.env", () => {
    expect(typeof tokenHost("bitbucket")).toBe("string");
  });
});
