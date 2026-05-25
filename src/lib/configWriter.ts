/**
 * Serialization entry point for `write_config`.
 *
 * Per ADR-0002, every Phase 4 write path funnels through `serializeConfig`.
 * This plan (04-01) lands the public surface plus the fresh-write branch only;
 * the round-trip branch is intentionally stubbed and will be implemented by
 * plan 04-02 (jsonc-parser-backed minimal-edit serialization) and 04-03 (the
 * `.json5`-not-JSONC-compatible refusal path).
 *
 * Pure function: no `fs`, no `process`, no I/O. The caller is responsible for
 * reading the existing file off disk and passing the string in (or omitting it
 * when the target file does not yet exist).
 */

export type SerializeArgs = {
  /**
   * The on-disk path the bytes will eventually be written to. Used by the
   * round-trip branch (04-02 / 04-03) to drive extension-based behavior
   * (e.g. detecting `.json5` for the JSONC-compatibility refusal). Unused on
   * the fresh-write path.
   */
  targetPath: string;
  /** The config object the caller wants on disk after the write. */
  nextConfig: Record<string, unknown>;
  /**
   * The current on-disk content of `targetPath`, or `undefined` if the file
   * does not exist yet (fresh-write path).
   */
  existing?: string;
};

export type SerializeOk = {
  mode: "fresh-write" | "round-trip";
  bytes: string;
};

export type SerializeRefusal = {
  refuse: true;
  reason: string;
  hint: string;
};

export type SerializeResult = SerializeOk | SerializeRefusal;

export function serializeConfig(args: SerializeArgs): SerializeResult {
  // Reference targetPath so it is not flagged as unused. The round-trip branch
  // (04-02 / 04-03) consumes it; the fresh-write path does not.
  void args.targetPath;

  if (args.existing === undefined) {
    return {
      mode: "fresh-write",
      // MUST stay byte-identical to the literal expression currently inlined
      // in src/tools/writeConfig.ts (`JSON.stringify(config, null, 2) + "\n"`)
      // — see ADR-0002 and the snapshot test in configWriter.test.ts.
      bytes: JSON.stringify(args.nextConfig, null, 2) + "\n",
    };
  }

  throw new Error("round-trip path not implemented — plan 04-02 wires this");
}
