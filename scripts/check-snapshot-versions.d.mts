// Type declarations for scripts/check-snapshot-versions.mjs.
// The script itself is plain ESM JS so it stays runnable with `node` without
// a compile step. These types let the vitest unit test consume the exports
// under strict TypeScript without an implicit-any error.

export interface SnapshotEntry {
  readonly file: string;
  readonly regenerateCmd: string;
}

export const SNAPSHOTS: readonly SnapshotEntry[];

export function extractRenovateVersion(source: string): string;

export interface CheckInputSnapshot {
  readonly file: string;
  readonly version: string;
  readonly regenerateCmd: string;
}

export interface StaleEntry {
  readonly file: string;
  readonly snapshotVersion: string;
  readonly regenerateCmd: string;
}

export type CheckResult =
  | { ok: true; liveVersion: string }
  | { ok: false; liveVersion: string; stale: StaleEntry[] };

export function checkSnapshotVersions(input: {
  liveVersion: string;
  snapshots: readonly CheckInputSnapshot[];
}): CheckResult;

export function loadSnapshots(
  repoRoot: string,
): Promise<CheckInputSnapshot[]>;

export function readLiveRenovateVersion(repoRoot: string): Promise<string>;

export function main(args: {
  repoRoot: string;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}): Promise<number>;
