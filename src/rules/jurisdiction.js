// "Is this item subject to the EAR?" -- the question that comes before every
// classification and licence question.
//
// There are several independent routes to EAR jurisdiction over a FOREIGN-made
// item, and they do not substitute for one another:
//
//   § 734.3   U.S.-origin items are subject to the EAR wherever they go
//   § 734.4   a foreign-made item containing more than the de minimis level of
//             controlled U.S. content is subject to the EAR
//   § 734.9   a foreign-PRODUCED item is subject to the EAR if an FDP rule
//             reaches it, with NO percentage test at all
//
// The trap this module exists to close: passing de minimis feels like an answer,
// and it is routinely treated as one. It is not. An item can be comfortably under
// 25 percent U.S. content, or contain none at all, and still be subject to the
// EAR under § 734.9. So a de minimis pass is never reported as a conclusion on
// its own -- the FDP result is always carried alongside it.

import { assessFdp } from "./fdp.js";
import { assessDeMinimis } from "./de-minimis.js";

/**
 * @param {object} input Union of the assessFdp and assessDeMinimis inputs, plus
 *   `itemOrigin` to route the analysis.
 */
export function assessEarJurisdiction(input) {
  const {
    itemOrigin = "foreign",
    destinationCountry,
    foreignItemEccn,
    skipDeMinimis = false,
    skipFdp = false
  } = input;

  // --- U.S.-origin short circuit ------------------------------------------
  if (itemOrigin === "us") {
    return {
      toolContract:
        "Determines whether an item is subject to the EAR. This is a jurisdiction question and precedes classification and licence analysis.",
      itemOrigin,
      routesAssessed: [],
      conclusion: {
        type: "subject_to_ear",
        basis: ["15 C.F.R. § 734.3"],
        statement:
          "The item is U.S.-origin, so it is subject to the EAR wherever it is located and wherever it goes. Neither de minimis nor the Foreign Direct Product rules are relevant: those exist to decide when FOREIGN-made items fall within the EAR. Proceed to classification and licence analysis."
      },
      nextSteps: [
        "Establish the ECCN with classify_eccn, then work the Commerce Country Chart.",
        "Run check_part744_enduse; end-use and end-user controls apply to EAR99 items too.",
        "Run analyze_license_exceptions only after the ECCN and Part 744 position are settled."
      ]
    };
  }

  const fdp = skipFdp
    ? null
    : assessFdp({ ...input, itemIsUsOrigin: false });
  const deMinimis = skipDeMinimis
    ? null
    : assessDeMinimis({
        foreignItemType: input.foreignItemType ?? "commodity",
        destinationCountry,
        foreignItemEccn,
        usControlledContentPercent: input.usControlledContentPercent,
        usSoftwareBundled: input.usSoftwareBundled,
        category5Part2UsContent: input.category5Part2UsContent,
        commingledTechnologyReportFiled: input.commingledTechnologyReportFiled,
        noDeMinimisFacts: input.noDeMinimisFacts
      });

  // --- combine -------------------------------------------------------------
  const fdpApplies = (fdp?.rulesApplying?.length ?? 0) > 0;
  const fdpIndeterminate = (fdp?.rulesIndeterminate?.length ?? 0) > 0;

  const dmVerdict = deMinimis?.verdict?.type ?? null;
  const dmSubjects = dmVerdict === "subject_to_ear" || dmVerdict === "no_de_minimis_available";
  const dmPasses = dmVerdict === "de_minimis_threshold_met";
  const dmUnknown = dmVerdict === "indeterminate" || dmVerdict === "cannot_evaluate";

  const basis = [];
  let type;
  let statement;

  if (fdpApplies || dmSubjects) {
    type = "subject_to_ear";
    if (fdpApplies) {
      basis.push(...fdp.rulesApplying.map((r) => r.citation));
    }
    if (dmSubjects) {
      basis.push(
        dmVerdict === "no_de_minimis_available"
          ? deMinimis.noDeMinimisLevel.triggered.map((c) => c.citation).join(", ")
          : "15 C.F.R. § 734.4"
      );
    }
    const parts = [];
    if (fdpApplies) {
      parts.push(
        `an FDP rule reaches it (${fdp.rulesApplying.map((r) => `${r.citation} ${r.name}`).join("; ")})`
      );
    }
    if (dmSubjects) {
      parts.push(
        dmVerdict === "no_de_minimis_available"
          ? "§ 734.4(a) removes the de minimis level for this fact pattern"
          : "its controlled U.S. content exceeds the applicable de minimis threshold"
      );
    }
    statement =
      `The foreign-made item IS subject to the EAR because ${parts.join(", and ")}. ` +
      (fdpApplies
        ? "Note that the FDP route does not depend on U.S. content at all: this conclusion stands even at zero percent U.S. content. "
        : "") +
      "Proceed to classification and licence analysis at the cited provisions.";
  } else if (fdpIndeterminate || dmUnknown) {
    type = "indeterminate";
    const open = [];
    if (fdpIndeterminate) open.push(`${fdp.rulesIndeterminate.length} FDP rule(s) unresolved`);
    if (dmUnknown) open.push("the de minimis calculation is unresolved");
    statement =
      `Jurisdiction cannot be determined: ${open.join(" and ")}. ` +
      "This is NOT a finding that the item is outside the EAR. " +
      (dmPasses
        ? "The de minimis threshold appears to be met, but that alone never establishes that an item is outside the EAR while any FDP rule remains unresolved. "
        : "") +
      "Resolve the open questions below.";
  } else {
    type = "not_established_as_subject_to_ear";
    statement =
      "On the facts supplied, neither the de minimis rule nor any FDP rule was established as bringing this foreign-made item within the EAR. " +
      "Treat this as a documented working conclusion, not a clearance: it depends entirely on the completeness of the production-input and end-user facts you supplied, and both § 734.4 and § 734.9 turn on 'knowledge', which includes reason to know.";
  }

  const openQuestions = [
    ...(fdp?.openQuestions ?? []).map((q) => ({ route: "fdp", ...q })),
    ...(dmUnknown
      ? [
          {
            route: "de_minimis",
            citation: "15 C.F.R. § 734.4",
            name: "De minimis U.S. content",
            unresolved: [deMinimis.verdict.statement]
          }
        ]
      : [])
  ];

  return {
    toolContract:
      "Determines whether an item is subject to the EAR, which precedes classification and licence analysis. De minimis and the Foreign Direct Product rules are independent routes: passing one does not answer the other.",
    itemOrigin,
    routesAssessed: [
      ...(deMinimis ? ["de_minimis_734_4"] : []),
      ...(fdp ? ["fdp_734_9"] : [])
    ],
    conclusion: { type, basis: [...new Set(basis)], statement },
    deMinimis: deMinimis
      ? {
          verdict: deMinimis.verdict,
          threshold: deMinimis.threshold,
          noDeMinimisLevel: deMinimis.noDeMinimisLevel,
          conditions: deMinimis.conditions
        }
      : { skipped: true },
    fdp: fdp
      ? {
          summary: fdp.summary,
          rulesApplying: fdp.rulesApplying,
          rulesIndeterminate: fdp.rulesIndeterminate,
          rulesNotApplying: fdp.rulesNotApplying,
          conclusion: fdp.conclusion
        }
      : { skipped: true },
    openQuestions,
    provenance: {
      ...(fdp?.provenance ?? {}),
      deMinimis: deMinimis?.provenance ?? null
    },
    ifSubjectToEarThen: [
      "Establish the ECCN. Run classify_eccn to locate candidate CCL paragraphs, then verify the parameters.",
      "Run check_part744_enduse. End-use and end-user controls apply regardless of ECCN and reach EAR99 items.",
      "Run analyze_license_exceptions. Note that items caught by an FDP rule often have sharply reduced exception eligibility at the licence provision cited by that rule.",
      "Screen every party with screen_restricted_party, and trace ownership for the 50 percent affiliates rule."
    ],
    nextSteps: [
      ...(openQuestions.length
        ? ["Resolve the open questions below; several FDP prongs turn on facts only the manufacturer knows."]
        : []),
      "Ask upstream suppliers for a model certification under § 734.9(a)(2) so the FDP position does not have to be reconstructed for every shipment.",
      "Record the jurisdiction determination, the facts relied on, the reviewer and the date under the Part 762 recordkeeping rules."
    ]
  };
}
