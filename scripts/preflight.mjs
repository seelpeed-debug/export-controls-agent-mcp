#!/usr/bin/env node
// Pre-push checks for this repository.
//
// Every check here exists because the corresponding mistake actually happened
// during development, not because it seemed like a good idea:
//
//   credentials   a law.go.kr account id survived in verify/run-verification.mjs
//                 as a default value, in a file that was about to be committed
//   large blobs   the 32 MB raw Consolidated Screening List download got staged
//   placeholders  a literal "<사용자명>" ended up as the git remote URL
//   data vintage  a "Refresh regulation snapshots" commit changed nothing but a
//                 timestamp, which erodes the audit value of the history
//
// Usage:  node scripts/preflight.mjs [--fix-hint]
// Exit code 0 means safe to push.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

let failures = 0;
let warnings = 0;

const pass = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg, hint) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
  if (hint) console.log(`        -> ${hint}`);
};
const warn = (msg, hint) => {
  warnings++;
  console.log(`  warn  ${msg}`);
  if (hint) console.log(`        -> ${hint}`);
};
const section = (name) => console.log(`\n${name}`);

const git = (cmd, allowFail = false) => {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
};

// ---------------------------------------------------------------------------
section("1. repository state");
// ---------------------------------------------------------------------------
const branch = git("rev-parse --abbrev-ref HEAD");
if (branch === "main") pass(`on branch ${branch}`);
else warn(`on branch ${branch}, not main`, "confirm this is intended before pushing");

const remote = git("remote get-url origin", true);
if (!remote) {
  fail("no origin remote configured", 'git remote add origin https://github.com/<user>/<repo>.git');
} else if (/[<>]|사용자명|your-username|YOUR/.test(remote)) {
  fail(`origin URL still contains a placeholder: ${remote}`, "git remote set-url origin <real URL>");
} else {
  pass(`origin: ${remote}`);
}

// ---------------------------------------------------------------------------
section("2. credentials and secrets in tracked content");
// ---------------------------------------------------------------------------
// Deliberately narrow: match assignments of real-looking values, not the mere
// mention of an env var name, so the check stays useful instead of noisy.
const SECRET_PATTERNS = [
  ["hardcoded LAW_OC default", String.raw`LAW_OC\s*\?\?\s*["'][A-Za-z0-9._-]{3,}["']`],
  ["hardcoded api key", String.raw`(api[_-]?key|apiKey|subscription-key)\s*[:=]\s*["'][A-Za-z0-9._-]{8,}["']`],
  ["AWS access key", String.raw`AKIA[0-9A-Z]{16}`],
  ["GitHub token", String.raw`gh[pousr]_[A-Za-z0-9]{20,}`],
  ["private key block", String.raw`BEGIN [A-Z ]*PRIVATE KEY`],
  ["bearer token", String.raw`Bearer\s+[A-Za-z0-9._-]{20,}`]
];
let secretHits = 0;
for (const [label, pattern] of SECRET_PATTERNS) {
  const out = git(`grep -n -I -E "${pattern}" -- ":!package-lock.json"`, true);
  if (out) {
    secretHits++;
    fail(`${label} found in tracked files:`);
    for (const line of out.split("\n").slice(0, 5)) console.log(`          ${line}`);
  }
}
if (secretHits === 0) pass("no credential patterns in tracked files");

// The local agent settings file has held a LAW_OC value inline before.
if (existsSync(".claude/settings.local.json")) {
  const ignored = git("check-ignore .claude/settings.local.json", true);
  if (ignored) pass(".claude/settings.local.json exists but is ignored");
  else fail(".claude/settings.local.json is NOT ignored", "add .claude/ to .gitignore");
}

// ---------------------------------------------------------------------------
section("3. staged and tracked file sizes");
// ---------------------------------------------------------------------------
const LARGE_FILE_KB = 2048;
const tracked = git("ls-files").split("\n").filter(Boolean);
const big = tracked
  .filter((f) => existsSync(f))
  .map((f) => ({ f, kb: statSync(f).size / 1024 }))
  .filter((x) => x.kb > LARGE_FILE_KB)
  .sort((a, b) => b.kb - a.kb);
if (big.length === 0) {
  pass(`no tracked file over ${LARGE_FILE_KB} KB`);
} else {
  for (const { f, kb } of big) {
    // src/data snapshots are expected to be large and are required at runtime.
    if (f.startsWith("src/data/")) warn(`${f} is ${kb.toFixed(0)} KB (expected: runtime snapshot)`);
    else fail(`${f} is ${kb.toFixed(0)} KB`, "raw source downloads belong in verify/ and .gitignore");
  }
}

// Raw caches that must never be tracked.
for (const forbidden of ["verify/csl-raw.json", "verify/part734.xml", "verify/part740.xml", "verify/part744.xml", "verify/part774.xml"]) {
  const isTracked = tracked.includes(forbidden);
  if (isTracked) fail(`${forbidden} is tracked`, `git rm --cached ${forbidden}`);
}

// ---------------------------------------------------------------------------
section("4. runtime data present and required by the server");
// ---------------------------------------------------------------------------
const REQUIRED_DATA = [
  "src/data/country-groups.json",
  "src/data/country-chart.json",
  "src/data/license-exception-catalog.json",
  "src/data/ccl.json",
  "src/data/screening-list.json",
  "src/data/korean-law.json",
  "src/data/fdp-rules.js"
];
const missing = REQUIRED_DATA.filter((f) => !tracked.includes(f));
if (missing.length) {
  fail(`runtime data not tracked: ${missing.join(", ")}`, "a fresh clone will not start without these");
} else {
  pass(`all ${REQUIRED_DATA.length} runtime data files tracked`);
}

// ---------------------------------------------------------------------------
section("5. regulation snapshot vintage");
// ---------------------------------------------------------------------------
const SCREENING_STALE_DAYS = 7;
const OTHER_STALE_DAYS = 30;
const vintages = [
  ["src/data/country-groups.json", OTHER_STALE_DAYS],
  ["src/data/country-chart.json", OTHER_STALE_DAYS],
  ["src/data/license-exception-catalog.json", OTHER_STALE_DAYS],
  ["src/data/ccl.json", OTHER_STALE_DAYS],
  ["src/data/screening-list.json", SCREENING_STALE_DAYS],
  ["src/data/korean-law.json", OTHER_STALE_DAYS]
];
for (const [file, threshold] of vintages) {
  if (!existsSync(file)) continue;
  const d = JSON.parse(readFileSync(file, "utf8"));
  const age = d.retrievedAt ? Math.floor((Date.now() - Date.parse(d.retrievedAt)) / 86_400_000) : null;
  const label = `${path.basename(file)} (${d.ecfrIssueDate ?? d.sourceGeneratedAt?.slice(0, 10) ?? "no issue date"})`;
  if (age === null) warn(`${label}: no retrievedAt`);
  else if (age > threshold) {
    warn(`${label}: ${age} days old, threshold ${threshold}`, "npm run data:rebuild");
  } else pass(`${label}: ${age} days old`);
}

// A commit that touches src/data but changes nothing substantive is noise.
const stagedData = git("diff --cached --name-only -- src/data", true)
  .split("\n")
  .filter(Boolean);
if (stagedData.length) {
  warn(
    `${stagedData.length} snapshot file(s) staged: ${stagedData.join(", ")}`,
    "confirm the regulation actually changed. The builders skip writing when only retrievedAt would move, so a staged snapshot should mean real movement."
  );
}

// ---------------------------------------------------------------------------
section("6. tests and validators");
// ---------------------------------------------------------------------------
for (const [label, cmd] of [
  ["npm test", "npm test"],
  ["npm run validate", "npm run validate"]
]) {
  try {
    execSync(cmd, { stdio: "ignore" });
    pass(`${label} passes`);
  } catch (e) {
    fail(`${label} failed (exit ${e.status})`, `run "${cmd}" to see the failures`);
  }
}

// ---------------------------------------------------------------------------
section("7. server starts and advertises its tools");
// ---------------------------------------------------------------------------
try {
  execSync("node verify/run-verification.mjs", { stdio: "ignore" });
  const report = JSON.parse(readFileSync("verify/verification-report.json", "utf8"));
  const calls = report.filter((e) => e.section === "tools/call");
  const bad = calls.filter((e) => /FAIL/.test(e.verdict ?? ""));
  const tools = report.find((e) => e.section === "tools/list");
  if (bad.length) fail(`${bad.length} of ${calls.length} MCP calls failed`);
  else pass(`${calls.length} MCP calls, 0 failures, ${tools.count} tools advertised`);
} catch (e) {
  fail("MCP harness did not complete", "node verify/run-verification.mjs");
}

// ---------------------------------------------------------------------------
console.log(
  `\n${failures === 0 ? "PREFLIGHT PASSED" : `PREFLIGHT FAILED: ${failures} blocking issue(s)`}` +
    `${warnings ? `, ${warnings} warning(s)` : ""}`
);
if (failures === 0) {
  console.log("\nSafe to push:");
  console.log("  git add -A");
  console.log('  git commit -m "<what changed and why>"');
  console.log("  git push");
}
process.exitCode = failures === 0 ? 0 : 1;
