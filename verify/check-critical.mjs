// Regression probes for the four Critical defects found in verification.
import { analyzeLicenseExceptions } from "../src/rules/license-exceptions.js";
import { checkPart744 } from "../src/rules/part744.js";

let fails = 0;
function check(id, desc, ok, detail) {
  const verdict = ok ? "PASS" : "FAIL";
  if (!ok) fails++;
  console.log(`${verdict}  ${id}  ${desc}`);
  if (detail) console.log(`        ${detail}`);
}

// ---- T8.3: 3B001.f -> China, $2,500. Must NOT offer LVS. ----
{
  const r = analyzeLicenseExceptions({
    eccn: "3B001.f.1",
    destinationCountry: "China",
    itemType: "hardware",
    valueUsd: 2500
  });
  const review = r.exceptionsToReview.flatMap((e) => e.symbols);
  const gate = r.mandatoryRestrictions.find((g) => g.citation === "15 C.F.R. § 740.2(a)(9)(i)");
  check("T8.3a", "740.2(a)(9)(i) gate fires for 3B001.f.1 -> China", Boolean(gate), gate?.detail);
  check("T8.3b", "LVS is not offered for review", !review.includes("LVS"), `review = [${review.join(", ")}]`);
  check(
    "T8.3c",
    "LVS explicitly foreclosed",
    r.exceptionsForeclosed.some((e) => e.symbols.includes("LVS")),
    r.exceptionsForeclosed.find((e) => e.symbols.includes("LVS"))?.whyStatus
  );
  check("T8.3d", "only GOV survives the gate", review.length === 1 && review[0] === "GOV", `review = [${review.join(", ")}]`);
}

// ---- T8.9: 3D001 software -> China. Must NOT offer ENC. ----
{
  const r = analyzeLicenseExceptions({
    eccn: "3D001",
    destinationCountry: "China",
    itemType: "software"
  });
  const review = r.exceptionsToReview.flatMap((e) => e.symbols);
  const enc = [...r.exceptionsToReview, ...r.exceptionsForeclosed, ...r.exceptionsOutOfScope].find((e) =>
    e.symbols.includes("ENC")
  );
  check("T8.9a", "ENC is not offered for review", !review.includes("ENC"), `review = [${review.join(", ")}]`);
  check("T8.9b", "ENC status is foreclosed or out_of_scope", enc && enc.status !== "requires_verification", enc?.whyStatus);
  check(
    "T8.9c",
    "740.2(a)(9)(i) gate fires for 3D001 -> China",
    r.mandatoryRestrictions.some((g) => g.citation === "15 C.F.R. § 740.2(a)(9)(i)")
  );
}

// ---- T7.10: 60%-owned subsidiary of an Entity List company ----
{
  const r = checkPart744({
    destinationCountry: "Singapore",
    endUser: "a 60%-owned subsidiary of an Entity List company",
    endUse: "commercial servers",
    eccn: "3A090.a",
    endUserScreening: {
      screeningPerformed: true,
      ownershipPercentByListedEntity: 60,
      headquarteredInMacauOrD5: false
    }
  });
  const aff = r.issuesToReview.find((i) => /Affiliates rule/i.test(i.rule));
  check("T7.10a", "affiliates rule (50%) fires", Boolean(aff), aff?.requirement?.slice(0, 120));
  check("T7.10b", "outcome is not a clearance", r.outcome.type === "licence_requirement_identified", r.outcome.type);
}

// ---- T7.9: Korean-owned fab in China, 3B001.a deposition tool ----
{
  const r = checkPart744({
    destinationCountry: "China",
    endUser: "SK hynix Wuxi (Korean-owned fab)",
    endUse: "commercial DRAM production",
    eccn: "3B001.a",
    flags: { semiconductorFabEndUse: true, advancedNodeProduction: "unknown" },
    endUserScreening: { screeningPerformed: true }
  });
  const s744_23 = r.issuesToReview.find((i) => i.citation.includes("744.23"));
  check("T7.9a", "744.23 fires for an IC fab in China", Boolean(s744_23), s744_23?.citation);
  check("T7.9b", "outcome flags a licence requirement", r.outcome.type === "licence_requirement_identified", r.outcome.type);
  const veu = r.alwaysCheck.find((a) => /Validated End User/i.test(a.requirement));
  check("T7.9c", "VEU revocation surfaced", Boolean(veu));

  // advanced node = yes must reach ANY item, including EAR99
  const r2 = checkPart744({
    destinationCountry: "China",
    eccn: "EAR99",
    flags: { semiconductorFabEndUse: true, advancedNodeProduction: "yes" },
    endUserScreening: { screeningPerformed: true }
  });
  check(
    "T7.9d",
    "744.23(a)(2)(i) reaches EAR99 at an advanced-node fab",
    r2.issuesToReview.some((i) => i.citation.includes("744.23(a)(2)(i)")),
    r2.issuesToReview.find((i) => i.citation.includes("744.23(a)(2)(i)"))?.effect?.slice(0, 100)
  );
}

// ---- Citation corrections ----
{
  const r = analyzeLicenseExceptions({ eccn: "3E001", destinationCountry: "Germany", itemType: "technology" });
  const all = [...r.exceptionsToReview, ...r.exceptionsForeclosed, ...r.exceptionsOutOfScope];
  const tsr = all.find((e) => e.symbols.includes("TSR"));
  const tsu = all.find((e) => e.symbols.includes("TSU"));
  const civ = all.find((e) => e.symbols.includes("CIV"));
  const spp = all.find((e) => e.symbols.includes("SPP"));
  all.push(...r.exceptionsNotModelled);
  check("CIT1", "TSR cited as § 740.6", tsr?.section === "15 C.F.R. § 740.6", tsr?.section);
  check("CIT2", "TSU cited as § 740.13", tsu?.section === "15 C.F.R. § 740.13", tsu?.section);
  check("CIT3", "CIV no longer appears", !civ);
  check("CIT4", "§ 740.5 is SPP", spp?.section === "15 C.F.R. § 740.5", `${spp?.section} ${spp?.title}`);
  const newOnes = ["NAC", "HBM", "IEC", "AIA", "ACM", "RFF", "LPP", "RPL", "APR"];
  const present = newOnes.filter((s) => all.some((e) => e.symbols.includes(s)));
  check("CIT5", "modern exceptions present", present.length === newOnes.length, `present = [${present.join(", ")}]`);
}

// ---- Taiwan STA regression (previously wrongly denied) ----
{
  const r = analyzeLicenseExceptions({ eccn: "3B001.f.1", destinationCountry: "Taiwan", itemType: "hardware", valueUsd: 5_000_000 });
  const sta = r.exceptionsToReview.find((e) => e.symbols.includes("STA"));
  check("TW1", "STA reviewable for Taiwan (A:6)", Boolean(sta), sta?.whyStatus);
  const gbs = r.exceptionsToReview.find((e) => e.symbols.includes("GBS"));
  check("TW2", "GBS reviewable for Taiwan (Country Group B) with per-ECCN condition", Boolean(gbs), gbs?.conditionsToVerify?.[0]);
}

// ---- Known-good answers must be preserved ----
{
  const r = analyzeLicenseExceptions({ eccn: "3E001", destinationCountry: "China", itemType: "technology" });
  const review = r.exceptionsToReview.flatMap((e) => e.symbols);
  check("REG1", "3E001 -> China still yields only GOV", review.length === 1 && review[0] === "GOV", `review = [${review.join(", ")}]`);

  const p = checkPart744({
    destinationCountry: "Korea, Republic of",
    endUser: "Samsung Electronics Hwaseong",
    endUse: "commercial DRAM",
    eccn: "3B001.c",
    endUserScreening: { screeningPerformed: true }
  });
  check("REG2", "clean Korea transaction yields no heuristic flag", p.outcome.type === "no_heuristic_flag", p.outcome.type);
  check(
    "REG3",
    "but is explicitly not a clearance",
    /NOT a clearance/i.test(p.outcome.statement)
  );

  const pk = checkPart744({
    destinationCountry: "Pakistan",
    endUse: "uranium enrichment centrifuge program",
    flags: { nuclearActivity: true },
    endUserScreening: { screeningPerformed: true }
  });
  check("REG4", "Pakistan nuclear still blocking", pk.issuesToReview.some((i) => i.citation === "15 C.F.R. § 744.2" && i.severity === "blocking"));
}

// ---- India missile over-trigger must be gated now ----
{
  const r = checkPart744({
    destinationCountry: "India",
    endUse: "space launch vehicle stage separation",
    flags: { missileActivity: true },
    endUserScreening: { screeningPerformed: true }
  });
  const m = r.issuesToReview.find((i) => i.citation.startsWith("15 C.F.R. § 744.3"));
  check("IN1", "India civil space launch not marked blocking", m && m.severity !== "blocking", `${m?.citation} severity=${m?.severity}`);
  const r2 = checkPart744({
    destinationCountry: "India",
    flags: { missileActivity: true, wmdDeliverySystem: true },
    endUserScreening: { screeningPerformed: true }
  });
  check(
    "IN2",
    "but WMD-delivery flag makes 744.3(a)(2) blocking worldwide",
    r2.issuesToReview.some((i) => i.citation.includes("744.3(a)(2)") && i.severity === "blocking")
  );
}

// ---- Unresolvable destination must refuse to conclude ----
{
  const r = analyzeLicenseExceptions({ eccn: "3B001.f.1", destinationCountry: "Freedonia", itemType: "hardware" });
  check("UNK1", "unknown country produces an input gap", r.inputGaps.some((g) => g.field === "destinationCountry"));
  check("UNK2", "conclusion refuses to conclude", /No conclusion/i.test(r.conclusion.statement), r.conclusion.statement);
  const p = checkPart744({ destinationCountry: "Freedonia" });
  check("UNK3", "part744 cannot_evaluate on unknown country", p.outcome.type === "cannot_evaluate", p.outcome.type);
}

// ---- Bare CCL entry must be indeterminate, not negative ----
{
  const r = analyzeLicenseExceptions({ eccn: "3B001", destinationCountry: "China", itemType: "hardware" });
  const gate = r.mandatoryRestrictions.find((g) => g.citation === "15 C.F.R. § 740.2(a)(9)(i)");
  check("IND1", "bare 3B001 -> China still raises the gate", Boolean(gate), gate?.severity);
  check("IND2", "and flags the missing subparagraph", r.inputGaps.some((g) => g.field === "eccn"), r.inputGaps.find((g) => g.field === "eccn")?.problem);
  check(
    "IND3",
    "the conclusion surfaces the gate rather than only the gap",
    /mandatory Part 740 restriction may already apply/i.test(r.conclusion.statement),
    r.conclusion.statement.slice(0, 110)
  );
}

// ---- graded input gaps: a missing ECCN must not bury a real finding ----
{
  const r = checkPart744({
    destinationCountry: "China",
    flags: { smeDevelopmentOrProduction: true, usPersonSupport: true },
    endUserScreening: { screeningPerformed: true }
  });
  check(
    "GAP1",
    "no ECCN supplied is 'limiting', not 'fatal'",
    r.inputGaps.every((g) => g.field !== "destinationCountry") &&
      r.inputGaps.find((g) => g.field === "eccn")?.severity === "limiting",
    `gaps = ${JSON.stringify(r.inputGaps.map((g) => [g.field, g.severity]))}`
  );
  check(
    "GAP2",
    "blocking issues still drive the outcome",
    r.outcome.type === "licence_requirement_identified",
    `outcome=${r.outcome.type} blocking=${r.issuesToReview.filter((i) => i.severity === "blocking").length}`
  );
  check("GAP3", "and the limitation is stated", /input gap/i.test(r.outcome.statement), r.outcome.statement.slice(0, 120));

  const r2 = checkPart744({
    destinationCountry: "India",
    flags: { missileActivity: true, wmdDeliverySystem: true },
    endUserScreening: { screeningPerformed: true }
  });
  check(
    "GAP4",
    "744.3(a)(2) survives a missing ECCN",
    r2.outcome.type === "licence_requirement_identified" &&
      r2.issuesToReview.some((i) => i.citation.includes("744.3(a)(2)")),
    `outcome=${r2.outcome.type}`
  );

  const r3 = checkPart744({ destinationCountry: "Freedonia", eccn: "3B001.f.1" });
  check("GAP5", "unresolved destination is still fatal", r3.outcome.type === "cannot_evaluate", `outcome=${r3.outcome.type}`);
}

// ---- free-text cues must raise the unasked question -------------------
{
  // The original T7.9 input, with no flags set at all.
  const r = checkPart744({
    destinationCountry: "China",
    endUser: "SK hynix Wuxi (Korean-owned fab)",
    endUse: "commercial DRAM production",
    eccn: "3B001.a",
    endUserScreening: { screeningPerformed: true }
  });
  const q = r.unansweredQuestions.find((x) => x.citation.includes("744.23(a)(2)"));
  check(
    "Q1",
    "fab/DRAM prose raises the 744.23(a)(2) question even with no flags",
    Boolean(q),
    q ? `triggeredBy = [${q.triggeredBy.join(", ")}]` : `questions = ${JSON.stringify(r.unansweredQuestions.map((x) => x.citation))}`
  );
  check("Q2", "and says to set the flag", q?.setThisInput === "flags.semiconductorFabEndUse", q?.setThisInput);
  check(
    "Q3",
    "and is labelled a question, not a finding",
    /question, not a finding/i.test(q?.note ?? ""),
    q?.note?.slice(0, 60)
  );
  check(
    "Q4",
    "the question is not counted as an issue",
    !r.issuesToReview.some((i) => i.citation.includes("744.23")),
    "744.23 must not appear in issuesToReview without the fact stated"
  );
  check(
    "Q5",
    "next steps lead with answering it",
    /unansweredQuestions/.test(r.nextSteps[0]),
    r.nextSteps[0]?.slice(0, 80)
  );
}
{
  // An explicit answer must suppress the question and produce the finding.
  const r = checkPart744({
    destinationCountry: "China",
    endUser: "SK hynix Wuxi",
    endUse: "commercial DRAM production",
    eccn: "3B001.a",
    flags: { semiconductorFabEndUse: true, advancedNodeProduction: "unknown" },
    endUserScreening: { screeningPerformed: true }
  });
  check(
    "Q6",
    "answering the question removes it and adds the finding",
    !r.unansweredQuestions.some((x) => x.citation.includes("744.23(a)(2)")) &&
      r.issuesToReview.some((i) => i.citation.includes("744.23(a)(2)")),
    `questions=${r.unansweredQuestions.length} issues=${r.issuesToReview.filter((i) => i.citation.includes("744.23")).length}`
  );
}
{
  // Negated prose must not raise a question.
  const r = checkPart744({
    destinationCountry: "Japan",
    endUse: "Commercial audio equipment. No military use and no defence application.",
    eccn: "EAR99",
    endUserScreening: { screeningPerformed: true }
  });
  check(
    "Q7",
    "negated cues do not raise questions",
    !r.unansweredQuestions.some((x) => x.citation === "15 C.F.R. § 744.21"),
    `questions = ${JSON.stringify(r.unansweredQuestions.map((x) => x.citation))}`
  );
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exit(fails === 0 ? 0 : 1);
