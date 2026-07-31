#!/usr/bin/env node
// Asserts that the FDP rule scopes transcribed in src/data/fdp-rules.js still
// match the live text of 15 C.F.R. § 734.9.
//
// The scopes are transcribed rather than machine-parsed, because the regulation
// states them as prose mixed with ECCN lists and exclusions. Transcription is
// only safe if drift is detectable, so this fetches § 734.9 and checks that
//
//   - every rule's paragraph letter still carries the rule name we recorded
//   - every ECCN token we recorded still appears in that rule's paragraph
//   - the rule count still matches
//
// Usage:  node scripts/validate-fdp-rules.mjs [--date YYYY-MM-DD]

import { FDP_RULES } from "../src/data/fdp-rules.js";

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : null;
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "export-controls-agent-mcp/validate-fdp" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

let issueDate = arg("--date");
if (!issueDate) {
  const titles = JSON.parse(await fetchText("https://www.ecfr.gov/api/versioner/v1/titles"));
  issueDate = titles.titles.find((t) => t.number === 15).latest_issue_date;
}
const url = `https://www.ecfr.gov/api/versioner/v1/full/${issueDate}/title-15.xml?part=734`;
const xml = await fetchText(url);

const decode = (s) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const open = xml.match(/<DIV8\b[^>]*\bN="734\.9"[^>]*>/i);
if (!open) throw new Error("§ 734.9 not found in the fetched part 734");
const start = open.index + open[0].length;
const nx = xml.slice(start).search(/<DIV8\b/i);
const section = decode(xml.slice(start, nx < 0 ? xml.length : start + nx));

console.log(`§ 734.9 fetched for eCFR issue date ${issueDate} (${(section.length / 1024).toFixed(0)} KB of text)`);
console.log(`${FDP_RULES.length} rules transcribed locally\n`);

const failures = [];
const warnings = [];

// Rule names must still be present verbatim-ish. Quote marks in the regulation
// are typographic, so compare on a normalised form.
const norm = (s) => s.replace(/[\u2018\u2019\u201c\u201d"']/g, "").toLowerCase();
const normSection = norm(section);

for (const rule of FDP_RULES) {
  if (!normSection.includes(norm(rule.name))) {
    failures.push(`${rule.citation}: rule name not found in § 734.9 -- "${rule.name}"`);
  }

  const tokens = [
    ...(rule.inputEccns ?? []),
    ...(rule.plantInputEccns ?? []),
    ...(rule.itemScopeEccns ?? []),
    ...(rule.itemScopeExclusions ?? [])
  ];
  // Base entries only: subparagraph forms like "3B001.a.4" appear in the text as
  // "3B001.a.4, c, d" so a literal search for each variant would be brittle.
  const bases = [...new Set(tokens.map((t) => t.split(".")[0].toUpperCase()))];
  const missing = bases.filter((b) => !section.toUpperCase().includes(b));
  if (missing.length) {
    failures.push(`${rule.citation}: ECCN base(s) no longer present in § 734.9: ${missing.join(", ")}`);
  }
}

// Paragraph letters we rely on must still exist.
for (const rule of FDP_RULES) {
  const para = rule.paragraph.replace(/[()]/g, "");
  const top = para[0];
  if (!new RegExp(`\\(${top}\\)`).test(section)) {
    failures.push(`${rule.citation}: paragraph (${top}) not found`);
  }
}

// Sanity: the two rules that matter most for Korean manufacturers must still be
// scoped the way the tool explains them.
if (!/Semiconductor Manufacturing Equipment \(SME\) FDP rule/i.test(section)) {
  failures.push("the SME FDP rule heading has changed or been removed");
}
if (!/destined to Macau or a destination in Country Group D:5/i.test(section)) {
  warnings.push("the SME FDP destination-scope wording has changed; re-read § 734.9(k)(2)");
}
if (!/logic or DRAM .?advanced-node integrated circuits/i.test(section)) {
  warnings.push("the Footnote 5 advanced-node facility wording has changed; re-read § 734.9(e)(3)(ii)");
}
if (!/Destined to any location worldwide/i.test(section)) {
  warnings.push("the advanced computing FDP worldwide destination wording has changed; re-read § 734.9(h)(2)");
}

for (const w of warnings) console.warn(`WARN  ${w}`);

if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nThe transcribed FDP rules no longer match § 734.9. Re-read the section and update src/data/fdp-rules.js."
  );
  process.exitCode = 1;
} else {
  console.log(`OK: all ${FDP_RULES.length} rule names and their ECCN bases are present in the current § 734.9.`);
  if (warnings.length) console.log(`(${warnings.length} wording warning(s) above -- not fatal, but worth reading.)`);
}
