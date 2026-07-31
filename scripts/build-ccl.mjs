#!/usr/bin/env node
// Builds src/data/ccl.json from the authoritative eCFR XML for
// 15 C.F.R. Part 774, Supplement No. 1 (the Commerce Control List).
//
// Why this exists: the previous classify_eccn tool carried a hand-written map
// asserting things like "lithography = 3B001.e" and "battery cathode = 1C010.e".
// Both are wrong -- 3B001.e is automatic multi-chamber wafer handling, 3B001.f is
// lithography, and 1C010 is fibrous or filamentary materials. Deriving paragraph
// structure and text from the regulation removes that entire error class and
// lets the tool quote the controlling parameters instead of paraphrasing them.
//
// Usage:  node scripts/build-ccl.mjs [--date YYYY-MM-DD] [--categories 1,3,4,5]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSnapshotIfChanged, forceRequested } from "./write-snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "src", "data", "ccl.json");

const TITLES_URL = "https://www.ecfr.gov/api/versioner/v1/titles";
const SOURCE_URL = (date) =>
  `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-15.xml?part=774`;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};

// Categories for which full item-paragraph text is captured. Others keep
// heading and licence metadata only, which keeps the file to a sane size.
const DEEP_CATEGORIES = new Set((arg("--categories") ?? "1,3,4,5").split(",").map((s) => s.trim()));

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "export-controls-agent-mcp/build-ccl" } });
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
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull the paragraph designator off "a.4.b. Equipment designed ..." */
function splitDesignator(text) {
  const m = text.match(/^((?:[a-z]|\d{1,2})(?:\.(?:[a-z]|\d{1,2}))*)\.\s+(.*)$/);
  if (!m) return null;
  // Guard against sentences that merely start with a letter and a full stop.
  if (m[1].length > 12) return null;
  return { designator: m[1], text: m[2] };
}

const issueDate = await resolveDate(arg("--date"));
const url = SOURCE_URL(issueDate);
const xml = await fetchText(url);

const open = xml.match(/<DIV9\b[^>]*\bN="Supplement No\. 1 to Part 774"[^>]*>/i);
if (!open) throw new Error("Supplement No. 1 to Part 774 not found");
const start = open.index + open[0].length;
const nextAppendix = xml.slice(start).search(/<DIV9\b[^>]*TYPE="APPENDIX"/i);
const sup = xml.slice(start, nextAppendix < 0 ? xml.length : start + nextAppendix);

// ECCN entry headings look like: <FP-2><B>3B001 Equipment for ... </B></FP-2>
const HEAD_RE = /<FP-2><B>\s*(\d[A-Z]\d{3})\s+([\s\S]*?)<\/B>\s*<\/FP-2>/g;
const heads = [...sup.matchAll(HEAD_RE)].map((m) => ({
  eccn: m[1],
  heading: decode(m[2]),
  start: m.index,
  bodyStart: m.index + m[0].length
}));
if (heads.length < 500) throw new Error(`only found ${heads.length} ECCN headings; expected 600+`);

const entries = [];
// Tables in an ECCN body that are not the License Requirements table. Recorded
// rather than silently skipped, so that a change in the CCL's table structure
// shows up as a count instead of as missing licence rows.
const nonLicenceTables = [];
const entriesWithoutLicenceRows = [];

for (let i = 0; i < heads.length; i++) {
  const h = heads[i];
  const body = sup.slice(h.bodyStart, heads[i + 1]?.start ?? sup.length);
  const category = h.eccn[0];
  const group = h.eccn[1];

  // <FP-1> blocks carry Reason for Control, the List Based License Exceptions
  // lines, STA special conditions and the Related Controls notes.
  const fp1 = [...body.matchAll(/<FP-1>([\s\S]*?)<\/FP-1>/gi)].map((m) => decode(m[1])).filter(Boolean);

  const pick = (label) => {
    const hit = fp1.find((t) => new RegExp(`^${label}\\s*:`, "i").test(t));
    return hit ? hit.replace(new RegExp(`^${label}\\s*:\\s*`, "i"), "") : null;
  };

  const licenceExceptionFlags = {};
  for (const t of fp1) {
    const m = t.match(/^([A-Z]{2,4})\s*:\s*(.+)$/);
    if (m && !["NS", "RS", "AT", "MT", "NP", "CB", "CC", "SI", "SS", "UN", "EI", "FC"].includes(m[1])) {
      licenceExceptionFlags[m[1]] = m[2];
    }
  }

  // License Requirements rows.
  //
  // An ECCN body can hold tables that are NOT the License Requirements table.
  // 2E003 carries the Category 2E Materials Processing deposition table, whose
  // rows are coating processes and substrates. Reading every table in the body
  // put eleven rows such as {control: "D. Plasma spraying", countryChart:
  // "\u201cSuperalloys\u201d"} into the licence data, where the Country Chart
  // evaluator could only report them as unreadable.
  //
  // The licence table is identifiable: its header names the Country Chart. Four
  // entries have more than one table, and for three of them BOTH are licence
  // tables with different columns, so gating on the header rather than taking the
  // first table is what keeps 1C351, 3D005 and 8C609 whole.
  const countryChart = [];
  for (const t of body.matchAll(/<TABLE\b[\s\S]*?<\/TABLE>/gi)) {
    const headRow = /<TR\b[^>]*>([\s\S]*?)<\/TR>/i.exec(t[0]);
    const headerCells = headRow
      ? [...headRow[1].matchAll(/<T[DH]\b[^>]*?\/>|<T[DH]\b[^>]*>([\s\S]*?)<\/T[DH]>/gi)].map((c) =>
          c[0].endsWith("/>") ? "" : decode(c[1] ?? "")
        )
      : [];
    // Sixteen distinct header shapes exist across the supplement. Fifteen of them
    // name the Country Chart, with the case and punctuation varying. The
    // sixteenth is 0E982's, a SINGLE-column table headed only "Control(s)"
    // because its requirement needs no column: a licence is required for all
    // destinations except Canada. Accept both, reject anything else.
    const namesTheChart = headerCells.some((h) => /country\s*chart/i.test(h));
    const isControlsOnly = /^control\(s\)$/i.test((headerCells[0] ?? "").trim());
    if (!namesTheChart && !isControlsOnly) {
      nonLicenceTables.push({ eccn: h.eccn, header: headerCells.slice(0, 3) });
      continue;
    }
    const tb = t[0].slice(t[0].search(/<TBODY\b/i));
    for (const r of tb.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)) {
      const cells = [...r[1].matchAll(/<TD\b[^>]*?\/>|<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map((c) =>
        c[0].endsWith("/>") ? "" : decode(c[1] ?? "")
      );
      if (!cells.length || !cells[0]) continue;
      if (cells.length >= 2 && cells[1]) {
        countryChart.push({ control: cells[0], countryChart: cells[1] });
        continue;
      }
      if (cells.length >= 2 && !cells[1]) {
        // The requirement cell is blank in the source. Where that happens the
        // requirement is stated in the control cell instead: 1E355 reads "CW
        // applies to entire entry. A license is required for CW reasons to CWC
        // non-States Parties ... See 742.18 ... The Commerce Country Chart is not
        // designed to determine licensing requirements for items controlled for CW
        // reasons." Leaving the field empty threw that away. 1D018's blank cell
        // carries no requirement at all, which the flag lets a reader see.
        countryChart.push({
          control: cells[0],
          countryChart: cells[0],
          requirementCellEmptyInSource: true
        });
        continue;
      }
      // Single-cell row: the control and its requirement are one sentence. The
      // old `cells.length >= 2` test discarded these, which is why 0E982 carried
      // no licence data at all despite requiring a licence for every destination
      // but Canada. The full text goes in both fields on purpose. Splitting it
      // would leave `control` reading "CC applies to technology for items
      // controlled by 0A982 or 0A503", which a scope matcher resolves against the
      // wrong entries and reports as out of scope -- suppressing the requirement.
      countryChart.push({
        control: cells[0],
        countryChart: cells[0],
        singleCellRow: true
      });
    }
  }
  if (!countryChart.length) entriesWithoutLicenceRows.push(h.eccn);

  const entry = {
    eccn: h.eccn,
    category,
    productGroup: group,
    heading: h.heading,
    reasonForControl: pick("Reason for Control"),
    countryChart,
    licenceExceptionFlags,
    staSpecialConditions: fp1.find((t) => /^STA\s*:/i.test(t)) ?? null,
    relatedControls: pick("Related Controls")
  };

  if (DEEP_CATEGORIES.has(category)) {
    const items = [];
    for (const p of body.matchAll(/<P>([\s\S]*?)<\/P>/gi)) {
      const text = decode(p[1]);
      if (!text) continue;
      const split = splitDesignator(text);
      if (split) {
        // A designator starting with a letter is an item paragraph ("a",
        // "a.4.b"). A digit at the top level is a numbered NOTE ("1. The
        // 'Minimum Resolvable Feature size' is calculated by ..."). There is no
        // ECCN paragraph "3B001.1", so notes must not be labelled as one.
        const kind = /^[a-z]/.test(split.designator) ? "item" : "note";
        items.push({
          paragraph: split.designator,
          kind,
          depth: split.designator.split(".").length,
          text: split.text
        });
        continue;
      }
      // Unnumbered prose still matters. Scope notes, exclusions and definitions
      // carry controlling language and vocabulary -- for example "3B001.a.1
      // includes atomic layer epitaxy (ALE) equipment" and the 'Process Design
      // Kit' definition preceding 3E001. Dropping these loses searchable text
      // and, worse, loses exclusions that change the answer.
      items.push({ paragraph: null, kind: "text", depth: 0, text });
    }
    entry.items = items;
    // Convenience index: top-level paragraph -> its lead text. CCL item
    // paragraphs are always lettered; a bare number at depth 1 is a numbered
    // note ("1. The 'Minimum Resolvable Feature size' is calculated by ..."),
    // not an item, so it must not appear here.
    entry.topLevelParagraphs = Object.fromEntries(
      items
        .filter((it) => it.kind === "item" && it.depth === 1 && /^[a-z]$/.test(it.paragraph))
        .map((it) => [it.paragraph, it.text])
    );
  }

  entries.push(entry);
}

// --- sanity checks against facts verified directly in the regulation --------
const byEccn = new Map(entries.map((e) => [e.eccn, e]));
function topLevel(eccn, para) {
  return byEccn.get(eccn)?.topLevelParagraphs?.[para] ?? "";
}
const checks = [
  ["3B001", "a", /epitaxial growth/i],
  ["3B001", "b", /ion implantation/i],
  ["3B001", "c", /etch/i],
  ["3B001", "d", /deposition/i],
  ["3B001", "e", /wafer handling/i],
  ["3B001", "f", /lithograph/i]
];
const failures = [];
for (const [eccn, para, re] of checks) {
  const t = topLevel(eccn, para);
  if (!re.test(t)) failures.push(`${eccn}.${para} should match ${re} but reads "${t.slice(0, 90)}"`);
}
// 1C010 is fibrous or filamentary materials, not battery chemistry.
const c1c010 = byEccn.get("1C010");
if (!c1c010) failures.push("1C010 not found");
else if (!/fibrous or filamentary/i.test(c1c010.heading)) {
  failures.push(`1C010 heading should mention "fibrous or filamentary" but reads "${c1c010.heading.slice(0, 90)}"`);
}
for (const required of ["3A090", "3B002", "3B993", "3C002", "3D001", "3E001"]) {
  if (!byEccn.has(required)) failures.push(`${required} not found`);
}

// Only 2E003 is expected to carry a table that is not the License Requirements
// table. If another entry starts doing so, either the CCL gained a table or the
// header test stopped recognising a licence table -- and the second case means
// licence rows are being dropped, which is exactly the failure this gate exists
// to prevent. Fail rather than guess which it is.
const EXPECTED_NON_LICENCE_TABLE_ENTRIES = ["2E003"];
const unexpectedTables = [...new Set(nonLicenceTables.map((t) => t.eccn))].filter(
  (e) => !EXPECTED_NON_LICENCE_TABLE_ENTRIES.includes(e)
);
if (unexpectedTables.length) {
  failures.push(
    `tables not recognised as License Requirements tables in: ${unexpectedTables.join(", ")}. ` +
      `Headers seen: ${JSON.stringify(nonLicenceTables.filter((t) => unexpectedTables.includes(t.eccn)).slice(0, 4))}. ` +
      "If these ARE licence tables, the header test is now wrong and licence rows are being lost."
  );
}
// The counterpart guard: verify the entries known to carry two licence tables
// still keep both, because that is what a naive "take the first table" fix would
// break.
for (const [eccn, minRows] of [
  ["1C351", 3],
  ["3D005", 4],
  ["8C609", 6]
]) {
  const n = byEccn.get(eccn)?.countryChart?.length ?? 0;
  if (n < minRows) {
    failures.push(
      `${eccn} has ${n} License Requirements rows, expected at least ${minRows}. This entry carries TWO licence tables and both must be read.`
    );
  }
}
if (failures.length) {
  throw new Error("sanity check failed, refusing to write dataset:\n  - " + failures.join("\n  - "));
}

const payload = {
  $comment: "GENERATED FILE -- do not edit by hand. Regenerate with: node scripts/build-ccl.mjs",
  citation: "15 C.F.R. Part 774, Supplement No. 1 (Commerce Control List)",
  source: { url, api: "eCFR versioner v1", format: "XML" },
  ecfrIssueDate: issueDate,
  retrievedAt: new Date().toISOString(),
  deepCategories: [...DEEP_CATEGORIES].sort(),
  deepCategoryNote:
    "Full item-paragraph text is captured only for the categories listed in deepCategories. Other entries carry heading and licence metadata only.",
  entryCount: entries.length,
  entries
};

const result = writeSnapshotIfChanged(OUT, payload, { force: forceRequested() });
console.log(result.written ? `wrote ${OUT}` : `SKIPPED ${OUT}`);
console.log(`  ${result.reason} (${(result.bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`eCFR issue date: ${issueDate}, ${entries.length} ECCN entries`);
const licenceRowCount = entries.reduce((n, e) => n + e.countryChart.length, 0);
console.log(
  `License Requirements rows: ${licenceRowCount} from ${entries.length - entriesWithoutLicenceRows.length} entries; ` +
    `${entriesWithoutLicenceRows.length} entries state their requirements outside a table`
);
if (nonLicenceTables.length) {
  console.log(
    `  skipped ${nonLicenceTables.length} table(s) that are not License Requirements tables: ` +
      [...new Set(nonLicenceTables.map((t) => t.eccn))].join(", ")
  );
}
for (const cat of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
  const n = entries.filter((e) => e.category === cat).length;
  const deep = DEEP_CATEGORIES.has(cat) ? " (full item text)" : "";
  if (n) console.log(`  category ${cat}: ${String(n).padStart(3)} entries${deep}`);
}
console.log("\n3B001 top-level paragraphs:");
for (const [p, t] of Object.entries(byEccn.get("3B001").topLevelParagraphs)) {
  console.log(`  .${p}  ${t.slice(0, 96)}`);
}
