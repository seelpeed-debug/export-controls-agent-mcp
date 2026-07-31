// Transaction triage for export-control review.
//
// WHAT CHANGED AND WHY
// The previous implementation scored transactions with substring matching over a
// flat keyword list. Two consequences, both observed in testing:
//
//   "Sale of office stationery to a Japanese trading house"
//        -> scored as a semiconductor transaction, because "ic" is inside
//           "off(ic)e"
//   "Strictly NO military end use, NO nuclear application, no missile programs.
//    Purely commercial consumer display panel."
//        -> scored HIGH (8), because the negations were invisible to it
//
// It also keyed country risk off keywords like "russia" and "iran", which both
// misses every other controlled destination and fires on any counterparty whose
// name happens to contain a country. Country signals here come from the Country
// Group tables instead.
//
// The score is a triage aid for ordering review work. It is not a legal
// conclusion, and a low tier is explicitly not a clearance.

import { matchTerms } from "../lib/text-match.js";
import { resolveCountry, COUNTRY_GROUP_PROVENANCE } from "../lib/countries.js";

// Signal vocabularies. Short, ambiguous tokens are written as the forms that
// actually appear on their own ("IC", "ICs" via plural tolerance) rather than as
// substrings that collide with ordinary English.
const SIGNALS = {
  semiconductor: [
    "semiconductor", "wafer", "IC", "integrated circuit", "chip", "die", "foundry",
    "fab", "lithography", "etch", "etching", "deposition", "photoresist", "mask",
    "reticle", "pellicle", "EDA", "ECAD", "DRAM", "NAND", "HBM", "logic", "node",
    "packaging", "advanced computing", "supercomputer", "GPU", "accelerator"
  ],
  battery: [
    "battery", "cathode", "anode", "electrolyte", "separator", "lithium", "nickel",
    "cobalt", "manganese", "graphite", "precursor", "BMS", "cell", "module", "pack",
    "solid state", "recycling", "NMC", "NCA", "LFP"
  ],
  technologyTransfer: [
    "technology", "source code", "software", "technical data", "know-how", "knowhow",
    "recipe", "process parameter", "remote support", "remote access", "training",
    "maintenance", "calibration", "design file", "cloud access", "secondment",
    "deemed export", "technical assistance", "commissioning"
  ],
  endUseConcern: [
    "military", "defence", "defense", "armed forces", "missile", "rocket", "UAV",
    "nuclear", "enrichment", "reactor", "chemical weapon", "biological weapon",
    "supercomputer", "AI training", "advanced node", "surveillance", "intelligence"
  ],
  counterpartyConcern: [
    "entity list", "denied person", "unverified list", "SDN", "restricted party",
    "sanctioned", "sanction", "state-owned", "military end user", "MEU"
  ]
};

// Bounded contributions. Capping each component stops one verbose paragraph from
// dominating the total, which is what let the old scorer reach 45.
const WEIGHTS = {
  semiconductor: { per: 1, cap: 2 },
  battery: { per: 1, cap: 2 },
  technologyTransfer: { per: 1, cap: 4 },
  endUseConcern: { per: 3, cap: 12 },
  counterpartyConcern: { per: 4, cap: 12 },
  usOrigin: 4,
  euTouchpoint: 2,
  technologyTransferFlag: 4,
  destination: { macauOrD5: 10, d1d4: 6, e1e2: 12, allied: 0, unlisted: 1 }
};

const MAX_SCORE =
  WEIGHTS.semiconductor.cap +
  WEIGHTS.battery.cap +
  WEIGHTS.technologyTransfer.cap +
  WEIGHTS.endUseConcern.cap +
  WEIGHTS.counterpartyConcern.cap +
  WEIGHTS.usOrigin +
  WEIGHTS.euTouchpoint +
  WEIGHTS.technologyTransferFlag +
  WEIGHTS.destination.e1e2;

function tierFor(normalized) {
  if (normalized >= 55) return "high";
  if (normalized >= 25) return "medium";
  return "low";
}

export function classifyTransactionRisk(input) {
  const {
    description,
    destinationCountry,
    counterparty,
    endUse,
    hasUsOriginTechnology,
    hasEuTouchpoint,
    involvesTechnologyTransfer
  } = input;

  // The destination is resolved structurally, so it is deliberately NOT part of
  // the free-text corpus. Including it there is how a counterparty named
  // "Russia Trading Co" used to become a country signal.
  const corpus = [description, counterparty ?? "", endUse ?? ""].filter(Boolean).join(". ");

  const detected = {};
  const assertedAbsent = {};
  const components = [];
  let score = 0;

  for (const [name, terms] of Object.entries(SIGNALS)) {
    const { present, negated } = matchTerms(corpus, terms);
    detected[name] = present;
    assertedAbsent[name] = negated;
    const w = WEIGHTS[name];
    const raw = present.length * w.per;
    const capped = Math.min(raw, w.cap);
    if (capped > 0) {
      components.push({
        component: name,
        terms: present,
        points: capped,
        cappedAt: raw > w.cap ? w.cap : null
      });
      score += capped;
    }
  }

  // Destination, from the Country Group tables.
  const dest = destinationCountry ? resolveCountry(destinationCountry) : null;
  let destinationAssessment;
  if (!destinationCountry) {
    destinationAssessment = {
      resolved: false,
      reason: "No destination supplied. Country-scoped controls could not be considered at all.",
      points: 0
    };
    components.push({ component: "destination", terms: [], points: 0, note: "not supplied" });
  } else if (!dest.resolved) {
    destinationAssessment = {
      resolved: false,
      input: destinationCountry,
      matchType: dest.matchType,
      reason:
        "Destination could not be matched to 15 C.F.R. Part 740, Supplement No. 1. Treat the country dimension of this score as unassessed.",
      points: 0
    };
    components.push({ component: "destination", terms: [], points: 0, note: "unresolved" });
  } else {
    const g = dest.groups;
    let points = WEIGHTS.destination.unlisted;
    let basis = "Not in any listed Country Group.";
    if (g.includes("E:1") || g.includes("E:2")) {
      points = WEIGHTS.destination.e1e2;
      basis = `Country Group ${g.filter((x) => x.startsWith("E")).join("/")} -- embargo or comprehensive sanction.`;
    } else if (dest.isMacau || g.includes("D:5")) {
      points = WEIGHTS.destination.macauOrD5;
      basis = dest.isMacau
        ? "Macau, which the EAR treats alongside Country Group D:5 throughout."
        : "Country Group D:5 (arms-embargoed).";
    } else if (g.includes("D:1") || g.includes("D:4")) {
      points = WEIGHTS.destination.d1d4;
      basis = `Country Group ${g.filter((x) => x === "D:1" || x === "D:4").join("/")}.`;
    } else if (g.includes("A:5") || g.includes("A:6")) {
      points = WEIGHTS.destination.allied;
      basis = `Country Group ${g.filter((x) => x === "A:5" || x === "A:6").join("/")}. This affects License Exception scope but switches off no Part 744 end-use control.`;
    }
    score += points;
    destinationAssessment = { resolved: true, canonical: dest.canonical, countryGroups: g, basis, points };
    components.push({ component: "destination", terms: [dest.canonical], points, note: basis });
  }

  for (const [flag, key, label] of [
    [hasUsOriginTechnology, "usOrigin", "U.S.-origin technology, software or content present"],
    [hasEuTouchpoint, "euTouchpoint", "EU touchpoint present"],
    [involvesTechnologyTransfer, "technologyTransferFlag", "Technology transfer involved"]
  ]) {
    if (flag) {
      score += WEIGHTS[key];
      components.push({ component: key, terms: [], points: WEIGHTS[key], note: label });
    }
  }

  const normalized = Math.round((Math.min(score, MAX_SCORE) / MAX_SCORE) * 100);
  const tier = tierFor(normalized);

  const negatedAny = Object.values(assertedAbsent).some((a) => a.length > 0);

  return {
    toolContract:
      "This is a triage score for ordering review work, not a legal conclusion. A 'low' tier is NOT a clearance: no restricted-party screening, ECCN classification, Part 744 analysis or Foreign Direct Product assessment is performed here.",
    provenance: { countryGroups: COUNTRY_GROUP_PROVENANCE },
    riskTier: tier,
    score: { raw: score, normalized, scaleMax: 100, rawMax: MAX_SCORE },
    scoreComponents: components,
    detected,
    assertedAbsent,
    matchingNotes: [
      "Terms are matched on word boundaries, so \"IC\" no longer matches \"office\" or \"application\".",
      negatedAny
        ? "Terms listed under assertedAbsent appear in the text but are negated (for example \"no military end use\"). They did NOT contribute to the score. Negation in a description is an assertion by the counterparty, not verified fact -- confirm it with an end-use certificate."
        : "No negated terms were detected in the description.",
      "The destination was assessed from the Country Group tables rather than from keywords, so it is not affected by country names appearing in party names."
    ],
    destination: destinationAssessment,
    reviewSteps: [
      "Map all items, software, technical data, services, subsidiaries, freight routes and final users.",
      "Determine Korean strategic-item or catch-all status; consider a 전문판정 (expert classification) under Foreign Trade Act Article 20.",
      "Determine whether each item, technology or software is subject to the EAR, including under § 734.4 de minimis and § 734.9 Foreign Direct Product rules.",
      "Establish the ECCN. Run classify_eccn to locate candidate CCL paragraphs, then verify parameters against the entry.",
      "Screen every party and address against the Entity List, MEU List, Unverified List and OFAC SDN List, and trace ownership for the 50 percent affiliates rule.",
      "Run check_part744_enduse for end-use and end-user controls; they reach EAR99 items.",
      "Run analyze_license_exceptions only after the ECCN and Part 744 position are settled.",
      "Review EU Regulation 2021/821 if an EU entity, EU-origin item, technical assistance, brokering or transit touchpoint exists.",
      "Convert findings into contract conditions, representations, covenants, suspension and termination rights, indemnity and recordkeeping obligations."
    ],
    suggestedNextTools:
      tier === "low"
        ? ["classify_eccn", "check_part744_enduse"]
        : ["classify_eccn", "check_part744_enduse", "analyze_license_exceptions", "build_due_diligence_checklist"],
    caution:
      "Heuristic triage only. Part 744 turns on knowledge and red flags that a structured input cannot capture, so escalate anything unusual regardless of the tier."
  };
}
