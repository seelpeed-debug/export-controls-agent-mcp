// License Exception issue analysis for 15 C.F.R. Part 740.
//
// DESIGN CONTRACT
// This module never reports that a License Exception is "available". Exception
// eligibility turns on the text of the specific ECCN entry, the Commerce
// Country Chart, per-exception conditions (written assurances, notifications,
// purchase orders), and independent Part 744/746 license requirements. None of
// that is derivable from a short structured input.
//
// So every candidate carries one of these statuses:
//   "foreclosed"            a 740.2 restriction removes it on the stated facts
//   "out_of_scope"          the exception does not cover this class of item
//   "requires_verification" worth reviewing; listed conditions must be confirmed
//   "indeterminate_input"   the input is not specific enough to place the item
//
// Callers must not collapse "requires_verification" into "yes".

import {
  resolveCountry,
  isMacauOrD5,
  isA5orA6,
  isD1D4D5ExclAllies,
  COUNTRY_GROUP_PROVENANCE,
  COUNTRY_GROUP_NOTES
} from "../lib/countries.js";
import { normalizeEccn, isEar99, parseEccn, expandParagraphList, matchAnySpec } from "../lib/eccn.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CATALOG = require("../data/license-exception-catalog.json");

export const LICENSE_EXCEPTION_PROVENANCE = Object.freeze({
  countryGroups: COUNTRY_GROUP_PROVENANCE,
  part740Catalog: {
    citation: CATALOG.citation,
    ecfrIssueDate: CATALOG.ecfrIssueDate,
    retrievedAt: CATALOG.retrievedAt,
    sourceUrl: CATALOG.source?.url ?? null,
    exceptionCount: CATALOG.count
  }
});

const BY_SECTION = new Map(CATALOG.exceptions.map((e) => [e.sectionNumber, e]));

function ex(sectionNumber) {
  const e = BY_SECTION.get(sectionNumber);
  if (!e) throw new Error(`Part 740 catalog has no § ${sectionNumber}; regenerate the catalog`);
  return e;
}

// ---------------------------------------------------------------------------
// 740.2(a)(9)(i) -- semiconductor manufacturing equipment and associated
// software/technology to Macau or Country Group D:5. Only GOV under 740.11(b).
// ---------------------------------------------------------------------------
const SME_GATE_SPECS = [
  ...expandParagraphList("3B001", "a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4, r"),
  "3B002.C",
  "3B993",
  "3B994",
  "3D001",
  "3D002",
  "3D003",
  "3D992",
  "3D993",
  "3D994",
  "3E001",
  "3E992",
  "3E993",
  "3E994"
];

// ---------------------------------------------------------------------------
// 740.2(a)(9)(ii)(A) and (B) -- advanced computing items and the ".z" families.
// ---------------------------------------------------------------------------
const ADVANCED_COMPUTING_GATE_SPECS = [
  // (A)
  "3A090",
  "4A090",
  "4E091",
  "3D001",
  "3E001",
  "4D090",
  "4E001",
  // (B)
  "3A001.Z",
  "4A003.Z",
  "4A004.Z",
  "4A005.Z",
  "4D001",
  "5A002.Z",
  "5A004.Z",
  "5A992.Z",
  "5D002.Z",
  "5D992.Z",
  "5E002",
  "5E992"
];

const ADVANCED_COMPUTING_ALLOWED = [
  { section: "740.9", note: "TMP, restricted to § 740.9(a)(6)" },
  { section: "740.8", note: "NAC/ACA under § 740.8 (ECCN 3A090.c is NOT eligible for NAC/ACA)" },
  { section: "740.10", note: "RPL under § 740.10" },
  { section: "740.11", note: "GOV, restricted to § 740.11(b)" },
  { section: "740.13", note: "TSU under § 740.13(a) and (c)" },
  { section: "740.25", note: "HBM under § 740.25" },
  {
    section: "740.27",
    note:
      "AIA under § 740.27, only for ECCN 4E091 to entities headquartered in countries in paragraph (a) of supplement no. 5 to part 740 and located outside Macau/Country Group D:5"
  },
  { section: "740.28", note: "ACM under § 740.28" }
];

// 740.2(a)(6) sanctioned destinations. Cuba/Iran/North Korea/Syria plus the
// listed Ukrainian regions; Russia and Belarus are "limited sanction".
const COMPREHENSIVE_SANCTION = ["Cuba", "Iran", "Korea, North", "Syria"];
const LIMITED_SANCTION = ["Russia", "Belarus"];

// Category 5 Part 2 (and the mass-market entries) are the only items ENC reaches.
const ENC_BASES = new Set(["5A002", "5A004", "5D002", "5E002", "5A992", "5D992", "5E992"]);

function gateSpecMatch(eccn, specs) {
  if (isEar99(eccn)) return { isMatch: false, isIndeterminate: false, matched: [], indeterminate: [] };
  return matchAnySpec(eccn, specs);
}

/**
 * @param {object} input
 * @param {string} input.eccn
 * @param {string} input.destinationCountry
 * @param {"export"|"reexport"|"transfer_in_country"} [input.transactionType]
 * @param {"hardware"|"software"|"technology"|"service"} [input.itemType]
 * @param {"commercial"|"government"|"military"|"unknown"} [input.endUserType]
 * @param {number} [input.valueUsd]
 * @param {boolean} [input.entityHeadquarteredInMacauOrD5]
 * @param {object} [input.flags]
 */
export function analyzeLicenseExceptions(input) {
  const {
    eccn,
    destinationCountry,
    transactionType = "export",
    itemType = "hardware",
    endUserType = "commercial",
    valueUsd,
    entityHeadquarteredInMacauOrD5 = false,
    flags = {}
  } = input;

  const normalized = normalizeEccn(eccn);
  const ear99 = isEar99(normalized);
  const parsed = parseEccn(normalized);
  const dest = resolveCountry(destinationCountry);

  const gates = [];
  const candidates = [];
  const inputGaps = [];

  // --- input quality -------------------------------------------------------
  if (!dest.resolved) {
    inputGaps.push({
      field: "destinationCountry",
      problem:
        dest.matchType === "ambiguous"
          ? `"${dest.input}" matches more than one country in Supplement No. 1 (${(dest.candidates ?? []).join(", ")})`
          : `"${dest.input}" could not be matched to a country in 15 C.F.R. Part 740, Supplement No. 1`,
      consequence:
        "Country Group membership is unknown, so no restriction or exception scope can be evaluated. Nothing below should be read as clearance."
    });
  }
  if (!ear99 && !parsed.valid) {
    inputGaps.push({
      field: "eccn",
      problem: `"${eccn}" is not a well-formed ECCN (expected a pattern like 3B001.f.1) or "EAR99"`,
      consequence: "ECCN-scoped restrictions and per-ECCN exception flags cannot be evaluated."
    });
  } else if (!ear99 && parsed.path.length === 0) {
    inputGaps.push({
      field: "eccn",
      problem: `"${normalized}" names a CCL entry with no subparagraph`,
      consequence:
        "Several Part 740 restrictions are scoped to specific subparagraphs. Without the subparagraph the analysis below is indeterminate, not negative."
    });
  }

  // --- Gate: 740.2(a)(6) sanctioned destinations ---------------------------
  if (dest.resolved) {
    const comprehensive = COMPREHENSIVE_SANCTION.includes(dest.canonical);
    const limited = LIMITED_SANCTION.includes(dest.canonical);
    if (comprehensive || limited) {
      gates.push({
        citation: "15 C.F.R. § 740.2(a)(6)",
        rule: comprehensive
          ? "Sanctioned destination"
          : "Destination subject to a limited sanction (Russia/Belarus)",
        effect:
          "No License Exception may be used unless that exception, or a portion of it, is specifically listed in the license exceptions paragraph for this country in 15 C.F.R. Part 746.",
        detail: `${dest.canonical} is a ${comprehensive ? "sanctioned destination" : "limited-sanction destination"} for purposes of § 740.2(a)(6).`,
        actionRequired:
          "Read the Part 746 section for this destination and use only the exceptions it names. Also check OFAC authority separately; BIS authorisation does not substitute for an OFAC licence.",
        severity: "blocking"
      });
    }
    if (dest.canonical === "Syria") {
      gates.push({
        citation: "15 C.F.R. § 740.5",
        rule: "License Exception SPP may be relevant for Syria",
        effect:
          "SPP authorises export/reexport of items designated EAR99 to Syria, but does not authorise anything that requires a licence under a Part 744 end-use or end-user control.",
        detail:
          "Added at 90 FR 42320 (Sept. 2, 2025). Note that § 740.5 previously carried License Exception CIV, which no longer exists.",
        severity: "informational"
      });
    }
  }

  // --- Gate: 740.2(a)(9)(i) SME to Macau/D:5 -------------------------------
  const smeMatch = gateSpecMatch(normalized, SME_GATE_SPECS);
  const destIsMacauOrD5 = dest.resolved && isMacauOrD5(dest);
  if ((smeMatch.isMatch || smeMatch.isIndeterminate) && destIsMacauOrD5) {
    const certain = smeMatch.isMatch;
    gates.push({
      citation: "15 C.F.R. § 740.2(a)(9)(i)",
      rule: "Semiconductor manufacturing equipment and associated software/technology to Macau or Country Group D:5",
      effect:
        "The ONLY License Exception available is GOV, restricted to eligibility under § 740.11(b). Every other License Exception, including LVS, GBS, STA, TSR, TSU and ENC, is unavailable.",
      detail: certain
        ? `${normalized} is within the § 740.2(a)(9)(i) list (matched ${smeMatch.matched.join(", ")}) and ${dest.canonical} is ${dest.isMacau ? "Macau" : "in Country Group D:5"}.`
        : `${normalized} may fall within the § 740.2(a)(9)(i) list (candidate paragraphs: ${smeMatch.indeterminate.join(", ")}). Supply the full subparagraph to resolve this.`,
      scopeList: "3B001.a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4, r; 3B002.c; 3B993; 3B994; and associated software/technology in 3D001, 3D002, 3D003, 3D992, 3D993, 3D994, 3E001, 3E992, 3E993, 3E994",
      severity: certain ? "blocking" : "blocking_unless_resolved"
    });
  }

  // --- Gate: 740.2(a)(9)(ii) advanced computing ----------------------------
  const acMatch = gateSpecMatch(normalized, ADVANCED_COMPUTING_GATE_SPECS);
  const acDestInScope = dest.resolved && isD1D4D5ExclAllies(dest);
  const acEntityInScope = Boolean(entityHeadquarteredInMacauOrD5);
  if ((acMatch.isMatch || acMatch.isIndeterminate) && (acDestInScope || acEntityInScope)) {
    const certain = acMatch.isMatch;
    gates.push({
      citation: "15 C.F.R. § 740.2(a)(9)(ii)",
      rule: "Advanced computing items and '.z' families to Country Group D:1/D:4/D:5 (excluding A:5/A:6), or to an entity headquartered in (or with ultimate parent headquartered in) Macau or Country Group D:5",
      effect:
        "Only these License Exceptions remain available: " +
        ADVANCED_COMPUTING_ALLOWED.map((a) => a.note).join("; ") +
        ". All others are unavailable.",
      detail: certain
        ? `${normalized} is within the § 740.2(a)(9)(ii) list (matched ${acMatch.matched.join(", ")}).` +
          (acEntityInScope
            ? " The end user was flagged as headquartered in, or having an ultimate parent headquartered in, Macau or Country Group D:5, which triggers this restriction regardless of the shipping destination."
            : ` ${dest.canonical} is in Country Group ${dest.groups.filter((g) => ["D:1", "D:4", "D:5"].includes(g)).join("/")} and is not in A:5 or A:6.`)
        : `${normalized} may fall within the § 740.2(a)(9)(ii) list (candidate paragraphs: ${acMatch.indeterminate.join(", ")}).`,
      severity: certain ? "blocking" : "blocking_unless_resolved"
    });
  }

  // --- Restrictions this tool does not model -------------------------------
  const unmodelled = [
    {
      citation: "15 C.F.R. § 740.2(a)(5)",
      rule: "Missile Technology (MT) controlled items",
      note: "If any MT column applies to this ECCN, only a short enumerated set of exceptions may be used. Not modelled here -- check the ECCN's Reason for Control."
    },
    {
      citation: "15 C.F.R. § 740.2(a)(4)",
      rule: "Items subject to § 742.7 (firearms)",
      note: "Restricts exceptions to a narrow set. Not modelled here."
    },
    {
      citation: "15 C.F.R. § 740.2(a)(3), (a)(7), (a)(8)",
      rule: "Surreptitious interception items, certain 6E001/6E002 technology, ECCN 2A983/2A984 families",
      note: "Not modelled here."
    }
  ];

  // --- Candidate exceptions ------------------------------------------------
  const foreclosedBy = gates.filter((g) => g.severity === "blocking" || g.severity === "blocking_unless_resolved");
  const smeGateActive = foreclosedBy.some((g) => g.citation === "15 C.F.R. § 740.2(a)(9)(i)");
  const acGateActive = foreclosedBy.some((g) => g.citation === "15 C.F.R. § 740.2(a)(9)(ii)");
  const sanctionGateActive = foreclosedBy.some((g) => g.citation === "15 C.F.R. § 740.2(a)(6)");

  const acAllowedSections = new Set(ADVANCED_COMPUTING_ALLOWED.map((a) => a.section));

  /** Apply the active gates to a candidate. */
  function gateStatus(sectionNumber) {
    if (smeGateActive && sectionNumber !== "740.11") {
      return {
        status: "foreclosed",
        why: "Foreclosed by § 740.2(a)(9)(i): only GOV under § 740.11(b) survives for these items to Macau/Country Group D:5."
      };
    }
    if (acGateActive && !acAllowedSections.has(sectionNumber)) {
      return {
        status: "foreclosed",
        why: "Foreclosed by § 740.2(a)(9)(ii) for advanced computing items to this destination or entity."
      };
    }
    if (sanctionGateActive) {
      return {
        status: "foreclosed",
        why:
          "Foreclosed by § 740.2(a)(6) unless this exception is specifically named for this destination in Part 746. Verify against the Part 746 country section before treating it as usable."
      };
    }
    return null;
  }

  function add(sectionNumber, { status, why, conditions = [], scopeNote = null }) {
    const meta = ex(sectionNumber);
    const gated = gateStatus(sectionNumber);
    candidates.push({
      symbols: meta.symbols,
      section: meta.section,
      title: meta.title,
      status: gated ? gated.status : status,
      whyStatus: gated ? gated.why : why,
      scopeNote,
      conditionsToVerify: gated ? [] : conditions
    });
  }

  const inGroupB = dest.resolved && dest.groups.includes("B");
  const inA5A6 = dest.resolved && isA5orA6(dest);

  // LVS  740.3
  if (ear99) {
    add("740.3", {
      status: "out_of_scope",
      why: "LVS applies to items listed on the CCL with an LVS dollar value. EAR99 items are not on the CCL."
    });
  } else if (itemType !== "hardware") {
    add("740.3", {
      status: "out_of_scope",
      why: "LVS covers commodities. Software and technology are handled by other exceptions (e.g. TSR, TSU)."
    });
  } else {
    add("740.3", {
      status: inGroupB ? "requires_verification" : "out_of_scope",
      why: inGroupB
        ? "Potentially relevant, but LVS eligibility and the applicable value limit are set by the individual ECCN entry."
        : `LVS is limited to Country Group B destinations. ${dest.resolved ? `${dest.canonical} is not in Country Group B.` : "Destination unresolved."}`,
      conditions: [
        "Confirm the ECCN entry states an LVS dollar value; if it says 'LVS: N/A' the exception is unavailable.",
        "Use the ECCN's own limit -- LVS values vary by entry (for example $200, $1,500, $3,000, $5,000). Do not assume a flat $3,000.",
        valueUsd === undefined
          ? "Provide the per-shipment value; it was not supplied, so the limit cannot be tested."
          : `Confirm the per-shipment value (US$${valueUsd.toLocaleString("en-US")}) is within the ECCN's LVS limit.`,
        "Confirm the ECCN's LVS entry is not excluded for the applicable reason for control (LVS is commonly 'N/A for MT')."
      ]
    });
  }

  // GBS  740.4
  if (ear99) {
    add("740.4", {
      status: "out_of_scope",
      why: "GBS applies to items listed on the CCL with 'GBS: Yes'. EAR99 items are not on the CCL."
    });
  } else {
    add("740.4", {
      status: inGroupB ? "requires_verification" : "out_of_scope",
      why: inGroupB
        ? "Potentially relevant, but GBS is available only where the ECCN entry itself says so."
        : `GBS is limited to Country Group B destinations. ${dest.resolved ? `${dest.canonical} is not in Country Group B.` : "Destination unresolved."}`,
      conditions: [
        "Confirm the ECCN entry's List Based License Exceptions block states 'GBS: Yes' for the relevant paragraph. Many entries say 'GBS: N/A'.",
        "Confirm no Part 744 end-use or end-user control independently requires a licence."
      ]
    });
  }

  // SPP  740.5
  add("740.5", {
    status: dest.resolved && dest.canonical === "Syria" && ear99 ? "requires_verification" : "out_of_scope",
    why:
      dest.resolved && dest.canonical === "Syria"
        ? ear99
          ? "SPP covers items designated EAR99 destined to Syria."
          : "SPP covers only items designated EAR99; this item is CCL-listed."
        : "SPP is limited to Syria as a destination.",
    conditions: [
      "Confirm the item is designated EAR99.",
      "Confirm no Part 744 end-use or end-user control applies, including § 744.8 (certain OFAC SDN designations). SPP does not override those."
    ]
  });

  // TSR  740.6
  const tsrRelevantItem = itemType === "technology" || itemType === "software";
  add("740.6", {
    status: !tsrRelevantItem
      ? "out_of_scope"
      : ear99
        ? "out_of_scope"
        : inGroupB
          ? "requires_verification"
          : "out_of_scope",
    why: !tsrRelevantItem
      ? "TSR covers technology and software only."
      : ear99
        ? "TSR operates on CCL entries flagged 'TSR—Yes'. EAR99 items are not on the CCL."
        : inGroupB
          ? "Potentially relevant for NS-only controlled technology or software."
          : `TSR requires a Country Group B destination (except Sudan and Ukraine). ${dest.resolved ? `${dest.canonical} is not in Country Group B.` : "Destination unresolved."}`,
    scopeNote:
      "TSR is § 740.6, 'Technology and software under restriction'. It is not the same as TSU (§ 740.13), and it applies to NS-only controlled items -- not to AT-only controlled items.",
    conditions: [
      "Confirm the Commerce Country Chart shows a licence requirement for this destination for NATIONAL SECURITY reasons ONLY. If any other reason for control (NP, CB, MT, RS, EI, SI) also applies, TSR is unavailable.",
      "Confirm the ECCN entry states 'TSR—Yes'.",
      "Confirm the destination is in Country Group B and is not Sudan or Ukraine.",
      "Obtain the written assurance required by § 740.6(a)(1) (technology) or § 740.6(a)(2) (software) from the importer BEFORE export. Without it TSR does not apply and a licence is required.",
      "Check the § 743.1 reporting requirement."
    ]
  });

  // APP  740.7
  const appBases = new Set(["4A003", "4D001", "4E001"]);
  const appRelevant = !ear99 && appBases.has(parsed.base ?? "");
  add("740.7", {
    status: appRelevant ? "requires_verification" : "out_of_scope",
    why: appRelevant
      ? "APP covers ECCN 4A003 computers and 4D001/4E001 software and technology therefor."
      : "APP is limited to ECCN 4A003 computers and associated 4D001/4E001 software and technology.",
    conditions: [
      "Identify the destination's Computer Tier under § 740.7(c) and (d). Note that for Computer Tier 3 destinations the eligible commodities are 'None' -- only certain deemed exports of technology and source code are covered.",
      "Compare the item's Adjusted Peak Performance against the tier limit.",
      "Confirm § 740.7(b)(5): APP does not authorise nuclear, chemical, biological or missile end uses or end users under §§ 744.2 through 744.5."
    ]
  });

  // NAC/ACA  740.8
  const nacSpecs = ["3A090", "4A090", "3A001.Z", "4A003.Z", "4A004.Z", "4A005.Z", "5A002.Z", "5A004.Z", "5A992.Z", "5D002.Z", "5D992.Z"];
  const nacMatch = gateSpecMatch(normalized, nacSpecs);
  add("740.8", {
    status: nacMatch.isMatch ? "requires_verification" : nacMatch.isIndeterminate ? "indeterminate_input" : "out_of_scope",
    why: nacMatch.isMatch
      ? "NAC/ACA covers ECCN 3A090 (except 3A090.c), 4A090 and the listed '.z' entries."
      : nacMatch.isIndeterminate
        ? "Cannot tell without the full subparagraph whether this entry is within NAC/ACA scope."
        : "NAC/ACA is limited to ECCN 3A090, 4A090 and the listed '.z' entries.",
    conditions: [
      "ECCN 3A090.c is NOT eligible for NAC/ACA.",
      "Items designed or marketed for datacentre use that meet the parameters of 3A090.a are excluded.",
      "Obtain a written purchase order before shipment (§ 740.8(a)(1)); commercial samples are treated separately.",
      "For NAC to Macau/Country Group D:5 or to an entity headquartered there, file the prior notification in SNAP-R at least 25 calendar days ahead and obtain the NAC confirmation number (§ 740.8(c)).",
      "For 5A002.z, 5A004.z or 5D002.z, the ENC requirements of § 740.17 must also be met.",
      "§ 740.8(b): no use where Part 744 or Part 746 independently requires a licence, subject to the narrow § 744.23(a)(3) carve-out."
    ]
  });

  // TMP 740.9 / RPL 740.10
  add("740.9", {
    status: flags.temporaryExport ? "requires_verification" : "out_of_scope",
    why: flags.temporaryExport
      ? "Flagged as a temporary export."
      : "Not flagged as a temporary import/export/reexport. Set flags.temporaryExport to evaluate.",
    conditions: [
      "Confirm the item returns within the period allowed and that no title or technology transfer occurs.",
      "If the advanced-computing restriction in § 740.2(a)(9)(ii) applies, only § 740.9(a)(6) eligibility survives."
    ]
  });
  add("740.10", {
    status: flags.servicingOrReplacementParts ? "requires_verification" : "out_of_scope",
    why: flags.servicingOrReplacementParts
      ? "Flagged as servicing or one-for-one replacement parts."
      : "Not flagged as servicing/replacement. Set flags.servicingOrReplacementParts to evaluate.",
    conditions: [
      "Confirm the one-for-one replacement and prior lawful export conditions of § 740.10.",
      "Confirm the § 740.10(a)(3)(v) prohibition on Country Group E:1 destinations does not apply."
    ]
  });

  // GOV  740.11
  add("740.11", {
    status:
      endUserType === "government" || flags.governmentEndUser
        ? "requires_verification"
        : smeGateActive || acGateActive
          ? "requires_verification"
          : "out_of_scope",
    why:
      endUserType === "government" || flags.governmentEndUser
        ? "A government end user was indicated."
        : smeGateActive || acGateActive
          ? "GOV under § 740.11(b) is the residual exception left open by the § 740.2(a)(9) restrictions, so it is the only avenue worth examining here."
          : "No government or international-organisation end use was indicated.",
    conditions: [
      "GOV is narrow. Identify the specific paragraph relied on; the § 740.2(a)(9) restrictions preserve only § 740.11(b) eligibility.",
      "A commercial sale to a state-owned enterprise is generally NOT within GOV. Confirm the end use is an official government use described in § 740.11(b)."
    ]
  });

  // TSU  740.13
  add("740.13", {
    status: tsrRelevantItem ? "requires_verification" : "out_of_scope",
    why: tsrRelevantItem
      ? "TSU covers operation technology and software, sales technology, software updates and mass-market software."
      : "TSU covers technology and software only.",
    scopeNote:
      "TSU is § 740.13, 'Technology and software—unrestricted'. Do not confuse it with TSR (§ 740.6).",
    conditions: [
      "Identify which TSU paragraph applies: (a) operation technology and software, (b) sales technology, (c) software updates, or the mass-market provisions.",
      "TSU is narrow -- it does not cover development or production technology.",
      "If the advanced-computing restriction in § 740.2(a)(9)(ii) applies, only § 740.13(a) and (c) survive."
    ]
  });

  // ENC  740.17 -- scoped to encryption items only.
  const encInScope = !ear99 && ENC_BASES.has(parsed.base ?? "");
  add("740.17", {
    status: encInScope ? "requires_verification" : "out_of_scope",
    why: encInScope
      ? "The ECCN is within Category 5 Part 2, which is where ENC operates."
      : `ENC applies to encryption items (ECCN 5A002, 5A004, 5D002, 5E002 and the 5x992 mass-market entries). ${normalized || "The stated item"} is not one of them, so ENC is irrelevant regardless of whether the item is software.`,
    conditions: [
      "Confirm the applicable § 740.17 paragraph and any classification request or self-classification reporting obligation.",
      "Check Supplement No. 3 to Part 740 (ENC Favorable Treatment Countries) for the destination."
    ]
  });

  // STA  740.20
  if (ear99) {
    add("740.20", {
      status: "out_of_scope",
      why: "STA authorises exports that would otherwise need a licence because of a CCL-based control. EAR99 items are not on the CCL, so STA is not the relevant authority."
    });
  } else {
    add("740.20", {
      status: inA5A6 ? "requires_verification" : "out_of_scope",
      why: inA5A6
        ? `${dest.canonical} is in Country Group ${dest.groups.filter((g) => g === "A:5" || g === "A:6").join("/")}, which is the STA destination scope.`
        : `STA is limited to Country Group A:5 and A:6 destinations. ${dest.resolved ? `${dest.canonical} is in ${dest.groups.length ? dest.groups.join(", ") : "no listed Country Group"}.` : "Destination unresolved."}`,
      conditions: [
        "Read the ECCN entry's 'Special Conditions for STA'. Several entries bar STA to A:5/A:6 outright -- 3D992, 3D993, 3E992 and 3E993 are examples relevant to semiconductor work.",
        "Obtain the consignee's written assurances required by § 740.20(d) BEFORE shipment.",
        "Confirm the § 740.20(b) eligibility requirements and the prior-notification and recordkeeping obligations.",
        dest.resolved && dest.canonical === "United Arab Emirates"
          ? "For the UAE, STA is available only to entities approved in Supplement No. 8 to Part 740 (§ 740.2(a)(26))."
          : "Confirm the destination is not subject to an entity-specific STA limitation."
      ]
    });
  }

  // HBM 740.25 / AIA 740.27 / ACM 740.28 / RFF 740.26 / LPP 740.29 / IEC 740.24
  const memoryRelevant = gateSpecMatch(normalized, ["3A090.C"]).isMatch || Boolean(flags.highBandwidthMemory);
  add("740.25", {
    status: memoryRelevant ? "requires_verification" : "out_of_scope",
    why: memoryRelevant
      ? "High Bandwidth Memory is addressed by ECCN 3A090.c and License Exception HBM."
      : "HBM is specific to high bandwidth memory items. Set flags.highBandwidthMemory or supply ECCN 3A090.c to evaluate.",
    conditions: ["Read § 740.25 in full; HBM carries its own eligibility and reporting conditions."]
  });

  // Anything in the Part 740 catalog that is not modelled above is still
  // reported, with a pointer to the section. The catalog is generated from
  // eCFR, so a newly added License Exception surfaces here automatically
  // instead of silently disappearing from the analysis.
  const NOT_MODELLED_NOTES = {
    "740.12": "Gift parcels and humanitarian donations.",
    "740.14": "Baggage: personal effects of individuals leaving the United States.",
    "740.15": "Aircraft, vessels and spacecraft.",
    "740.16":
      "Additional permissive reexports. Relevant where a non-U.S. reexporter moves items between specified destinations; conditions are destination- and ECCN-specific.",
    "740.18": "Agricultural commodities.",
    "740.19": "Consumer communications devices.",
    "740.21": "Support for the Cuban People.",
    "740.22": "Authorized Cybersecurity Exports; scoped to specified cybersecurity items and destinations.",
    "740.23": "Medical devices.",
    "740.24":
      "Implemented Export Control, tied to specific ECCN entries (for example software and technology for equipment controlled by 3B001.c.1.a and 3B001.c.1.c) and to § 740.2(a)(22). Check whether the ECCN entry lists 'IEC: Yes'.",
    "740.26": "Restricted Fabrication 'Facility'. Evaluate if a designated facility is involved.",
    "740.27":
      "Artificial Intelligence Authorization, tied to the Supplement No. 5 to Part 740 country list, principally for ECCN 4E091.",
    "740.28": "Advanced Compute Manufacturing.",
    "740.29": "Low Processing Performance."
  };
  const handled = new Set(candidates.flatMap((c) => [c.section.replace("15 C.F.R. § ", "")]));
  for (const entry of CATALOG.exceptions) {
    if (handled.has(entry.sectionNumber)) continue;
    add(entry.sectionNumber, {
      status: "not_modelled",
      why:
        `Not modelled by this tool. ${NOT_MODELLED_NOTES[entry.sectionNumber] ?? "Review the section text directly."}`,
      conditions: [`Read ${entry.section} and confirm whether its scope covers this transaction.`]
    });
  }

  // --- Independent licence requirements -----------------------------------
  const independent = [
    {
      citation: "15 C.F.R. Part 744",
      requirement: "End-use and end-user controls",
      note:
        "Part 744 applies independently of ECCN and of any License Exception, and reaches EAR99 items. Run check_part744_enduse for this transaction. Most License Exceptions cannot be used where Part 744 requires a licence."
    },
    {
      citation: "15 C.F.R. Part 746",
      requirement: "Embargoes and other special controls",
      note: "Determines which exceptions, if any, survive for sanctioned destinations."
    },
    {
      citation: "15 C.F.R. § 734.9",
      requirement: "Foreign Direct Product (FDP) rules",
      note:
        "Run assess_ear_jurisdiction. A foreign-made item with no U.S. content can still be subject to the EAR under the Entity List, Advanced Computing or SME FDP rules, which matters for Korean-manufactured items shipped without any U.S.-origin parts. Items caught by an FDP rule frequently have sharply reduced exception eligibility at the licence provision that rule cites.",
      tool: "assess_ear_jurisdiction"
    },
    {
      citation: "15 C.F.R. § 734.4",
      requirement: "De minimis",
      note:
        "Run assess_ear_jurisdiction. Determines whether a foreign-made item is subject to the EAR by controlled U.S.-content value. Passing de minimis does not answer the FDP question.",
      tool: "assess_ear_jurisdiction"
    },
    {
      citation: "15 C.F.R. § 748.15 and Supplement No. 7 to Part 748",
      requirement: "Validated End User (VEU) authorisation",
      note:
        "Not modelled by this tool. VEU authorisations for foreign-owned fabs in China were revoked effective 31 December 2025, so historical reliance on VEU must be re-verified rather than assumed."
    }
  ];

  // --- Conclusion ----------------------------------------------------------
  const forReview = candidates.filter((c) => c.status === "requires_verification");
  const foreclosed = candidates.filter((c) => c.status === "foreclosed");
  const indeterminate = candidates.filter((c) => c.status === "indeterminate_input");
  const notModelled = candidates.filter((c) => c.status === "not_modelled");

  let statement;
  if (inputGaps.length && foreclosedBy.length) {
    // A gap must not bury a restriction that has already fired. A bare "3B001"
    // to China cannot be resolved to a subparagraph, but § 740.2(a)(9)(i) may
    // well apply, and that is the more important half of the answer.
    statement =
      `Incomplete input, AND a mandatory Part 740 restriction may already apply (${foreclosedBy.map((g) => g.citation).join(", ")}). ` +
      "Resolve the items in inputGaps to confirm, and treat the restriction as applying until you have. Do not read the candidate list as clearance.";
  } else if (inputGaps.length) {
    statement =
      "No conclusion. The input is not specific enough to evaluate Part 740 restrictions; see inputGaps. Do not read the candidate list as clearance.";
  } else if (smeGateActive || acGateActive || sanctionGateActive) {
    statement =
      `A mandatory Part 740 restriction applies (${foreclosedBy.map((g) => g.citation).join(", ")}). ` +
      `${foreclosed.length} exception(s) are foreclosed on these facts. ` +
      `${forReview.length} remain worth examining, and each still requires its own conditions to be satisfied.`;
  } else {
    statement =
      `${forReview.length} exception(s) are worth examining for this fact pattern. ` +
      "This tool does not determine eligibility: each candidate's conditions must be confirmed against the ECCN entry, the Commerce Country Chart and the exception text.";
  }

  return {
    toolContract:
      "This tool identifies License Exception issues to review. It does not determine that any exception is available, and 'requires_verification' must not be read as 'yes'.",
    provenance: LICENSE_EXCEPTION_PROVENANCE,
    input: {
      eccn: normalized || null,
      eccnParsed: parsed.valid ? { base: parsed.base, subparagraph: parsed.path.join(".") || null } : null,
      isEar99: ear99,
      destinationCountry,
      transactionType,
      itemType,
      endUserType,
      valueUsd: valueUsd ?? null,
      entityHeadquarteredInMacauOrD5
    },
    destination: {
      resolved: dest.resolved,
      canonical: dest.canonical,
      matchType: dest.matchType,
      countryGroups: dest.groups,
      isMacau: dest.isMacau,
      note: dest.isMacau ? COUNTRY_GROUP_NOTES.macau : null
    },
    inputGaps,
    mandatoryRestrictions: gates,
    restrictionsNotModelled: unmodelled,
    exceptionsToReview: forReview,
    exceptionsForeclosed: foreclosed,
    exceptionsIndeterminate: indeterminate,
    exceptionsNotModelled: notModelled.map((c) => ({
      symbols: c.symbols,
      section: c.section,
      title: c.title,
      whyStatus: c.whyStatus
    })),
    exceptionsOutOfScope: candidates
      .filter((c) => c.status === "out_of_scope")
      .map((c) => ({ symbols: c.symbols, section: c.section, title: c.title, whyStatus: c.whyStatus })),
    independentLicenceRequirements: independent,
    conclusion: { type: "issues_identified", statement },
    nextSteps: [
      "Resolve every item in inputGaps before relying on any part of this output.",
      "Work through mandatoryRestrictions first; they override per-exception analysis.",
      "For each exception in exceptionsToReview, read the ECCN entry's List Based License Exceptions block and the exception text, and record which condition was satisfied by what evidence.",
      "Run check_part744_enduse and confirm Part 744 does not independently require a licence.",
      "Assess § 734.9 FDP and § 734.4 de minimis separately; neither is modelled here.",
      "Have export-control counsel confirm any conclusion before shipment."
    ]
  };
}
