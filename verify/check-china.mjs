// Regression checks for the PRC export-control module.
//
// The failure modes this pins are specific to how this regime differs from the
// EAR: a suspended measure must not read as absent, a 0.1 percent floor must not
// be treated like a de minimis ceiling, a name that did not match an incomplete
// list must not read as cleared, and a shipment with both ends outside China must
// not read as out of scope.

import {
  assessChinaExportControls,
  measureStatusOn,
  CHINA_STATUSES,
  RARE_EARTH_TECHNOLOGY_TYPES
} from "../src/rules/china.js";
import {
  CHINA_PROVENANCE,
  ANNOUNCEMENTS,
  ANNOUNCEMENT_BY_ID,
  SUSPENSION,
  EXTRATERRITORIAL_ROUTES,
  KNOWN_DESIGNATIONS,
  ENTITY_MECHANISMS,
  NOT_MODELLED
} from "../src/data/china-export-control.js";

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};
const ask = (input) => assessChinaExportControls(input);
const ids = (r) => r.findings.map((f) => f.id);
const byId = (r, id) => r.findings.find((f) => f.id === id);

// =========================================================================
// Dataset shape and honesty markers
// =========================================================================
{
  t("D1", CHINA_PROVENANCE.handTranscribed === true, "must declare itself hand-transcribed");
  t("D2", /no versioned machine-readable/i.test(CHINA_PROVENANCE.transcribedNotParsed), "must say why");
  t("D3", Boolean(CHINA_PROVENANCE.asOfDate), CHINA_PROVENANCE.asOfDate);
  t("D4", KNOWN_DESIGNATIONS.complete === false, "the designation list must declare itself incomplete");
  t(
    "D5",
    /has NOT been cleared/i.test(KNOWN_DESIGNATIONS.completenessWarning),
    "the incompleteness warning must say a non-match is not a clearance"
  );
  t("D6", NOT_MODELLED.length >= 4, `${NOT_MODELLED.length} not-modelled entries`);
  t(
    "D7",
    NOT_MODELLED.some((n) => /Export Control List for Dual-Use Items/i.test(n.item)),
    "the control list must be disclosed as absent"
  );
  // Article numbers were deliberately not asserted. If someone adds one later
  // without verifying it, this is the tripwire.
  const blob = JSON.stringify(ANNOUNCEMENTS) + JSON.stringify(NOT_MODELLED);
  t(
    "D8",
    !/Export Control Law,?\s*Article\s*\d+/i.test(blob),
    "no unverified Export Control Law article numbers may be asserted"
  );
  t("D9", RARE_EARTH_TECHNOLOGY_TYPES.length === 5, `${RARE_EARTH_TECHNOLOGY_TYPES.length} technology routes`);
  t("D10", EXTRATERRITORIAL_ROUTES.length === 3, `${EXTRATERRITORIAL_ROUTES.length} No. 61 routes`);
}

// =========================================================================
// The suspension. This is the fact that decides most answers.
// =========================================================================
{
  t("S1", SUSPENSION.until === "2026-11-10", SUSPENSION.until);
  t("S2", SUSPENSION.from === "2025-11-07", SUSPENSION.from);
  t("S3", SUSPENSION.suspends.length === 6, SUSPENSION.suspends.join(","));
  t("S4", SUSPENSION.doesNotSuspend.includes("2025-18"), "No. 18 must be recorded as not suspended");
  t(
    "S5",
    /not repealed/i.test(SUSPENSION.legalEffect),
    "the legal effect must say the instruments survive the pause"
  );
  t("S6", /not an exemption/i.test(SUSPENSION.whatToDoNow), "must say suspension is not an exemption");

  // Boundary dates for No. 61. Three states, not two: it was published on
  // 2025-10-09, was not due to commence until 2025-12-01, and was suspended on
  // 2025-11-07 in between. So it is never operative before the pause expires.
  const cases = [
    ["2025-10-20", { operative: false, notYetEffective: true, suspended: false }],
    ["2025-11-06", { operative: false, notYetEffective: true, suspended: false }],
    ["2025-11-30", { operative: false, notYetEffective: true, suspended: false }],
    ["2025-12-01", { operative: false, notYetEffective: undefined, suspended: true }],
    ["2026-07-31", { operative: false, notYetEffective: undefined, suspended: true }],
    ["2026-11-09", { operative: false, notYetEffective: undefined, suspended: true }],
    ["2026-11-10", { operative: true, notYetEffective: undefined, suspended: false }],
    ["2026-11-11", { operative: true, notYetEffective: undefined, suspended: false }]
  ];
  cases.forEach(([d, want], i) => {
    const s = measureStatusOn("2025-61", d, "content-floor");
    const ok =
      s.operative === want.operative &&
      Boolean(s.suspended) === Boolean(want.suspended) &&
      Boolean(s.notYetEffective) === Boolean(want.notYetEffective);
    t(
      `S7.${i + 1}`,
      ok,
      `${d} operative=${s.operative} suspended=${Boolean(s.suspended)} notYetEffective=${Boolean(s.notYetEffective)}`
    );
  });

  // No. 18 is never in the window.
  for (const [i, d] of ["2025-11-08", "2026-07-31", "2026-11-11"].entries()) {
    t(`S8.${i + 1}`, measureStatusOn("2025-18", d).operative === true, `No. 18 must stay operative on ${d}`);
  }
}

// =========================================================================
// Announcement No. 18 survived the suspension
// =========================================================================
{
  const r = ask({ itemCategory: "rare_earth", rareEarthElements: ["dysprosium"] });
  t("A1", ids(r).includes("no18-elements"), ids(r).join(","));
  const f = byId(r, "no18-elements");
  t("A2", f.status === "license_required", f.status);
  t("A3", /NOT suspended/i.test(f.important), "must warn that this one was not suspended");
  t("A4", r.status === "license_required", r.status);

  // Element names must be found in free text too, in English and Chinese.
  const en = ask({ itemDescription: "sintered magnet containing terbium and gadolinium" });
  t("A5", ids(en).includes("no18-elements"), "English element names in free text");
  t("A6", byId(en, "no18-elements").elements.sort().join(",") === "gadolinium,terbium", byId(en, "no18-elements").elements.join(","));
  const zh = ask({ itemDescription: "含镝的钕铁硼永磁体" });
  t("A7", ids(zh).includes("no18-elements"), "Chinese element names in free text");

  // An uncontrolled rare earth must not fire it. Neodymium is not on the No. 18 list.
  const nd = ask({ itemDescription: "neodymium iron boron magnet", itemCategory: "rare_earth" });
  t("A8", !ids(nd).includes("no18-elements"), "neodymium alone must not trigger No. 18");
  t(
    "A9",
    nd.inputGaps.some((g) => g.field === "rareEarthElements"),
    "a rare-earth item with no controlled element must raise a gap, not go quiet"
  );

  const lu = ask({ rareEarthElements: ["lutetium"] });
  const luFinding = byId(lu, "no18-elements");
  t("A10", Boolean(luFinding), "lutetium still points to No. 18");
  t(
    "A11",
    !luFinding.controlledForms.find((x) => x.element === "lutetium").forms.includes("permanent magnet materials"),
    "lutetium must not inherit the permanent-magnet category from other elements"
  );
}

// =========================================================================
// The 0.1 percent floor, which runs the opposite way to EAR de minimis
// =========================================================================
{
  const above = ask({ containsChineseOriginRareEarths: true, chineseOriginRareEarthValuePercent: 0.1 });
  const a = above.extraterritorialRoutes.find((x) => /1\(a\)/.test(x.limb));
  t("F1", a.met === "yes", `0.1 percent exactly must be caught: ${a.met}`);

  const below = ask({ containsChineseOriginRareEarths: true, chineseOriginRareEarthValuePercent: 0.09 });
  t("F2", below.extraterritorialRoutes.find((x) => /1\(a\)/.test(x.limb)).met === "no", "0.09 percent is below the floor");

  // A percentage that would comfortably clear EAR de minimis is caught here.
  const twenty = ask({ containsChineseOriginRareEarths: true, chineseOriginRareEarthValuePercent: 20 });
  t("F3", twenty.extraterritorialRoutes.find((x) => /1\(a\)/.test(x.limb)).met === "yes", "20 percent is caught");
  const f = byId(twenty, "no61-extraterritorial");
  t("F4", Boolean(f), "a met route must produce a finding");
  t(
    "F5",
    (f.earContrast ?? []).some((c) => /ceiling/i.test(c) && /floor/i.test(c)),
    "the finding must contrast the EAR ceiling with the Chinese floor"
  );
  t("F6", EXTRATERRITORIAL_ROUTES[0].thresholdDirection === "floor", EXTRATERRITORIAL_ROUTES[0].thresholdDirection);

  // Missing percentage must be a gap, never a pass.
  const unknown = ask({ containsChineseOriginRareEarths: true });
  t("F7", unknown.extraterritorialRoutes.find((x) => /1\(a\)/.test(x.limb)).met === "unknown", "missing percentage is unknown");
  t(
    "F8",
    unknown.inputGaps.some((g) => g.field === "chineseOriginRareEarthValuePercent"),
    "missing percentage must raise a gap"
  );
}

// =========================================================================
// A suspended measure must not read as absent
// =========================================================================
{
  const now = ask({
    asOfDate: "2026-07-31",
    producedOutsideChinaUsingChineseRareEarthTechnology: true,
    chineseRareEarthTechnologyTypes: ["magnetic_material_manufacturing"]
  });
  const f = byId(now, "no61-extraterritorial");
  t("R1", f.status === "license_required_if_reactivated", f.status);
  t("R2", now.status === "license_required_if_reactivated", now.status);
  t("R3", /not an exemption|revive/i.test(now.summary), now.summary.slice(0, 120));
  t("R4", now.summary.includes("2026-11-10"), "the summary must carry the expiry date");
  t("R5", f.measureStatus.suspended === true && f.measureStatus.daysUntilRevival === 102, JSON.stringify(f.measureStatus.daysUntilRevival));

  // After expiry the same facts become an operative requirement.
  const later = ask({
    asOfDate: "2026-12-01",
    producedOutsideChinaUsingChineseRareEarthTechnology: true
  });
  t("R6", byId(later, "no61-extraterritorial").status === "license_required", byId(later, "no61-extraterritorial").status);
  t("R7", later.status === "license_required", later.status);

  // No. 61's extraterritorial limbs never operated: the pause landed on
  // 2025-11-07, before the announcement's own 2025-12-01 commencement date.
  // A date inside the pause must not be reported as operative just because it
  // sits after the announcement was published.
  const inside = ask({ asOfDate: "2025-12-15", itemOriginChina: true });
  t("R8", byId(inside, "no61-extraterritorial").status === "license_required_if_reactivated", byId(inside, "no61-extraterritorial").status);
  const preCommencement = measureStatusOn("2025-61", "2025-10-20", "content-floor");
  t("R9", preCommencement.notYetEffective === true, JSON.stringify(preCommencement));
  t("R10", preCommencement.operative === false, "published is not the same as operative");
  t(
    "R11",
    /never operated/i.test(preCommencement.neverOperated ?? ""),
   "the record must state that these limbs never operated"
 );
  t(
    "R12",
    /absence of enforcement history|no enforcement history/i.test(ANNOUNCEMENT_BY_ID["2025-61"].neverOperated),
   "and must say why that is a reason to plan for it rather than discount it"
 );
}

// =========================================================================
// Entity mechanisms: incomplete list, so no non-match may read as cleared
// =========================================================================
{
  const r = ask({ counterpartyNames: ["Rheinmetall AG", "Some Unlisted GmbH"] });
  t("E1", r.entityScreening.status === "not_screenable", r.entityScreening.status);
  t("E2", (r.entityScreening.incidentalMatches ?? []).length === 1, "Rheinmetall is recorded in this snapshot");
  // The bug this pins: a match on one name previously suppressed the question for
  // the others, letting an unscreened name ride along and read as cleared.
  t("E3", r.unansweredQuestions.length >= 1, "unmatched names must still raise a question");
  const q = r.unansweredQuestions.find((x) => /Some Unlisted GmbH/.test(x.question));
  t("E4", Boolean(q), `the unmatched name must be named: ${JSON.stringify(r.unansweredQuestions.map((x) => x.question))}`);
  t("E5", !/Rheinmetall/.test(q?.question ?? ""), "the matched name must not be swept into the unscreened question");
  t("E6", /not a clearance/i.test(q?.why ?? ""), q?.why?.slice(0, 80));

  // Nothing supplied at all: no false comfort either.
  const none = ask({});
  t("E7", none.entityScreening.status === "not_screenable", none.entityScreening.status);

  // The 管控名单 prohibition must be recorded as binding non-Chinese parties.
  const cl = ENTITY_MECHANISMS.find((m) => m.id === "control-list");
  t("E8", cl.bindsNonChineseParties === true, "管控名单 binds parties in any country");
  t(
    "E9",
    cl.prohibits.some((p) => /ANY country|any country/.test(p)),
    "the prohibition text must say it reaches suppliers anywhere"
  );
  const uel = ENTITY_MECHANISMS.find((m) => m.id === "uel");
  t("E10", uel.bindsNonChineseParties === false, "the UEL is a different mechanism with different reach");
}

// =========================================================================
// Both ends outside China is not out of scope
// =========================================================================
{
  const r = ask({
    exportFromCountry: "Korea, South",
    exportToCountry: "Vietnam",
    itemOriginChina: true
  });
  t(
    "X1",
    r.caveats.some((c) => /both ends of this shipment are outside China/i.test(c.point ?? "")),
    "a wholly non-Chinese shipment must be told it is still in scope"
  );
  t("X2", byId(r, "no61-extraterritorial")?.routesMet?.length >= 1, "Chinese origin alone meets 1(c)");

  // A shipment out of China does not get the caveat, which is about the surprise.
  const fromCn = ask({ exportFromCountry: "China", exportToCountry: "Vietnam", itemOriginChina: true });
  t(
    "X3",
    !fromCn.caveats.some((c) => /both ends of this shipment are outside China/i.test(c.point ?? "")),
    "no such caveat when the export leaves China"
  );
}

// =========================================================================
// Military end user and the 50 percent affiliates rule
// =========================================================================
{
  const mil = ask({ endUserMilitary: true });
  const f = byId(mil, "no61-military-end-user");
  t("M1", Boolean(f), ids(mil).join(","));
  t("M2", /in principle not permitted/i.test(f.rule), f.rule.slice(0, 70));
  t("M3", /prohibition to be rebutted/i.test(f.effect), "must not read as a licence to apply for");

  const sub = ask({ counterpartyIsSubsidiaryOfListedEntity: true });
  const g = byId(sub, "no61-affiliates");
  t("M4", Boolean(g), ids(sub).join(","));
  t("M5", /50 percent/i.test(g.rule), g.rule.slice(0, 70));
  t("M6", /744\.21\(a\)\(3\)/.test(g.earAnalogue ?? ""), g.earAnalogue);
}

// =========================================================================
// Category pointers
// =========================================================================
{
  const bat = ask({ itemCategory: "lithium_battery" });
  t("C1", ids(bat).includes("no58-battery"), ids(bat).join(","));
  t("C2", byId(bat, "no58-battery").measure === "No. 58 of 2025", byId(bat, "no58-battery").measure);
  const tech = ask({ itemCategory: "rare_earth_technology" });
  t("C3", ids(tech).includes("no62-technology"), ids(tech).join(","));
  t(
    "C4",
    /intangible transfer|Intangible transfer/.test(byId(tech, "no62-technology").note),
    "the technology finding must warn about intangible transfer"
  );

  const superhard = ask({ itemCategory: "superhard_material" });
  t("C5", ids(superhard).includes("no55-superhard-material"), ids(superhard).join(","));
  t("C6", byId(superhard, "no55-superhard-material").status === "license_required_if_reactivated", byId(superhard, "no55-superhard-material").status);
  const equipment = ask({ itemCategory: "rare_earth_equipment" });
  t("C7", ids(equipment).includes("no56-rare-earth-equipment"), ids(equipment).join(","));
  const strategic = ask({ itemCategory: "strategic_mineral" });
  t("C8", byId(strategic, "no10-strategic-minerals").status === "requires_verification", byId(strategic, "no10-strategic-minerals").status);
  const no10 = ANNOUNCEMENT_BY_ID["2025-10"].controlledCodes;
  t("C9", no10.includes("6C001.a") && no10.includes("6E002") && no10.includes("3E004"), no10.join(","));
  const no56 = ANNOUNCEMENT_BY_ID["2025-56"].controlledCodes;
  t("C10", no56.includes("2B902") && no56.includes("1C914"), no56.join(","));
  const no58 = ANNOUNCEMENT_BY_ID["2025-58"].controlledCodes;
  t("C11", no58.includes("3A001") && no58.includes("3C902.b.2") && no58.includes("3E901.b"), no58.join(","));
  const no62 = ANNOUNCEMENT_BY_ID["2025-62"].controlledCodes;
  t("C12", no62.join(",") === "1E902.a,1E902.b", no62.join(","));
}

// =========================================================================
// Nothing may report as clear
// =========================================================================
{
  const empty = ask({ asOfDate: "2026-07-31" });
  t("N1", CHINA_STATUSES.includes(empty.status), empty.status);
  t("N2", empty.status !== "no_requirement" && empty.status !== "clear", empty.status);
  t(
    "N3",
    /not a clearance|Do not read this as an absence/i.test(empty.summary),
    empty.summary.slice(0, 100)
  );
  t(
    "N4",
    empty.caveats.some((c) => /not bundled/i.test(c.point ?? "")),
    "every answer must disclose that no item was classified"
  );
  t("N5", empty.nextSteps.some((s) => /Do not carry a U\.S\. de minimis conclusion across/.test(s)), "the cross-regime warning must be in nextSteps");

  // The announcement register must travel with every answer, carrying live state.
  t("N6", empty.announcementRegister.length === ANNOUNCEMENTS.length, `${empty.announcementRegister.length} entries`);
  const reg61 = empty.announcementRegister.find((a) => a.number === "No. 61 of 2025");
  t("N7", reg61.state === "suspended", reg61.state);
  t("N8", reg61.daysUntilRevival === 102, String(reg61.daysUntilRevival));
  const reg18 = empty.announcementRegister.find((a) => a.number === "No. 18 of 2025");
  t("N9", reg18.state === "in_force" && reg18.notSuspended === true, `${reg18.state} notSuspended=${reg18.notSuspended}`);
  t("N10", Boolean(ANNOUNCEMENT_BY_ID["2026-30"]), "the July 2026 EU designation announcement is recorded");
  t("N10b", Boolean(ANNOUNCEMENT_BY_ID["2026-23"]), "the June 2026 U.S. designation announcement is recorded");

  // The constant reference material moved to a resource; the pointer must remain
  // so a reader can still find what is not modelled.
  t("N11", empty.fullFramework?.resource === "export-controls://china-framework", JSON.stringify(empty.fullFramework));
  t("N12", Array.isArray(empty.notModelled) && empty.notModelled.length >= 4, `${empty.notModelled?.length} not-modelled items`);

  // Payload budget. This tool carries a constant register, so it is the largest
  // in the server; keep it from creeping.
  const kb = JSON.stringify(empty).length / 1024;
  t("N13", kb < 13, `empty payload is ${kb.toFixed(1)} KB`);
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exitCode = fails ? 1 : 0;
