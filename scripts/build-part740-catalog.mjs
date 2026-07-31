#!/usr/bin/env node
// Builds src/data/license-exception-catalog.json -- the list of License
// Exceptions that actually exist in 15 C.F.R. Part 740, with their current
// section numbers, symbols and headings, taken from eCFR XML.
//
// Why generate this: the previous hand-written list cited "CIV (740.5)" long
// after CIV was removed and 740.5 was reused for License Exception SPP, and
// labelled 740.13 as "TSR" when 740.13 is TSU. Deriving the catalog from the
// regulation makes that class of drift impossible.
//
// Usage:  node scripts/build-part740-catalog.mjs [--date YYYY-MM-DD]

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "src", "data", "license-exception-catalog.json");

const TITLES_URL = "https://www.ecfr.gov/api/versioner/v1/titles";
const SOURCE_URL = (date) =>
  `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-15.xml?part=740`;

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "export-controls-agent-mcp/build-part740-catalog" }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

async function resolveDate(explicit) {
  if (explicit) return explicit;
  const json = JSON.parse(await fetchText(TITLES_URL));
  const t15 = json.titles.find((t) => t.number === 15);
  if (!t15) throw new Error("title 15 not found in eCFR titles index");
  return t15.latest_issue_date;
}

function decode(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const dateArgIdx = process.argv.indexOf("--date");
const issueDate = await resolveDate(dateArgIdx > -1 ? process.argv[dateArgIdx + 1] : null);
const url = SOURCE_URL(issueDate);
const xml = await fetchText(url);

const exceptions = [];
for (const m of xml.matchAll(/<DIV8\b[^>]*\bN="([^"]+)"[^>]*>\s*<HEAD>([\s\S]*?)<\/HEAD>/gi)) {
  const section = m[1];
  const heading = decode(m[2]).replace(/^§\s*/, "").replace(/\.$/, "");
  if (section === "740.1" || section === "740.2") continue; // scope + restrictions, not exceptions
  // Symbol is the parenthesised 2-4 letter code, e.g. "... (LVS)" or "(NAC) and ... (ACA)".
  const symbols = [...heading.matchAll(/\(([A-Z]{2,4})\)/g)].map((s) => s[1]);
  const title = heading.replace(/^740\.\d+\s*/, "");
  exceptions.push({
    section: `15 C.F.R. § ${section}`,
    sectionNumber: section,
    symbols,
    title
  });
}

if (exceptions.length < 20) {
  throw new Error(`only parsed ${exceptions.length} license exceptions; expected 25+`);
}

// Guards against the specific errors this file exists to prevent.
const bySection = Object.fromEntries(exceptions.map((e) => [e.sectionNumber, e]));
const assertions = [
  ["740.5", "SPP"],
  ["740.6", "TSR"],
  ["740.13", "TSU"],
  ["740.8", "NAC"],
  ["740.25", "HBM"]
];
for (const [sec, sym] of assertions) {
  if (!bySection[sec]?.symbols.includes(sym)) {
    throw new Error(
      `sanity check failed: § ${sec} should carry symbol ${sym} but parsed ` +
        JSON.stringify(bySection[sec] ?? null)
    );
  }
}
if (exceptions.some((e) => e.symbols.includes("CIV"))) {
  throw new Error("sanity check failed: License Exception CIV should no longer exist in Part 740");
}

const payload = {
  $comment:
    "GENERATED FILE -- do not edit by hand. Regenerate with: node scripts/build-part740-catalog.mjs",
  citation: "15 C.F.R. Part 740 (License Exceptions)",
  source: { url, api: "eCFR versioner v1", format: "XML" },
  ecfrIssueDate: issueDate,
  retrievedAt: new Date().toISOString(),
  count: exceptions.length,
  exceptions
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");

console.log(`wrote ${OUT}`);
console.log(`eCFR issue date: ${issueDate}, ${exceptions.length} license exceptions`);
for (const e of exceptions) {
  console.log(`  ${e.sectionNumber.padEnd(8)} ${(e.symbols.join("/") || "-").padEnd(9)} ${e.title}`);
}
