// End-use and end-user control analysis for 15 C.F.R. Part 744.
//
// DESIGN CONTRACT
// This module produces a list of Part 744 issues that must be reviewed. It does
// NOT screen any party against any list -- it has no access to the Entity List,
// MEU List, Unverified List or SDN List. Absence of flags therefore means
// "this heuristic found nothing", never "the transaction is clear".
//
// Country scopes below are taken from the current regulation text rather than
// from memory, because they have changed repeatedly. In particular § 744.21 now
// reaches Burma, Cambodia, China, Nicaragua and Venezuela (for items in
// Supplement No. 2 to Part 744) plus Belarus and Russia (for any item) -- not
// the China/Russia/Venezuela trio from the 2020 rule.

import {
  resolveCountry,
  isMacauOrD5,
  isA5orA6,
  COUNTRY_GROUP_PROVENANCE,
  COUNTRY_GROUP_NOTES
} from "../lib/countries.js";
import { normalizeEccn, isEar99, parseEccn, expandParagraphList, matchAnySpec, eccnCategoryGroup } from "../lib/eccn.js";
import { matchTerms } from "../lib/text-match.js";

export const PART744_PROVENANCE = Object.freeze({
  countryGroups: COUNTRY_GROUP_PROVENANCE,
  part744: {
    citation: "15 C.F.R. Part 744 (Control Policy: End-User and End-Use Based)",
    verifiedAgainst: "eCFR title 15, part 744",
    ecfrIssueDate: "2026-07-23",
    keyAmendments: [
      "90 FR 47212 (Sept. 30, 2025) -- Affiliates rule, § 744.21(a)(3) and Supplement No. 8 to Part 744",
      "§ 744.23 supercomputer / advanced-node IC / SME end-use controls"
    ]
  }
});

// § 744.21(a)(1): items in Supplement No. 2 to Part 744, for military end use
// or military end users in these countries.
const MEU_SUPP2_COUNTRIES = ["Burma", "Cambodia", "China (PRC)", "Nicaragua", "Venezuela"];
// § 744.21(a)(2): ANY item subject to the EAR, for these countries.
const MEU_ANY_ITEM_COUNTRIES = ["Belarus", "Russia"];

// § 744.22(a): military-intelligence end use / end user.
const MILINT_COUNTRIES = ["Belarus", "Burma", "Cambodia", "China (PRC)", "Russia", "Venezuela"];

// Supplement No. 3 to Part 744 -- countries NOT subject to the § 744.2(a)
// nuclear end-use restrictions. Note that South Korea is NOT on this list.
const NUCLEAR_CARVE_OUT = [
  "Australia", "Austria", "Belgium", "Canada", "Denmark", "Finland", "France", "Germany",
  "Greece", "Iceland", "Ireland", "Italy", "Japan", "Luxembourg", "Netherlands",
  "New Zealand", "Norway", "Portugal", "Spain", "Sweden", "Turkey", "Türkiye", "United Kingdom"
];

// § 744.23(a)(1) item scope for the "supercomputer" control.
const SUPERCOMPUTER_ITEM_SPECS = [
  "3A001", "3A991", "4A994", "5A002", "5A004", "5A992", "4A003", "4A004"
];

// § 744.23(a)(4)(i) SME scope. 3B001 except .g and .h.
const SME_TARGET_SPECS = [
  ...expandParagraphList("3B001", "a, b, c, d, e, f, i, j, k, l, m, n, o, p, q, r"),
  "3B002", "3B611", "3B903", "3B991", "3B992", "3B993", "3B994"
];

function severityRank(s) {
  return { blocking: 3, high: 2, medium: 1, informational: 0 }[s] ?? 0;
}

/**
 * Free-text cues that suggest a flag should have been set.
 *
 * The § 744.23 and § 744.21 controls are driven by explicit flags, because
 * inferring a licence requirement from prose would be guessing. But staying
 * silent is its own failure: a request describing "commercial DRAM production"
 * at a fab in China plainly needs the § 744.23(a)(2) question asked. So a cue
 * raises a QUESTION rather than a finding.
 */
const FLAG_CUES = {
  semiconductorFabEndUse: {
    terms: ["fab", "fabrication", "foundry", "wafer", "DRAM", "NAND", "IC production", "integrated circuit", "node", "lithography"],
    flag: "flags.semiconductorFabEndUse",
    citation: "15 C.F.R. § 744.23(a)(2)",
    question:
      "Will the item be used in the development or production of integrated circuits at a facility in Macau or Country Group D:5? If so, § 744.23(a)(2)(i) requires a licence for ANY item subject to the EAR where advanced-node production occurs at that facility, including EAR99 items and regardless of who owns the fab."
  },
  smeDevelopmentOrProduction: {
    terms: ["semiconductor manufacturing equipment", "SME", "etcher", "deposition tool", "tool parts", "spare parts", "subsystem"],
    flag: "flags.smeDevelopmentOrProduction",
    citation: "15 C.F.R. § 744.23(a)(4)",
    question:
      "Is the item for the development or production of semiconductor manufacturing equipment? If so, § 744.23(a)(4) applies to CCL items destined to Macau or Country Group D:5."
  },
  militaryEndUse: {
    terms: ["military", "defence", "defense", "armed forces", "PLA", "army", "navy", "air force"],
    flag: "flags.militaryEndUse",
    citation: "15 C.F.R. § 744.21",
    question:
      "Is there a military end use or military end user? § 744.21 reaches Burma, Cambodia, China, Nicaragua and Venezuela for Supplement No. 2 items, and Belarus and Russia for any item."
  },
  usPersonSupport: {
    terms: ["secondment", "expatriate", "US engineer", "American staff", "on-site support", "resident engineer"],
    flag: "flags.usPersonSupport",
    citation: "15 C.F.R. § 744.6",
    question:
      "Will any U.S. person provide support? § 744.6 attaches to the person, not the item, and applies even where nothing subject to the EAR moves."
  },
  ecadTcadForAdvancedNodeDesign: {
    terms: ["ECAD", "TCAD", "EDA", "design software", "place and route", "synthesis"],
    flag: "flags.ecadTcadForAdvancedNodeDesign",
    citation: "15 C.F.R. § 744.23(a)(2)(iii)",
    question:
      "Is this ECAD or TCAD software or technology used to design an advanced-node IC that will be produced in Macau or Country Group D:5?"
  }
};

/**
 * @param {object} input
 * @param {string} input.destinationCountry
 * @param {string} [input.endUser]
 * @param {string} [input.endUse]
 * @param {string} [input.eccn]
 * @param {object} [input.flags]
 * @param {object} [input.endUserScreening]
 */
export function checkPart744(input) {
  const {
    destinationCountry,
    endUser = "",
    endUse = "",
    eccn = "",
    flags = {},
    endUserScreening = {}
  } = input;

  const dest = resolveCountry(destinationCountry);
  const normalized = normalizeEccn(eccn);
  const ear99 = isEar99(normalized);
  const parsed = parseEccn(normalized);
  const { category, group } = eccnCategoryGroup(normalized);

  const issues = [];
  const inputGaps = [];

  const macauOrD5 = dest.resolved && isMacauOrD5(dest);

  // Gaps are graded. An unresolved destination is fatal, because every
  // country-scoped control was skipped. A missing ECCN only limits the
  // item-scoped checks -- several Part 744 controls (§ 744.6 U.S.-person
  // activities, § 744.3(a)(2) WMD-delivery systems, the Entity List and the
  // affiliates rule) attach regardless of ECCN, so a finding under those must
  // not be downgraded to "cannot evaluate" just because no ECCN was supplied.
  if (!dest.resolved) {
    inputGaps.push({
      field: "destinationCountry",
      severity: "fatal",
      problem:
        dest.matchType === "ambiguous"
          ? `"${dest.input}" matches more than one country (${(dest.candidates ?? []).join(", ")})`
          : `"${dest.input}" could not be matched to a country in 15 C.F.R. Part 740, Supplement No. 1`,
      consequence:
        "Every country-scoped Part 744 control below was skipped. This output cannot be used."
    });
  }
  if (!normalized) {
    inputGaps.push({
      field: "eccn",
      severity: "limiting",
      problem: "No ECCN or EAR99 designation supplied",
      consequence:
        "Item-scoped checks were skipped (§ 744.23 item scopes, § 744.17, and whether the item is within Supplement No. 2 to Part 744 for § 744.21). Controls that do not depend on the ECCN were still evaluated, so any issue reported below stands."
    });
  }

  // ---------------------------------------------------------------------
  // Restricted-party status. This is the single most common source of a
  // Part 744 licence requirement and the tool cannot determine it.
  // ---------------------------------------------------------------------
  const screeningPerformed = endUserScreening.screeningPerformed === true;
  const listed =
    endUserScreening.listedOnEntityList ||
    endUserScreening.listedOnMeuList ||
    endUserScreening.sdnListed;
  const ownershipPct = Number.isFinite(endUserScreening.ownershipPercentByListedEntity)
    ? endUserScreening.ownershipPercentByListedEntity
    : null;
  const affiliateTriggered =
    endUserScreening.ownedFiftyPercentOrMoreByListedEntity === true ||
    (ownershipPct !== null && ownershipPct >= 50);

  if (listed) {
    issues.push({
      citation: "15 C.F.R. § 744.16 (Entity List); § 744.21(b)(1) (MEU List); § 744.8 (SDN)",
      rule: "Listed party is a party to the transaction",
      requirement:
        "A licence is required to the extent stated in the List Requirement column of the entry.",
      effect:
        "Per § 744.16(b), NO License Exception is available for a listed Entity List party for the specified items, apart from the narrow § 740.2(a)(5) civil-aviation carve-out for certain Indian and Pakistani entities and entities listed under § 744.20.",
      severity: "blocking"
    });
  }

  if (affiliateTriggered) {
    issues.push({
      citation: "15 C.F.R. § 744.21(a)(3), § 744.8(a)(2), § 744.16, and Supplement No. 8 to Part 744",
      rule: "Affiliates rule -- 50 percent ownership",
      requirement:
        "A foreign entity owned, directly or indirectly, individually or in aggregate, 50 percent or more by one or more listed entities is subject to a licence requirement to the same degree as if the transaction were with its owners.",
      effect:
        "The unlisted affiliate inherits the owner's licence requirement, licence-exception ineligibility and licence review policy. Where multiple listed owners apply, the MOST restrictive of their requirements governs.",
      detail:
        ownershipPct !== null
          ? `Stated ownership by a listed entity is ${ownershipPct}%, which is at or above the 50 percent threshold.`
          : "Ownership of 50 percent or more by a listed entity was indicated.",
      note:
        "Added by 90 FR 47212 (Sept. 30, 2025). Read Supplement No. 8 to Part 744 for the ownership-aggregation guidelines.",
      severity: "blocking"
    });
  } else if (ownershipPct !== null && ownershipPct > 0 && ownershipPct < 50) {
    issues.push({
      citation: "Supplement No. 8 to Part 744, paragraph (c)",
      rule: "Sub-50 percent ownership by a listed entity",
      requirement:
        "No automatic licence requirement, but BIS advises caution: such entities may be designated in future.",
      detail: `Stated ownership by a listed entity is ${ownershipPct}%.`,
      severity: "medium"
    });
  }

  if (!screeningPerformed) {
    issues.push({
      citation: "15 C.F.R. § 744.16, § 744.15, § 744.21(b), § 744.8; 15 C.F.R. Part 732 Supplement No. 3",
      rule: "Restricted-party screening has NOT been performed by this tool",
      requirement:
        "Screen the end user, ultimate consignee, intermediate consignees, purchaser, freight forwarders, banks and all listed addresses against the Entity List (Supplement No. 4 to Part 744), MEU List (Supplement No. 7), Unverified List (Supplement No. 6) and the OFAC SDN List.",
      effect:
        "Until this is done, no part of this output may be treated as indicating that the transaction is permissible.",
      detail:
        "This server holds no restricted-party data. Ownership must also be traced to apply the 50 percent affiliates rule; if ownership cannot be determined, § 744.21(a)(3) requires resolving the red flag or obtaining a licence before proceeding (see Red Flag 29, Supplement No. 3 to Part 732).",
      severity: "blocking"
    });
  }

  // ---------------------------------------------------------------------
  // § 744.21 Military end use / end user
  // ---------------------------------------------------------------------
  if (dest.resolved) {
    const supp2Scope = MEU_SUPP2_COUNTRIES.includes(dest.canonical);
    const anyItemScope = MEU_ANY_ITEM_COUNTRIES.includes(dest.canonical);
    if (flags.militaryEndUse || flags.militaryEndUser) {
      if (anyItemScope) {
        issues.push({
          citation: "15 C.F.R. § 744.21(a)(2)",
          rule: "Military end use / military end user -- Belarus or Russia",
          requirement:
            "A licence is required for ANY item subject to the EAR, including items designated EAR99.",
          effect:
            "Licence review policy is denial, except for food and medicine designated EAR99 which is case-by-case. Only License Exception GOV under § 740.11(b)(2)(i) and (ii) is available.",
          severity: "blocking"
        });
      } else if (supp2Scope) {
        issues.push({
          citation: "15 C.F.R. § 744.21(a)(1)",
          rule: `Military end use / military end user -- ${dest.canonical}`,
          requirement:
            "A licence is required for items subject to the EAR that are LISTED IN SUPPLEMENT NO. 2 TO PART 744.",
          effect:
            "Presumption of denial. Only License Exception GOV under § 740.11(b)(2)(i) and (ii) is available.",
          detail:
            "Scope note: unlike Belarus and Russia, this control is limited to the Supplement No. 2 item list. It does NOT reach every EAR99 item. Check whether the item appears in Supplement No. 2 before concluding a licence is required.",
          actionRequired: "Compare the item against Supplement No. 2 to Part 744.",
          severity: "high"
        });
      } else {
        issues.push({
          citation: "15 C.F.R. § 744.21",
          rule: "Military end use indicated, but outside the § 744.21 country scope",
          requirement:
            "§ 744.21 country scope is Burma, Cambodia, China, Nicaragua and Venezuela (Supplement No. 2 items) and Belarus and Russia (any item).",
          detail: `${dest.canonical} is not within that scope. A military end use may still trigger § 744.17 (microprocessors), § 744.22, the ITAR, or a CCL-based licence requirement.`,
          severity: "medium"
        });
      }
      // MEU applies to listed military end users wherever located.
      issues.push({
        citation: "15 C.F.R. § 744.21(a)(1) and (a)(2), final sentences",
        rule: "Military end users located outside the listed countries",
        requirement:
          "Burmese, Cambodian, Chinese, Nicaraguan and Venezuelan military end users outside their own country are limited to entities on the MEU List (Supplement No. 7 to Part 744). Belarusian and Russian military end users outside their own country are limited to Entity List entries carrying a footnote 3 designation.",
        severity: "medium"
      });
    }
  }

  // ---------------------------------------------------------------------
  // § 744.22 Military-intelligence end use / end user
  // ---------------------------------------------------------------------
  if (flags.militaryIntelligenceEndUse && dest.resolved) {
    const inScope =
      MILINT_COUNTRIES.includes(dest.canonical) ||
      dest.groups.includes("E:1") ||
      dest.groups.includes("E:2");
    issues.push({
      citation: "15 C.F.R. § 744.22",
      rule: "Military-intelligence end use or end user",
      requirement: inScope
        ? "A licence is required for ANY item subject to the EAR."
        : "Country scope is Belarus, Burma, Cambodia, China, Russia, Venezuela and Country Groups E:1 and E:2.",
      detail: inScope
        ? `${dest.canonical} is within the § 744.22 scope. Review policy is a presumption of denial. Only License Exception GOV under § 740.11(b)(2)(ii) is available.`
        : `${dest.canonical} is not within the § 744.22 country scope, but confirm the end user is not a listed military-intelligence end user under § 744.22(f)(2), which applies wherever located.`,
      severity: inScope ? "blocking" : "medium"
    });
  }

  // ---------------------------------------------------------------------
  // § 744.2 Nuclear
  // ---------------------------------------------------------------------
  if (flags.nuclearActivity && dest.resolved) {
    const carvedOut = NUCLEAR_CARVE_OUT.includes(dest.canonical);
    issues.push({
      citation: "15 C.F.R. § 744.2",
      rule: "Nuclear end-use control",
      requirement:
        "A licence is required where you know or have reason to know the item will be used in nuclear explosive activities, unsafeguarded nuclear activities, or safeguarded/unsafeguarded nuclear fuel-cycle activities as described in § 744.2(a).",
      detail: carvedOut
        ? `${dest.canonical} appears in Supplement No. 3 to Part 744, so certain § 744.2(a) restrictions do not apply. Confirm which paragraph of § 744.2(a) is engaged before relying on that carve-out.`
        : `${dest.canonical} is NOT in Supplement No. 3 to Part 744, so the § 744.2(a) restrictions apply in full.`,
      severity: carvedOut ? "medium" : "blocking"
    });
  }

  // ---------------------------------------------------------------------
  // § 744.3 Missile -- country-gated, unlike the previous implementation
  // ---------------------------------------------------------------------
  if (flags.missileActivity && dest.resolved) {
    const inD4 = dest.groups.includes("D:4");
    const wmdDelivery = flags.wmdDeliverySystem === true;
    if (wmdDelivery) {
      issues.push({
        citation: "15 C.F.R. § 744.3(a)(2)",
        rule: "Rocket systems or UAVs for delivery of chemical, biological or nuclear weapons",
        requirement:
          "A licence is required for use anywhere in the world, regardless of range capability, except by governmental nuclear-weapons-delivery programmes of NPT Nuclear Weapons States that are also NATO members.",
        severity: "blocking"
      });
    } else if (inD4) {
      issues.push({
        citation: "15 C.F.R. § 744.3(a)(1) and (a)(3)",
        rule: "Rocket systems or UAVs with a range of at least 300 km",
        requirement:
          "A licence is required where the item will be used in the design, development, production, operation, installation, maintenance, repair, overhaul or refurbishing of such systems in or by a country in Country Group D:4.",
        detail: `${dest.canonical} is in Country Group D:4. Under § 744.3(a)(3), if you cannot determine the range capability or the intended use, the licence requirement applies anyway.`,
        severity: "blocking"
      });
    } else {
      issues.push({
        citation: "15 C.F.R. § 744.3",
        rule: "Rocket or UAV end use indicated, outside the Country Group D:4 scope",
        requirement:
          "§ 744.3(a)(1) and (a)(3) are limited to countries in Country Group D:4. § 744.3(a)(2) applies worldwide but only to systems for delivery of chemical, biological or nuclear weapons.",
        detail: `${dest.canonical} is not in Country Group D:4 (its groups: ${dest.groups.join(", ") || "none"}). A civil space-launch or commercial UAV programme in a non-D:4 destination is not automatically caught. Set flags.wmdDeliverySystem if the system is for WMD delivery. MT-controlled items on the CCL still carry their own licence requirement.`,
        severity: "medium"
      });
    }
  }

  // ---------------------------------------------------------------------
  // § 744.4 CBW and § 744.5 maritime nuclear propulsion
  // ---------------------------------------------------------------------
  if (flags.cbwActivity) {
    issues.push({
      citation: "15 C.F.R. § 744.4",
      rule: "Chemical or biological weapons end-use control",
      requirement:
        "A licence is required where you know or have reason to know the item will be used in chemical or biological weapons activities. This control has no country carve-out.",
      severity: "blocking"
    });
  }
  if (flags.maritimeNuclearPropulsion) {
    issues.push({
      citation: "15 C.F.R. § 744.5",
      rule: "Maritime nuclear propulsion end-use control",
      requirement: "See § 744.5 and § 748.4 for special provisions on technical data.",
      severity: "high"
    });
  }

  // ---------------------------------------------------------------------
  // § 744.23 Supercomputer / advanced-node IC / SME
  // ---------------------------------------------------------------------
  if (macauOrD5) {
    const where = dest.isMacau ? "Macau" : `${dest.canonical} (Country Group D:5)`;

    if (flags.supercomputerEndUse) {
      const itemMatch = normalized ? matchAnySpec(normalized, SUPERCOMPUTER_ITEM_SPECS) : null;
      issues.push({
        citation: "15 C.F.R. § 744.23(a)(1)",
        rule: "Supercomputer end use",
        requirement:
          "A licence is required for ICs specified in 3A001, 3A991, 4A994, 5A002, 5A004 or 5A992, and for computers, electronic assemblies or components in 4A003, 4A004, 4A994, 5A002, 5A004 or 5A992, when destined for the development, production, operation, installation, maintenance, repair, overhaul or refurbishing of a supercomputer located in or destined to Macau or Country Group D:5.",
        detail: itemMatch
          ? itemMatch.isMatch
            ? `${normalized} is within the item scope (matched ${itemMatch.matched.join(", ")}).`
            : `${normalized} does not appear to be within the § 744.23(a)(1) item scope; confirm against the ECCN.`
          : "No ECCN supplied, so item scope was not tested.",
        severity: "blocking"
      });
    }

    // (a)(2) advanced-node IC production facility. This is the control the
    // previous implementation missed for Korean-owned fabs in China.
    if (flags.semiconductorFabEndUse) {
      const node = flags.advancedNodeProduction ?? "unknown";
      if (node === "yes") {
        issues.push({
          citation: "15 C.F.R. § 744.23(a)(2)(i)",
          rule: "Any item destined for a facility producing advanced-node integrated circuits",
          requirement:
            "A licence is required for ANY item subject to the EAR where you know the item will be used in the development or production of ICs at a facility located in Macau or Country Group D:5 where production of advanced-node ICs occurs.",
          effect:
            "The item scope is unlimited -- ECCN and EAR99 status are both irrelevant. Ownership of the fab is also irrelevant: a fab in China owned by a Korean, Taiwanese or U.S. parent is within scope.",
          detail: `Facility is in ${where}.`,
          relatedChecks: [
            "§ 744.23(a)(2)(iv): items under (a)(2)(i) and (ii) destined to entities designated with a Footnote 5 are excluded from this licence requirement.",
            "§ 744.23(a)(5): 'production' excludes back-end steps such as assembly, test and packaging that do not alter the IC technology level.",
            "Validated End User authorisations for foreign-owned fabs in China were revoked effective 31 December 2025. Do not assume a historical VEU authorisation still applies."
          ],
          severity: "blocking"
        });
      } else if (node === "unknown") {
        issues.push({
          citation: "15 C.F.R. § 744.23(a)(2)(ii)",
          rule: "Category 3 items to an IC production facility where the technology node is unknown",
          requirement:
            "A licence is required for any item subject to the EAR specified in Product Groups B, C, D or E of Category 3 where you know the item will be used in the development or production of ICs at a facility in Macau or Country Group D:5 that produces ICs, but you do not know whether advanced-node IC production occurs there.",
          detail:
            `Facility is in ${where} and advancedNodeProduction was not established.` +
            (category
              ? ` The stated ECCN ${normalized} is in Category ${category}, Product Group ${group}${category === "3" && ["B", "C", "D", "E"].includes(group) ? " -- within this scope." : " -- confirm whether it is within Category 3 Product Groups B/C/D/E."}`
              : " No ECCN supplied, so the Category 3 scope was not tested."),
          actionRequired:
            "Establish the facility's technology node. If advanced-node production occurs, § 744.23(a)(2)(i) applies instead and reaches ANY item.",
          severity: "blocking"
        });
      } else {
        issues.push({
          citation: "15 C.F.R. § 744.23(a)(2)",
          rule: "IC production facility in Macau or Country Group D:5",
          requirement:
            "Advanced-node production was stated not to occur. Document the basis for that determination, because (a)(2)(ii) otherwise applies to Category 3 Product Group B/C/D/E items on an 'unknown node' basis.",
          severity: "high"
        });
      }
    }

    // (a)(4) SME development or production
    if (flags.smeDevelopmentOrProduction) {
      issues.push({
        citation: "15 C.F.R. § 744.23(a)(4)(i)",
        rule: "Items for development or production of semiconductor manufacturing equipment",
        requirement:
          "A licence is required for any item subject to the EAR and specified on the CCL when destined to or within Macau or Country Group D:5 for the development or production of equipment, components, assemblies or accessories specified in 3B001 (except 3B001.g and .h), 3B002, 3B611, 3B903, 3B991 (except 3B991.b.2.a through b.2.b), 3B992, 3B993 or 3B994, or associated software and technology in Category 3 Product Groups D or E.",
        detail: `Destination is ${where}.`,
        relatedChecks: [
          "§ 744.23(a)(4)(ii) extends this to indirect transactions where development or production is by an entity headquartered in, or with an ultimate parent headquartered in, Macau or Country Group D:5, wherever that work occurs.",
          "General Order No. 4 in Supplement No. 1 to Part 736 provides a Temporary General License for less restricted SME parts, components and equipment in certain cases."
        ],
        severity: "blocking"
      });
    }
  }

  // (a)(3) advanced computing to D:5-headquartered entities, wherever located.
  if (endUserScreening.headquarteredInMacauOrD5) {
    issues.push({
      citation: "15 C.F.R. § 744.23(a)(3)",
      rule: "Advanced computing items to an entity headquartered in Macau or Country Group D:5",
      requirement:
        "A licence is required for the listed advanced computing items (including 3A090.b and the '.z' entries) destined for an entity that is headquartered in, or whose ultimate parent company is headquartered in, Macau or a destination in Country Group D:5 -- wherever that entity is located. ECCN 3A090.c has its own scope under (a)(3)(i)(B).",
      detail:
        "This reaches shipments to third countries. A data-centre operator in Singapore or Malaysia whose ultimate parent is in China is within scope.",
      severity: "blocking"
    });
  }

  // § 744.23(a)(2)(iii) ECAD/TCAD
  if (flags.ecadTcadForAdvancedNodeDesign) {
    issues.push({
      citation: "15 C.F.R. § 744.23(a)(2)(iii)",
      rule: "ECAD or TCAD software and technology for advanced-node IC design",
      requirement:
        "A licence is required for any ECAD or TCAD software or technology subject to the EAR where you know it will be used in the design of an advanced-node IC that will be produced in Macau or Country Group D:5.",
      severity: "blocking"
    });
  }

  // ---------------------------------------------------------------------
  // § 744.6 U.S. person activities
  // ---------------------------------------------------------------------
  if (flags.usPersonSupport && dest.resolved) {
    const nuclearScope = !NUCLEAR_CARVE_OUT.includes(dest.canonical);
    issues.push({
      citation: "15 C.F.R. § 744.6",
      rule: "Restrictions on specific activities of U.S. persons",
      requirement:
        "No U.S. person may, without a licence, 'support' the activities listed in § 744.6(b) -- nuclear explosive devices in any country not listed in Supplement No. 3 to Part 744; missiles in Country Group D:4 or E:2; chemical or biological weapons anywhere in the world; and the further categories in § 744.6(b) and (c).",
      effect:
        "This control attaches to the person, not the item. It applies even where no item subject to the EAR moves at all -- for example a U.S.-citizen or U.S.-permanent-resident engineer providing technical support at an overseas fab.",
      detail: `${dest.canonical} ${nuclearScope ? "is NOT" : "IS"} in Supplement No. 3 to Part 744 for the nuclear paragraph.`,
      actionRequired:
        "Identify which employees, contractors and secondees are U.S. persons and map their activities against § 744.6(b) and (c).",
      severity: "high"
    });
  }

  // ---------------------------------------------------------------------
  // § 744.17 microprocessors
  // ---------------------------------------------------------------------
  if (flags.militaryEndUse && normalized && category === "3") {
    issues.push({
      citation: "15 C.F.R. § 744.17",
      rule: "Microprocessors and associated software and technology for military end use",
      requirement:
        "Separate licence requirement for certain microprocessors and associated software and technology for military end uses or military end users. See Supplement No. 1 to Part 744 for military end-use examples.",
      severity: "medium"
    });
  }

  // ---------------------------------------------------------------------
  // Unanswered questions raised by the free text
  // ---------------------------------------------------------------------
  const freeText = [endUser, endUse].filter(Boolean).join(". ");
  const unansweredQuestions = [];
  if (freeText) {
    for (const [flagName, cue] of Object.entries(FLAG_CUES)) {
      if (flags[flagName] !== undefined) continue; // caller already answered
      const { present } = matchTerms(freeText, cue.terms);
      if (present.length === 0) continue;
      unansweredQuestions.push({
        citation: cue.citation,
        triggeredBy: present,
        setThisInput: cue.flag,
        question: cue.question,
        note:
          "This is a question, not a finding. The control was NOT evaluated because the input did not state the fact either way."
      });
    }
  }

  // ---------------------------------------------------------------------
  // Country-level context that is NOT itself a Part 744 trigger
  // ---------------------------------------------------------------------
  const context = [];
  if (dest.resolved) {
    if (dest.groups.includes("E:1")) {
      context.push({
        citation: "15 C.F.R. Part 746; Country Group E:1",
        note: `${dest.canonical} is in Country Group E:1. Read the applicable Part 746 section and check OFAC authority; most License Exceptions are unavailable.`
      });
    }
    if (dest.groups.includes("E:2")) {
      context.push({
        citation: "15 C.F.R. Part 746; Country Group E:2",
        note: `${dest.canonical} is in Country Group E:2 (unilateral embargo). Read the applicable Part 746 section.`
      });
    }
    if (macauOrD5) {
      context.push({
        citation: "15 C.F.R. Part 740, Supplement No. 1; § 740.2(a)(9)",
        note:
          `${dest.isMacau ? "Macau" : dest.canonical} is within the "Macau or Country Group D:5" scope used throughout the EAR. ` +
          (dest.isMacau ? COUNTRY_GROUP_NOTES.macau : "") +
          " License Exception availability for Category 3 items is heavily restricted; run analyze_license_exceptions."
      });
    }
    if (isA5orA6(dest)) {
      context.push({
        citation: "15 C.F.R. Part 740, Supplement No. 1",
        note: `${dest.canonical} is in Country Group ${dest.groups.filter((g) => g === "A:5" || g === "A:6").join("/")}. This affects License Exception STA and several Part 744 carve-outs, but it does not switch off any Part 744 end-use control.`
      });
    }
  }

  // ---------------------------------------------------------------------
  // Always-applicable reminders
  // ---------------------------------------------------------------------
  const alwaysCheck = [
    {
      citation: "15 C.F.R. § 744.1 and Part 732, Supplement No. 3",
      requirement:
        "Part 744 controls turn on 'knowledge', which includes reason to know from red flags. Resolve red flags rather than relying on the absence of adverse information.",
      appliesTo: "Every transaction, including EAR99 items."
    },
    {
      citation: "15 C.F.R. § 744.15 and Supplement No. 6 to Part 744",
      requirement:
        "Check the Unverified List. A UVL party requires a UVL statement and removes License Exception eligibility.",
      appliesTo: "Every transaction."
    },
    {
      citation: "15 C.F.R. § 734.9",
      requirement:
        "Assess the Foreign Direct Product rules separately. Entity List FDP, Advanced Computing FDP and SME FDP can make a foreign-made item with no U.S. content subject to the EAR.",
      appliesTo: "Korean-manufactured items in particular; not modelled by this tool."
    },
    {
      citation: "15 C.F.R. § 748.15 and Supplement No. 7 to Part 748",
      requirement:
        "If a Validated End User authorisation has historically been relied on, re-verify it. VEU authorisations for foreign-owned semiconductor fabs in China were revoked effective 31 December 2025.",
      appliesTo: "Transactions with China-located fabs."
    }
  ];

  // ---------------------------------------------------------------------
  // Outcome
  // ---------------------------------------------------------------------
  issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const blocking = issues.filter((i) => i.severity === "blocking");
  const high = issues.filter((i) => i.severity === "high");

  const fatalGaps = inputGaps.filter((g) => g.severity === "fatal");
  const limitingGaps = inputGaps.filter((g) => g.severity === "limiting");

  const outcome = fatalGaps.length
    ? "cannot_evaluate"
    : blocking.length
      ? "licence_requirement_identified"
      : high.length
        ? "significant_issues_to_resolve"
        : limitingGaps.length
          ? "incomplete_no_flag"
          : "no_heuristic_flag";

  const limitSuffix = limitingGaps.length
    ? ` Note that ${limitingGaps.length} input gap(s) limited the analysis: ${limitingGaps.map((g) => g.field).join(", ")}. Item-scoped controls were not evaluated.`
    : "";

  const statement = {
    cannot_evaluate: "Cannot evaluate. Required input is missing or unresolved; see inputGaps.",
    licence_requirement_identified:
      `${blocking.length} issue(s) indicate a Part 744 licence requirement or an unresolved blocking condition. Resolve each before proceeding.` +
      limitSuffix,
    significant_issues_to_resolve:
      `${high.length} significant issue(s) require resolution. No Part 744 licence requirement was positively identified, which is not the same as none applying.` +
      limitSuffix +
      (unansweredQuestions.length ? ` ${unansweredQuestions.length} control(s) were not evaluated; see unansweredQuestions.` : ""),
    incomplete_no_flag:
      "No Part 744 trigger was identified from the facts supplied, but the analysis was incomplete." +
      limitSuffix +
      " Supply the missing input and re-run before drawing any conclusion.",
    no_heuristic_flag:
      "This heuristic identified no Part 744 trigger from the facts supplied. That is NOT a clearance: no restricted-party screening was performed, the Foreign Direct Product rules were not assessed, and Part 744 turns on knowledge and red flags that a structured input cannot capture." +
      (unansweredQuestions.length
        ? ` ${unansweredQuestions.length} control(s) were not evaluated because the input did not state the relevant fact; see unansweredQuestions.`
        : "")
  }[outcome];

  return {
    toolContract:
      "This tool lists Part 744 issues to review. It performs NO restricted-party screening and cannot clear a transaction. An empty issue list means the heuristic found nothing, not that the transaction is permissible.",
    provenance: PART744_PROVENANCE,
    input: {
      destinationCountry,
      endUser: endUser || null,
      endUse: endUse || null,
      eccn: normalized || null,
      isEar99: ear99,
      flags,
      endUserScreening
    },
    destination: {
      resolved: dest.resolved,
      canonical: dest.canonical,
      matchType: dest.matchType,
      countryGroups: dest.groups,
      isMacau: dest.isMacau,
      isMacauOrD5: macauOrD5
    },
    inputGaps,
    issuesToReview: issues,
    unansweredQuestions,
    countryContext: context,
    alwaysCheck,
    outcome: { type: outcome, statement },
    nextSteps: [
      ...(unansweredQuestions.length
        ? [
            `Answer the ${unansweredQuestions.length} question(s) in unansweredQuestions and re-run. The description contains cues for controls that were not evaluated because the relevant fact was not stated.`
          ]
        : []),
      "Perform restricted-party screening on every party and address, then re-run with endUserScreening.screeningPerformed set.",
      "Trace ownership to apply the 50 percent affiliates rule under § 744.21(a)(3) and Supplement No. 8 to Part 744.",
      "For each issue, record the determination, the evidence relied on, the reviewer and the date.",
      "Run analyze_license_exceptions; a Part 744 licence requirement generally removes License Exception eligibility.",
      "Assess § 734.9 Foreign Direct Product rules separately.",
      "Have export-control counsel confirm any blocking issue before shipment."
    ]
  };
}
