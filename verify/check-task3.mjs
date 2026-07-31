import { classifyTransactionRisk } from "../src/rules/transaction-risk.js";
import { draftExportControlClause, buildDueDiligenceChecklist } from "../src/rules/clauses.js";

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

// ---- the two original false positives -----------------------------------
{
  const r = classifyTransactionRisk({
    description: "Sale of office stationery to a Japanese trading house.",
    destinationCountry: "Japan"
  });
  t("R1", r.detected.semiconductor.length === 0, `semiconductor = [${r.detected.semiconductor.join(", ")}]`);
  t("R2", r.riskTier === "low", `tier = ${r.riskTier}, normalized = ${r.score.normalized}`);
}
{
  const r = classifyTransactionRisk({
    description:
      "Strictly NO military end use, NO nuclear application, no missile programs. Purely commercial consumer display panel.",
    destinationCountry: "Taiwan"
  });
  t("R3", r.riskTier === "low", `tier = ${r.riskTier}, normalized = ${r.score.normalized}`);
  t(
    "R4",
    ["military", "nuclear", "missile"].every((x) => r.assertedAbsent.endUseConcern.includes(x)),
    `assertedAbsent = [${r.assertedAbsent.endUseConcern.join(", ")}]`
  );
  t("R5", r.detected.endUseConcern.length === 0, `detected = [${r.detected.endUseConcern.join(", ")}]`);
  t(
    "R6",
    r.matchingNotes.some((n) => /assertion by the counterparty, not verified fact/i.test(n)),
    "negation is flagged as an unverified assertion"
  );
}

// ---- genuine high risk still scores high --------------------------------
{
  const r = classifyTransactionRisk({
    description: "EUV lithography scanner spare parts with remote calibration support for an advanced node fab.",
    destinationCountry: "China",
    counterparty: "a party on the Entity List",
    endUse: "advanced node semiconductor fabrication for AI training supercomputer",
    hasUsOriginTechnology: true,
    hasEuTouchpoint: true,
    involvesTechnologyTransfer: true
  });
  t("R7", r.riskTier === "high", `tier = ${r.riskTier}, normalized = ${r.score.normalized}`);
  t("R8", r.score.normalized <= 100, `normalized = ${r.score.normalized} (must be bounded)`);
}

// ---- score is bounded even under keyword flooding -----------------------
{
  const r = classifyTransactionRisk({
    description:
      "battery cathode anode electrolyte separator lithium nickel cobalt manganese graphite precursor wafer chip semiconductor lithography etch deposition mask reticle military missile nuclear supercomputer surveillance intelligence entity list SDN sanctioned restricted party technology source code software know-how training calibration",
    destinationCountry: "Iran",
    hasUsOriginTechnology: true,
    hasEuTouchpoint: true,
    involvesTechnologyTransfer: true
  });
  t("R9", r.score.normalized <= 100, `normalized = ${r.score.normalized}`);
  t("R10", r.riskTier === "high", `tier = ${r.riskTier}`);
  const capped = r.scoreComponents.filter((c) => c.cappedAt !== null && c.cappedAt !== undefined);
  t("R11", capped.length > 0, `components capped: ${capped.map((c) => c.component).join(", ")}`);
}

// ---- destination comes from Country Groups, not keywords ----------------
{
  const r = classifyTransactionRisk({
    description: "Commercial display panels sold to Russia Trading Company, a Japanese distributor.",
    destinationCountry: "Japan"
  });
  t("R12", r.destination.canonical === "Japan", `destination = ${r.destination.canonical}`);
  t("R13", r.riskTier === "low", `tier = ${r.riskTier} (party name must not drive country risk)`);
}
{
  const r = classifyTransactionRisk({ description: "industrial valves", destinationCountry: "Kazakhstan" });
  t(
    "R14",
    r.destination.countryGroups.includes("D:1"),
    `Kazakhstan groups = ${r.destination.countryGroups.join(", ")}`
  );
  t("R15", r.destination.points > 0, `destination points = ${r.destination.points}`);
}
{
  const r = classifyTransactionRisk({ description: "test equipment", destinationCountry: "Macau" });
  t("R16", /Macau/.test(r.destination.basis), r.destination.basis);
}
{
  const r = classifyTransactionRisk({ description: "test equipment", destinationCountry: "Freedonia" });
  t("R17", r.destination.resolved === false, `matchType = ${r.destination.matchType}`);
  t("R18", /unassessed/i.test(r.destination.reason), r.destination.reason);
}

// ---- low tier is not a clearance ---------------------------------------
{
  const r = classifyTransactionRisk({ description: "paper clips", destinationCountry: "Japan" });
  t("R19", /NOT a clearance/i.test(r.toolContract), "contract states low is not a clearance");
}

// ---- riskLevel now changes clause output --------------------------------
{
  const low = draftExportControlClause({ transactionType: "equipment supply", riskLevel: "low" });
  const med = draftExportControlClause({ transactionType: "equipment supply", riskLevel: "medium" });
  const high = draftExportControlClause({ transactionType: "equipment supply", riskLevel: "high" });
  t("C1", low.clauses.length < med.clauses.length, `low=${low.clauses.length} med=${med.clauses.length}`);
  t("C2", med.clauses.length < high.clauses.length, `med=${med.clauses.length} high=${high.clauses.length}`);
  t(
    "C3",
    JSON.stringify(low.clauses) !== JSON.stringify(high.clauses),
    "low and high clause text must differ"
  );
  t("C4", high.clauses.some((c) => /734\.9/.test(c)), "high tier cites the FDP rules");
  t("C5", high.clauses.some((c) => /744\.6/.test(c)), "high tier covers U.S.-person activity");
  t("C6", med.clauses.some((c) => /50\s*퍼센트|50 percent/.test(c)), "medium tier has the affiliates representation");
  t("C7", low.clauses.every((c) => !/734\.9/.test(c)), "low tier omits the high-tier provisions");
  t("C8", Boolean(low.riskLevelEffect?.explanation), "riskLevelEffect explains what the setting bought");
}
{
  const en = draftExportControlClause({ language: "en", transactionType: "technology license", riskLevel: "high" });
  const ko = draftExportControlClause({ language: "ko", transactionType: "technology license", riskLevel: "high" });
  t("C9", en.clauses.length === ko.clauses.length, `en=${en.clauses.length} ko=${ko.clauses.length}`);
  t("C10", /export control/i.test(en.clauses[0]) && /수출통제/.test(ko.clauses[0]), "language parity");
}
{
  const noOpts = draftExportControlClause({
    transactionType: "x",
    riskLevel: "low",
    includeIndemnity: false,
    includeAuditRight: false
  });
  const withOpts = draftExportControlClause({ transactionType: "x", riskLevel: "low" });
  t("C11", withOpts.clauses.length === noOpts.clauses.length + 2, `${noOpts.clauses.length} vs ${withOpts.clauses.length}`);
}

// ---- industry now changes the checklist ---------------------------------
{
  const semi = buildDueDiligenceChecklist({ transactionStage: "pre_contract", industry: "semiconductor" });
  const batt = buildDueDiligenceChecklist({ transactionStage: "pre_contract", industry: "battery" });
  const both = buildDueDiligenceChecklist({ transactionStage: "pre_contract", industry: "both" });
  t(
    "K1",
    JSON.stringify(semi.flatChecklist) !== JSON.stringify(batt.flatChecklist),
    "semiconductor and battery checklists must differ"
  );
  t("K2", both.itemCount > semi.itemCount && both.itemCount > batt.itemCount, `semi=${semi.itemCount} batt=${batt.itemCount} both=${both.itemCount}`);
  t("K3", semi.flatChecklist.some((x) => /744\.23/.test(x)), "semiconductor list covers 744.23");
  t("K4", semi.flatChecklist.some((x) => /3B001\.a\.4/.test(x)), "semiconductor list covers 3B001 subparagraph scoping");
  t("K5", batt.flatChecklist.some((x) => /1C010/.test(x)), "battery list warns about 1C010");
  t("K6", batt.flatChecklist.every((x) => !/744\.23/.test(x)), "battery list omits the semiconductor-only items");
  t("K7", Boolean(semi.industryEffect?.explanation), "industryEffect explains the selection");
}
{
  const stages = ["pre_contract", "contracting", "pre_shipment", "technical_support", "post_shipment"];
  const sets = stages.map((s) => JSON.stringify(buildDueDiligenceChecklist({ transactionStage: s, industry: "both" }).checklist.stageSpecific));
  t("K8", new Set(sets).size === stages.length, "every stage yields a distinct stage-specific set");
  const ts = buildDueDiligenceChecklist({ transactionStage: "technical_support", industry: "both" });
  t("K9", ts.flatChecklist.some((x) => /deemed export/i.test(x)), "technical_support covers deemed exports");
  const post = buildDueDiligenceChecklist({ transactionStage: "post_shipment", industry: "both" });
  t("K10", post.flatChecklist.some((x) => /Validated End User/i.test(x)), "post_shipment covers VEU re-verification");
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exit(fails ? 1 : 0);
