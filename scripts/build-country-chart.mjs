#!/usr/bin/env node
// Builds src/data/country-chart.json from the authoritative eCFR XML for
// 15 C.F.R. Part 738, Supplement No. 1 (the Commerce Country Chart).
//
// WHY XML AND NOT TEXT
// The chart is a 196-row grid whose whole meaning lives in which cells are
// empty. eCFR emits an empty cell as a self-closing <TD/>, and every plain-text
// rendering collapses it, which shifts every mark after it into the wrong
// column. A shifted chart is worse than no chart: it answers confidently and
// wrongly. Do not substitute a text source here.
//
// WHAT ELSE THIS FILE CAPTURES
//   - the 4 embargoed destinations whose rows carry NO marks at all and instead
//     point at Part 746. Reading "no X" there as "no licence required" is the
//     single worst mistake available in this dataset.
//   - the 10 footnotes, which carry substantive requirements the grid omits
//     (footnote 10 is the only thing that catches firearms to Australia).
//   - the destinations that have no row and must inherit another country's row
//     under 738.3(b).
//   - the 738.3(a)(1) entries that bypass the chart entirely.
//
// Usage:  node scripts/build-country-chart.mjs [--date YYYY-MM-DD] [--force]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSnapshotIfChanged, forceRequested } from "./write-snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "src", "data", "country-chart.json");

const TITLES_URL = "https://www.ecfr.gov/api/versioner/v1/titles";
const SOURCE_URL = (date) =>
  `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-15.xml?part=738`;

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "export-controls-agent-mcp/build-country-chart" }
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

// --- helpers -------------------------------------------------------------
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
  return decodeEntities(String(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Narrow to an APPENDIX element by its N attribute. */
function extractAppendix(source, name) {
  const open = source.match(new RegExp(`<DIV9\\b[^>]*\\bN="${name}"[^>]*>`, "i"));
  if (!open) throw new Error(`appendix element for "${name}" not found`);
  const start = open.index + open[0].length;
  const nextDiv9 = source.slice(start).search(/<DIV9\b/i);
  return source.slice(start, nextDiv9 < 0 ? source.length : start + nextDiv9);
}

/**
 * Split a <TR> into positional cells. A self-closing <TD/> is an EMPTY cell and
 * must keep its slot, otherwise every later mark lands in the wrong column.
 * Returns raw inner HTML so callers can read <sup> footnote markers.
 */
function rawCells(rowInner) {
  const cells = [];
  const re = /<T[DH]\b[^>]*?\/>|<T[DH]\b[^>]*>([\s\S]*?)<\/T[DH]>/gi;
  for (const m of rowInner.matchAll(re)) {
    cells.push(m[0].endsWith("/>") ? "" : (m[1] ?? ""));
  }
  return cells;
}

/** "Cyprus <sup>2</sup> <sup>3</sup>" -> { name: "Cyprus", footnotes: [2,3] } */
function splitFootnotes(rawCell) {
  const footnotes = [...rawCell.matchAll(/<sup\b[^>]*>\s*(\d+)\s*<\/sup>/gi)].map((m) =>
    Number(m[1])
  );
  const name = stripTags(rawCell.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, " "));
  return { name, footnotes };
}

/** Expand a header row's colspans into one label per column. */
function expandHeaderGroups(rowInner) {
  const labels = [];
  const re = /<TH\b([^>]*)>([\s\S]*?)<\/TH>/gi;
  for (const m of rowInner.matchAll(re)) {
    const attrs = m[1];
    // The "Countries" stub spans both header rows; it labels no data column.
    if (/\browspan\s*=\s*"?2"?/i.test(attrs)) continue;
    const span = Number(/\bcolspan\s*=\s*"?(\d+)"?/i.exec(attrs)?.[1] ?? 1);
    const label = stripTags(m[2]);
    for (let i = 0; i < span; i++) labels.push(label);
  }
  return labels;
}

// --- main ----------------------------------------------------------------
const dateArgIdx = process.argv.indexOf("--date");
const issueDate = await resolveDate(dateArgIdx > -1 ? process.argv[dateArgIdx + 1] : null);
const url = SOURCE_URL(issueDate);
const xml = await fetchText(url);
const sup = extractAppendix(xml, "Supplement No. 1 to Part 738");

// Locate the chart by content, not by position: it is the table whose header
// carries the column identifiers. Indexing into the table list would silently
// pick up a different table if eCFR ever adds one.
const chartTable = (() => {
  for (const m of sup.matchAll(/<TABLE\b[\s\S]*?<\/TABLE>/gi)) {
    if (/<TH\b[^>]*>\s*CB\s+1\s*<\/TH>/i.test(m[0])) return m[0];
  }
  throw new Error("Commerce Country Chart table not found (no 'CB 1' header cell)");
})();

const rows = [...chartTable.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)].map((m) => m[1]);
if (rows.length < 100) throw new Error(`chart table looks truncated (${rows.length} rows)`);

// Header rows: [0] reason-for-control groups, [1] column identifiers.
const groupLabels = expandHeaderGroups(rows[0]);
const columns = rawCells(rows[1]).map(stripTags);

const EXPECTED_COLUMNS = [
  "CB 1", "CB 2", "CB 3",
  "NP 1", "NP 2",
  "NS 1", "NS 2",
  "MT 1",
  "RS 1", "RS 2",
  "FC 1",
  "CC 1", "CC 2", "CC 3",
  "AT 1", "AT 2"
];
if (columns.join("|") !== EXPECTED_COLUMNS.join("|")) {
  throw new Error(
    "column identifiers changed, refusing to write dataset.\n" +
      `  expected: ${EXPECTED_COLUMNS.join(", ")}\n` +
      `  found:    ${columns.join(", ")}\n` +
      "Every rule that names a column must be reviewed before this is accepted."
  );
}
if (groupLabels.length !== columns.length) {
  throw new Error(
    `header colspans expand to ${groupLabels.length} labels but there are ${columns.length} columns`
  );
}

const columnLabels = Object.fromEntries(columns.map((c, i) => [c, groupLabels[i]]));

// --- body ----------------------------------------------------------------
const countries = {};
const embargoed = {};
const footnotes = {};
const oddities = [];

for (const rowInner of rows.slice(2)) {
  const cells = rawCells(rowInner);

  // A single-cell row is a footnote: "<sup>1</sup> See 746.1(b) ..." or "1 See ..."
  if (cells.length === 1) {
    const text = stripTags(cells[0]);
    const m = /^(\d+)\s+([\s\S]+)$/.exec(text);
    if (m) footnotes[m[1]] = m[2].trim();
    else oddities.push({ kind: "unnumbered-footnote", text: text.slice(0, 160) });
    continue;
  }

  const { name, footnotes: fns } = splitFootnotes(cells[0]);
  if (!name) continue;

  // Embargoed destinations get a merged cell pointing at another part, and NO
  // marks. They must never be read as "nothing is marked, so nothing applies".
  if (cells.length === 2) {
    embargoed[name] = { pointer: stripTags(cells[1]), footnotes: fns };
    continue;
  }

  if (cells.length !== columns.length + 1) {
    oddities.push({ kind: "unexpected-cell-count", name, cells: cells.length });
    continue;
  }

  const marks = [];
  for (let i = 0; i < columns.length; i++) {
    const v = stripTags(cells[i + 1]);
    if (!v) continue;
    if (v.toUpperCase() !== "X") {
      oddities.push({ kind: "non-X-mark", name, column: columns[i], value: v });
      continue;
    }
    marks.push(columns[i]);
  }
  countries[name] = { marks, footnotes: fns };
}

// --- assertions ----------------------------------------------------------
// Facts checked against the regulation. If eCFR restructures the supplement or
// BIS moves a destination, these fail loudly rather than quietly shipping a
// wrong compliance dataset.
const has = (c, col) => countries[c]?.marks.includes(col);
const failures = [];

const countryCount = Object.keys(countries).length;
if (countryCount < 190) failures.push(`only ${countryCount} country rows parsed`);
if (Object.keys(footnotes).length !== 10)
  failures.push(`expected 10 footnotes, parsed ${Object.keys(footnotes).length}`);

// China is marked in both NS columns; close allies are marked in NS 1 only.
// Getting this backwards would invert the answer for every NS item.
for (const [c, col] of [
  ["China", "NS 1"], ["China", "NS 2"], ["China", "MT 1"], ["China", "CC 1"],
  ["Japan", "NS 1"], ["Korea, South", "NS 1"], ["Austria", "NS 1"],
  ["India", "NS 1"], ["Russia", "NS 1"], ["Russia", "NS 2"]
]) {
  if (!has(c, col)) failures.push(`${c} should be marked ${col} but is not`);
}
for (const [c, col] of [
  ["Japan", "NS 2"], ["Korea, South", "NS 2"], ["Austria", "NS 2"],
  ["China", "AT 1"], ["China", "FC 1"], ["Japan", "CC 1"]
]) {
  if (has(c, col)) failures.push(`${c} should NOT be marked ${col} but is`);
}

// The embargo rows, and the fact they carry no marks.
for (const c of ["Cuba", "Iran", "Korea, North", "Syria"]) {
  if (!embargoed[c]) failures.push(`${c} should be an embargo pointer row but is not`);
  if (countries[c]) failures.push(`${c} should not have a graded row`);
}
// Hong Kong was removed from the chart by 85 FR 83788 and is governed by the
// China entry. If a row ever reappears, the inheritance rule below is wrong.
if (countries["Hong Kong"] || embargoed["Hong Kong"])
  failures.push("Hong Kong has a chart row again; revisit the territory inheritance rule");

// Footnotes that carry substantive requirements.
const fnOf = (c) => countries[c]?.footnotes ?? embargoed[c]?.footnotes ?? [];
for (const [c, n] of [
  ["Australia", 10], ["United Kingdom", 10], ["India", 7], ["Liechtenstein", 5],
  ["Russia", 6], ["Belarus", 6], ["Iran", 1]
]) {
  if (!fnOf(c).includes(n)) failures.push(`${c} should carry footnote ${n}`);
}
for (const n of [5, 7, 10]) {
  if (!footnotes[String(n)]) failures.push(`footnote ${n} text missing`);
}
if (!/Switzerland/i.test(footnotes["5"] ?? ""))
  failures.push("footnote 5 should redirect Liechtenstein to Switzerland");
if (!/6A003\.b\.4\.b/i.test(footnotes["7"] ?? ""))
  failures.push("footnote 7 should still name 6A003.b.4.b");

if (oddities.some((o) => o.kind === "non-X-mark" || o.kind === "unexpected-cell-count"))
  failures.push("unexpected cell shapes: " + JSON.stringify(oddities.slice(0, 5)));

if (failures.length) {
  throw new Error(
    "sanity check failed, refusing to write dataset:\n  - " + failures.join("\n  - ")
  );
}

// --- hand-maintained additions -------------------------------------------

// Input spellings -> the exact row labels used by this supplement. These differ
// from Part 740 Supplement No. 1: the chart says "China", the Country Groups
// tables say "China (PRC)". Do not share one alias map between them.
const ALIASES = {
  china: "China",
  "china (prc)": "China",
  "people's republic of china": "China",
  prc: "China",
  "mainland china": "China",
  "south korea": "Korea, South",
  "republic of korea": "Korea, South",
  "korea, republic of": "Korea, South",
  rok: "Korea, South",
  "north korea": "Korea, North",
  dprk: "Korea, North",
  "democratic people's republic of korea": "Korea, North",
  myanmar: "Burma",
  turkey: "Türkiye",
  turkiye: "Türkiye",
  "cote d'ivoire": "Cote d'Ivoire",
  "côte d'ivoire": "Cote d'Ivoire",
  "ivory coast": "Cote d'Ivoire",
  uae: "United Arab Emirates",
  uk: "United Kingdom",
  "great britain": "United Kingdom",
  britain: "United Kingdom",
  "russian federation": "Russia",
  "south sudan": "South Sudan, Republic of",
  "the bahamas": "Bahamas, The",
  bahamas: "Bahamas, The",
  "the gambia": "Gambia, The",
  gambia: "Gambia, The",
  "congo (democratic republic of)": "Congo (Democratic Republic of the)",
  "democratic republic of the congo": "Congo (Democratic Republic of the)",
  drc: "Congo (Democratic Republic of the)",
  "republic of the congo": "Congo (Republic of the)",
  czechia: "Czech Republic",
  "viet nam": "Vietnam",
  macao: "Macau",
  "macau sar": "Macau",
  // The regulation misspells Seychelles in the row label. Accept both.
  seychelles: "Seycheles",
  micronesia: "Micronesia (Federated State of)",
  "federated states of micronesia": "Micronesia (Federated State of)",
  "sint maarten": "Sint Maarten (the Dutch two-fifths of the island of Saint Martin)",
  "holy see": "Vatican City",
  "vatican": "Vatican City",
  "saint kitts and nevis": "St. Kitts and Nevis",
  "saint lucia": "St. Lucia",
  "saint vincent and the grenadines": "St. Vincent and the Grenadines",
  "east timor": "Timor-Leste",
  swaziland: "Eswatini",
  macedonia: "North Macedonia",
  "cabo verde": "Cape Verde",
  eswatini: "Eswatini"
};

// 738.3(b): a destination absent from the chart takes the licensing treatment of
// the country it belongs to. BIS does not publish an exhaustive mapping, so this
// holds ONLY the instances the EAR itself names. Anything else must come back
// indeterminate and be resolved by the user -- guessing a parent country here
// would be inventing law.
const TERRITORY_INHERITANCE = {
  "hong kong": {
    row: "China",
    basis:
      "BIS removed the Hong Kong entry from the Commerce Country Chart effective 23 December 2020 (85 FR 83788); licence requirements for Hong Kong are governed by the entry for China."
  },
  liechtenstein: {
    row: "Switzerland",
    basis:
      "Footnote 5 to Supplement No. 1 to Part 738, and 738.3(b): Liechtenstein serves as one territory with Switzerland for purposes of the EAR."
  },
  "cayman islands": {
    row: "United Kingdom",
    basis: "738.3(b), which gives the Cayman Islands as its worked example of a dependent territory."
  }
};

// 738.3(a)(1): these impose a licence requirement for ALL destinations without a
// Country Chart column. Looking them up in the grid finds nothing and would
// wrongly read as "no requirement".
const ALL_DESTINATIONS_ENTRIES = {
  citation: "15 C.F.R. 738.3(a)(1)",
  note:
    "A licence is required for all destinations for items controlled under these entries. The Commerce Country Chart does not apply to them.",
  noLicenceExceptions: ["0A983", "5E001.a (for 5A001.f.1, or for 5D001.a (for 5A001.f.1))", "5E980"],
  govOnly: {
    entries: [
      "5A001.f.1",
      "5A980",
      "5D001 (for 5A001.f.1, or for 5E001.a (for 5A001.f.1 or for 5D001.a (for 5A001.f.1)))",
      "5D980"
    ],
    condition:
      "License Exception GOV may apply only if the item is consigned to and for the official use of an agency of the U.S. Government, see 740.2(a)(3)."
  },
  licensingPolicy: "See 742.11 or 742.13 for licensing policy, and part 748 for application instructions."
};

const payload = {
  $comment:
    "GENERATED FILE -- do not edit by hand. Regenerate with: node scripts/build-country-chart.mjs",
  citation: "15 C.F.R. Part 738, Supplement No. 1 (Commerce Country Chart)",
  source: { url, api: "eCFR versioner v1", format: "XML" },
  ecfrIssueDate: issueDate,
  retrievedAt: new Date().toISOString(),
  procedure: {
    citation: "15 C.F.R. 738.4(a)(2)",
    steps: [
      "Identify every Reason for Control in the ECCN and the Country Chart column each one names.",
      "For each column, check whether an X appears in the cell for the destination.",
      "An X means a licence is required for that reason and destination unless a License Exception applies.",
      "Each affirmative requirement must be overcome separately; one exception covering one reason is not enough."
    ],
    noMarkCaveat:
      "738.4(a)(2)(ii)(B): no X means no licence is required on that reason for control and destination ONLY IF General Prohibitions Four through Ten do not apply and the ECCN's License Requirements section does not refer you elsewhere in the EAR. It is not a conclusion that the transaction is permitted.",
    notAllEntriesUseTheChart:
      "738.4(a)(1): some ECCNs state their licence requirements in full or refer to another provision instead of naming a column."
  },
  notes: {
    embargoedRows:
      "Cuba, Iran, North Korea and Syria have no marks at all. Their rows point to Part 746 (and 742.19 for North Korea). Absence of an X for these destinations carries no permissive meaning whatsoever.",
    hongKong:
      "Hong Kong has no row. Under 85 FR 83788 it is governed by the China entry, and it is likewise absent from the Part 740 Country Group tables because it is no longer a separate destination.",
    footnotesAreSubstantive:
      "The footnotes impose requirements the grid does not show. Footnote 10 is the only thing in this supplement that requires a licence for the listed firearms entries to Australia and the United Kingdom, whose graded rows are almost entirely empty.",
    columnOrder:
      "Column order in the source table is CB, NP, NS, MT, RS, FC, CC, AT. Lookups are by column name; the order is recorded only so a restructuring of the table is detected."
  },
  columns,
  columnLabels,
  countryCount,
  countries,
  embargoed,
  footnotes,
  aliases: ALIASES,
  territoryInheritance: TERRITORY_INHERITANCE,
  territoryInheritanceNote:
    "738.3(b) states the principle but BIS publishes no exhaustive list. Only the instances the EAR itself names are recorded here. A destination that is neither a row nor listed here must be reported as indeterminate, not as unrestricted.",
  allDestinationsEntries: ALL_DESTINATIONS_ENTRIES,
  oddities
};

const result = writeSnapshotIfChanged(OUT, payload, { force: forceRequested(), pretty: true });
console.log(result.written ? `wrote ${OUT}` : `SKIPPED ${OUT}`);
console.log(`  ${result.reason}`);
console.log(`eCFR issue date: ${issueDate}`);
console.log(`columns:   ${columns.length}  (${columns.join(", ")})`);
console.log(`countries: ${countryCount} graded rows, ${Object.keys(embargoed).length} embargo rows`);
console.log(`footnotes: ${Object.keys(footnotes).length}`);
if (oddities.length) console.log(`oddities:  ${JSON.stringify(oddities)}`);
