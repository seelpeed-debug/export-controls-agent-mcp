// The Foreign Direct Product rules of 15 C.F.R. § 734.9, transcribed from the
// eCFR text of title 15 part 734 as issued 2026-07-23.
//
// HAND-CURATED, DELIBERATELY. The product scopes mix ECCN lists with prose
// conditions ("except 3B001.a.4, c, d, f.1 ...", "for 3B commodities"), so a
// generic parser would be less trustworthy than a transcription that is checked
// against the live text. scripts/validate-fdp-rules.mjs asserts every ECCN token
// recorded here still appears in the corresponding paragraph of § 734.9, which
// catches drift without pretending the structure can be parsed automatically.
//
// STRUCTURE OF EVERY RULE
// A foreign-produced item is subject to the EAR only if it meets BOTH:
//   productScope     what the item is, and what U.S. technology/software or
//                    plant produced it
//   reachScope       where it is going, who is receiving it, or what it will be
//                    used for
// Failing either prong means the rule does not apply. That is why each rule is
// evaluated as two independent prongs rather than as one score.

/** Product-group D and E ECCNs used as the "input technology/software" list by several rules. */
const CAT3_45_D_E = [
  "3D001", "3D901", "3D991", "3D992", "3D993", "3D994",
  "3E001", "3E002", "3E003", "3E901", "3E991", "3E992", "3E993", "3E994",
  "4D001", "4D993", "4D994", "4E001", "4E992", "4E993",
  "5D001", "5D991", "5E001", "5E991"
];

/** The § 734.9(k) / § 734.4(a)(8) semiconductor-manufacturing-equipment set. */
export const SME_ITEM_SCOPE = [
  "3B001.a.4", "3B001.c", "3B001.d", "3B001.f.1", "3B001.f.5", "3B001.f.6",
  "3B001.k", "3B001.l", "3B001.m", "3B001.n", "3B001.p.2", "3B001.p.4", "3B001.r",
  "3B002.c"
];

/** Input list shared by the Footnote 5 and SME plant-route product scopes. */
const CAT3B_PLANT_INPUTS = [
  "3D001", "3D901", "3D991", "3D992", "3D993", "3D994",
  "3E001", "3E901", "3E991", "3E992", "3E993", "3E994"
];

export const FDP_RULES = [
  {
    id: "national_security",
    paragraph: "(b)",
    citation: "15 C.F.R. § 734.9(b)",
    name: "National Security FDP rule",
    itemScopeDescription:
      "The foreign-produced item is subject to national security controls as designated in its ECCN on the CCL.",
    // Decidable from the ECCN's Reason for Control in the bundled CCL snapshot.
    itemScopeTest: "ns_controlled",
    inputDescription:
      "Direct product of U.S.-origin technology or software that requires a written assurance as a supporting document for a licence (see paragraph (o)(3)(i) of Supplement No. 2 to Part 748), or product of a plant or major component that is itself such a direct product.",
    inputEccns: null,
    reach: { type: "country", countryGroups: ["D:1", "E:1", "E:2"] },
    licenceReference: "See the applicable ECCN and the Commerce Country Chart."
  },
  {
    id: "9x515",
    paragraph: "(c)",
    citation: "15 C.F.R. § 734.9(c)",
    name: "9x515 FDP rule",
    itemScopeDescription: "The foreign-produced item is specified in a 9x515 ECCN.",
    itemScopeTest: "is_9x515",
    inputDescription: "Direct product of U.S.-origin technology or software specified in ECCN 9D515 or 9E515.",
    inputEccns: ["9D515", "9E515"],
    reach: { type: "country", countryGroups: ["D:5", "E:1", "E:2"] },
    licenceReference: "See Part 742 and the applicable 9x515 ECCN."
  },
  {
    id: "600_series",
    paragraph: "(d)",
    citation: "15 C.F.R. § 734.9(d)",
    name: '"600 series" FDP rule',
    itemScopeDescription:
      'The foreign-produced item is specified in a "600 series" ECCN, or in ECCN 0A919 for the direct-product route.',
    itemScopeTest: "is_600_series",
    inputDescription: 'Direct product of U.S.-origin technology or software specified in a "600 series" ECCN.',
    inputEccns: null,
    reach: { type: "country", countryGroups: ["D:1", "D:3", "D:4", "D:5", "E:1", "E:2"] },
    licenceReference: "See Part 742 and the applicable 600-series ECCN."
  },
  {
    id: "entity_list_fn1",
    paragraph: "(e)(1)",
    citation: "15 C.F.R. § 734.9(e)(1)",
    name: "Entity List FDP rule: Footnote 1",
    // No item-scope restriction at all: this rule reaches any foreign-produced
    // item that satisfies the input condition, so the item prong is always met.
    itemScopeUnrestricted: true,
    itemScopeDescription: "Any foreign-produced item meeting the input condition; the item's own ECCN is not limited.",
    inputDescription:
      "Direct product of technology or software subject to the EAR and specified in the listed Category 3, 4 or 5 product-group D or E ECCNs, or product of a plant or major component that is itself such a direct product.",
    inputEccns: CAT3_45_D_E,
    reach: {
      type: "end_user",
      entityListFootnote: 1,
      description:
        "There is knowledge that the item will be incorporated into, or used in the production or development of, any part, component or equipment produced, purchased or ordered by a Footnote 1 designated entity; OR a Footnote 1 entity is a party to the transaction as purchaser, intermediate consignee, ultimate consignee or end user."
    },
    licenceReference: "15 C.F.R. § 744.11(a)(2)(i)"
  },
  {
    id: "entity_list_fn4",
    paragraph: "(e)(2)",
    citation: "15 C.F.R. § 734.9(e)(2)",
    name: "Entity List FDP rule: Footnote 4",
    itemScopeUnrestricted: true,
    itemScopeDescription: "Any foreign-produced item meeting the input condition; the item's own ECCN is not limited.",
    inputDescription:
      "Direct product of technology or software subject to the EAR and specified in the listed Category 3, 4 or 5 product-group D or E ECCNs, including 5D002 and 5E002, or product of a qualifying plant.",
    inputEccns: [...CAT3_45_D_E, "5D002", "5E002"],
    reach: {
      type: "end_user",
      entityListFootnote: 4,
      description:
        "Knowledge that a Footnote 4 designated entity is a party to the transaction, or that the item will be incorporated into or used in the production or development of parts, components or equipment produced, purchased or ordered by such an entity."
    },
    licenceReference: "15 C.F.R. § 744.11(a)(2)(ii)"
  },
  {
    id: "entity_list_fn5_advanced_node",
    paragraph: "(e)(3)",
    citation: "15 C.F.R. § 734.9(e)(3)",
    name: 'Entity List FDP rule: Footnote 5 and "advanced-node integrated circuit" production',
    itemScopeDescription:
      "The foreign-produced commodity is specified in ECCN 3B001 (except 3B001.a.4, c, d, f.1, f.5, f.6, g, h, k to n, p.2, p.4, r), 3B002 (except 3B002.c), 3B903, 3B991 (except 3B991.b.2.a through b.2.b), 3B992, 3B993 or 3B994.",
    itemScopeEccns: ["3B001", "3B002", "3B903", "3B991", "3B992", "3B993", "3B994"],
    itemScopeExclusions: [...SME_ITEM_SCOPE, "3B001.g", "3B001.h", "3B991.b.2.a", "3B991.b.2.b"],
    inputDescription:
      "Direct product of technology or software subject to the EAR specified in ECCN 3D001 (for 3B commodities), 3D901 (for 3B903), 3D991 (for 3B991 and 3B992), 3D993, 3D994, 3E001 (for 3B commodities), 3E901 (for 3B903), 3E991 (for 3B991 and 3B992), 3E993 or 3E994; or produced by, or containing a commodity produced by, a qualifying plant.",
    inputEccns: CAT3B_PLANT_INPUTS,
    containsIcRoute:
      "The product scope is also met where the foreign-produced commodity CONTAINS an integrated circuit produced by a plant or major component that is itself a direct product of the listed U.S.-origin technology or software. Production of an integrated circuit includes wafer fabrication as well as assembly, testing and packaging. See Red Flag 26 in Supplement No. 3 to Part 732.",
    reach: {
      type: "end_user",
      entityListFootnote: 5,
      advancedNodeFacility: true,
      description:
        "Knowledge that the commodity will be incorporated into any part, component or equipment produced, purchased or ordered by a Footnote 5 designated entity OR by an entity located at a facility in Macau or Country Group D:5 where production of logic or DRAM advanced-node integrated circuits occurs; or that such an entity or facility is a party to the transaction."
    },
    licenceReference: "15 C.F.R. § 744.11(a)(2)(v)"
  },
  {
    id: "russia_belarus_crimea",
    paragraph: "(f)",
    citation: "15 C.F.R. § 734.9(f)",
    name: "Russia/Belarus/temporarily occupied Crimea region of Ukraine FDP rule",
    itemScopeDescription:
      "The foreign-produced item is specified in any ECCN on the CCL, or in Supplement No. 6 or 7 to Part 746.",
    itemScopeTest: "any_ccl_eccn",
    inputDescription:
      "Direct product of U.S.-origin technology or software subject to the EAR specified in any ECCN in product group D or E of the CCL, or product of a qualifying plant.",
    inputEccns: null,
    inputAnyDorE: true,
    reach: {
      type: "destination",
      countries: ["Russia", "Belarus"],
      alsoCrimea: true,
      description:
        "Knowledge that the item is destined to Russia, Belarus or the temporarily occupied Crimea region of Ukraine."
    },
    licenceReference: "15 C.F.R. § 746.8"
  },
  {
    id: "russia_belarus_meu",
    paragraph: "(g)",
    citation: "15 C.F.R. § 734.9(g)",
    name: "Russia/Belarus-Military End User and Procurement FDP rule",
    itemScopeUnrestricted: true,
    itemScopeDescription: "Any foreign-produced item meeting the input condition.",
    inputDescription:
      "Direct product of technology or software subject to the EAR specified in any ECCN in product group D or E, or product of a qualifying plant.",
    inputEccns: null,
    inputAnyDorE: true,
    reach: {
      type: "end_user",
      entityListFootnote: 3,
      description:
        "Knowledge that a footnote 3 designated entity is a party to the transaction, or that the item will be incorporated into or used in the production or development of parts, components or equipment produced, purchased or ordered by such an entity."
    },
    licenceReference: "15 C.F.R. § 746.8"
  },
  {
    id: "advanced_computing",
    paragraph: "(h)",
    citation: "15 C.F.R. § 734.9(h)",
    name: "Advanced computing FDP rule",
    itemScopeDescription:
      "The foreign-produced item is specified in ECCN 3A090, 3E001 (for 3A090), 4A090 or 4E001 (for 4A090); or is an integrated circuit, computer, electronic assembly or component specified in ECCN 3A001.z, 4A003.z, 4A004.z, 4A005.z, 5A002.z, 5A004.z or 5A992.z.",
    itemScopeEccns: [
      "3A090", "4A090", "3E001", "4E001",
      "3A001.z", "4A003.z", "4A004.z", "4A005.z", "5A002.z", "5A004.z", "5A992.z"
    ],
    inputDescription:
      "Direct product of technology or software subject to the EAR specified in the listed Category 3, 4 or 5 product-group D or E ECCNs, or product of a qualifying plant.",
    inputEccns: [...CAT3_45_D_E, "4D090", "5D002", "5E002"],
    reach: {
      type: "worldwide",
      description:
        "Knowledge that the item is destined to ANY location worldwide, or will be incorporated into any part, component, computer or equipment not designated EAR99 destined to any location worldwide; or is technology developed by an entity headquartered in, or with an ultimate parent headquartered in, Macau or Country Group D:5 for the production of a mask or an integrated circuit wafer or die."
    },
    licenceReference: "15 C.F.R. § 742.6(a)(6); review policy § 742.6(b)(10)"
  },
  {
    id: "supercomputer",
    paragraph: "(i)",
    citation: "15 C.F.R. § 734.9(i)",
    name: '"Supercomputer" FDP rule',
    itemScopeUnrestricted: true,
    itemScopeDescription: "Any foreign-produced item meeting the input condition.",
    inputDescription:
      "Direct product of technology or software subject to the EAR specified in the listed Category 3, 4 or 5 product-group D or E ECCNs, or product of a qualifying plant.",
    inputEccns: CAT3_45_D_E,
    reach: {
      type: "end_use",
      supercomputerInPrcOrMacau: true,
      description:
        "Knowledge that the item will be used in the design, development, production, operation, installation, maintenance, repair, overhaul or refurbishing of a supercomputer located in or destined to the PRC or Macau; or incorporated into or used in the development or production of any part, component or equipment that will be used in such a supercomputer."
    },
    licenceReference: "15 C.F.R. § 744.23"
  },
  {
    id: "iran",
    paragraph: "(j)",
    citation: "15 C.F.R. § 734.9(j)",
    name: "Iran FDP rule",
    itemScopeDescription:
      "The foreign-produced item is identified in Supplement No. 7 to Part 746, or specified in any ECCN in Categories 3 through 9 of the CCL.",
    itemScopeTest: "category_3_to_9",
    inputDescription:
      "Direct product of U.S.-origin technology or software subject to the EAR specified in any ECCN in product group D or E in Categories 3 through 9, or product of a qualifying plant.",
    inputEccns: null,
    inputAnyDorE: true,
    reach: {
      type: "destination",
      countries: ["Iran"],
      description:
        "Knowledge that the item is destined to Iran, or will be incorporated into or used in the production or development of items identified in Supplement No. 7 to Part 746; or the Government of Iran is a party to the transaction."
    },
    licenceReference: "15 C.F.R. Part 746 (Iran)"
  },
  {
    id: "sme",
    paragraph: "(k)",
    citation: "15 C.F.R. § 734.9(k)",
    name: "Semiconductor Manufacturing Equipment (SME) FDP rule",
    itemScopeDescription:
      "The foreign-produced commodity is specified in ECCN 3B001.a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4, r, or 3B002.c.",
    itemScopeEccns: SME_ITEM_SCOPE,
    inputDescription:
      "Direct product of technology or software subject to the EAR specified in ECCN 3D992 or 3E992; OR produced by, or containing a commodity produced by, a plant or major component that is itself a direct product of the listed Category 3B input ECCNs.",
    inputEccns: ["3D992", "3E992"],
    plantInputEccns: CAT3B_PLANT_INPUTS,
    containsIcRoute:
      "The product scope is met where the commodity CONTAINS an integrated circuit produced by a plant or major component that is itself a direct product of the listed U.S.-origin technology or software. Production includes wafer fabrication, assembly, testing and packaging. See Red Flag 26 in Supplement No. 3 to Part 732.",
    reach: {
      type: "destination",
      macauOrD5: true,
      description: "Knowledge that the item is destined to Macau or a destination in Country Group D:5."
    },
    licenceReference:
      "15 C.F.R. §§ 742.4(a)(4) and 742.6(a)(6)(i)(A); review policy §§ 742.4(b)(2) and 742.6(b)(10)"
  },
  {
    id: "ai_model_weights",
    paragraph: "(l)",
    citation: "15 C.F.R. § 734.9(l)",
    name: "AI model weights FDP rule",
    itemScopeDescription: "The foreign-produced item is specified in ECCN 4E091.",
    itemScopeEccns: ["4E091"],
    inputDescription:
      "Produced by a complete plant or major component of a plant located outside the United States that is itself a direct product of U.S.-origin technology or software. This rule has no direct-product-of-technology route; only the plant route.",
    inputEccns: null,
    plantRouteOnly: true,
    reach: {
      type: "worldwide",
      description: "The foreign-produced 4E091 item is destined to any location worldwide."
    },
    licenceReference: "15 C.F.R. § 742.6(a)(13)"
  }
];

export const FDP_PROVENANCE = Object.freeze({
  citation: "15 C.F.R. § 734.9 (Foreign-Direct Product (FDP) Rules)",
  verifiedAgainst: "eCFR title 15, part 734",
  ecfrIssueDate: "2026-07-23",
  ruleCount: FDP_RULES.length,
  transcribedNotParsed:
    "Rule scopes are transcribed from the regulation text and checked against it by scripts/validate-fdp-rules.mjs. They are not machine-parsed."
});
