import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  tokenize,
  buildCorpus,
  rankCorpus,
  coverageOf,
  indexLocalPresets,
  detectFacets,
  assembleDraft,
  suggestPresets,
  type CorpusPreset,
} from "../../src/lib/presetSuggester.js";
import { PRESETS } from "../../src/data/presets.generated.js";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric boundaries", () => {
    expect(tokenize("Group dev-dependencies, please")).toEqual(
      expect.arrayContaining(["group", "dev", "dependencies"]),
    );
  });

  it("splits camelCase identifiers into words", () => {
    expect(tokenize("automergeMinor")).toEqual(["automerge", "minor"]);
  });

  it("drops short tokens and common stopwords", () => {
    const tokens = tokenize("I want to automerge all of the patch updates");
    expect(tokens).not.toContain("i");
    expect(tokens).not.toContain("to");
    expect(tokens).not.toContain("of");
    expect(tokens).not.toContain("the");
    expect(tokens).toContain("automerge");
    expect(tokens).toContain("patch");
  });
});

describe("rankCorpus", () => {
  // A synthetic corpus where "group" is ubiquitous (the real-world flood risk)
  // but "dev"/"dependencies" are rare — IDF must let the specific preset win.
  const presets: CorpusPreset[] = [
    {
      name: "group:devDependencies",
      namespace: "group",
      description: "Group all devDependencies together",
      body: { packageRules: [{ matchDepTypes: ["devDependencies"], groupName: "dev" }] },
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      name: `group:thing${i}Monorepo`,
      namespace: "group",
      description: "Group a monorepo's packages",
      body: { packageRules: [{ groupName: `thing${i}` }] },
    })),
    {
      name: "schedule:weekly",
      namespace: "schedule",
      description: "Schedule on the weekend",
      body: { schedule: ["every weekend"] },
    },
  ];
  const corpus = buildCorpus(presets);

  it("ranks the specific match above ubiquitous-token-only matches (IDF anti-flood)", () => {
    const ranked = rankCorpus("group dev dependencies", corpus, { limit: 50, minScore: 0 });
    expect(ranked[0]?.name).toBe("group:devDependencies");
    const specific = ranked.find((r) => r.name === "group:devDependencies")!;
    const monorepo = ranked.find((r) => r.name.endsWith("Monorepo"))!;
    expect(specific.score).toBeGreaterThan(monorepo.score);
  });

  it("is deterministic — identical input yields identical ordering and scores", () => {
    const a = rankCorpus("group dev dependencies", corpus, { limit: 10 });
    const b = rankCorpus("group dev dependencies", corpus, { limit: 10 });
    expect(a).toEqual(b);
  });

  it("breaks score ties by name ascending", () => {
    const ranked = rankCorpus("monorepo", corpus, { limit: 50, minScore: 0 });
    const monorepos = ranked.filter((r) => r.name.endsWith("Monorepo")).map((r) => r.name);
    expect(monorepos).toEqual([...monorepos].sort());
  });

  it("honors the namespace filter", () => {
    const ranked = rankCorpus("group weekend schedule", corpus, {
      namespace: "schedule",
      minScore: 0,
      limit: 50,
    });
    expect(ranked.every((r) => r.namespace === "schedule")).toBe(true);
    expect(ranked.some((r) => r.name === "schedule:weekly")).toBe(true);
  });

  it("caps results at limit", () => {
    const ranked = rankCorpus("group", corpus, { limit: 3, minScore: 0 });
    expect(ranked.length).toBe(3);
  });

  it("filters out matches below minScore", () => {
    const ranked = rankCorpus("group dev dependencies", corpus, { limit: 50, minScore: 0.5 });
    expect(ranked.every((r) => r.score >= 0.5)).toBe(true);
    expect(ranked.some((r) => r.name === "group:devDependencies")).toBe(true);
    expect(ranked.some((r) => r.name.endsWith("Monorepo"))).toBe(false);
  });

  it("records which fields matched in matchedOn", () => {
    const ranked = rankCorpus("devDependencies", corpus, { minScore: 0, limit: 50 });
    const hit = ranked.find((r) => r.name === "group:devDependencies")!;
    expect(hit.matchedOn).toContain("name");
  });

  it("omits body unless includeBody is set", () => {
    const without = rankCorpus("devDependencies", corpus, { minScore: 0, limit: 1 });
    expect(without[0]?.body).toBeUndefined();
    const withBody = rankCorpus("devDependencies", corpus, {
      minScore: 0,
      limit: 1,
      includeBody: true,
    });
    expect(withBody[0]?.body).toBeDefined();
  });
});

describe("coverageOf", () => {
  it("classifies high scores as strong", () => {
    expect(coverageOf(0.9)).toBe("strong");
    expect(coverageOf(0.6)).toBe("strong");
  });
  it("classifies mid scores as partial", () => {
    expect(coverageOf(0.59)).toBe("partial");
    expect(coverageOf(0.3)).toBe("partial");
  });
  it("classifies low scores as weak", () => {
    expect(coverageOf(0.29)).toBe("weak");
    expect(coverageOf(0)).toBe("weak");
  });
});

describe("indexLocalPresets", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), `rmcp-suggester-${process.pid}-`));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("indexes flat *.json presets, deriving name from the filename and namespace 'local'", async () => {
    await writeFile(path.join(dir, "automerge.json"), JSON.stringify({ description: "top desc" }));
    const { presets } = await indexLocalPresets(dir);
    const p = presets.find((x) => x.name === "automerge")!;
    expect(p).toBeDefined();
    expect(p.namespace).toBe("local");
    expect(p.description).toBe("top desc");
    expect(p.file).toBe("automerge.json");
  });

  it("falls back to the first packageRules[].description when no top-level description", async () => {
    await writeFile(
      path.join(dir, "groupDev.json"),
      JSON.stringify({ packageRules: [{ description: "rule desc", groupName: "dev" }] }),
    );
    const { presets } = await indexLocalPresets(dir);
    expect(presets.find((x) => x.name === "groupDev")!.description).toBe("rule desc");
  });

  it("uses null description when neither is present", async () => {
    await writeFile(path.join(dir, "base.json"), JSON.stringify({ extends: ["config:recommended"] }));
    const { presets } = await indexLocalPresets(dir);
    expect(presets.find((x) => x.name === "base")!.description).toBeNull();
  });

  it("indexes presets containing {{argN}} Handlebars params without error", async () => {
    await writeFile(
      path.join(dir, "semanticCommitType.json"),
      JSON.stringify({ packageRules: [{ matchPackageNames: ["{{arg0}}"], semanticCommitType: "{{arg1}}" }] }),
    );
    const { presets, warnings } = await indexLocalPresets(dir);
    expect(presets.find((x) => x.name === "semanticCommitType")).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it("warns on a malformed JSON file instead of crashing", async () => {
    await writeFile(path.join(dir, "good.json"), JSON.stringify({ description: "ok" }));
    await writeFile(path.join(dir, "broken.json"), "{ not valid json ");
    const { presets, warnings } = await indexLocalPresets(dir);
    expect(presets.find((x) => x.name === "good")).toBeDefined();
    expect(presets.find((x) => x.name === "broken")).toBeUndefined();
    expect(warnings.some((w) => w.includes("broken.json"))).toBe(true);
  });

  it("ignores non-preset files", async () => {
    await writeFile(path.join(dir, "renovate.json"), JSON.stringify({ description: "x" }));
    await writeFile(path.join(dir, "README.md"), "# presets");
    await mkdir(path.join(dir, "subdir"));
    const { presets } = await indexLocalPresets(dir);
    expect(presets.map((p) => p.name)).toEqual(["renovate"]);
  });

  it("caps the number of indexed presets and warns", async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(dir, `p${i}.json`), JSON.stringify({ description: `p${i}` }));
    }
    const { presets, warnings } = await indexLocalPresets(dir, { maxPresetsIndexed: 4 });
    expect(presets.length).toBe(4);
    expect(warnings.some((w) => /cap/i.test(w))).toBe(true);
  });

  it("rejects when the path does not exist", async () => {
    await expect(indexLocalPresets(path.join(dir, "does-not-exist"))).rejects.toThrow();
  });
});

// Maps a draft `extends` reference to its PRESETS catalogue key:
// the `:foo` shorthand resolves to `default:foo`.
function presetKey(ref: string): string {
  return ref.startsWith(":") ? `default${ref}` : ref;
}

describe("detectFacets", () => {
  it("detects multiple facets in one intent", () => {
    const ids = detectFacets("automerge patch and minor updates, group my dev dependencies").map(
      (f) => f.id,
    );
    expect(ids).toContain("automerge");
    expect(ids).toContain("groupDevDeps");
  });

  it("detects no facets for an unrelated query", () => {
    expect(detectFacets("purple elephant dancing")).toEqual([]);
  });
});

describe("assembleDraft", () => {
  it("marks the draft unvalidated with a validate/lint hint", () => {
    const draft = assembleDraft("automerge minor updates");
    expect(draft.unvalidated).toBe(true);
    expect(draft.hint).toMatch(/validate_config/);
    expect(draft.hint).toMatch(/lint_config/);
  });

  it("recommends :automergeMinor for an automerge-minor intent", () => {
    const draft = assembleDraft("automerge minor and patch updates");
    expect(draft.config.extends).toContain(":automergeMinor");
    expect(draft.facets).toContain("automerge");
  });

  it("contributes a packageRules entry for grouping dev dependencies", () => {
    const draft = assembleDraft("group my dev dependencies together");
    const rules = draft.config.packageRules as Array<Record<string, unknown>>;
    expect(rules.some((r) => Array.isArray(r.matchDepTypes) && (r.matchDepTypes as string[]).includes("devDependencies"))).toBe(true);
  });

  it("sets a top-level key for semantic commits", () => {
    const draft = assembleDraft("use semantic commit messages");
    expect(draft.config.semanticCommits).toBe("enabled");
  });

  it("merges multiple facets into one draft", () => {
    const draft = assembleDraft("automerge minor updates and group dev dependencies");
    expect(draft.config.extends).toContain(":automergeMinor");
    expect(draft.config.packageRules).toBeDefined();
    expect(draft.facets.length).toBeGreaterThanOrEqual(2);
  });

  it("returns an empty config with an explanatory note when no facet matches", () => {
    const draft = assembleDraft("purple elephant dancing");
    expect(draft.facets).toEqual([]);
    expect(draft.config).toEqual({});
    expect(draft.notes.join(" ")).toMatch(/describe/i);
  });

  it("every facet recommends only presets that exist in the catalogue (drift guard)", () => {
    const triggeringQueries = [
      "automerge all updates",
      "automerge major updates",
      "automerge minor updates",
      "automerge patch updates",
      "automerge updates",
      "group dev dependencies",
      "group non-major updates",
      "group monorepo packages",
      "schedule weekly",
      "schedule monthly",
      "run during non-office hours",
      "pin github action digests",
      "pin docker image digests",
      "pin digests",
      "semantic commit messages",
      "disable major updates",
      "separate major releases",
      "lockfile maintenance",
      "add labels to prs",
    ];
    for (const q of triggeringQueries) {
      const draft = assembleDraft(q);
      const refs = (draft.config.extends as string[] | undefined) ?? [];
      for (const ref of refs) {
        expect(PRESETS[presetKey(ref)], `${q} → ${ref}`).toBeDefined();
      }
    }
  });
});

describe("facet edge cases (review feedback)", () => {
  it("does not map 'during office hours' to schedule:nonOfficeHours (reversed semantics)", () => {
    const draft = assembleDraft("run renovate during office hours");
    expect((draft.config.extends as string[] | undefined) ?? []).not.toContain(
      "schedule:nonOfficeHours",
    );
  });

  it("does not map 'business hours' to schedule:nonOfficeHours (reversed semantics)", () => {
    const draft = assembleDraft("only update during business hours please");
    expect((draft.config.extends as string[] | undefined) ?? []).not.toContain(
      "schedule:nonOfficeHours",
    );
  });

  it("maps clearly-outside-work phrasings to schedule:nonOfficeHours", () => {
    for (const q of [
      "run outside office hours",
      "schedule during non-office hours",
      "update after hours",
      "off hours only",
    ]) {
      expect((assembleDraft(q).config.extends as string[] | undefined) ?? [], q).toContain(
        "schedule:nonOfficeHours",
      );
    }
  });

  it("does not fire groupDevDeps for 'development'/'devops' without dependency intent", () => {
    expect(detectFacets("group package updates for our development workflow").map((f) => f.id)).not.toContain(
      "groupDevDeps",
    );
    expect(detectFacets("group our devops tooling updates").map((f) => f.id)).not.toContain(
      "groupDevDeps",
    );
  });

  it("still fires groupDevDeps for genuine dev-dependency phrasings", () => {
    for (const q of [
      "group my dev dependencies",
      "combine devDependencies into one PR",
      "batch dev deps together",
    ]) {
      expect(detectFacets(q).map((f) => f.id), q).toContain("groupDevDeps");
    }
  });

  it("notes the disable/separate-major contradiction when both facets fire", () => {
    const draft = assembleDraft("separate and disable major updates");
    expect(draft.facets).toEqual(expect.arrayContaining(["disableMajor", "separateMajor"]));
    expect(draft.notes.join(" ")).toMatch(/conflict/i);
  });
});

describe("suggestPresets", () => {
  it("returns strong coverage and no draft for a clearly-covered intent", async () => {
    const result = await suggestPresets("automerge minor updates");
    expect(result.coverage).toBe("strong");
    expect(result.builtIn[0]?.name).toBe("default:automergeMinor");
    expect(result.draft).toBeUndefined();
  });

  it("returns a draft skeleton when coverage is weak", async () => {
    const result = await suggestPresets("purple elephant dancing");
    expect(result.coverage).toBe("weak");
    expect(result.draft).toBeDefined();
  });

  it("emits a composed draft for a multi-facet intent even if a single facet is well-covered", async () => {
    const result = await suggestPresets("automerge minor updates and group dev dependencies");
    expect(result.draft).toBeDefined();
    expect(result.draft!.facets.length).toBeGreaterThanOrEqual(2);
    expect(result.draft!.config.extends).toContain(":automergeMinor");
  });

  it("suppresses the draft when includeDraft is false even on weak coverage", async () => {
    const result = await suggestPresets("purple elephant dancing", { includeDraft: false });
    expect(result.draft).toBeUndefined();
  });

  it("indexes a local presets repo into the local array", async () => {
    const localDir = await mkdtemp(path.join(tmpdir(), `rmcp-suggester-local-${process.pid}-`));
    try {
      await writeFile(
        path.join(localDir, "groupDevDependencies.json"),
        JSON.stringify({
          packageRules: [{ matchDepTypes: ["devDependencies"], groupName: "dev dependencies" }],
        }),
      );
      const result = await suggestPresets("group dev dependencies", { presetsPath: localDir });
      expect(result.local.some((m) => m.name === "groupDevDependencies")).toBe(true);
    } finally {
      await rm(localDir, { recursive: true, force: true });
    }
  });

  it("propagates an error when presetsPath does not exist", async () => {
    await expect(
      suggestPresets("anything", { presetsPath: "/no/such/presets/dir/at/all" }),
    ).rejects.toThrow();
  });
});
