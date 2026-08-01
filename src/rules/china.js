// PRC export-control assessment, MOFCOM.
//
// DESIGN CONTRACT
// Three things this module will not do.
//
// 1. It will not report that a transaction is clear. It holds neither the
//    Export Control List for Dual-Use Items nor any entity designation list, so
//    the two questions an exporter most wants answered cannot be answered here.
//    Statuses say what was found, and silence is reported as silence.
//
// 2. It will not treat a suspended measure as absent. Announcements Nos. 55, 56,
//    57, 58, 61 and 62 of 2025 are paused by Announcement No. 70 of 2025 until
//    10 November 2026, and the instruments remain law. A fact pattern that meets
//    a suspended test gets `license_required_if_reactivated`, with the date. A
//    reader who is told only "not currently required" will build a supply chain
//    that breaks on expiry.
//
// 3. It will not carry over a conclusion from the EAR. Announcement No. 61's
//    content test is a 0.1 percent floor, where § 734.4 is a 25 or 10 percent
//    ceiling. An item that comfortably clears U.S. de minimis is caught by the
//    Chinese rule at a fiftieth of the content, and the two analyses share
//    nothing but vocabulary.

import { containsTerm } from "../lib/text-match.js";
import {
  CHINA_PROVENANCE,
  INSTRUMENTS,
  ANNOUNCEMENTS,
  ANNOUNCEMENT_BY_ID,
  SUSPENSION,
  EXTRATERRITORIAL_ROUTES,
  NO61_END_USER_RULE,
  CONTROLLED_RARE_EARTHS_IN_FORCE,
  ENTITY_MECHANISMS,
  KNOWN_DESIGNATIONS,
  NOT_MODELLED
} from "../data/china-export-control.js";

export const CHINA_STATUSES = Object.freeze([
  "license_required",
  "license_required_if_reactivated",
  "requires_verification",
  "indeterminate_input",
  "not_screenable",
  "out_of_scope"
]);

const RARE_EARTH_TECHNOLOGY_TYPES = Object.freeze([
  "extraction",
  "smelting_separation",
  "metal_smelting",
  "magnetic_material_manufacturing",
  "secondary_resource_recycling"
]);

/**
 * Is a measure operative on a given date?
 * Returns the suspension window as well, because "not operative today" is only
 * half the answer.
 */
export function measureStatusOn(announcementId, asOfDate, limb = null) {
  const a = ANNOUNCEMENT_BY_ID[announcementId];
  if (!a) return { known: false, announcementId };
  const d = String(asOfDate);

  // A measure cannot be operative before it commences. This is not academic: the
  // November 2025 suspension landed one day before Announcement No. 61's own
  // commencement date, so its extraterritorial limbs have never operated at all.
  const commences =
    a.limbEffectiveFrom?.[limb] ??
    (limb ? a.extraterritorialEffectiveFrom : null) ??
    a.effectiveFrom ??
    a.date;
  const neverOperated =
    limb && a.neverOperatedLimbs?.includes(limb)
      ? a.neverOperated
      : !limb
        ? a.neverOperated
        : null;
  if (commences && d < commences) {
    return {
      known: true,
      announcement: a.number,
      operative: false,
      suspended: false,
      notYetEffective: true,
      commencesOn: commences,
      basis: `announced ${a.date} but does not commence until ${commences}`,
      ...(neverOperated ? { neverOperated } : {})
    };
  }

  const suspended = SUSPENSION.suspends.includes(announcementId);
  if (!suspended) {
    return {
      known: true,
      announcement: a.number,
      operative: a.status === "in_force",
      suspended: false,
      basis: a.status === "in_force" ? "in force as transcribed" : `status recorded as ${a.status}`
    };
  }
  const within = d >= SUSPENSION.from && d < SUSPENSION.until;
  return {
    known: true,
    announcement: a.number,
    operative: !within,
    suspended: within,
    ...(neverOperated ? { neverOperated } : {}),
    suspensionInstrument: SUSPENSION.instrument,
    suspendedFrom: SUSPENSION.from,
    suspendedUntil: SUSPENSION.until,
    daysUntilRevival: within ? daysBetween(d, SUSPENSION.until) : null,
    basis: within
      ? `implementation paused by ${SUSPENSION.instrument} until ${SUSPENSION.until}; the instrument is not repealed`
      : `the suspension window ${SUSPENSION.from} to ${SUSPENSION.until} does not cover ${d}`,
    legalEffect: SUSPENSION.legalEffect
  };
}

function daysBetween(a, b) {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.round((t2 - t1) / 86_400_000);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Which controlled rare earths does the text or the list name? */
function findRareEarths({ rareEarthElements, itemDescription }) {
  const named = new Set();
  for (const e of rareEarthElements ?? []) {
    const k = String(e).trim().toLowerCase();
    if (CONTROLLED_RARE_EARTHS_IN_FORCE.elements.includes(k)) named.add(k);
  }
  if (itemDescription) {
    for (const [i, e] of CONTROLLED_RARE_EARTHS_IN_FORCE.elements.entries()) {
      if (containsTerm(itemDescription, e)) named.add(e);
      const zh = CONTROLLED_RARE_EARTHS_IN_FORCE.elementsZh[i];
      if (zh && String(itemDescription).includes(zh)) named.add(e);
    }
  }
  return [...named];
}

/**
 * Assess a transaction against the PRC export-control framework.
 */
export function assessChinaExportControls(input = {}) {
  const {
    asOfDate = todayIso(),
    itemDescription = null,
    itemCategory = "unknown",
    rareEarthElements = null,

    itemOriginChina = null,
    containsChineseOriginRareEarths = null,
    chineseOriginRareEarthValuePercent = null,
    producedOutsideChinaUsingChineseRareEarthTechnology = null,
    chineseRareEarthTechnologyTypes = null,

    exportFromCountry = null,
    exportToCountry = null,
    endUserMilitary = null,
    counterpartyNames = null,
    counterpartyIsSubsidiaryOfListedEntity = null
  } = input;

  const findings = [];
  const inputGaps = [];
  const unansweredQuestions = [];
  const caveats = [];

  // --- the suspension, stated once and up front ---------------------------
  const suspensionState = {
    ...SUSPENSION,
    asOfDate,
    currentlyWithinSuspension: asOfDate >= SUSPENSION.from && asOfDate < SUSPENSION.until,
    daysUntilExpiry: daysBetween(asOfDate, SUSPENSION.until)
  };

  // --- No. 18: in force, and not covered by the suspension ----------------
  const st18 = measureStatusOn("2025-18", asOfDate);
  const namedElements = findRareEarths({ rareEarthElements, itemDescription });
  const controlledForms = namedElements.map((element) => ({
    element,
    forms: CONTROLLED_RARE_EARTHS_IN_FORCE.formsByElement?.[element] ?? CONTROLLED_RARE_EARTHS_IN_FORCE.itemForms
  }));
  const formNames = [...new Set(controlledForms.flatMap((x) => x.forms))];
  if (namedElements.length) {
    findings.push({
      id: "no18-elements",
      measure: ANNOUNCEMENT_BY_ID["2025-18"].number,
      measureDate: ANNOUNCEMENT_BY_ID["2025-18"].date,
      status: st18.operative ? "license_required" : "license_required_if_reactivated",
      elements: namedElements,
      controlledForms,
      requirement:
        "An export licence is required for the named elements in the forms listed for those elements, including " +
        formNames.join(", ") +
        ". The exact form and code still require confirmation against the announcement.",
      measureStatus: st18,
      important:
        "This announcement was NOT suspended in November 2025. Reporting that 'China suspended its rare-earth controls' is wrong for these seven elements.",
      verify:
        "Confirm the item's form and customs commodity number against the announcement. Presence of the element is not the control; the form is."
    });
  } else if (itemCategory === "rare_earth" || /rare earth|희토류|稀土/i.test(String(itemDescription ?? ""))) {
    inputGaps.push({
      field: "rareEarthElements",
      severity: "limiting",
      why:
        "The item looks rare-earth related but no controlled element was identified. Announcement No. 18 of 2025 is element-specific and remains in force, so the elements present decide the answer."
    });
  }

  // --- No. 61: extraterritorial reach ------------------------------------
  const st61 = measureStatusOn("2025-61", asOfDate);
  const st61EndUser = measureStatusOn("2025-61", asOfDate, "end-user");
  const routeResults = [];

  for (const route of EXTRATERRITORIAL_ROUTES) {
    const routeStatus = measureStatusOn("2025-61", asOfDate, route.id);
    let met = "unknown";
    let basis = "";

    if (route.id === "content-floor") {
      if (containsChineseOriginRareEarths === false) {
        met = "no";
        basis = "no Chinese-origin rare-earth content was declared";
      } else if (chineseOriginRareEarthValuePercent === null || chineseOriginRareEarthValuePercent === undefined) {
        met = "unknown";
        basis =
          "the value of Chinese-origin rare earths as a share of item value was not supplied, and the test is a 0.1 percent floor";
      } else if (Number(chineseOriginRareEarthValuePercent) >= route.thresholdPercent) {
        met = "yes";
        basis = `declared Chinese-origin rare-earth value is ${chineseOriginRareEarthValuePercent} percent of item value, at or above the ${route.thresholdPercent} percent floor`;
      } else {
        met = "no";
        basis = `declared Chinese-origin rare-earth value is ${chineseOriginRareEarthValuePercent} percent, below the ${route.thresholdPercent} percent floor`;
      }
    } else if (route.id === "technology-route") {
      if (producedOutsideChinaUsingChineseRareEarthTechnology === true) {
        met = "yes";
        const types = (chineseRareEarthTechnologyTypes ?? []).filter((t) =>
          RARE_EARTH_TECHNOLOGY_TYPES.includes(String(t))
        );
        basis =
          "production outside China used Chinese rare-earth process technology" +
          (types.length ? ` (${types.join(", ")})` : "; the specific technology was not named");
      } else if (producedOutsideChinaUsingChineseRareEarthTechnology === false) {
        met = "no";
        basis = "production outside China using Chinese rare-earth process technology was expressly denied";
      } else {
        met = "unknown";
        basis =
          "whether production used Chinese rare-earth extraction, smelting separation, metal smelting, magnetic material manufacturing or recycling technology was not stated";
      }
    } else if (route.id === "chinese-origin") {
      if (itemOriginChina === true) {
        met = "yes";
        basis = "the item was declared as originally produced in China";
      } else if (itemOriginChina === false) {
        met = "no";
        basis = "the item was declared as not of Chinese origin";
      } else {
        met = "unknown";
        basis = "the item's country of origin was not stated";
      }
    }

    routeResults.push({ ...route, met, basis, measureStatus: routeStatus });
  }

  const routesMet = routeResults.filter((r) => r.met === "yes");
  const routesUnknown = routeResults.filter((r) => r.met === "unknown");
  const routesMetOperative = routesMet.filter((r) => r.measureStatus.operative);
  const routesMetSuspended = routesMet.filter((r) => r.measureStatus.suspended);

  if (routesMet.length) {
    const routeStatus =
      routesMetOperative.length > 0
        ? "license_required"
        : routesMetSuspended.length > 0
          ? "license_required_if_reactivated"
          : "requires_verification";
    findings.push({
      id: "no61-extraterritorial",
      measure: ANNOUNCEMENT_BY_ID["2025-61"].number,
      measureDate: ANNOUNCEMENT_BY_ID["2025-61"].date,
      status: routeStatus,
      routesMet: routesMet.map((r) => ({ limb: r.limb, test: r.test, basis: r.basis })),
      requirement:
        "A MOFCOM dual-use item export permit is required before export, including where both the origin and the destination of the shipment are outside China.",
      measureStatus: st61,
      routeStatuses: Object.fromEntries(
        routesMet.map((r) => [
          r.id,
          {
            state: r.measureStatus.notYetEffective
              ? "not_yet_effective"
              : r.measureStatus.suspended
                ? "suspended"
                : r.measureStatus.operative
                  ? "in_force"
                  : "not_operative",
            ...(r.measureStatus.neverOperated ? { neverOperated: r.measureStatus.neverOperated } : {})
          }
        ])
      ),
      earContrast: routesMet.map((r) => r.earContrast).filter(Boolean),
      itemListCaveat:
        "This tool cannot confirm the item appears on Announcement No. 61's own appendix. The route test above is met on the facts given; the item-scope question is unresolved because the appendix is not bundled. A route that was not yet effective is reported as requires_verification rather than as a live or revived licence requirement."
    });
  }
  if (routesUnknown.length && !routesMet.length) {
    for (const r of routesUnknown) {
      inputGaps.push({
        field:
          r.id === "content-floor"
            ? "chineseOriginRareEarthValuePercent"
            : r.id === "technology-route"
              ? "producedOutsideChinaUsingChineseRareEarthTechnology"
              : "itemOriginChina",
        severity: "limiting",
        why: `${r.limb} could not be evaluated: ${r.basis}`
      });
    }
  }

  // --- No. 61 § 2 and the entity mechanisms -------------------------------
  if (endUserMilitary === true) {
    findings.push({
      id: "no61-military-end-user",
      measure: ANNOUNCEMENT_BY_ID["2025-61"].number,
      status: st61EndUser.operative ? "license_required" : st61EndUser.suspended ? "license_required_if_reactivated" : "requires_verification",
      rule: NO61_END_USER_RULE.rule,
      effect:
        "An application for a military end user is in principle not permitted. Treat this as a prohibition to be rebutted, not a licence to be applied for.",
      measureStatus: st61EndUser
    });
  }
  if (counterpartyIsSubsidiaryOfListedEntity === true) {
    findings.push({
      id: "no61-affiliates",
      measure: ANNOUNCEMENT_BY_ID["2025-61"].number,
      status: st61EndUser.operative ? "license_required" : st61EndUser.suspended ? "license_required_if_reactivated" : "requires_verification",
      rule: NO61_END_USER_RULE.affiliatesRule,
      earAnalogue: NO61_END_USER_RULE.earAnalogue,
      measureStatus: st61EndUser
    });
  }

  // --- the 管控名单 prohibition, which binds parties anywhere --------------
  const controlList = ENTITY_MECHANISMS.find((m) => m.id === "control-list");
  const nameHits = [];
  for (const n of counterpartyNames ?? []) {
    const q = String(n).trim().toLowerCase();
    if (!q) continue;
    for (const d of KNOWN_DESIGNATIONS.entries) {
      const dn = d.name.toLowerCase();
      if (dn === q || dn.includes(q) || q.includes(dn)) nameHits.push({ input: n, ...d });
    }
  }

  const screening = {
    status: "not_screenable",
    why: KNOWN_DESIGNATIONS.completenessWarning,
    mechanisms: ENTITY_MECHANISMS.map((m) => ({
      list: m.nameZh,
      nameEn: m.nameEn,
      bindsNonChineseParties: m.bindsNonChineseParties
    })),
    ...(nameHits.length ? { incidentalMatches: nameHits } : {}),
    doInstead:
      "Read the numbered MOFCOM announcements. A designation takes effect through the announcement, which is the operative instrument."
  };
  if (nameHits.length) {
    findings.push({
      id: "entity-designation-match",
      status: "requires_verification",
      matches: nameHits,
      effect:
        "One or more counterparty names matched a designation this snapshot happens to record. Confirm against the announcement, then read the prohibition, which for 管控名单 reaches suppliers in any country.",
      prohibitions: controlList.prohibits
    });
  }
  // A match on one name says nothing about the others. Raising this question only
  // when NOTHING matched would let an unmatched name ride along behind a matched
  // one and read as cleared, which is the failure this whole module is built to
  // avoid.
  if (counterpartyNames?.length) {
    const matched = new Set(nameHits.map((h) => h.input));
    const unmatched = counterpartyNames.filter((n) => !matched.has(n));
    if (unmatched.length) {
      unansweredQuestions.push({
        question: `Is ${unmatched.map((n) => `"${n}"`).join(", ")} on 管控名单, the Unreliable Entity List or the Malicious Entity List?`,
        why:
          "This server holds no designation list, so no answer was produced for these names. They were not screened, and the absence of a match is not a clearance. A match on a different name in the same request changes nothing about these.",
        whoBinds:
          "If a counterparty is on 管控名单, parties in any country are prohibited from supplying it with Chinese-origin dual-use items. A Korean supplier with no Chinese entity is inside that prohibition.",
        doInstead: "Read the numbered MOFCOM announcements, which are the operative instrument for each designation."
      });
    }
  }

  // --- category-specific pointers -----------------------------------------
  if (itemCategory === "lithium_battery" || itemCategory === "graphite_anode") {
    const st58 = measureStatusOn("2025-58", asOfDate);
    findings.push({
      id: "no58-battery",
      measure: ANNOUNCEMENT_BY_ID["2025-58"].number,
      measureDate: ANNOUNCEMENT_BY_ID["2025-58"].date,
      status: st58.operative ? "requires_verification" : "license_required_if_reactivated",
      subject: ANNOUNCEMENT_BY_ID["2025-58"].subject,
      measureStatus: st58,
      note:
        "This is the announcement that reaches secondary-battery supply chains directly. Whether a specific cell, cathode material, anode material or piece of production equipment is in scope depends on the announcement's own list, which is not bundled here."
    });
  }
  if (itemCategory === "rare_earth_technology") {
    const st62 = measureStatusOn("2025-62", asOfDate);
    findings.push({
      id: "no62-technology",
      measure: ANNOUNCEMENT_BY_ID["2025-62"].number,
      measureDate: ANNOUNCEMENT_BY_ID["2025-62"].date,
      status: st62.operative ? "requires_verification" : "license_required_if_reactivated",
      subject: ANNOUNCEMENT_BY_ID["2025-62"].subject,
      measureStatus: st62,
      note:
      "The controlled act is transfer of know-how, including design drawings, process specifications, parameters, procedures and simulation data. Intangible transfer to a foreign colleague or a shared engineering system can be the export."
    });
  }
  const categoryPointers = [
    {
      categories: ["strategic_mineral"],
      announcementId: "2025-10",
      id: "no10-strategic-minerals",
      note:
        "The item category points to Announcement No. 10's strategic-mineral controls. This tool does not classify the item against the announcement's detailed codes or parameters, so confirm whether the specific tungsten, tellurium, bismuth, molybdenum or indium item is listed."
    },
    {
      categories: ["superhard_material"],
      announcementId: "2025-55",
      id: "no55-superhard-material",
      note:
        "The category points to the artificial-diamond and DCPCVD controls in Announcement No. 55. Confirm the particle size, product parameters and technology/equipment code against the announcement."
    },
    {
      categories: ["rare_earth_equipment"],
      announcementId: "2025-56",
      id: "no56-rare-earth-equipment",
      note:
        "The category points to Announcement No. 56's 2B902 rare-earth production and processing equipment and raw-material controls. This tool does not classify the equipment against the detailed parameters."
    },
    {
      categories: ["rare_earth"],
      announcementId: "2025-57",
      id: "no57-rare-earth-package",
      note:
        "The category also requires checking Announcement No. 57 for holmium, erbium, thulium, europium and ytterbium items. It is separate from No. 18 and is currently suspended until the recorded expiry."
    }
  ];
  for (const pointer of categoryPointers) {
    if (!pointer.categories.includes(itemCategory)) continue;
    const announcement = ANNOUNCEMENT_BY_ID[pointer.announcementId];
    const state = measureStatusOn(pointer.announcementId, asOfDate);
    findings.push({
      id: pointer.id,
      measure: announcement.number,
      measureDate: announcement.date,
      status: state.operative
        ? "requires_verification"
        : state.suspended
          ? "license_required_if_reactivated"
          : "requires_verification",
      subject: announcement.subject,
      controlledCodes: announcement.controlledCodes,
      measureStatus: state,
      note: pointer.note
    });
  }

  // --- extraterritorial framing -------------------------------------------
  const bothOutsideChina =
    exportFromCountry &&
    exportToCountry &&
    !isChina(exportFromCountry) &&
    !isChina(exportToCountry);
  if (bothOutsideChina) {
    caveats.push({
      point:
        "Both ends of this shipment are outside China, which does not put it outside this regime. Announcement No. 61 of 2025 requires a MOFCOM permit for exactly that case, and the 管控名单 prohibition on supplying Chinese-origin dual-use items binds suppliers wherever they sit.",
      citation: "MOFCOM Announcement No. 61 of 2025; Export Control Law"
    });
  }

  // --- aggregate ----------------------------------------------------------
  const operative = findings.filter((f) => f.status === "license_required");
  const dormant = findings.filter((f) => f.status === "license_required_if_reactivated");
  const toVerify = findings.filter((f) => f.status === "requires_verification");

  let status;
  let summary;
  if (operative.length) {
    status = "license_required";
    summary =
      `A Chinese export licence requirement is engaged on the facts given: ${operative.map((f) => f.measure ?? f.id).join("; ")}. ` +
      "This tool cannot confirm the item appears on the relevant control list, because that list is not bundled here.";
  } else if (dormant.length) {
    status = "license_required_if_reactivated";
    summary =
      `The facts given meet ${dormant.length} test(s) under measures whose implementation is currently paused by ${SUSPENSION.instrument} until ${SUSPENSION.until} ` +
      `(${suspensionState.daysUntilExpiry} days from ${asOfDate}). The instruments are not repealed, so these requirements revive on expiry unless MOFCOM extends or withdraws the suspension. ` +
      "Suspension is not an exemption.";
  } else if (toVerify.length) {
    status = "requires_verification";
    summary = `${toVerify.length} issue(s) identified for manual review against the MOFCOM announcements.`;
  } else if (inputGaps.length) {
    status = "indeterminate_input";
    summary =
      "No conclusion. The input did not carry the facts these measures turn on; see inputGaps. Do not read this as an absence of Chinese export-control exposure.";
  } else {
    status = "requires_verification";
    summary =
      "Nothing in the facts given engaged a transcribed Chinese measure. That is not a clearance: this server holds neither the Export Control List for Dual-Use Items nor any entity designation list, so the two questions that decide most cases were not asked.";
  }

  caveats.push({
    point:
      "The Export Control List for Dual-Use Items is not bundled, so no item was classified. The Chinese equivalent of the ECCN question is unanswered.",
    citation: "Regulations on Export Control of Dual-Use Items (2024)"
  });
  caveats.push({
    point:
      "Catch-all controls reach unlisted items where the exporter knows or should know of a proscribed end use. Like Part 744 of the EAR, that turns on knowledge and is not evaluable from a structured input."
  });

  return {
    toolContract:
      "This tool identifies Chinese export-control issues to review. It does not classify items, does not screen entities, and never reports that a transaction is permitted.",
    provenance: CHINA_PROVENANCE,
    asOfDate,
    status,
    summary,
    suspension: suspensionState,
    findings,
    extraterritorialRoutes: routeResults.map((r) => ({
      limb: r.limb,
      test: r.test,
      met: r.met,
      basis: r.basis,
      state: r.measureStatus.notYetEffective
        ? "not_yet_effective"
        : r.measureStatus.suspended
          ? "suspended"
          : r.measureStatus.operative
            ? "in_force"
            : "not_operative",
      ...(r.measureStatus.neverOperated ? { neverOperated: r.measureStatus.neverOperated } : {}),
      ...(r.earAnalogue ? { earAnalogue: r.earAnalogue, earContrast: r.earContrast } : {})
    })),
    entityScreening: screening,
    inputGaps,
    unansweredQuestions,
    caveats,
    notModelled: NOT_MODELLED.map((n) => n.item),
    // The register is the most useful constant in this payload, so it stays, but
    // compactly. The suspension instrument, its window and its legal effect are
    // stated once in `suspension` above rather than repeated on all six suspended
    // entries, which is where most of the bulk used to be.
    announcementRegister: ANNOUNCEMENTS.map((a) => {
      const s = measureStatusOn(a.id, asOfDate);
      return {
        number: a.number,
        date: a.date,
        subject: a.subject,
        state: s.notYetEffective ? "not_yet_effective" : s.suspended ? "suspended" : s.operative ? "in_force" : "not_operative",
        ...(s.daysUntilRevival !== null && s.daysUntilRevival !== undefined
          ? { daysUntilRevival: s.daysUntilRevival }
          : {}),
        ...(a.notSuspended ? { notSuspended: true } : {}),
        ...(s.neverOperated ? { neverOperated: s.neverOperated } : {})
      };
    }),
    fullFramework: {
      note:
        "The instrument register, the not-modelled detail and the entity mechanisms are held as a resource rather than repeated on every call.",
      resource: "export-controls://china-framework"
    },
    nextSteps: [
      "Read the numbered announcements named above on mofcom.gov.cn. They are the operative instruments.",
      "Determine whether the item is on the Export Control List for Dual-Use Items. This server cannot.",
      "Map Chinese-origin content by value and Chinese-origin process technology through the supply chain now, regardless of the suspension, because the 0.1 percent floor in Announcement No. 61 makes trace content decisive.",
      "Screen every counterparty against 管控名单, the Unreliable Entity List and the Malicious Entity List. This server cannot.",
      "Do not carry a U.S. de minimis conclusion across. Clearing § 734.4 at 20 percent says nothing about a 0.1 percent floor.",
      "Have PRC-qualified counsel confirm any conclusion."
    ]
  };
}

function isChina(country) {
  const c = String(country ?? "").trim().toLowerCase();
  return [
    "china",
    "prc",
    "china (prc)",
    "people's republic of china",
    "mainland china",
    "중국",
    "中国"
  ].includes(c);
}

export { RARE_EARTH_TECHNOLOGY_TYPES };
