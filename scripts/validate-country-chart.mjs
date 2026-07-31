#!/usr/bin/env node
// Drift check for the Commerce Country Chart model against the live regulation.
//
// The builder validates the data it writes. This validates the ASSUMPTIONS the
// evaluator makes about the regulation's wording, which no snapshot can catch:
//
//   - the 16 column identifiers, which every rule in the CCL names by string
//   - the 738.3(a)(1) entry list, which is transcribed here by hand
//   - the footnotes that create requirements the grid does not show
//   - that Hong Kong still has no row of its own
//   - that every prose destination scope the evaluator recognises still appears
//     in the CCL. This is the important one. If BIS rewords a scope, the pattern
//     stops matching, the affected rows silently become "unparsed", and the tool
//     quietly stops reporting a licence requirement it used to catch.
//
// Read-only. It never rewrites a dataset.
//
// Usage:  node scripts/validate-country-chart.mjs [--offline]

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  PROSE_SCOPE_PATTERNS,
  COUNTRY_CHART_COLUMNS,
  assessCountryChartRequirement
} from "../src/rules/country-chart.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CHART = require("../src/data/country-chart.json");
const CCL = require("../src/data/ccl.json");

const offline = process.argv.includes("--offline");
let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  fails++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m) => {
  warns++;
  console.log(`  warn  ${m}`);
};

const decode = (s) =>
  s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
const flat = (s) => decode(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// -------------------------------------------------------------------------
console.log("1. prose destination scopes still appear in the CCL");
// -------------------------------------------------------------------------
{
  const cells = [];
  for (const e of CCL.entries) for (const r of e.countryChart ?? []) cells.push(String(r.countryChart ?? ""));

  for (const p of PROSE_SCOPE_PATTERNS) {
    const hits = cells.filter((c) => c && p.test(c)).length;
    if (hits === 0) {
      bad(
        `"${p.id}" matches nothing in the current CCL. Either the wording changed or the entries were removed. ` +
          `Any row that used to match is now reported as unparsed, so a licence requirement may have stopped being caught.`
      );
    } else {
      ok(`${p.id}: ${hits} row(s)`);
    }
  }
}

// -------------------------------------------------------------------------
console.log("2. parse coverage");
// -------------------------------------------------------------------------
{
  // One row in the whole CCL cannot be read, and the reason is in the regulation:
  // 1D018's MT row has a blank Country Chart cell and its control text names no
  // requirement. The ceiling may fall, never rise.
  const CEILING = 1;
  let rows = 0;
  let unparsed = 0;
  const offenders = new Map();
  for (const entry of CCL.entries) {
    if (!entry.countryChart?.length) continue;
    const r = assessCountryChartRequirement({ eccn: entry.eccn, destination: "China" });
    for (const req of r.requirements ?? []) {
      rows++;
      if (req.determination === "unparsed") {
        unparsed++;
        offenders.set(entry.eccn, (offenders.get(entry.eccn) ?? 0) + 1);
      }
    }
  }
  if (unparsed > CEILING) {
    bad(
      `${unparsed} of ${rows} License Requirements rows are unreadable, above the ceiling of ${CEILING}. ` +
        `Offenders: ${[...offenders.entries()].map(([k, v]) => `${k}x${v}`).join(", ")}`
    );
  } else {
    ok(`${unparsed} of ${rows} rows unreadable (ceiling ${CEILING})`);
  }
  const unexpected = [...offenders.keys()].filter((e) => e !== "1D018");
  if (unexpected.length) {
    bad(
      `unreadable rows in unexpected entries: ${unexpected.join(", ")}`,
      "either the CCL changed shape or the evaluator lost a form it used to read"
    );
  } else if (offenders.size) {
    ok("the single unreadable row is 1D018's, whose Country Chart cell is blank in the regulation");
  }

  // The rows the CCL builder used to lose. Each of these was absent or wrong
  // before the licence-table gate, and each is a real requirement.
  for (const [eccn, want] of [
    ["1C350", /CB Column 2/i],
    ["0E982", /all destinations, except canada/i],
    ["1E355", /742\.18/]
  ]) {
    const e = CCL.entries.find((x) => x.eccn === eccn);
    const blob = JSON.stringify(e?.countryChart ?? []);
    if (!e?.countryChart?.length) bad(`${eccn} has no License Requirements rows; the licence-table gate has regressed`);
    else if (!want.test(blob)) bad(`${eccn}'s rows no longer contain ${want}`);
    else ok(`${eccn} still carries its requirement`);
  }
  // And the ones that must not be halved by taking only the first table.
  for (const [eccn, min] of [["1C351", 3], ["3D005", 4], ["8C609", 6]]) {
    const n = CCL.entries.find((x) => x.eccn === eccn)?.countryChart?.length ?? 0;
    if (n < min) bad(`${eccn} has ${n} rows, expected at least ${min}: it carries TWO licence tables`);
  }
  ok("entries with two licence tables keep both");
}

// -------------------------------------------------------------------------
console.log("3. every column named in the CCL exists in the chart");
// -------------------------------------------------------------------------
{
  const named = new Set();
  for (const e of CCL.entries)
    for (const r of e.countryChart ?? [])
      for (const m of String(r.countryChart ?? "").matchAll(/\b([A-Z]{2})\s+Column\s+(\d+)\b/gi))
        named.add(`${m[1].toUpperCase()} ${m[2]}`);

  const missing = [...named].filter((c) => !COUNTRY_CHART_COLUMNS.includes(c));
  if (missing.length) bad(`the CCL names columns the chart does not have: ${missing.join(", ")}`);
  else ok(`all ${named.size} columns named in the CCL exist in the chart`);

  const unused = COUNTRY_CHART_COLUMNS.filter((c) => !named.has(c));
  if (unused.length) warn(`chart columns no CCL entry references: ${unused.join(", ")}`);
}

// -------------------------------------------------------------------------
console.log("4. footnotes that create requirements");
// -------------------------------------------------------------------------
{
  const f = CHART.footnotes ?? {};
  if (Object.keys(f).length !== 10) bad(`expected 10 footnotes, snapshot has ${Object.keys(f).length}`);
  else ok("10 footnotes");

  if (!/Switzerland/i.test(f["5"] ?? "")) bad("footnote 5 no longer redirects Liechtenstein to Switzerland");
  else ok("footnote 5 redirects to Switzerland");

  if (!/6A003\.b\.4\.b/i.test(f["7"] ?? "")) bad("footnote 7 no longer names 6A003.b.4.b");
  else ok("footnote 7 names 6A003.b.4.b");

  if (!/0A501/.test(f["10"] ?? "")) bad("footnote 10 no longer names 0A501");
  else ok("footnote 10 names 0A501");

  // The footnote must actually fire through the evaluator, not merely exist.
  const au = assessCountryChartRequirement({ eccn: "0A501", destination: "Australia" });
  if (!au.footnotes.some((x) => x.number === 10 && x.mayApplyToThisEccn))
    bad("footnote 10 does not fire for 0A501 to Australia; the only catch for firearms there is gone");
  else ok("footnote 10 fires for 0A501 to Australia");
}

// -------------------------------------------------------------------------
console.log("5. destinations with no graded row");
// -------------------------------------------------------------------------
{
  for (const c of ["Cuba", "Iran", "Korea, North", "Syria"]) {
    if (!CHART.embargoed[c]) bad(`${c} is no longer an embargo pointer row`);
  }
  ok("the four embargoed destinations still carry no marks");

  if (CHART.countries["Hong Kong"] || CHART.embargoed["Hong Kong"])
    bad("Hong Kong has a chart row again; the 85 FR 83788 inheritance rule must be revisited");
  else ok("Hong Kong still has no row and inherits China's");

  for (const [key, v] of Object.entries(CHART.territoryInheritance ?? {})) {
    const target = v.row;
    if (!CHART.countries[target] && !CHART.embargoed[target])
      bad(`territory inheritance "${key}" points at "${target}", which is not a row`);
  }
  ok("every territory inheritance target is a real row");
}

// -------------------------------------------------------------------------
console.log("6. 738.3(a)(1) entries, against the live section");
// -------------------------------------------------------------------------
if (offline) {
  console.log("  skipped (--offline)");
} else {
  try {
    const titles = await (await fetch("https://www.ecfr.gov/api/versioner/v1/titles")).json();
    const live = titles.titles.find((t) => t.number === 15)?.latest_issue_date;
    const res = await fetch(
      `https://www.ecfr.gov/api/versioner/v1/full/${live}/title-15.xml?part=738`,
      { headers: { "User-Agent": "export-controls-agent-mcp/validate-country-chart" } }
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const xml = await res.text();

    if (live !== CHART.ecfrIssueDate) {
      warn(
        `snapshot is dated ${CHART.ecfrIssueDate} but eCFR's latest issue date for title 15 is ${live}. ` +
          "Rebuild with: node scripts/build-country-chart.mjs"
      );
    } else {
      ok(`snapshot matches the live eCFR issue date (${live})`);
    }

    const sec = /<DIV8\b[^>]*\bN="738\.3"[^>]*>([\s\S]*?)<\/DIV8>/i.exec(xml);
    if (!sec) {
      bad("738.3 not found in the live part; the section may have been restructured");
    } else {
      const text = flat(sec[1]);
      const spec = CHART.allDestinationsEntries ?? {};
      const claimed = [
        ...(spec.noLicenceExceptions ?? []),
        ...(spec.govOnly?.entries ?? [])
      ].map((s) => s.split(" ")[0]);
      const absent = claimed.filter((e) => !text.includes(e));
      if (absent.length) {
        bad(
          `738.3 no longer mentions ${absent.join(", ")}. The all-destinations list in country-chart.json is ` +
            "hand-transcribed and must be re-read against the section."
        );
      } else {
        ok(`all ${claimed.length} transcribed all-destinations entries still appear in 738.3`);
      }
      if (!/license is required for all destinations/i.test(text)) {
        bad("738.3 no longer contains the phrase 'a license is required for all destinations'");
      } else {
        ok("738.3 still states an all-destinations requirement");
      }
      if (!/territory, possession, dependency or department/i.test(text)) {
        warn("738.3(b)'s territory-inheritance wording changed; re-read it against territoryInheritance");
      } else {
        ok("738.3(b) territory-inheritance wording unchanged");
      }
    }

    const proc = /<DIV8\b[^>]*\bN="738\.4"[^>]*>([\s\S]*?)<\/DIV8>/i.exec(xml);
    const ptext = proc ? flat(proc[1]) : "";
    if (!/a license is not required based on the particular Reason for Control and destination/i.test(ptext)) {
      warn("738.4(a)(2)(ii)(B) wording changed; re-read the caveat this tool attaches to a no-requirement answer");
    } else {
      ok("738.4(a)(2)(ii)(B) still conditions a no-requirement answer");
    }
    if (!/Each affirmative license requirement must be overcome by a License Exception/i.test(ptext)) {
      warn("738.4(a)(2)(ii)(A)'s per-requirement wording changed; the conjunctive warning may be stale");
    } else {
      ok("738.4(a)(2)(ii)(A) still requires each requirement to be overcome separately");
    }
  } catch (e) {
    warn(`could not reach eCFR (${String(e.message ?? e)}); ran offline checks only`);
  }
}

console.log(
  `\n${fails === 0 ? "COUNTRY CHART VALIDATION PASSED" : fails + " CHECK(S) FAILED"}` +
    (warns ? `, ${warns} warning(s)` : "")
);
process.exitCode = fails ? 1 : 0;
