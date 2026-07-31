// Regression checks for the Commerce Country Chart evaluator (Part 738).
//
// Every expectation here is fixed against the regulation text, not against
// whatever the code happened to return when it was written. The cases are chosen
// to pin the failure modes that make a chart lookup dangerous rather than merely
// wrong: reading an empty cell as permission, dropping the rows that state their
// scope in prose, ignoring the footnotes, and treating a missing row as a clear
// destination.

import {
  assessCountryChartRequirement,
  resolveChartDestination,
  COUNTRY_CHART_COLUMNS
} from "../src/rules/country-chart.js";
import { analyzeLicenseExceptions } from "../src/rules/license-exceptions.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CHART = require("../src/data/country-chart.json");
const CCL = require("../src/data/ccl.json");

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};
const ask = (eccn, destination) => assessCountryChartRequirement({ eccn, destination });
const dets = (r) => (r.requirements ?? []).map((x) => x.determination);

// =========================================================================
// The dataset itself
// =========================================================================
{
  t("D1", COUNTRY_CHART_COLUMNS.length === 16, `${COUNTRY_CHART_COLUMNS.length} columns`);
  t(
    "D2",
    COUNTRY_CHART_COLUMNS.join(",") ===
      "CB 1,CB 2,CB 3,NP 1,NP 2,NS 1,NS 2,MT 1,RS 1,RS 2,FC 1,CC 1,CC 2,CC 3,AT 1,AT 2",
    COUNTRY_CHART_COLUMNS.join(",")
  );
  t("D3", Object.keys(CHART.countries).length === 196, `${Object.keys(CHART.countries).length} rows`);
  t("D4", Object.keys(CHART.footnotes).length === 10, `${Object.keys(CHART.footnotes).length} footnotes`);
  t("D5", (CHART.oddities ?? []).length === 0, JSON.stringify(CHART.oddities ?? []));

  // China is marked in both NS columns; a close ally only in NS 1. Inverting
  // this would flip the answer for every NS-controlled item.
  t("D6", CHART.countries["China"].marks.includes("NS 2"), "China NS 2");
  t("D7", !CHART.countries["Japan"].marks.includes("NS 2"), "Japan must NOT be NS 2");
  t("D8", CHART.countries["Japan"].marks.includes("NS 1"), "Japan NS 1");
  t("D9", !CHART.countries["China"].marks.includes("AT 1"), "China must NOT be AT 1");

  // Macau is not in Country Group D:5 but its chart row matches China's.
  t(
    "D10",
    CHART.countries["Macau"].marks.join(",") === CHART.countries["China"].marks.join(","),
    "Macau row should equal China's"
  );

  // The four destinations with no marks at all.
  for (const [i, c] of ["Cuba", "Iran", "Korea, North", "Syria"].entries()) {
    t(`D11.${i + 1}`, Boolean(CHART.embargoed[c]) && !CHART.countries[c], `${c} must be an embargo row`);
  }

  // Hong Kong was removed from the chart by 85 FR 83788.
  t("D12", !CHART.countries["Hong Kong"] && !CHART.embargoed["Hong Kong"], "Hong Kong must have no row");
  t("D13", CHART.territoryInheritance["hong kong"]?.row === "China", "Hong Kong inherits China");

  // Australia's graded row is nearly empty; footnote 10 is the only thing in the
  // supplement that catches firearms entries to it.
  t("D14", CHART.countries["Australia"].footnotes.includes(10), "Australia footnote 10");
  t("D15", CHART.countries["India"].footnotes.includes(7), "India footnote 7");
  t("D16", /Switzerland/i.test(CHART.footnotes["5"]), "footnote 5 redirects to Switzerland");
}

// =========================================================================
// Column path
// =========================================================================
{
  // 1C010 is NS Column 2 for the entire entry. China is marked, Japan is not.
  const cn = ask("1C010.a", "China");
  t("C1", cn.status === "license_required", cn.status);
  const jp = ask("1C010.a", "Japan");
  t("C2", jp.status === "no_chart_requirement", jp.status);
  t(
    "C3",
    jp.caveats.some((c) => c.citation === "15 C.F.R. 738.4(a)(2)(ii)(B)"),
    "a no-requirement answer must carry the 738.4(a)(2)(ii)(B) caveat"
  );
  t(
    "C4",
    jp.caveats.some((c) => /General Prohibitions Four through Ten/i.test(c.text ?? "")),
    "caveat must name General Prohibitions Four through Ten"
  );
  t("C5", !/available|permitted|clear/i.test(jp.summary), `summary must not read as clearance: ${jp.summary}`);

  // 5A002 is NS Column 1, and Japan IS marked there. A tool that assumed allies
  // are never marked would get this wrong.
  const enc = ask("5A002", "Japan");
  t("C6", enc.status === "license_required", enc.status);

  // 1C351 states "Column 1." with no reason prefix; it must resolve to CB 1 from
  // the Control(s) cell, and CB 1 is scoped to d.15 and .16 only.
  const cb = ask("1C351.a", "Germany");
  t("C7", cb.status === "no_chart_requirement", cb.status);
  const cb1 = cb.requirements.find((r) => (r.columns ?? []).some((c) => c.column === "CB 1"));
  t("C8", Boolean(cb1), "the bare 'Column 1.' cell must resolve to a CB 1 column");
  t("C9", cb1?.determination === "scope_not_applicable", cb1?.determination);
}

// =========================================================================
// Prose path -- the rows a column-only implementation drops
// =========================================================================
{
  // 3A090.a reaches any destination worldwide.
  const ww = ask("3A090.a", "Vietnam");
  t("P1", ww.status === "license_required", ww.status);
  const wwRow = ww.requirements.find((r) => r.proseScope === "worldwide");
  t("P2", wwRow?.determination === "license_required", wwRow?.determination);

  // 3A090.c is Macau or D:5 only, so Vietnam is outside it.
  const mac = ask("3A090.c", "Vietnam");
  t("P3", mac.status === "no_chart_requirement", mac.status);

  // 3B001.c is caught by the Macau/D:5 row for China.
  const cn = ask("3B001.c", "China");
  t("P4", cn.status === "license_required", cn.status);
  t(
    "P5",
    cn.requirements.some((r) => r.proseScope === "macau-or-d5" && r.determination === "license_required"),
    "the Macau/D:5 prose row must fire for China"
  );
  // ... and Macau itself, which is NOT in D:5 and is named separately.
  const mo = ask("3B001.c", "Macau");
  t("P6", mo.status === "license_required", mo.status);

  // The same entry to Japan: the Macau/D:5 rows must NOT fire.
  const jp = ask("3B001.c", "Japan");
  t(
    "P7",
    jp.requirements
      .filter((r) => r.proseScope === "macau-or-d5")
      .every((r) => r.determination === "no_chart_requirement"),
    "Macau/D:5 rows must not fire for Japan"
  );
}

// =========================================================================
// Subparagraph scope
// =========================================================================
{
  // 3B001.b sits in exactly one row (NS Column 2). Everything else in the entry
  // must be reported as out of scope, not as an unresolved maybe.
  const b = ask("3B001.b", "China");
  t("S1", b.status === "license_required", b.status);
  t("S2", dets(b).filter((d) => d === "scope_not_applicable").length === 4, JSON.stringify(b.determinationCounts));
  t("S3", !dets(b).includes("license_required_if_in_scope"), "3B001.b should be fully resolved");

  // 3B001.f straddles two rows (f.1/f.5/f.6 in one, f.2-f.4 in another), so it
  // genuinely cannot be resolved and must say so rather than pick one.
  const f = ask("3B001.f", "China");
  t("S4", f.status === "requires_verification", f.status);
  t("S5", dets(f).includes("license_required_if_in_scope"), JSON.stringify(f.determinationCounts));

  // A bare entry must ask for the subparagraph.
  const bare = ask("3B001", "China");
  t("S6", bare.status === "requires_verification", bare.status);
  t(
    "S7",
    bare.unansweredQuestions.some((q) => /Which subparagraph/i.test(q.question)),
    "a bare ECCN must raise the subparagraph question"
  );

  // Numeric sub-ranges ("a.1 to a.3", "f.2 to f.4") must expand, otherwise the
  // NS Column 2 row degrades to an unreadable description.
  const nsRow = ask("3B001.b", "China").requirements.find(
    (r) => (r.columns ?? []).some((c) => c.column === "NS 2")
  );
  t("S8", nsRow?.scope.applies === "yes", nsRow?.scope.basis);
  t("S9", (nsRow?.scope.specs ?? []).includes("3B001.A.2"), "a.1 to a.3 must expand");
  t("S10", (nsRow?.scope.specs ?? []).includes("3B001.F.3"), "f.2 to f.4 must expand");
  t("S11", (nsRow?.scope.specs ?? []).includes("3B001.I"), "g to j must expand");

  // "entire entry except 0A501.y": .y is out, .a is in.
  const y = ask("0A501.y", "Germany");
  t(
    "S12",
    y.requirements
      .filter((r) => /except/i.test(r.scope.text))
      .every((r) => r.determination === "scope_not_applicable"),
    "0A501.y must be excluded from the 'except 0A501.y' rows"
  );
  const a = ask("0A501.a", "Germany");
  t("S13", a.status === "license_required", a.status);
}

// =========================================================================
// The dangerous cases
// =========================================================================
{
  // An embargoed destination has no marks. This must never read as permissive.
  for (const [i, c] of ["Iran", "Cuba", "Korea, North", "Syria"].entries()) {
    const r = ask("1C010.a", c);
    t(`X1.${i + 1}`, r.status === "embargo_destination", `${c}: ${r.status}`);
    t(`X2.${i + 1}`, /no permissive meaning/i.test(r.summary), `${c} summary must disclaim`);
    t(
      `X3.${i + 1}`,
      (r.requirements ?? []).every((x) => x.determination === "embargo_destination"),
      `${c}: every row must be marked embargo_destination`
    );
  }

  // Footnote 10 requires a licence for 0A501 to Australia although the graded
  // row shows nothing. A grid-only reading returns "no requirement" here.
  const au = ask("0A501", "Australia");
  t("X4", au.status === "requires_verification", au.status);
  t("X5", au.footnotes.some((f) => f.number === 10 && f.mayApplyToThisEccn), "footnote 10 must fire");
  t("X6", /footnote 10/i.test(au.summary), au.summary);

  // Footnote 7 preserves an RS Column 2 requirement for India.
  const inr = ask("6A003.b.4.b", "India");
  t("X7", inr.footnotes.some((f) => f.number === 7 && f.mayApplyToThisEccn), "footnote 7 must fire");

  // An unknown destination must not resolve to an empty row.
  const nowhere = ask("1C010.a", "Freedonia");
  t("X8", nowhere.status === "indeterminate_input", nowhere.status);
  t("X9", /738\.3\(b\)/.test(JSON.stringify(nowhere.inputGaps)), "must cite 738.3(b) and ask for the parent country");

  // Hong Kong has no row of its own and must take China's.
  const hk = ask("3B001.c", "Hong Kong");
  t("X10", hk.status === "license_required", hk.status);
  t("X11", hk.destination.chartRow === "China" && hk.destination.matchType === "inherited", hk.destination.matchType);
  t("X12", /85 FR 83788/.test(hk.destination.inheritanceBasis ?? ""), "inheritance must cite the Federal Register rule");

  // 738.3(a)(1) entries bypass the chart entirely.
  const noExc = ask("0A983", "Germany");
  t("X13", noExc.status === "license_required", noExc.status);
  t("X14", /None apply/i.test(noExc.allDestinationsEntry?.licenceExceptions ?? ""), "0A983 has no licence exceptions");
  const gov = ask("5A980", "Germany");
  t("X15", /GOV/.test(gov.allDestinationsEntry?.licenceExceptions ?? ""), "5A980 is GOV-only");

  // EAR99 is off the CCL, but that is not clearance.
  const e99 = ask("EAR99", "China");
  t("X16", e99.status === "out_of_scope", e99.status);
  t("X17", /744\.23/.test(e99.summary), "EAR99 answer must point at the controls that still reach it");
}

// =========================================================================
// Parse coverage. Anything the evaluator cannot read is a silent gap, so the
// count is pinned. It may fall, never rise.
// =========================================================================
{
  let rows = 0;
  let unparsed = 0;
  const offenders = new Set();
  for (const entry of CCL.entries) {
    if (!entry.countryChart?.length) continue;
    const r = ask(entry.eccn, "China");
    for (const req of r.requirements ?? []) {
      rows++;
      if (req.determination === "unparsed") {
        unparsed++;
        offenders.add(entry.eccn);
      }
    }
  }
  t("R1", rows === 1536, `${rows} rows evaluated`);
  t("R2", unparsed <= 1, `${unparsed} unreadable rows (ceiling 1): ${[...offenders].join(", ")}`);
  // Exactly one row in the whole CCL cannot be read, and the reason is in the
  // regulation rather than in this code: 1D018's MT row has a blank Country Chart
  // cell and its control text names no requirement. Anything else appearing here
  // means the evaluator lost the ability to read a form it used to handle.
  t(
    "R3",
    [...offenders].every((e) => e === "1D018"),
    `unexpected unreadable entries: ${[...offenders].join(", ")}`
  );
}

// =========================================================================
// Rows the CCL builder used to lose or invent
// =========================================================================
{
  // 2E003 carries the Category 2E deposition table alongside its licence table.
  // Reading every table in the body put eleven coating-process rows into the
  // licence data. It should now hold exactly its two real rows.
  const e2 = CCL.entries.find((x) => x.eccn === "2E003");
  t("B1", e2.countryChart.length === 2, `2E003 has ${e2.countryChart.length} rows`);
  t(
    "B2",
    !JSON.stringify(e2.countryChart).includes("Superalloys"),
    "the deposition table must not appear in the licence rows"
  );
  const r2 = ask("2E003", "China");
  t("B3", r2.status === "license_required", r2.status);
  t("B4", !dets(r2).includes("unparsed"), JSON.stringify(r2.determinationCounts));

  // 1C350 stated its whole requirement in one merged cell, so the old
  // two-cell-minimum test dropped it and this major CW-precursor entry carried no
  // licence data at all.
  const c350 = CCL.entries.find((x) => x.eccn === "1C350");
  t("B5", (c350.countryChart ?? []).length >= 1, `1C350 has ${c350.countryChart?.length ?? 0} rows`);
  const r350 = ask("1C350", "China");
  t("B6", r350.status === "license_required", r350.status);
  t(
    "B7",
    r350.requirements.some((x) => (x.columns ?? []).some((c) => c.column === "CB 2" && c.marked)),
    "1C350 to China must resolve to a marked CB 2"
  );
  t("B8", ask("1C350", "Japan").status === "no_chart_requirement", ask("1C350", "Japan").status);

  // 0E982's licence table has a single column, because its requirement needs no
  // column: a licence is required for all destinations except Canada.
  const e982 = CCL.entries.find((x) => x.eccn === "0E982");
  t("B9", (e982.countryChart ?? []).length >= 1, `0E982 has ${e982.countryChart?.length ?? 0} rows`);
  const r982 = ask("0E982", "Germany");
  t(
    "B10",
    r982.requirements.some((x) => x.proseScope === "all-destinations-except-canada"),
    JSON.stringify(r982.requirements.map((x) => x.proseScope))
  );
  t("B11", r982.status === "requires_verification", r982.status);
  t("B12", ask("0E982", "Canada").status === "no_chart_requirement", ask("0E982", "Canada").status);

  // 1E355's requirement cell is blank because the requirement is in the control
  // cell. It must resolve to the cross-reference, not to an unreadable row.
  const r355 = ask("1E355", "China");
  const cw = r355.requirements.find((x) => x.reason === "CW");
  t("B13", cw?.determination === "requires_other_provision", cw?.determination);
  t("B14", /742\.18/.test(cw?.note ?? ""), "the CW row must carry its 742.18 cross-reference");

  // 1D018's blank cell is a gap in the regulation. Report that, not a format error.
  const r018 = ask("1D018", "China");
  const mt = r018.requirements.find((x) => x.reason === "MT");
  t("B15", mt?.determination === "unparsed", mt?.determination);
  t("B16", /blank in the CCL itself/.test(mt?.note ?? ""), mt?.note?.slice(0, 70));
  t("B17", r018.status === "license_required", `NS still resolves: ${r018.status}`);

  // Entries with two licence tables must keep both. A "take the first table" fix
  // would have quietly halved these.
  for (const [i, [eccn, min]] of [["1C351", 3], ["3D005", 4], ["8C609", 6]].entries()) {
    const n = CCL.entries.find((x) => x.eccn === eccn)?.countryChart?.length ?? 0;
    t(`B18.${i + 1}`, n >= min, `${eccn} has ${n} rows, expected at least ${min}`);
  }
}

// =========================================================================
// Destination resolution
// =========================================================================
{
  const cases = [
    ["China", "China"],
    ["PRC", "China"],
    ["china", "China"],
    ["Hong Kong", "China"],
    ["hong kong", "China"],
    ["Liechtenstein", "Switzerland"],
    ["Cayman Islands", "United Kingdom"],
    ["Seychelles", "Seycheles"],
    ["Türkiye", "Türkiye"],
    ["turkey", "Türkiye"],
    ["South Korea", "Korea, South"],
    ["Macau", "Macau"],
    ["Macao", "Macau"]
  ];
  cases.forEach(([input, expected], i) => {
    const r = resolveChartDestination(input);
    t(`N${i + 1}`, r.resolved && r.chartRow === expected, `${input} -> ${r.chartRow ?? r.reason}`);
  });
  for (const [i, bad] of ["Freedonia", "", "   "].entries()) {
    t(`N.bad${i + 1}`, !resolveChartDestination(bad).resolved, `${JSON.stringify(bad)} must not resolve`);
  }
  // Hong Kong must also carry China's Country Group memberships, otherwise the
  // D:5 gate in the FDP rules misses it.
  const hk = resolveChartDestination("Hong Kong");
  t("N.hk", hk.countryGroups.groups.includes("D:5"), `Hong Kong groups: ${hk.countryGroups.groups.join(",")}`);
}

// =========================================================================
// Integration with the License Exception tool
// =========================================================================
{
  // No licence requirement means no exception is needed on that ground, and the
  // exception tool must now say so instead of listing candidates in a vacuum.
  const clear = analyzeLicenseExceptions({ eccn: "1C010.a", destinationCountry: "Japan" });
  t("I1", clear.licenceRequirement.status === "no_chart_requirement", clear.licenceRequirement.status);
  t("I2", /no List Based License Exception is needed/i.test(clear.conclusion.statement), clear.conclusion.statement);

  // Two requirements means one exception has to overcome both.
  const two = analyzeLicenseExceptions({ eccn: "0A501.a", destinationCountry: "Germany" });
  t("I3", (two.licenceRequirement.requirementsToOvercome ?? []).length === 2, JSON.stringify(two.licenceRequirement.requirementsToOvercome));
  t("I4", /738\.4\(a\)\(2\)\(ii\)\(A\)/.test(two.licenceRequirement.conjunctive ?? ""), two.licenceRequirement.conjunctive);
  t(
    "I5",
    (two.licenceRequirement.requirementsToOvercome ?? []).map((r) => r.reason).sort().join(",") === "NS,RS",
    "0A501.a to Germany is NS 1 and RS 1"
  );

  // The SME gate and the chart requirement must both survive in one answer.
  const sme = analyzeLicenseExceptions({ eccn: "3B001.c", destinationCountry: "China" });
  t("I6", sme.licenceRequirement.status === "license_required", sme.licenceRequirement.status);
  t("I7", sme.exceptionsForeclosed.length >= 20, `${sme.exceptionsForeclosed.length} foreclosed`);
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exitCode = fails ? 1 : 0;
