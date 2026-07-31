// De minimis U.S. content analysis under 15 C.F.R. § 734.4.
//
// WHAT THIS ANSWERS
// De minimis is a JURISDICTION question: is a foreign-made item that contains
// controlled U.S.-origin content subject to the EAR at all? It is not a licence
// question, and it comes first.
//
// THREE THINGS PRACTITIONERS GET WRONG, SO THEY ARE ENFORCED HERE
//
//  1. Passing de minimis does not mean the item is free of the EAR. The Foreign
//     Direct Product rules in § 734.9 capture foreign-produced items with ZERO
//     U.S. content. A Korean-built tool with no U.S. parts can still be subject
//     to the EAR under the SME FDP rule. This module always says so.
//  2. There are nine categories in § 734.4(a) with NO de minimis level at all.
//     Running a percentage calculation for those is meaningless.
//  3. The threshold depends on the destination, not on the exporter. E:1 and E:2
//     destinations get 10 percent; everywhere else gets 25 percent.

import { resolveCountry, COUNTRY_GROUP_PROVENANCE } from "../lib/countries.js";
import { normalizeEccn, isEar99, parseEccn, expandParagraphList, matchAnySpec } from "../lib/eccn.js";

export const DE_MINIMIS_PROVENANCE = Object.freeze({
  citation: "15 C.F.R. § 734.4 (De minimis U.S. content) and Supplement No. 2 to Part 734",
  verifiedAgainst: "eCFR title 15, part 734",
  ecfrIssueDate: "2026-07-23",
  countryGroups: COUNTRY_GROUP_PROVENANCE
});

/**
 * § 734.4(a): categories with NO de minimis level. Each is expressed as a test
 * over the supplied facts plus, where the regulation scopes it, a destination
 * condition.
 */
const NO_DE_MINIMIS_CASES = [
  {
    id: "a1_high_app_computer",
    citation: "15 C.F.R. § 734.4(a)(1)",
    description:
      "A foreign-made computer with an Adjusted Peak Performance exceeding that in ECCN 4A003.b containing U.S.-origin controlled semiconductors (other than memory circuits).",
    test: (f) => f.highApppComputerWithUsSemiconductors === true
  },
  {
    id: "a2_encryption_technology",
    citation: "15 C.F.R. § 734.4(a)(2)",
    description:
      "Foreign-produced encryption technology incorporating U.S.-origin encryption technology controlled by ECCN 5E002. Subject to the EAR regardless of the amount of U.S. content.",
    test: (f) => f.incorporates5E002EncryptionTechnology === true
  },
  {
    id: "a3_3B993f1_advanced_node",
    citation: "15 C.F.R. § 734.4(a)(3)",
    description:
      "Equipment meeting ECCN 3B993.f.1 parameters when destined for use in the development or production of advanced-node integrated circuits.",
    test: (f) => f.is3B993f1ForAdvancedNodeProduction === true
  },
  {
    id: "a4_9E003_technology",
    citation: "15 C.F.R. § 734.4(a)(4)",
    description:
      "U.S.-origin technology controlled by ECCN 9E003.a.1 through a.6, a.8, .h, .i and .l when redrawn, used, consulted or otherwise commingled abroad.",
    test: (f) => f.commingles9E003Technology === true
  },
  {
    id: "a5_0A919_military_commodity",
    citation: "15 C.F.R. § 734.4(a)(5)",
    description:
      "Foreign-made military commodities incorporating commodities described in ECCN 0A919.a.1, when destined for Country Group D:5.",
    test: (f, ctx) => f.isMilitaryCommodityWith0A919 === true && ctx.inD5
  },
  {
    id: "a6i_9x515_600series_enumerated",
    citation: "15 C.F.R. § 734.4(a)(6)(i)",
    description:
      "Foreign-made items incorporating U.S.-origin 9x515 or 600-series items enumerated in paragraphs .a through .x, when destined for Country Group D:5.",
    test: (f, ctx) => f.incorporates9x515Or600Series === "enumerated" && ctx.inD5
  },
  {
    id: "a6ii_9x515_600series_y",
    citation: "15 C.F.R. § 734.4(a)(6)(ii)",
    description:
      "Foreign-made items incorporating U.S.-origin 9x515 or 600-series .y items, when destined for Country Group E:1 or E:2, or for Belarus, China or Russia.",
    test: (f, ctx) =>
      f.incorporates9x515Or600Series === "y_items" &&
      (ctx.inE1 || ctx.inE2 || ["Belarus", "China (PRC)", "Russia"].includes(ctx.canonical))
  },
  {
    id: "a8_sme_fdp_us_ic",
    citation: "15 C.F.R. § 734.4(a)(8)",
    description:
      "A commodity meeting ECCN 3B001.a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4, r, or 3B002.c that contains a U.S.-origin integrated circuit. Tied to the SME FDP rule.",
    test: (f, ctx) => ctx.itemInSmeSet && f.containsUsOriginIntegratedCircuit === true
  },
  {
    id: "a9_footnote5_fdp",
    citation: "15 C.F.R. § 734.4(a)(9)",
    description:
      "An item meeting an ECCN in Category 3B other than the SME set (3B001.a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4, r, 3B002.c). Tied to the Footnote 5 FDP rule.",
    test: (f, ctx) => ctx.itemInCategory3B && !ctx.itemInSmeSet && f.containsUsOriginIntegratedCircuit === true
  }
];

const SME_SET = [
  ...expandParagraphList("3B001", "a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4, r"),
  "3B002.C"
];

/**
 * @param {object} input
 * @param {"commodity"|"software"|"technology"} input.foreignItemType
 * @param {string} input.destinationCountry
 * @param {number} [input.usControlledContentPercent]
 * @param {string} [input.foreignItemEccn]
 * @param {boolean} [input.usSoftwareBundled]   software shipped bundled, not separately
 * @param {boolean} [input.category5Part2UsContent]
 * @param {boolean} [input.commingledTechnologyReportFiled]
 * @param {object} [input.noDeMinimisFacts]
 */
export function assessDeMinimis(input) {
  const {
    foreignItemType = "commodity",
    destinationCountry,
    usControlledContentPercent,
    foreignItemEccn = "",
    usSoftwareBundled,
    category5Part2UsContent = false,
    commingledTechnologyReportFiled,
    noDeMinimisFacts = {}
  } = input;

  const dest = resolveCountry(destinationCountry);
  const normalized = normalizeEccn(foreignItemEccn);
  const parsed = parseEccn(normalized);

  const inputGaps = [];
  if (!dest.resolved) {
    inputGaps.push({
      field: "destinationCountry",
      severity: "fatal",
      problem:
        dest.matchType === "ambiguous"
          ? `"${dest.input}" matches more than one country (${(dest.candidates ?? []).join(", ")})`
          : `"${dest.input}" could not be matched to a country in 15 C.F.R. Part 740, Supplement No. 1`,
      consequence:
        "The de minimis threshold is set by the destination, so it cannot be determined. The § 734.4(a) destination-scoped exclusions were also skipped."
    });
  }

  const ctx = {
    canonical: dest.canonical,
    inD5: dest.resolved && dest.groups.includes("D:5"),
    inE1: dest.resolved && dest.groups.includes("E:1"),
    inE2: dest.resolved && dest.groups.includes("E:2"),
    itemInSmeSet: !isEar99(normalized) && matchAnySpec(normalized, SME_SET).isMatch,
    itemInCategory3B: parsed.valid && parsed.base?.startsWith("3B")
  };

  // --- § 734.4(a): no de minimis at all -----------------------------------
  const noDeMinimisTriggered = NO_DE_MINIMIS_CASES.filter((c) => {
    try {
      return c.test(noDeMinimisFacts, ctx) === true;
    } catch {
      return false;
    }
  }).map((c) => ({ id: c.id, citation: c.citation, description: c.description }));

  const unassessedNoDeMinimisCases = NO_DE_MINIMIS_CASES.filter(
    (c) => !noDeMinimisTriggered.some((t) => t.id === c.id)
  ).map((c) => ({ id: c.id, citation: c.citation, description: c.description }));

  // --- threshold ----------------------------------------------------------
  let threshold = null;
  let thresholdBasis = null;
  if (dest.resolved) {
    if (ctx.inE1 || ctx.inE2) {
      threshold = 10;
      thresholdBasis =
        `${dest.canonical} is in Country Group ${[ctx.inE1 ? "E:1" : null, ctx.inE2 ? "E:2" : null].filter(Boolean).join("/")}. ` +
        "The 25 percent rule in § 734.4(d) is unavailable for E:1 and E:2 destinations, so only the 10 percent rule in § 734.4(c) can apply.";
    } else {
      threshold = 25;
      thresholdBasis =
        `${dest.canonical} is not in Country Group E:1 or E:2, so the 25 percent rule in § 734.4(d) is available. ` +
        "The 10 percent rule in § 734.4(c) applies to any country in the world and remains available as well.";
    }
  }

  // --- verdict ------------------------------------------------------------
  let verdict;
  let statement;

  if (noDeMinimisTriggered.length > 0) {
    verdict = "no_de_minimis_available";
    statement =
      `§ 734.4(a) removes the de minimis level entirely for this fact pattern (${noDeMinimisTriggered.map((c) => c.citation).join(", ")}). ` +
      "The foreign-made item is subject to the EAR regardless of the U.S.-content percentage, so no calculation will help.";
  } else if (inputGaps.some((g) => g.severity === "fatal")) {
    verdict = "cannot_evaluate";
    statement = "Cannot evaluate. The destination sets the threshold and could not be resolved.";
  } else if (foreignItemType === "software" && usSoftwareBundled === false) {
    verdict = "subject_to_ear";
    statement =
      "U.S.-origin software exported or reexported separately from the foreign-made item, that is not bundled or incorporated with it, is not eligible for the de minimis exclusion at all and remains subject to the EAR. See the note to § 734.4(c)(1) and (d)(1).";
  } else if (usControlledContentPercent === undefined || usControlledContentPercent === null) {
    verdict = "indeterminate";
    statement =
      `The applicable threshold is ${threshold} percent, but no U.S.-controlled-content percentage was supplied. ` +
      "Calculate it under Supplement No. 2 to Part 734 before drawing any conclusion. Absence of a figure is not a de minimis pass.";
  } else if (usControlledContentPercent > threshold) {
    verdict = "subject_to_ear";
    statement =
      `Stated U.S. controlled content of ${usControlledContentPercent} percent exceeds the ${threshold} percent threshold for ${dest.canonical}, ` +
      "so the foreign-made item is subject to the EAR.";
  } else {
    verdict = "de_minimis_threshold_met";
    statement =
      `Stated U.S. controlled content of ${usControlledContentPercent} percent is at or below the ${threshold} percent threshold for ${dest.canonical}. ` +
      "Subject to the conditions below being satisfied, the reexport would not be subject to the EAR on de minimis grounds. This does NOT mean the item is outside the EAR: run the § 734.9 Foreign Direct Product analysis separately.";
  }

  // --- conditions that must be satisfied ----------------------------------
  const conditions = [];
  if (verdict === "de_minimis_threshold_met" || verdict === "indeterminate") {
    conditions.push({
      requirement:
        "Count only CONTROLLED U.S.-origin content. Content that would not require a licence to the destination is generally excluded from the numerator.",
      citation: "Supplement No. 2 to Part 734"
    });
    conditions.push({
      requirement:
        "Use the calculation method in Supplement No. 2 to Part 734. You are responsible for the calculation.",
      citation: "15 C.F.R. § 734.4(e)"
    });
    conditions.push({
      requirement:
        "Document the method used to determine the percentage and retain it under the Part 762 recordkeeping rules.",
      citation: "15 C.F.R. § 734.4(g)"
    });
    if (foreignItemType === "technology") {
      conditions.push({
        requirement:
          "For foreign technology commingled with controlled U.S.-origin technology, a one-time report must be filed with BIS BEFORE relying on the de minimis exclusion. Reliance without that filing is not available.",
        citation: "15 C.F.R. § 734.4(c)(3) and (d)(3); Supplement No. 2 to Part 734",
        satisfied: commingledTechnologyReportFiled === true ? true : commingledTechnologyReportFiled === false ? false : null
      });
      conditions.push({
        requirement: "See § 770.3 for the principles that apply to commingled U.S.-origin technology and software.",
        citation: "15 C.F.R. § 734.4(f)"
      });
    }
    if (foreignItemType === "commodity") {
      conditions.push({
        requirement:
          "Bundled U.S.-origin software counts toward the percentage only if it is CCL-listed with an AT-only reason for control, or designated EAR99. For any other software an ECCN-specific analysis is required.",
        citation: "15 C.F.R. § 734.4(c)(1) note (3) and (d)(1) note (3)"
      });
    }
    if (category5Part2UsContent) {
      conditions.push({
        requirement:
          "Category 5 Part 2 U.S.-origin content triggers the special requirements in § 734.4(b). Depending on how the encryption item was classified or authorised under § 740.17, the item may be subject to the EAR notwithstanding the percentage, and the 25 percent rule may be unavailable.",
        citation: "15 C.F.R. § 734.4(b)"
      });
    }
  }

  return {
    toolContract:
      "This assesses de minimis U.S. content under § 734.4 only. Meeting the threshold does NOT place the item outside the EAR: the § 734.9 Foreign Direct Product rules reach foreign-produced items with zero U.S. content and must be assessed separately.",
    provenance: DE_MINIMIS_PROVENANCE,
    input: {
      foreignItemType,
      destinationCountry,
      foreignItemEccn: normalized || null,
      usControlledContentPercent: usControlledContentPercent ?? null,
      usSoftwareBundled: usSoftwareBundled ?? null,
      category5Part2UsContent
    },
    destination: {
      resolved: dest.resolved,
      canonical: dest.canonical,
      countryGroups: dest.groups
    },
    inputGaps,
    threshold: { percent: threshold, basis: thresholdBasis },
    noDeMinimisLevel: {
      triggered: noDeMinimisTriggered,
      note:
        noDeMinimisTriggered.length > 0
          ? "One or more § 734.4(a) categories apply, so the percentage is irrelevant."
          : "No § 734.4(a) category was established from the facts supplied. That is not a finding that none applies -- each is fact-specific and several were not asked about.",
      casesNotEstablished: unassessedNoDeMinimisCases
    },
    conditions,
    verdict: { type: verdict, statement },
    alwaysAlso: [
      {
        citation: "15 C.F.R. § 734.9",
        requirement:
          "Run the Foreign Direct Product analysis. FDP has no percentage test: a foreign-produced item with no U.S. content at all can be subject to the EAR, most relevantly for Korean manufacturers under the SME FDP rule in § 734.9(k) and the Footnote 5 rule in § 734.9(e)(3)."
      },
      {
        citation: "15 C.F.R. § 734.4(a)(7)",
        requirement:
          "OFAC rules can prohibit exports from abroad by U.S.-owned or controlled entities notwithstanding the de minimis provisions, and the de minimis rules do not relieve U.S. persons of their own obligations."
      },
      {
        citation: "15 C.F.R. Part 744",
        requirement:
          "End-use and end-user controls apply independently of jurisdiction analysis once the item is subject to the EAR."
      }
    ],
    nextSteps: [
      "Establish the U.S.-controlled-content percentage using Supplement No. 2 to Part 734, not an invoice-value shortcut.",
      "Work through each § 734.4(a) category explicitly; they override the percentage.",
      "Run assess_fdp for the same transaction before concluding the item is outside the EAR.",
      "Retain the calculation method and the reviewer's determination under Part 762."
    ]
  };
}
