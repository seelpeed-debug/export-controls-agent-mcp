import { assessFdp } from "../src/rules/fdp.js";
import { assessDeMinimis } from "../src/rules/de-minimis.js";
import { assessEarJurisdiction } from "../src/rules/jurisdiction.js";
import { FDP_RULES } from "../src/data/fdp-rules.js";

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};
const ids = (list) => list.map((r) => r.id);

// =========================================================================
// The headline gap this work closed: zero U.S. content, still subject to EAR
// =========================================================================
{
  const r = assessFdp({
    destinationCountry: "China",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["3E992"]
  });
  t("H1", r.conclusion.type === "subject_to_ear_under_fdp", r.conclusion.type);
  t("H2", ids(r.rulesApplying).includes("sme"), `applying: ${ids(r.rulesApplying).join(", ")}`);
  const sme = r.rulesApplying.find((x) => x.id === "sme");
  t("H3", sme.citation === "15 C.F.R. § 734.9(k)", sme.citation);
  t("H4", /742\.4\(a\)\(4\)/.test(sme.licenceReference), sme.licenceReference);
  t(
    "H5",
    /regardless of how little U\.S\. content/.test(r.conclusion.statement),
    "conclusion states the no-percentage point"
  );
}
// Same item, destination outside Macau/D:5 -> the destination prong fails
{
  const r = assessFdp({
    destinationCountry: "Japan",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["3E992"]
  });
  const sme = r.rulesNotApplying.find((x) => x.citation === "15 C.F.R. § 734.9(k)");
  t("H6", Boolean(sme), `SME must be does_not_apply for Japan; applying=${ids(r.rulesApplying).join(",")}`);
  t("H7", /neither Macau nor in Country Group D:5/.test(sme.whyNot), sme.whyNot);
}
// Same destination, but production inputs outside the SME input list
{
  const r = assessFdp({
    destinationCountry: "China",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["5E002"],
    producedByPlantThatIsDirectProductOfUsTechnology: false,
    containsIcFromSuchPlant: false
  });
  t(
    "H8",
    !ids(r.rulesApplying).includes("sme"),
    `SME must not apply when no route is met; applying=${ids(r.rulesApplying).join(",")}`
  );
}

// =========================================================================
// Two-prong discipline: both prongs required, and unknown is not "no"
// =========================================================================
{
  // Product scope met, reach unknown -> indeterminate, never does_not_apply
  const r = assessFdp({
    destinationCountry: "Japan",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["3E992"]
  });
  const fn1 = r.rulesIndeterminate.find((x) => x.id === "entity_list_fn1");
  t("P1", Boolean(fn1), "Footnote 1 unresolved because footnote status was not established");
  t("P2", fn1.productScope.state === "met", `productScope=${fn1.productScope.state}`);
  t("P3", fn1.reachScope.state === "indeterminate", `reachScope=${fn1.reachScope.state}`);

  // Asserting footnote status is known and absent resolves it to does_not_apply
  const r2 = assessFdp({
    destinationCountry: "Japan",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["3E992"],
    entityListFootnotes: [],
    entityListFootnotesKnown: true
  });
  t(
    "P4",
    r2.rulesNotApplying.some((x) => x.citation === "15 C.F.R. § 734.9(e)(1)"),
    `fn1 status after asserting known: ${ids(r2.rulesIndeterminate).join(",")}`
  );
}
{
  // Rules with no item-scope restriction must not be reported as indeterminate
  // on the item prong. This was a real bug.
  const r = assessFdp({
    destinationCountry: "Japan",
    foreignItemEccn: "EAR99",
    producedUsingUsTechnologyEccns: ["3E001"]
  });
  for (const id of ["entity_list_fn1", "entity_list_fn4", "russia_belarus_meu", "supercomputer"]) {
    const rule = [...r.rulesApplying, ...r.rulesIndeterminate, ...r.rulesNotApplying].find(
      (x) => x.id === id || x.citation === FDP_RULES.find((f) => f.id === id).citation
    );
    const full = [...r.rulesApplying, ...r.rulesIndeterminate].find((x) => x.id === id);
    t(
      `P5-${id}`,
      !full || full.productScope.itemScope.state === "met",
      full ? `itemScope=${full.productScope.itemScope.state}` : "resolved to does_not_apply"
    );
  }
}

// =========================================================================
// Item-scope tests resolve rules that would otherwise be noise
// =========================================================================
{
  const r = assessFdp({
    destinationCountry: "China",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["3E992"]
  });
  const notApplying = r.rulesNotApplying.map((x) => x.citation);
  t("S1", notApplying.includes("15 C.F.R. § 734.9(c)"), "9x515 resolved to does_not_apply for an etcher");
  t("S2", notApplying.includes("15 C.F.R. § 734.9(d)"), "600 series resolved to does_not_apply");
  const ns = [...r.rulesApplying, ...r.rulesIndeterminate].find((x) => x.id === "national_security");
  t(
    "S3",
    ns && ns.productScope.itemScope.state === "met" && /national security/i.test(ns.productScope.itemScope.reason),
    ns?.productScope.itemScope.reason?.slice(0, 90)
  );
}
{
  // A 600-series item is recognised
  const r = assessFdp({
    destinationCountry: "China",
    foreignItemEccn: "9A610",
    producedUsingUsTechnologyInAnyDorE: true
  });
  const six = [...r.rulesApplying, ...r.rulesIndeterminate].find((x) => x.id === "600_series");
  t("S4", six && six.productScope.itemScope.state === "met", six?.productScope.itemScope.reason);
}
{
  // Advanced computing reach is worldwide
  const r = assessFdp({
    destinationCountry: "Vietnam",
    foreignItemEccn: "3A090.a",
    producedUsingUsTechnologyEccns: ["3D001"]
  });
  t("S5", ids(r.rulesApplying).includes("advanced_computing"), `applying=${ids(r.rulesApplying).join(",")}`);
  const ac = r.rulesApplying.find((x) => x.id === "advanced_computing");
  t("S6", /worldwide/.test(ac.reachScope.reason), ac.reachScope.reason.slice(0, 80));
}
{
  // Footnote 5 route via an advanced-node fab, and the SME exclusion is honoured
  const r = assessFdp({
    destinationCountry: "China",
    foreignItemEccn: "3B002.b",
    producedByPlantThatIsDirectProductOfUsTechnology: true,
    recipientAtAdvancedNodeFacilityInMacauOrD5: true
  });
  t("S7", ids(r.rulesApplying).includes("entity_list_fn5_advanced_node"), `applying=${ids(r.rulesApplying).join(",")}`);
  // 3B002.c is excluded from the Footnote 5 item scope (it is in the SME set)
  const r2 = assessFdp({
    destinationCountry: "China",
    foreignItemEccn: "3B002.c",
    producedByPlantThatIsDirectProductOfUsTechnology: true,
    recipientAtAdvancedNodeFacilityInMacauOrD5: true
  });
  t(
    "S8",
    !ids(r2.rulesApplying).includes("entity_list_fn5_advanced_node"),
    `3B002.c is excluded from Footnote 5 scope; applying=${ids(r2.rulesApplying).join(",")}`
  );
  t("S9", ids(r2.rulesApplying).includes("sme"), "3B002.c is in the SME set instead");
}

// =========================================================================
// U.S.-origin short circuit
// =========================================================================
{
  const r = assessFdp({ destinationCountry: "China", foreignItemEccn: "3B001.c", itemIsUsOrigin: true });
  t("U1", r.notApplicable === true && r.conclusion.type === "us_origin_item", r.conclusion.type);
  const j = assessEarJurisdiction({ itemOrigin: "us", destinationCountry: "China" });
  t("U2", j.conclusion.type === "subject_to_ear", j.conclusion.type);
  t("U3", j.conclusion.basis.includes("15 C.F.R. § 734.3"), j.conclusion.basis.join(","));
}

// =========================================================================
// de minimis
// =========================================================================
{
  const cn = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "China", usControlledContentPercent: 20 });
  t("D1", cn.threshold.percent === 25 && cn.verdict.type === "de_minimis_threshold_met", `${cn.threshold.percent}% ${cn.verdict.type}`);
  const ir = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "Iran", usControlledContentPercent: 20 });
  t("D2", ir.threshold.percent === 10 && ir.verdict.type === "subject_to_ear", `${ir.threshold.percent}% ${ir.verdict.type}`);
  const ir8 = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "Iran", usControlledContentPercent: 8 });
  t("D3", ir8.verdict.type === "de_minimis_threshold_met", ir8.verdict.type);
  const cu = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "Cuba", usControlledContentPercent: 20 });
  t("D4", cu.threshold.percent === 10, `Cuba is E:2, threshold ${cu.threshold.percent}%`);
}
{
  // Boundary: exactly at the threshold passes ("valued at 25% or less")
  const at25 = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "Japan", usControlledContentPercent: 25 });
  t("D5", at25.verdict.type === "de_minimis_threshold_met", `25% exactly -> ${at25.verdict.type}`);
  const over = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "Japan", usControlledContentPercent: 25.1 });
  t("D6", over.verdict.type === "subject_to_ear", `25.1% -> ${over.verdict.type}`);
}
{
  // § 734.4(a) removes the threshold entirely
  const sme = assessDeMinimis({
    foreignItemType: "commodity",
    destinationCountry: "China",
    foreignItemEccn: "3B001.c",
    usControlledContentPercent: 1,
    noDeMinimisFacts: { containsUsOriginIntegratedCircuit: true }
  });
  t("D7", sme.verdict.type === "no_de_minimis_available", sme.verdict.type);
  t("D8", sme.noDeMinimisLevel.triggered.some((c) => c.citation === "15 C.F.R. § 734.4(a)(8)"), sme.noDeMinimisLevel.triggered.map((c) => c.citation).join(","));

  const fn5 = assessDeMinimis({
    foreignItemType: "commodity",
    destinationCountry: "China",
    foreignItemEccn: "3B002.b",
    usControlledContentPercent: 1,
    noDeMinimisFacts: { containsUsOriginIntegratedCircuit: true }
  });
  t("D9", fn5.noDeMinimisLevel.triggered.some((c) => c.citation === "15 C.F.R. § 734.4(a)(9)"), fn5.noDeMinimisLevel.triggered.map((c) => c.citation).join(","));

  const enc = assessDeMinimis({
    foreignItemType: "technology",
    destinationCountry: "Germany",
    usControlledContentPercent: 1,
    noDeMinimisFacts: { incorporates5E002EncryptionTechnology: true }
  });
  t("D10", enc.verdict.type === "no_de_minimis_available", enc.verdict.type);
}
{
  // Missing percentage must be indeterminate, never a pass
  const r = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "Germany" });
  t("D11", r.verdict.type === "indeterminate", r.verdict.type);
  t("D12", /not a de minimis pass/i.test(r.verdict.statement), "absence of a figure is not a pass");
}
{
  // Separately exported U.S. software is never de minimis eligible
  const r = assessDeMinimis({
    foreignItemType: "software",
    destinationCountry: "Germany",
    usControlledContentPercent: 2,
    usSoftwareBundled: false
  });
  t("D13", r.verdict.type === "subject_to_ear", r.verdict.type);
  t("D14", /not bundled or incorporated/.test(r.verdict.statement), "explains why");
}
{
  // Technology requires the one-time BIS report before reliance
  const r = assessDeMinimis({
    foreignItemType: "technology",
    destinationCountry: "Germany",
    usControlledContentPercent: 5,
    commingledTechnologyReportFiled: false
  });
  const cond = r.conditions.find((c) => /one-time report/i.test(c.requirement));
  t("D15", Boolean(cond) && cond.satisfied === false, `condition satisfied=${cond?.satisfied}`);
}
{
  // de minimis must always carry the FDP warning
  const r = assessDeMinimis({ foreignItemType: "commodity", destinationCountry: "Japan", usControlledContentPercent: 1 });
  t("D16", r.alwaysAlso.some((a) => a.citation === "15 C.F.R. § 734.9"), "FDP cross-reference present");
  t("D17", /no percentage test/i.test(r.alwaysAlso.find((a) => a.citation === "15 C.F.R. § 734.9").requirement), "states FDP has no percentage test");
}

// =========================================================================
// The combined trap: de minimis passes but FDP still captures
// =========================================================================
{
  const r = assessEarJurisdiction({
    destinationCountry: "China",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["3E992"],
    usControlledContentPercent: 0
  });
  t("J1", r.deMinimis.verdict.type === "de_minimis_threshold_met", `de minimis: ${r.deMinimis.verdict.type}`);
  t("J2", r.conclusion.type === "subject_to_ear", `overall: ${r.conclusion.type}`);
  t("J3", r.conclusion.basis.includes("15 C.F.R. § 734.9(k)"), r.conclusion.basis.join(","));
  t("J4", /zero percent U\.S\. content/.test(r.conclusion.statement), "states the zero-content point explicitly");
  t("J5", r.routesAssessed.length === 2, r.routesAssessed.join(","));
}
{
  // Nothing established must not read as clearance
  const r = assessEarJurisdiction({
    destinationCountry: "Japan",
    foreignItemEccn: "EAR99",
    usControlledContentPercent: 1,
    entityListFootnotes: [],
    entityListFootnotesKnown: true,
    producedUsingUsTechnologyEccns: [],
    producedUsingUsTechnologyInAnyDorE: false,
    producedByPlantThatIsDirectProductOfUsTechnology: false,
    containsIcFromSuchPlant: false,
    forSupercomputerInPrcOrMacau: false
  });
  t("J6", ["not_established_as_subject_to_ear", "indeterminate"].includes(r.conclusion.type), r.conclusion.type);
  t("J7", /not a clearance|NOT a finding/i.test(r.conclusion.statement), r.conclusion.statement.slice(0, 90));
}
{
  // An unresolved FDP prong must block a de-minimis-only conclusion
  const r = assessEarJurisdiction({
    destinationCountry: "Japan",
    foreignItemEccn: "3B001.c",
    usControlledContentPercent: 1
  });
  t("J8", r.conclusion.type === "indeterminate", r.conclusion.type);
  t("J9", r.openQuestions.length > 0, `${r.openQuestions.length} open question(s)`);
  t("J10", r.openQuestions.some((q) => q.route === "fdp"), "FDP questions surfaced");
}
{
  // § 734.4(a) and FDP can both bite
  const r = assessEarJurisdiction({
    destinationCountry: "China",
    foreignItemEccn: "3B001.c",
    producedUsingUsTechnologyEccns: ["3E992"],
    usControlledContentPercent: 1,
    noDeMinimisFacts: { containsUsOriginIntegratedCircuit: true }
  });
  t("J11", r.conclusion.type === "subject_to_ear", r.conclusion.type);
  t("J12", r.conclusion.basis.length >= 2, `basis: ${r.conclusion.basis.join(" | ")}`);
}

// =========================================================================
// Provenance and rule inventory
// =========================================================================
{
  t("V1", FDP_RULES.length === 13, `${FDP_RULES.length} rules transcribed`);
  const paras = FDP_RULES.map((r) => r.paragraph);
  t("V2", new Set(paras).size === paras.length, `paragraphs unique: ${paras.join(",")}`);
  t(
    "V3",
    FDP_RULES.every((r) => r.citation.startsWith("15 C.F.R. § 734.9")),
    "all rules cite § 734.9"
  );
  t(
    "V4",
    FDP_RULES.every((r) => r.reach && r.reach.type),
    "every rule declares a reach type"
  );
  const r = assessFdp({ destinationCountry: "Japan", foreignItemEccn: "EAR99" });
  t("V5", r.provenance.fdp.ecfrIssueDate === "2026-07-23", r.provenance.fdp.ecfrIssueDate);
  t("V6", /transcribed/i.test(r.provenance.fdp.transcribedNotParsed), "provenance discloses transcription");
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exitCode = fails ? 1 : 0;
