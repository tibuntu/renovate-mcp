#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const pkgPath = resolve(repoRoot, "package.json");
const renovatePkgPath = resolve(repoRoot, "node_modules/renovate/package.json");

const renovatePkg = JSON.parse(readFileSync(renovatePkgPath, "utf8"));
const upstream = renovatePkg.dependencies?.jsonata;
if (!upstream) {
  console.error("renovate package has no jsonata dependency — aborting sync");
  process.exit(1);
}

const raw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(raw);
const current = pkg.dependencies?.jsonata;
if (current === upstream) {
  console.log(`jsonata pin already matches renovate (${upstream})`);
  process.exit(0);
}

const updated = raw.replace(
  /("jsonata":\s*)"[^"]+"/,
  `$1"${upstream}"`,
);
if (updated === raw) {
  console.error("failed to rewrite jsonata pin in package.json");
  process.exit(1);
}
writeFileSync(pkgPath, updated);
console.log(`jsonata pin: ${current} -> ${upstream}`);
