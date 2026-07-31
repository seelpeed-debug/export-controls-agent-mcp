#!/usr/bin/env node
// Builds src/data/country-groups.json from the authoritative eCFR XML for
// 15 C.F.R. Part 740, Supplement No. 1 (Country Groups).
//
// The eCFR XML preserves <TD> cells, so column membership is recovered exactly.
// Plain-text renderings of this supplement collapse empty cells and CANNOT be
// parsed reliably -- do not substitute a text source here.
//
// Usage:  node scripts/build-country-groups.mjs [--date YYYY-MM-DD]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSnapshotIfChanged, forceRequested } from "./write-snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "src", "data", "country-groups.json");

const TITLES_URL = "https://www.ecfr.gov/api/versioner/v1/titles";
const SOURCE_URL = (date) =>
  `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-15.xml?part=740`;

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "export-controls-agent-mcp/build-country-groups" }
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

// --- minimal, dependency-free helpers ------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the table whose <CAPTION> contains `caption`. */
function findTable(xml, caption) {
  const re = /<TABLE\b[\s\S]*?<\/TABLE>/gi;
  for (const m of xml.matchAll(re)) {
    if (m[0].includes(caption)) return m[0];
  }
  throw new Error(`table with caption containing "${caption}" not found`);
}

/**
 * eCFR renders table footnotes as ordinary <TR> rows inside <TFOOT>/<TBODY>.
 * They must not become "countries".
 */
function isFootnoteRow(firstCell) {
  return (
    firstCell.length > 80 || // footnote prose
    /^\d+\s/.test(firstCell) || // "1 Country Group A:1 is a list of ..."
    /^\(\w\)\s/.test(firstCell) // "(a) A comprehensive embargo against ..."
  );
}

/** "Ukraine 4" / "United Arab Emirates 5" carry a trailing footnote marker. */
function cleanCountry(name) {
  return name.replace(/\s+\d+$/, "").trim();
}

/** Parse rows of a country-group table into { country: [labels...] }. */
function parseGroupTable(tableXml, labels) {
  const body = tableXml.slice(tableXml.search(/<TBODY\b/i));
  const out = {};
  for (const rowMatch of body.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)) {
    // Self-closing <TD .../> means an empty cell; keep it as a positional slot.
    const cells = [];
    for (const c of rowMatch[1].matchAll(/<TD\b[^>]*?\/>|<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)) {
      cells.push(c[0].endsWith("/>") ? "" : stripTags(c[1] ?? ""));
    }
    if (cells.length === 0) continue;
    if (!cells[0] || isFootnoteRow(cells[0])) continue;
    const country = cleanCountry(cells[0]);
    if (!country) continue;
    const marks = [];
    for (let i = 0; i < labels.length; i++) {
      if ((cells[i + 1] ?? "").toUpperCase().includes("X")) marks.push(labels[i]);
    }
    out[country] = marks;
  }
  if (Object.keys(out).length === 0) throw new Error("parsed zero rows");
  return out;
}

/** Invert { country: [labels] } into { label: [countries] }. */
function invert(byCountry, labels) {
  const out = Object.fromEntries(labels.map((l) => [l, []]));
  for (const [country, marks] of Object.entries(byCountry)) {
    for (const m of marks) out[m].push(country);
  }
  for (const l of labels) out[l].sort((a, b) => a.localeCompare(b, "en"));
  return out;
}

/** Country Group B is a simple <SCOL2> list, not a table. */
function parseGroupB(xml) {
  // Heading reads "Country Group B&#x2014;Countries"; match loosely on the label
  // and then take the first list that follows it.
  const hd = xml.search(/<HD\d[^>]*>\s*Country Group B/i);
  if (hd < 0) throw new Error("Country Group B heading not found");
  const scol = xml.slice(hd).match(/<SCOL2\b[^>]*>([\s\S]*?)<\/SCOL2>/i);
  if (!scol) throw new Error("Country Group B list not found");
  const items = [...scol[1].matchAll(/<LI\b[^>]*>([\s\S]*?)<\/LI>/gi)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
  if (items.length < 50) throw new Error(`Country Group B looks truncated (${items.length})`);
  return items.sort((a, b) => a.localeCompare(b, "en"));
}

// --- main ----------------------------------------------------------------
const dateArgIdx = process.argv.indexOf("--date");
const explicitDate = dateArgIdx > -1 ? process.argv[dateArgIdx + 1] : null;

const issueDate = await resolveDate(explicitDate);
const url = SOURCE_URL(issueDate);
const xml = await fetchText(url);

// Narrow to the Supplement No. 1 APPENDIX element. Matching on the bare phrase
// "Supplement No. 1 to Part 740" is wrong -- that string also appears as a
// cross-reference inside the Part 740 section text, and slicing there would let
// the Group B parser wander into Supplement No. 3 (ENC favorable-treatment
// countries) and silently produce a bogus dataset.
function extractAppendix(source, name) {
  const openRe = new RegExp(`<DIV9\\b[^>]*\\bN="${name}"[^>]*>`, "i");
  const open = source.match(openRe);
  if (!open) throw new Error(`appendix element for "${name}" not found`);
  const start = open.index + open[0].length;
  const nextDiv9 = source.slice(start).search(/<DIV9\b/i);
  const end = nextDiv9 < 0 ? source.length : start + nextDiv9;
  return source.slice(start, end);
}

const sup = extractAppendix(xml, "Supplement No. 1 to Part 740");

const A_LABELS = ["A:1", "A:2", "A:3", "A:4", "A:5", "A:6"];
const D_LABELS = ["D:1", "D:2", "D:3", "D:4", "D:5"];
const E_LABELS = ["E:1", "E:2"];

const aByCountry = parseGroupTable(findTable(sup, "Country Group A"), A_LABELS);
const dByCountry = parseGroupTable(findTable(sup, "Country Group D"), D_LABELS);
const eByCountry = parseGroupTable(findTable(sup, "Country Group E"), E_LABELS);
const bList = parseGroupB(sup);

const groups = {
  ...invert(aByCountry, A_LABELS),
  B: bList,
  ...invert(dByCountry, D_LABELS),
  ...invert(eByCountry, E_LABELS)
};

// Sanity assertions, verified against the regulation text. If eCFR restructures
// the tables these fail loudly rather than silently producing a wrong
// compliance dataset.
const mustInclude = [
  ["A:5", "Korea, South"],
  ["A:5", "Japan"],
  ["A:6", "Taiwan"],
  ["D:1", "China (PRC)"],
  ["D:5", "China (PRC)"],
  ["D:5", "Russia"],
  ["D:1", "Macau"],
  ["E:1", "Iran"],
  ["E:1", "Korea, North"],
  ["E:2", "Cuba"]
];
// Facts that must NOT hold. Macau is the important one: the EAR consistently
// writes "Macau or a destination specified in Country Group D:5" precisely
// because Macau is NOT in D:5. Any rule keyed only on D:5 silently under-reports
// Macau, so we assert the shape of the data our gating logic depends on.
const mustExclude = [
  ["D:5", "Macau"],
  ["A:5", "Taiwan"],
  ["E:1", "Cuba"]
];

const failures = [
  ...mustInclude
    .filter(([g, c]) => !groups[g]?.includes(c))
    .map(([g, c]) => `${c} should be in ${g} but is not`),
  ...mustExclude
    .filter(([g, c]) => groups[g]?.includes(c))
    .map(([g, c]) => `${c} should NOT be in ${g} but is`)
];
if (failures.length) {
  throw new Error("sanity check failed, refusing to write dataset: " + failures.join("; "));
}

// Common input spellings -> the exact row labels used by Supplement No. 1.
// Hand-maintained: the regulation gives no alias table.
const ALIASES = {
  china: "China (PRC)",
  "china (people's republic of)": "China (PRC)",
  "people's republic of china": "China (PRC)",
  prc: "China (PRC)",
  "mainland china": "China (PRC)",
  macao: "Macau",
  "macau sar": "Macau",
  "hong kong": "Hong Kong",
  "south korea": "Korea, South",
  "republic of korea": "Korea, South",
  "korea, republic of": "Korea, South",
  "korea (republic of)": "Korea, South",
  rok: "Korea, South",
  "north korea": "Korea, North",
  dprk: "Korea, North",
  "korea (democratic people's republic of)": "Korea, North",
  "democratic people's republic of korea": "Korea, North",
  myanmar: "Burma",
  turkey: "Türkiye",
  turkiye: "Türkiye",
  uae: "United Arab Emirates",
  uk: "United Kingdom",
  "great britain": "United Kingdom",
  usa: "United States",
  us: "United States",
  "u.s.": "United States",
  "united states of america": "United States",
  "russian federation": "Russia",
  "south sudan": "South Sudan, Republic of",
  "congo (democratic republic of the)": "Congo (Democratic Republic of)",
  drc: "Congo (Democratic Republic of)",
  "czechia": "Czech Republic",
  "viet nam": "Vietnam"
};

const payload = {
  $comment:
    "GENERATED FILE -- do not edit by hand. Regenerate with: node scripts/build-country-groups.mjs",
  citation: "15 C.F.R. Part 740, Supplement No. 1 (Country Groups)",
  source: { url, api: "eCFR versioner v1", format: "XML" },
  ecfrIssueDate: issueDate,
  retrievedAt: new Date().toISOString(),
  notes: {
    macau:
      "Macau is NOT in Country Group D:5. The EAR writes 'Macau or a destination specified in Country Group D:5' throughout, so any rule keyed only on D:5 must add Macau explicitly.",
    d5Controlling:
      "Per the note to Country Group D:5, if this table conflicts with the State Department's arms-embargo notices (22 CFR 126.1 and Federal Register), the State Department list controls.",
    uae:
      "License Exception STA is available only to approved UAE entities listed in Supplement No. 8 to Part 740 (see 15 C.F.R. 740.2(a)(26))."
  },
  aliases: ALIASES,
  labels: {
    "A:1": "Wassenaar Arrangement participating states",
    "A:2": "Missile Technology Control Regime",
    "A:3": "Australia Group",
    "A:4": "Nuclear Suppliers Group",
    "A:5": "STA-eligible (Tier 1) destinations",
    "A:6": "Additional STA-eligible destinations",
    B: "Country Group B",
    "D:1": "National Security concern",
    "D:2": "Nuclear concern",
    "D:3": "Chemical & Biological concern",
    "D:4": "Missile Technology concern",
    "D:5": "U.S. arms-embargoed countries",
    "E:1": "Terrorist supporting countries / comprehensive embargo",
    "E:2": "Unilateral embargo"
  },
  groups,
  byCountry: { A: aByCountry, D: dByCountry, E: eByCountry }
};

const result = writeSnapshotIfChanged(OUT, payload, { force: forceRequested(), pretty: true });
console.log(result.written ? `wrote ${OUT}` : `SKIPPED ${OUT}`);
console.log(`  ${result.reason}`);
console.log(`eCFR issue date: ${issueDate}`);
for (const k of [...A_LABELS, "B", ...D_LABELS, ...E_LABELS]) {
  console.log(`  ${k.padEnd(4)} ${String(groups[k].length).padStart(3)} entries`);
}
