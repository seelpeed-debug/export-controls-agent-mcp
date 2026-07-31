// Foreign Direct Product analysis under 15 C.F.R. § 734.9.
//
// WHY THIS MATTERS MOST FOR A KOREAN MANUFACTURER
// De minimis asks what fraction of an item is American. FDP does not ask that at
// all. A tool built entirely in Korea from Korean parts, containing no U.S.
// content whatsoever, is subject to the EAR if it was produced using U.S.-origin
// technology or software of the right ECCN and is heading to the wrong place or
// party. The SME rule in § 734.9(k) and the Footnote 5 rule in § 734.9(e)(3) are
// the two that reach Korean semiconductor-equipment supply chains directly.
//
// EVALUATION MODEL
// Every rule has two prongs and needs BOTH. So each prong is resolved to one of
//   met | not_met | indeterminate
// and the rule only applies when both are `met`. Where a prong is
// `indeterminate` the rule is reported as indeterminate, never as inapplicable:
// the difference between "this rule does not apply" and "we do not know whether
// this rule applies" is the whole point of the analysis.

import { createRequire } from "node:module";
import { resolveCountry, isMacauOrD5, COUNTRY_GROUP_PROVENANCE } from "../lib/countries.js";
import { normalizeEccn, isEar99, parseEccn, matchAnySpec } from "../lib/eccn.js";
import { FDP_RULES, FDP_PROVENANCE } from "../data/fdp-rules.js";

const require = createRequire(import.meta.url);
const CCL = require("../data/ccl.json");

export { FDP_PROVENANCE };

/** Reason-for-Control lookup, so "is this NS-controlled?" is answered from data. */
const REASON_FOR_CONTROL = new Map(
  CCL.entries.map((e) => [e.eccn, (e.reasonForControl ?? "").toUpperCase()])
);

/**
 * Item-scope predicates for the rules whose scope the regulation states as a
 * condition rather than an ECCN list. Resolving these turns a pile of
 * "indeterminate" results into real answers: an etcher is plainly not a 9x515
 * item, and saying so is more useful than declining to decide.
 */
const ITEM_SCOPE_TESTS = {
  is_9x515: (eccn) => {
    const { base } = parseEccn(eccn);
    if (!base) return { state: UNKNOWN, reason: "ECCN could not be parsed." };
    const hit = /^9[A-EX]515$/.test(base);
    return {
      state: hit ? MET : NOT_MET,
      reason: hit ? `${base} is a 9x515 ECCN.` : `${base} is not a 9x515 ECCN.`
    };
  },
  is_600_series: (eccn) => {
    const { base } = parseEccn(eccn);
    if (!base) return { state: UNKNOWN, reason: "ECCN could not be parsed." };
    // "600 series" ECCNs have a 6 as the third character, e.g. 9A610, 0A606.
    const hit = /^\d[A-E]6\d\d$/.test(base) || base === "0A919";
    return {
      state: hit ? MET : NOT_MET,
      reason: hit
        ? `${base} is a "600 series" ECCN (or 0A919, which this rule also reaches).`
        : `${base} is not a "600 series" ECCN.`
    };
  },
  ns_controlled: (eccn) => {
    const { base } = parseEccn(eccn);
    if (!base) return { state: UNKNOWN, reason: "ECCN could not be parsed." };
    const reasons = REASON_FOR_CONTROL.get(base);
    if (reasons === undefined) {
      return {
        state: UNKNOWN,
        reason: `${base} was not found in the bundled CCL snapshot, so its Reason for Control could not be checked.`
      };
    }
    const hit = /\bNS\b/.test(reasons);
    return {
      state: hit ? MET : NOT_MET,
      reason: hit
        ? `${base} carries a national security reason for control (Reason for Control: ${reasons}).`
        : `${base} does not carry a national security reason for control (Reason for Control: ${reasons || "none stated"}).`,
      caveat: hit
        ? "The rule turns on NS control as designated in the ECCN. Confirm the specific subparagraph is NS-controlled, since some entries apply NS only to certain paragraphs."
        : undefined
    };
  },
  any_ccl_eccn: (eccn) => {
    if (isEar99(eccn)) {
      return {
        state: UNKNOWN,
        reason:
          "The item is EAR99, so it is not on the CCL. This rule also reaches items in Supplement No. 6 or 7 to Part 746, which this tool does not hold. Check those supplements."
      };
    }
    const { base, valid } = parseEccn(eccn);
    if (!valid) return { state: UNKNOWN, reason: "ECCN could not be parsed." };
    return { state: MET, reason: `${base} is a CCL entry, which satisfies this rule's item scope.` };
  },
  category_3_to_9: (eccn) => {
    if (isEar99(eccn)) {
      return {
        state: UNKNOWN,
        reason:
          "The item is EAR99. This rule also reaches items identified in Supplement No. 7 to Part 746, which this tool does not hold."
      };
    }
    const { base, valid } = parseEccn(eccn);
    if (!valid) return { state: UNKNOWN, reason: "ECCN could not be parsed." };
    const cat = Number(base[0]);
    const hit = cat >= 3 && cat <= 9;
    return {
      state: hit ? MET : NOT_MET,
      reason: hit
        ? `${base} is in Category ${cat}, within Categories 3 through 9.`
        : `${base} is in Category ${cat}, outside Categories 3 through 9. Also check Supplement No. 7 to Part 746.`
    };
  }
};

const MET = "met";
const NOT_MET = "not_met";
const UNKNOWN = "indeterminate";

/** Tri-state from a boolean-or-undefined input. */
function tri(value) {
  if (value === true) return MET;
  if (value === false) return NOT_MET;
  return UNKNOWN;
}

function anyOf(...states) {
  if (states.includes(MET)) return MET;
  if (states.includes(UNKNOWN)) return UNKNOWN;
  return NOT_MET;
}

/**
 * Does the foreign item's own ECCN fall inside the rule's item scope?
 */
function evaluateItemScope(rule, eccn) {
  // Rules with no item-scope restriction reach any foreign-produced item, so
  // this prong is satisfied without knowing the ECCN at all.
  if (rule.itemScopeUnrestricted) {
    return {
      state: MET,
      reason: `This rule places no restriction on the item's own ECCN: ${rule.itemScopeDescription}`
    };
  }

  if (!eccn) {
    return { state: UNKNOWN, reason: "No ECCN supplied for the foreign-produced item." };
  }

  if (rule.itemScopeTest) {
    const fn = ITEM_SCOPE_TESTS[rule.itemScopeTest];
    if (!fn) {
      return { state: UNKNOWN, reason: `Unimplemented item-scope test "${rule.itemScopeTest}".` };
    }
    return fn(eccn);
  }

  if (!rule.itemScopeEccns) {
    return {
      state: UNKNOWN,
      reason: `Item scope is defined by a condition rather than an ECCN list: ${rule.itemScopeDescription}`
    };
  }
  if (isEar99(eccn)) {
    return {
      state: NOT_MET,
      reason: "The foreign-produced item is designated EAR99, which is outside this rule's enumerated item scope."
    };
  }

  const excluded = rule.itemScopeExclusions
    ? matchAnySpec(eccn, rule.itemScopeExclusions)
    : { isMatch: false, isIndeterminate: false, matched: [] };
  if (excluded.isMatch) {
    return {
      state: NOT_MET,
      reason: `${eccn} is expressly excluded from this rule's item scope (matched ${excluded.matched.join(", ")}).`
    };
  }

  const included = matchAnySpec(eccn, rule.itemScopeEccns);
  if (included.isMatch) {
    if (excluded.isIndeterminate) {
      return {
        state: UNKNOWN,
        reason:
          `${eccn} is within ${included.matched.join(", ")}, but this rule excludes ${excluded.indeterminate.join(", ")}. ` +
          "Supply the full subparagraph to decide whether the exclusion applies."
      };
    }
    return { state: MET, reason: `${eccn} is within the item scope (matched ${included.matched.join(", ")}).` };
  }
  if (included.isIndeterminate) {
    return {
      state: UNKNOWN,
      reason: `${eccn} may fall within ${included.indeterminate.join(", ")}. Supply the full subparagraph to decide.`
    };
  }
  return { state: NOT_MET, reason: `${eccn} is not within this rule's item scope.` };
}

/**
 * Was the item produced using U.S.-origin technology/software of the right ECCN,
 * or by a qualifying plant?
 */
function evaluateInputScope(rule, input) {
  const declared = (input.producedUsingUsTechnologyEccns ?? []).map(normalizeEccn).filter(Boolean);
  const plantRoute = tri(input.producedByPlantThatIsDirectProductOfUsTechnology);
  const containsIc = tri(input.containsIcFromSuchPlant);

  // The AI model weights rule has no direct-product-of-technology route.
  if (rule.plantRouteOnly) {
    return {
      state: plantRoute,
      reason:
        plantRoute === MET
          ? "Produced by a plant or major component that is itself a direct product of U.S.-origin technology or software."
          : plantRoute === NOT_MET
            ? "Not produced by such a plant, and this rule has no direct-product-of-technology route."
            : "Whether the producing plant is itself a direct product of U.S.-origin technology or software was not established.",
      routesConsidered: ["plant"]
    };
  }

  // Direct-product route.
  let directState = UNKNOWN;
  let directReason;
  if (rule.inputAnyDorE) {
    directState = tri(input.producedUsingUsTechnologyInAnyDorE);
    directReason =
      directState === MET
        ? "Direct product of U.S.-origin technology or software in any product group D or E ECCN."
        : directState === NOT_MET
          ? "Not a direct product of U.S.-origin product-group D or E technology or software."
          : "Whether U.S.-origin product-group D or E technology or software was used in production was not established.";
  } else if (rule.inputEccns) {
    if (declared.length === 0) {
      directState = UNKNOWN;
      directReason =
        "No U.S.-origin technology or software ECCNs were supplied. This is the single most common gap: the production inputs, not the item's own content, decide the FDP product scope.";
    } else {
      const hits = declared.filter((d) => matchAnySpec(d, rule.inputEccns).isMatch);
      if (hits.length > 0) {
        directState = MET;
        directReason = `Produced using U.S.-origin technology or software specified in ${hits.join(", ")}, which is within this rule's input list.`;
      } else {
        directState = NOT_MET;
        directReason = `None of the supplied production inputs (${declared.join(", ")}) is within this rule's input list.`;
      }
    }
  } else {
    directState = UNKNOWN;
    directReason = `The input condition is defined by a condition rather than an ECCN list: ${rule.inputDescription}`;
  }

  // Plant route, and where the rule provides it, the "contains an IC from such a
  // plant" route.
  const routes = [{ route: "direct_product", state: directState, reason: directReason }];
  routes.push({
    route: "plant",
    state: plantRoute,
    reason:
      plantRoute === MET
        ? "Produced by a plant or major component of a plant that is itself a direct product of qualifying U.S.-origin technology or software."
        : plantRoute === NOT_MET
          ? "Not produced by such a plant."
          : "Whether the producing plant is itself a direct product of qualifying U.S.-origin technology or software was not established."
  });
  if (rule.containsIcRoute) {
    routes.push({
      route: "contains_ic_from_plant",
      state: containsIc,
      reason:
        containsIc === MET
          ? "The commodity contains an integrated circuit produced by such a plant, which independently satisfies the product scope."
          : containsIc === NOT_MET
            ? "The commodity does not contain an integrated circuit produced by such a plant."
            : "Whether the commodity contains an integrated circuit produced by such a plant was not established. Note that IC production here includes assembly, testing and packaging.",
      note: rule.containsIcRoute
    });
  }

  return {
    state: anyOf(...routes.map((r) => r.state)),
    reason: "Satisfied if ANY route below is met.",
    routes
  };
}

/** Where is it going, who is getting it, what will it be used for? */
function evaluateReachScope(rule, input, dest) {
  const r = rule.reach;

  if (r.type === "worldwide") {
    return {
      state: MET,
      reason:
        "This rule's destination scope is any location worldwide, so the reach prong is satisfied regardless of destination.",
      description: r.description
    };
  }

  if (r.type === "country") {
    if (!dest.resolved) {
      return { state: UNKNOWN, reason: "Destination could not be resolved to a Country Group.", description: r.description };
    }
    const hit = r.countryGroups.filter((g) => dest.groups.includes(g));
    return {
      state: hit.length ? MET : NOT_MET,
      reason: hit.length
        ? `${dest.canonical} is in Country Group ${hit.join("/")}, within this rule's country scope (${r.countryGroups.join(", ")}).`
        : `${dest.canonical} is in ${dest.groups.join(", ") || "no listed Country Group"}, outside this rule's country scope (${r.countryGroups.join(", ")}).`,
      description: r.description
    };
  }

  if (r.type === "destination") {
    if (r.macauOrD5) {
      if (!dest.resolved) {
        return { state: UNKNOWN, reason: "Destination could not be resolved.", description: r.description };
      }
      const inScope = isMacauOrD5(dest);
      return {
        state: inScope ? MET : NOT_MET,
        reason: inScope
          ? `${dest.canonical} is ${dest.isMacau ? "Macau" : "in Country Group D:5"}, within this rule's destination scope.`
          : `${dest.canonical} is neither Macau nor in Country Group D:5.`,
        description: r.description
      };
    }
    if (!dest.resolved) {
      return { state: UNKNOWN, reason: "Destination could not be resolved.", description: r.description };
    }
    const named = (r.countries ?? []).includes(dest.canonical);
    const crimea = r.alsoCrimea && input.destinedToCrimea === true;
    const govIran = r.countries?.includes("Iran") && input.governmentOfIranIsAParty === true;
    const state = named || crimea || govIran ? MET : UNKNOWN;
    return {
      state: state === MET ? MET : (r.countries ?? []).length && !named && !r.alsoCrimea ? NOT_MET : state,
      reason: named
        ? `${dest.canonical} is within this rule's destination scope.`
        : crimea
          ? "Destined to the temporarily occupied Crimea region of Ukraine."
          : govIran
            ? "The Government of Iran is a party to the transaction."
            : `${dest.canonical} is not a named destination for this rule, but the rule also reaches related end uses and parties; confirm those.`,
      description: r.description
    };
  }

  if (r.type === "end_user") {
    const fn = r.entityListFootnote;
    const flag = input.entityListFootnotes?.includes?.(fn);
    const facility = r.advancedNodeFacility && input.recipientAtAdvancedNodeFacilityInMacauOrD5 === true;
    if (flag === true || facility) {
      return {
        state: MET,
        reason: flag
          ? `A Footnote ${fn} designated entity was indicated as involved in the transaction.`
          : "The recipient was indicated as located at a facility in Macau or Country Group D:5 where logic or DRAM advanced-node integrated circuit production occurs.",
        description: r.description
      };
    }
    if (input.entityListFootnotesKnown === true && !flag && !r.advancedNodeFacility) {
      return {
        state: NOT_MET,
        reason: `No Footnote ${fn} entity is involved, on the facts supplied.`,
        description: r.description
      };
    }
    return {
      state: UNKNOWN,
      reason:
        `Whether a Footnote ${fn} designated entity is involved was not established.` +
        (r.advancedNodeFacility
          ? " Nor was whether the recipient sits at an advanced-node logic or DRAM production facility in Macau or Country Group D:5."
          : "") +
        " Footnote designations are recorded in the License Requirement column of the Entity List, and the reach extends to purchasers, intermediate consignees and ultimate consignees, not only the end user.",
      description: r.description
    };
  }

  if (r.type === "end_use") {
    const s = tri(input.forSupercomputerInPrcOrMacau);
    return {
      state: s,
      reason:
        s === MET
          ? "Indicated as destined for, or for use in, a supercomputer located in or destined to the PRC or Macau."
          : s === NOT_MET
            ? "Not indicated as supercomputer-related for the PRC or Macau."
            : "Supercomputer end use in the PRC or Macau was not established.",
      description: r.description
    };
  }

  return { state: UNKNOWN, reason: "Unrecognised reach type.", description: r.description };
}

/**
 * @param {object} input
 * @param {string} input.destinationCountry
 * @param {string} [input.foreignItemEccn]
 * @param {string[]} [input.producedUsingUsTechnologyEccns]
 * @param {boolean} [input.producedUsingUsTechnologyInAnyDorE]
 * @param {boolean} [input.producedByPlantThatIsDirectProductOfUsTechnology]
 * @param {boolean} [input.containsIcFromSuchPlant]
 * @param {number[]} [input.entityListFootnotes]
 * @param {boolean} [input.entityListFootnotesKnown]
 * @param {boolean} [input.recipientAtAdvancedNodeFacilityInMacauOrD5]
 * @param {boolean} [input.forSupercomputerInPrcOrMacau]
 * @param {boolean} [input.destinedToCrimea]
 * @param {boolean} [input.governmentOfIranIsAParty]
 * @param {boolean} [input.itemIsUsOrigin]
 */
export function assessFdp(input) {
  const { destinationCountry, foreignItemEccn = "", itemIsUsOrigin = false } = input;
  const dest = resolveCountry(destinationCountry);
  const eccn = normalizeEccn(foreignItemEccn);

  // FDP applies to FOREIGN-produced items. A U.S.-origin item is already subject
  // to the EAR and needs no FDP analysis at all.
  if (itemIsUsOrigin) {
    return {
      toolContract:
        "The Foreign Direct Product rules determine whether a FOREIGN-produced item is subject to the EAR.",
      provenance: { fdp: FDP_PROVENANCE, countryGroups: COUNTRY_GROUP_PROVENANCE },
      notApplicable: true,
      conclusion: {
        type: "us_origin_item",
        statement:
          "The item was stated to be U.S.-origin. It is already subject to the EAR under § 734.3 and no FDP analysis is needed. Proceed straight to classification and licence analysis."
      }
    };
  }

  const results = FDP_RULES.map((rule) => {
    const itemScope = evaluateItemScope(rule, eccn);
    const inputScope = evaluateInputScope(rule, input);
    const productScope = {
      state: itemScope.state === NOT_MET || inputScope.state === NOT_MET
        ? NOT_MET
        : itemScope.state === MET && inputScope.state === MET
          ? MET
          : UNKNOWN,
      itemScope,
      inputScope
    };
    const reachScope = evaluateReachScope(rule, input, dest);

    const state =
      productScope.state === NOT_MET || reachScope.state === NOT_MET
        ? NOT_MET
        : productScope.state === MET && reachScope.state === MET
          ? MET
          : UNKNOWN;

    return {
      id: rule.id,
      paragraph: rule.paragraph,
      citation: rule.citation,
      name: rule.name,
      status:
        state === MET ? "applies" : state === NOT_MET ? "does_not_apply" : "indeterminate",
      productScope,
      reachScope,
      licenceReference: rule.licenceReference,
      ...(rule.containsIcRoute ? { containsIcNote: rule.containsIcRoute } : {})
    };
  });

  const applies = results.filter((r) => r.status === "applies");
  const indeterminate = results.filter((r) => r.status === "indeterminate");
  const doesNotApply = results.filter((r) => r.status === "does_not_apply");

  let conclusionType;
  let statement;
  if (applies.length > 0) {
    conclusionType = "subject_to_ear_under_fdp";
    statement =
      `The foreign-produced item is subject to the EAR under ${applies.length} FDP rule(s): ` +
      `${applies.map((r) => `${r.citation} (${r.name})`).join("; ")}. ` +
      "This holds regardless of how little U.S. content the item contains. Once subject to the EAR, classify it and work the licence requirement at the cited provision.";
  } else if (indeterminate.length > 0) {
    conclusionType = "indeterminate";
    statement =
      `No FDP rule was established as applying, but ${indeterminate.length} rule(s) could not be resolved on the facts supplied. ` +
      "That is not a finding that the item is outside the EAR. Resolve the open prongs listed under each indeterminate rule.";
  } else {
    conclusionType = "no_fdp_rule_established";
    statement =
      "On the facts supplied, no FDP rule was established as applying. Every rule resolved to does_not_apply. " +
      "Confirm that the production inputs and the end-user facts were stated completely before relying on this, and note that de minimis under § 734.4 is a separate question.";
  }

  const openQuestions = [];
  for (const r of indeterminate) {
    const unresolved = [];
    if (r.productScope.itemScope.state === UNKNOWN) unresolved.push(`item scope: ${r.productScope.itemScope.reason}`);
    if (r.productScope.inputScope.state === UNKNOWN) {
      const routes = (r.productScope.inputScope.routes ?? [])
        .filter((x) => x.state === UNKNOWN)
        .map((x) => x.route);
      unresolved.push(`production input (unresolved routes: ${routes.join(", ") || "n/a"})`);
    }
    if (r.reachScope.state === UNKNOWN) unresolved.push(`reach: ${r.reachScope.reason}`);
    openQuestions.push({ citation: r.citation, name: r.name, unresolved });
  }

  return {
    toolContract:
      "The Foreign Direct Product rules ask whether a FOREIGN-produced item is subject to the EAR. There is no percentage test: an item with zero U.S. content can be caught. A rule reported as indeterminate has NOT been ruled out.",
    provenance: { fdp: FDP_PROVENANCE, countryGroups: COUNTRY_GROUP_PROVENANCE },
    input: {
      destinationCountry,
      foreignItemEccn: eccn || null,
      producedUsingUsTechnologyEccns: input.producedUsingUsTechnologyEccns ?? [],
      producedByPlantThatIsDirectProductOfUsTechnology:
        input.producedByPlantThatIsDirectProductOfUsTechnology ?? null,
      containsIcFromSuchPlant: input.containsIcFromSuchPlant ?? null,
      entityListFootnotes: input.entityListFootnotes ?? null,
      recipientAtAdvancedNodeFacilityInMacauOrD5:
        input.recipientAtAdvancedNodeFacilityInMacauOrD5 ?? null
    },
    destination: {
      resolved: dest.resolved,
      canonical: dest.canonical,
      countryGroups: dest.groups,
      isMacau: dest.isMacau
    },
    summary: {
      rulesEvaluated: results.length,
      applies: applies.length,
      indeterminate: indeterminate.length,
      doesNotApply: doesNotApply.length
    },
    rulesApplying: applies,
    rulesIndeterminate: indeterminate,
    rulesNotApplying: doesNotApply.map((r) => ({
      citation: r.citation,
      name: r.name,
      whyNot:
        r.productScope.state === NOT_MET
          ? r.productScope.itemScope.state === NOT_MET
            ? r.productScope.itemScope.reason
            : r.productScope.inputScope.routes?.find((x) => x.state === NOT_MET)?.reason ??
              "Production input condition not met."
          : r.reachScope.reason
    })),
    openQuestions,
    conclusion: { type: conclusionType, statement },
    alwaysAlso: [
      {
        citation: "15 C.F.R. § 734.4",
        requirement:
          "De minimis is a separate route to EAR jurisdiction for foreign-made items containing controlled U.S. content. Passing FDP does not answer it, and vice versa."
      },
      {
        citation: "15 C.F.R. § 734.9(a)(2)",
        requirement:
          "A supplier can provide a model certification stating that an item would be subject to the EAR if a future transaction meets a rule's destination or end-user scope. Consider requesting one from upstream suppliers."
      },
      {
        citation: "15 C.F.R. § 734.9(a)(3)",
        requirement:
          "BIS may inform a person, individually or by rule, that foreign-produced items are subject to the EAR. Check for any is-informed notice."
      },
      {
        citation: "Supplement No. 3 to Part 732, Red Flag 26",
        requirement:
          "Additional guidance on the scope of the Footnote 5 and SME product scopes, particularly the route that captures a commodity merely CONTAINING a qualifying integrated circuit."
      }
    ],
    nextSteps: [
      "Establish which U.S.-origin technology or software ECCNs were used to produce the item, and whether the producing plant is itself a direct product of U.S.-origin technology. Without those two facts most rules cannot be resolved.",
      "Check the Entity List License Requirement column for footnote 1, 3, 4 and 5 designations on every party, not just the end user.",
      "For Category 3B commodities going to Macau or Country Group D:5, work § 734.9(k) and § 734.9(e)(3) first; they are the rules that reach Korean-manufactured equipment with no U.S. content.",
      "Request model certifications from suppliers under § 734.9(a)(2) so this analysis does not have to be reconstructed per shipment.",
      "Record the determination, the facts relied on, the reviewer and the date."
    ]
  };
}
