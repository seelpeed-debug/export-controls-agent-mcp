// Commerce Control List text search.
//
// DESIGN NOTE
// The tool this replaces asserted a hand-written mapping from keywords to ECCN
// paragraphs. Every one of its 3B001 assignments except ".c" was wrong, and it
// pointed battery cathode material at 1C010, which controls fibrous and
// filamentary materials. The failure was structural: the mapping encoded a
// human guess about the regulation.
//
// Here the curated vocabulary decides only WHAT WORDS TO LOOK FOR. Which ECCN
// paragraph comes back is decided by the text of the Commerce Control List, and
// the controlling language is quoted verbatim so the reader checks parameters
// against the regulation rather than against a paraphrase.

import { createRequire } from "node:module";
import { containsTerm, matchTerms } from "../lib/text-match.js";

const require = createRequire(import.meta.url);
const CCL = require("../data/ccl.json");

export const CCL_PROVENANCE = Object.freeze({
  citation: CCL.citation,
  ecfrIssueDate: CCL.ecfrIssueDate,
  retrievedAt: CCL.retrievedAt,
  sourceUrl: CCL.source?.url ?? null,
  entryCount: CCL.entryCount,
  deepCategories: CCL.deepCategories,
  coverageNote: CCL.deepCategoryNote
});

// Search vocabulary.
//
// A concept has two sides, and conflating them is why a naive keyword list
// fails: a datasheet says "ion implanter", the regulation says "ion
// implantation". So each concept lists
//   match:  the spellings a user might write
//   search: the spellings the Commerce Control List actually uses
// `search` defaults to `match` when the two coincide. Every `search` term is
// asserted to occur somewhere in the bundled CCL by
// scripts/validate-vocabulary.mjs, so a dead search key fails the build instead
// of silently returning nothing.
//
// Groups exist only to narrow the search and carry no legal meaning.
const CONCEPTS = {
  semiconductor: [
    { match: ["lithography", "litho"], search: ["lithography"] },
    { match: ["EUV", "extreme ultraviolet"], search: ["EUV", "Extreme Ultraviolet"] },
    { match: ["DUV", "deep ultraviolet"], search: ["deep ultraviolet", "deep-ultraviolet"] },
    { match: ["immersion"] },
    {
      match: ["scanner", "stepper", "step and repeat", "step and scan", "exposure tool"],
      search: ["step and repeat", "step and scan", "align and expose"]
    },
    { match: ["imprint lithography", "nanoimprint", "nano-imprint"], search: ["imprint lithography"] },
    { match: ["mask", "photomask"], search: ["mask"] },
    { match: ["reticle"] },
    { match: ["pellicle"] },
    { match: ["photoresist", "resist"], search: ["photoresist", "resist"] },
    { match: ["etch", "etcher", "etching", "dry etch", "wet etch"], search: ["etching", "etch"] },
    { match: ["anisotropic"] },
    { match: ["isotropic"] },
    { match: ["plasma"] },
    { match: ["TSV", "through silicon via"], search: ["Through Silicon Via"] },
    { match: ["deposition"] },
    { match: ["CVD", "chemical vapor deposition", "chemical vapour deposition"], search: ["chemical vapor deposition"] },
    { match: ["ALD", "atomic layer deposition"], search: ["Atomic Layer Deposition", "atomic layer epitaxy"] },
    { match: ["PVD", "physical vapor deposition", "sputtering"], search: ["physical vapor deposition"] },
    { match: ["PECVD", "plasma enhanced chemical vapor deposition"], search: ["plasma enhanced"] },
    { match: ["epitaxy", "epitaxial", "epi"], search: ["epitaxial"] },
    { match: ["MOCVD", "metal organic chemical vapor deposition"], search: ["Metal Organic Chemical Vapor Deposition"] },
    { match: ["MBE", "molecular beam epitaxy", "molecular beam"], search: ["molecular beam"] },
    {
      match: ["ion implantation", "ion implant", "implanter", "implantation", "doping"],
      search: ["ion implantation", "implant"]
    },
    { match: ["annealing", "anneal", "rapid thermal"], search: ["annealing"] },
    { match: ["cleaning", "clean", "surface preparation"], search: ["cleaning", "preclean"] },
    { match: ["metrology"] },
    { match: ["inspection", "inspecting"], search: ["inspection", "inspecting"] },
    { match: ["overlay"] },
    { match: ["defect"] },
    { match: ["wafer handling", "wafer transfer", "robotic handler"], search: ["wafer handling"] },
    { match: ["wafer"] },
    { match: ["IC", "integrated circuit", "chip", "die"], search: ["integrated circuit"] },
    { match: ["microprocessor", "CPU"], search: ["microprocessor"] },
    { match: ["memory", "DRAM", "NAND", "SRAM"], search: ["memory"] },
    { match: ["HBM", "high bandwidth memory"], search: ["memory bandwidth"] },
    { match: ["GAAFET", "gate all around", "gate-all-around"], search: ["Gate-All-Around", "GAAFET"] },
    {
      match: ["EDA", "ECAD", "electronic design automation", "computer aided design", "design software"],
      search: ["Computer Aided Design", "ECAD"]
    },
    { match: ["multipatterning", "multi-patterning"], search: ["multipatterning"] },
    { match: ["computational lithography", "OPC"], search: ["computational lithography"] },
    { match: ["PDK", "process design kit"], search: ["Process Design Kit"] },
    { match: ["substrate"] },
    { match: ["silicon carbide", "SiC"], search: ["Silicon Carbide"] },
    { match: ["gallium nitride", "GaN", "gallium"], search: ["gallium"] },
    { match: ["indium"] },
    { match: ["diamond"] },
    { match: ["accelerator", "GPU", "AI chip", "advanced computing"], search: ["Total Processing Performance", "neural"] }
  ],
  // Battery vocabulary needs care. Most battery-sounding words either do not
  // appear in the CCL at all, or appear in an unrelated sense. Verified against
  // the bundled CCL:
  //   "manganese"   0 occurrences anywhere
  //   "cathode"     metal crude forms (ingots, cathodes) and cathodic arc
  //                 deposition -- not battery cathodes
  //   "lithium"     lithium-6 enrichment for tritium production -- nuclear
  //   "separator"   isotope separation equipment
  //   "electrolyte" only inside the 3A001.e.1 / 3A991.j definition of a 'cell'
  // Marking these keeps the tool from presenting a confident-looking but
  // irrelevant hit, which is the same failure as the old hardcoded 1C010 map.
  battery: [
    { match: ["battery", "batteries"], search: ["battery"] },
    { match: ["cell", "cells"], search: ["cell"] },
    { match: ["electrode"] },
    { match: ["fuel cell"] },
    { match: ["capacitor", "supercapacitor"], search: ["capacitor"] },
    { match: ["energy density"] },
    { match: ["precursor"] },
    { match: ["cobalt"] },
    { match: ["nickel"] },
    { match: ["graphite"] },
    {
      match: ["cathode", "cathode active material", "CAM", "NMC", "NCA", "LFP", "pCAM"],
      search: ["cathode"],
      falseFriend:
        "The CCL uses \"cathode\" for metal crude forms (ingots, cathodes) and for cathodic arc deposition equipment, not for battery cathode active material. Treat any hit as almost certainly irrelevant."
    },
    {
      match: ["anode", "anode active material"],
      search: ["anode"],
      falseFriend:
        "The CCL uses \"anode\" for metal crude forms and for vacuum/discharge devices, not for battery anode material."
    },
    {
      match: ["lithium"],
      search: ["lithium"],
      falseFriend:
        "In the CCL, \"lithium\" almost always refers to lithium-6 enrichment for tritium production (Category 1 nuclear entries), not to lithium-ion battery chemistry."
    },
    {
      match: ["separator"],
      search: ["separator"],
      falseFriend:
        "In the CCL, \"separator\" refers to isotope separation equipment, not to a battery separator film."
    },
    {
      match: ["electrolyte", "solid electrolyte", "solid state electrolyte", "sulfide electrolyte"],
      search: ["electrolyte"],
      falseFriend:
        "\"electrolyte\" appears in the CCL only inside the definition of a 'cell' for ECCN 3A001.e.1 and 3A991.j. There is no CCL entry for battery electrolyte chemistry."
    },
    {
      match: ["manganese"],
      search: [],
      noCclWording:
        "\"manganese\" does not appear anywhere in the Commerce Control List. No entry is keyed on this element, which is consistent with manganese-based cathode material being EAR99 -- but that still requires a documented Order of Review."
    }
  ],
  materials: [
    { match: ["carbon fiber", "carbon fibre", "aramid", "fibrous"], search: ["fibrous or filamentary"] },
    { match: ["prepreg"] },
    { match: ["composite"] },
    { match: ["powder"] },
    { match: ["alloy"] },
    { match: ["hydride"] },
    { match: ["gallium oxide"] }
  ],
  software: [
    { match: ["software", "firmware"], search: ["software"] },
    { match: ["source code"] },
    { match: ["simulation", "simulate"], search: ["simulation"] },
    { match: ["library", "libraries"], search: ["library"] }
  ],
  technology: [
    { match: ["technology", "know-how", "knowhow", "technical data"], search: ["technology"] },
    { match: ["development"] },
    { match: ["production"] }
  ]
};

/** Concepts as a flat list, with `search` defaulted from `match`. */
export const CONCEPT_LIST = Object.entries(CONCEPTS).flatMap(([group, concepts]) =>
  concepts.map((c) => ({
    group,
    match: c.match,
    search: c.search ?? c.match,
    falseFriend: c.falseFriend ?? null,
    noCclWording: c.noCclWording ?? null
  }))
);

/** Terms to look for in the user's text, per group. */
function matchVocabulary(groups) {
  return [...new Set(CONCEPT_LIST.filter((c) => groups.includes(c.group)).flatMap((c) => c.match))];
}

/** Map matched user-side terms to the regulation-side terms to search for. */
function searchTermsFor(matchedTerms) {
  const set = new Set();
  const mapping = [];
  const warnings = [];
  for (const c of CONCEPT_LIST) {
    const hit = c.match.filter((m) => matchedTerms.includes(m));
    if (hit.length === 0) continue;
    for (const s of c.search) set.add(s);
    mapping.push({
      matchedInDescription: hit,
      searchedInCcl: c.search,
      ...(c.falseFriend ? { falseFriendWarning: c.falseFriend } : {}),
      ...(c.noCclWording ? { noCclWording: c.noCclWording } : {})
    });
    if (c.falseFriend) warnings.push(`"${hit.join('", "')}": ${c.falseFriend}`);
    if (c.noCclWording) warnings.push(`"${hit.join('", "')}": ${c.noCclWording}`);
  }
  return { terms: [...set], mapping, warnings };
}

const ALL_GROUPS = Object.keys(CONCEPTS);

// Pre-lowercased searchable slices, built once.
const INDEX = CCL.entries.map((e) => ({
  entry: e,
  heading: e.heading,
  paragraphs: e.items ?? []
}));

function categoriesFor(industry) {
  // Category 3 is Electronics; 1 is Materials/Chemicals; 4 Computers; 5 Telecom
  // and Information Security. Anything outside deepCategories has heading-level
  // text only, so it is still searched but can only match on the heading.
  switch (industry) {
    case "semiconductor":
      return ["3", "4", "5", "1"];
    case "battery":
      return ["1", "3", "8", "9"];
    case "other":
      return null; // all
    default:
      return null;
  }
}

/**
 * Search the CCL for paragraphs that mention the given terms.
 * @returns {Array<{eccn, category, productGroup, heading, reasonForControl,
 *   licenceExceptionFlags, staSpecialConditions, matchedTerms, matches}>}
 */
export function searchCcl(terms, { categories = null, maxEntries = 12, maxMatchesPerEntry = 6 } = {}) {
  const results = [];

  for (const rec of INDEX) {
    if (categories && !categories.includes(rec.entry.category)) continue;

    const matches = [];
    const matchedTerms = new Set();

    // Heading match
    for (const term of terms) {
      if (containsTerm(rec.heading, term)) {
        matchedTerms.add(term);
        matches.push({ paragraph: null, scope: "heading", term, text: rec.heading });
      }
    }

    // Item paragraph and note matches. Numbered notes carry definitions that
    // are often the reason a term appears, but they are not ECCN paragraphs, so
    // they are never labelled as one.
    for (const item of rec.paragraphs) {
      const isItem = item.kind === "item";
      for (const term of terms) {
        if (containsTerm(item.text, term)) {
          matchedTerms.add(term);
          matches.push({
            paragraph: isItem ? `${rec.entry.eccn}.${item.paragraph}` : null,
            scope: isItem ? "item" : item.kind === "note" ? "note" : "scope_text",
            noteRef: item.kind === "note" ? `${rec.entry.eccn} note ${item.paragraph}` : undefined,
            depth: item.depth,
            term,
            text: item.text
          });
        }
      }
    }

    if (matchedTerms.size === 0) continue;

    // Rank matches: real item paragraphs first, shallowest first; then the
    // entry heading; then notes and unnumbered scope text.
    const rank = (m) => ({ item: 0, heading: 1, note: 2, scope_text: 3 })[m.scope] ?? 4;
    matches.sort((a, b) => rank(a) - rank(b) || (a.depth ?? 0) - (b.depth ?? 0));

    results.push({
      eccn: rec.entry.eccn,
      category: rec.entry.category,
      productGroup: rec.entry.productGroup,
      heading: rec.heading,
      reasonForControl: rec.entry.reasonForControl,
      licenceExceptionFlags: rec.entry.licenceExceptionFlags,
      staSpecialConditions: rec.entry.staSpecialConditions,
      relatedControls: rec.entry.relatedControls,
      matchedTerms: [...matchedTerms],
      matchScore: matchedTerms.size,
      matchCount: matches.length,
      matches: matches.slice(0, maxMatchesPerEntry)
    });
  }

  results.sort((a, b) => b.matchScore - a.matchScore || a.eccn.localeCompare(b.eccn));
  return { results: results.slice(0, maxEntries), totalEntriesMatched: results.length };
}

/**
 * Build the classify_eccn payload.
 */
export function classifyEccnCandidates({ itemDescription, itemType, industry, keySpecs }) {
  const text = [itemDescription, keySpecs].filter(Boolean).join(". ");
  const groups =
    industry === "semiconductor"
      ? ["semiconductor", "software", "technology", "materials"]
      : industry === "battery"
        ? ["battery", "materials", "software", "technology"]
        : ALL_GROUPS;

  const { present, negated } = matchTerms(text, matchVocabulary(groups));
  const { terms: searchTerms, mapping, warnings } = searchTermsFor(present);
  const categories = categoriesFor(industry);

  const search = searchTerms.length
    ? searchCcl(searchTerms, { categories })
    : { results: [], totalEntriesMatched: 0 };

  const notes = [...warnings];
  if (negated.length) {
    notes.push(
      `These terms appear in the description but are asserted ABSENT, so they were not used as search keys: ${negated.join(", ")}.`
    );
  }
  if (!present.length) {
    notes.push(
      "No vocabulary term was found in the description. That is not evidence of EAR99 status -- it means this text search had nothing to search on. Describe the item using technical terms, or work the CCL Order of Review manually."
    );
  } else if (!search.totalEntriesMatched) {
    notes.push(
      `Terms were recognised in the description (${present.join(", ")}) but the corresponding Commerce Control List wording (${searchTerms.join(", ")}) did not appear in the categories searched. Widen the search with industry "other", or work the Order of Review manually. This is not evidence of EAR99 status.`
    );
  }
  if (search.totalEntriesMatched > search.results.length) {
    notes.push(
      `${search.totalEntriesMatched} CCL entries matched; the ${search.results.length} highest-scoring are shown. Narrow the description to reduce the set.`
    );
  }
  if (industry === "battery") {
    notes.push(
      "Battery cathode and anode active materials, precursors and most electrolytes are commonly EAR99, but that conclusion still requires a documented CCL review. Note that 1C010 controls \"fibrous or filamentary materials\" and is not a battery-chemistry entry."
    );
  }

  return {
    toolContract:
      "This tool performs a TEXT SEARCH of the Commerce Control List and quotes the paragraphs that mention your terms. It does not classify the item. A match means the paragraph is worth reading, not that the item is controlled; a non-match does not establish EAR99.",
    provenance: { ccl: CCL_PROVENANCE },
    input: { itemDescription, itemType, industry, keySpecs: keySpecs || null },
    searchTerms: {
      matchedInDescription: present,
      assertedAbsent: negated,
      searchedInCcl: searchTerms,
      conceptMapping: mapping,
      categoriesSearched: categories ?? "all",
      note:
        "matchedInDescription are the words found in your text. searchedInCcl are the words actually looked up in the Commerce Control List, which uses different phrasing (a datasheet says 'ion implanter'; the regulation says 'ion implantation')."
    },
    cclTextMatches: search.results,
    notes,
    orderOfReview: [
      "Confirm the item is 'subject to the EAR' at all (15 C.F.R. § 734.3), and that it is not exclusively controlled by another agency such as the ITAR.",
      "Work the CCL Order of Review in Supplement No. 4 to Part 774 rather than starting from a keyword match.",
      "For each candidate paragraph, compare the item against every technical parameter in the entry. Entries use 'having all of the following' and 'having any of the following'; the distinction is decisive.",
      "Check the entry's Related Controls note, which routes many items to a different ECCN (for example 3B001 points to 3B903, 3B991, 3D001, 3D992, 3E001 and 3E992).",
      "Only after a documented review that no ECCN describes the item may it be designated EAR99.",
      "Determine licence requirements from the ECCN's Reason for Control and the Commerce Country Chart (Supplement No. 1 to Part 738).",
      "Check Part 744 end-use and end-user controls independently; they reach EAR99 items.",
      "Assess § 734.9 Foreign Direct Product rules and § 734.4 de minimis separately.",
      "For a binding answer, request a commodity classification (CCATS) from BIS under § 748.3."
    ],
    caution:
      "Text proximity is not classification. Binding classification requires parameter-by-parameter comparison against the ECCN, and BIS is the only authority that can issue a binding determination."
  };
}
