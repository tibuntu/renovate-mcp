/**
 * SYNTHETIC bot-log fixture. Hand-written, NOT captured from a real run: the
 * line envelope (name/hostname/pid/level/logContext/repository/msg/time/v) is
 * copied from a real `LOG_FORMAT=json LOG_LEVEL=debug` local run, and the two
 * payloads follow Renovate's code (`lookup()` in process/extract-update.js for
 * `packageFiles with updates`; `filterDependencyDashboardData` in
 * finalize/repository-statistics.js for `branches info extended`, whose
 * upgrades carry no `manager`; `BranchResult` / `PrBlockedBy` in
 * workers/types.d.ts for `result` / `prBlockedBy`). The captured counterpart
 * is `test/fixtures/bot-log-real.jsonl`; this one stays for cases that need to
 * vary the payloads.
 */

export const REPO = "example/repo";

function line(msg: string, body: Record<string, unknown>, repository: string | undefined = REPO): string {
  return JSON.stringify({
    name: "renovate",
    hostname: "synthetic-host",
    pid: 1,
    level: 20,
    logContext: "synthetic-context",
    ...(repository ? { repository } : {}),
    ...body,
    msg: msg,
    time: "2026-01-01T00:00:00.000Z",
    v: 0,
  });
}

const dep = (depName: string, currentValue: string, newVersion: string, branchName: string) => ({
  depName,
  packageName: depName,
  currentValue,
  currentVersion: currentValue,
  datasource: "npm",
  depType: "dependencies",
  updates: [{ newVersion, newValue: newVersion, updateType: "minor", branchName }],
  warnings: [],
});

export const PACKAGE_FILES = {
  npm: [
    {
      packageFile: "package.json",
      deps: [
        dep("lodash", "4.0.0", "4.17.21", "renovate/lodash-4.x"),
        dep("left-pad", "1.0.0", "1.3.0", "renovate/left-pad-1.x"),
        dep("react", "17.0.0", "18.3.1", "renovate/react-18.x"),
        dep("chalk", "4.0.0", "4.1.2", "renovate/chalk-4.x"),
      ],
    },
  ],
};

const upgrade = (depName: string, newVersion: string, packageFile = "package.json") => ({
  depName,
  packageName: depName,
  datasource: "npm",
  currentValue: "x",
  currentVersion: "x",
  newValue: newVersion,
  newVersion,
  packageFile,
  updateType: "minor",
});

export const BRANCHES = [
  { baseBranch: "main", branchName: "renovate/lodash-4.x", result: "pending", prBlockedBy: "AwaitingTests", upgrades: [upgrade("lodash", "4.17.21")] },
  { baseBranch: "main", branchName: "renovate/left-pad-1.x", result: "pr-limit-reached", prBlockedBy: "RateLimited", upgrades: [upgrade("left-pad", "1.3.0")] },
  { baseBranch: "main", branchName: "renovate/react-18.x", result: "needs-pr-approval", prBlockedBy: "NeedsApproval", upgrades: [upgrade("react", "18.3.1")] },
  { baseBranch: "main", branchName: "renovate/chalk-4.x", prNo: 7, prTitle: "Update chalk", result: "pr-created", upgrades: [upgrade("chalk", "4.1.2")] },
];

/** A well-formed bot log: noise lines, both messages, a non-JSON line. */
export function syntheticLog(opts: { branches?: boolean; packageFiles?: boolean } = {}): string {
  const lines = [
    line("Repository started", { renovateVersion: "0.0.0" }),
    "this line is not JSON (a CI wrapper printed it)",
    line("Extracted dependencies", { baseBranch: "main" }),
  ];
  if (opts.packageFiles !== false) {
    lines.push(line("packageFiles with updates", { baseBranch: "main", config: PACKAGE_FILES }));
  }
  if (opts.branches !== false) {
    lines.push(line("branches info extended", { branchesInformation: BRANCHES }));
  }
  lines.push(line("Repository finished", { durationMs: 1 }));
  return lines.join("\n") + "\n";
}

export { line as logLine };
