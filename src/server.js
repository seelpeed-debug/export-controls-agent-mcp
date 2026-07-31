#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { checkPart744 } from "./rules/part744.js";
import { analyzeLicenseExceptions } from "./rules/license-exceptions.js";
import { classifyEccnCandidates } from "./rules/ccl-search.js";
import { classifyTransactionRisk } from "./rules/transaction-risk.js";
import { draftExportControlClause, buildDueDiligenceChecklist } from "./rules/clauses.js";
import { getKoreanLawArticle } from "./lib/korean-law.js";
import { screenParty, screeningProvenance, SCREENING_LIMITS } from "./lib/screening.js";
import { assessEarJurisdiction } from "./rules/jurisdiction.js";
import { assessCountryChartRequirement } from "./rules/country-chart.js";
import { assessChinaExportControls } from "./rules/china.js";
import {
  CHINA_PROVENANCE,
  INSTRUMENTS,
  ANNOUNCEMENTS,
  SUSPENSION,
  EXTRATERRITORIAL_ROUTES,
  NO61_END_USER_RULE,
  CONTROLLED_RARE_EARTHS_IN_FORCE,
  ENTITY_MECHANISMS,
  KNOWN_DESIGNATIONS,
  NOT_MODELLED
} from "./data/china-export-control.js";
import { datasetProvenance, checkFreshness, ALL_DATASET_IDS } from "./lib/provenance.js";

// Read the version from package.json rather than repeating it. It was hardcoded
// as "0.1.0" and stayed there through the 0.2.0 release, so the server advertised
// a version it was not running.
const { version: SERVER_VERSION } = createRequire(import.meta.url)("../package.json");

const server = new McpServer({
  name: "export-controls-agent-mcp",
  version: SERVER_VERSION
});

const OFFICIAL_SOURCES = {
  bisEar: "https://www.bis.gov/regulations/ear",
  bisEarToc: "https://www.bis.gov/regulations/ear/table-of-contents",
  entityList: "https://www.bis.gov/entity-list",
  euDualUse: "https://eur-lex.europa.eu/eli/reg/2021/821/oj?locale=en",
  chinaMofcom: "https://www.mofcom.gov.cn/",
  chinaMofcomAnnouncements:
    "https://www.mofcom.gov.cn/ — numbered announcements (公告) are the operative instruments for PRC export controls",
  koreaStrategicTrade: "https://www.motie.go.kr/",
  koreanLaw: "https://www.law.go.kr/DRF/ (Open API; requires a LAW_OC account id)"
};

/**
 * Wrap a payload as MCP text content, stamping it with the vintage of the
 * regulation snapshots it was derived from. Every answer this server gives is
 * only as current as its data, so the stamp travels with the answer.
 *
 * @param {object} data
 * @param {string[]|null} datasetIds Datasets the payload actually relied on.
 *   Pass an empty array for payloads that use no snapshot data.
 */
function asJson(data, datasetIds = ALL_DATASET_IDS) {
  const payload =
    datasetIds && datasetIds.length > 0
      ? { ...data, dataProvenance: datasetProvenance(datasetIds) }
      : data;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

server.registerResource(
  "official-sources",
  "export-controls://official-sources",
  {
    title: "Official export-control source links",
    description: "Canonical official sources used by this MCP server.",
    mimeType: "application/json"
  },
  async () => ({
    contents: [
      {
        uri: "export-controls://official-sources",
        mimeType: "application/json",
        text: JSON.stringify(OFFICIAL_SOURCES, null, 2)
      }
    ]
  })
);

server.registerResource(
  "data-provenance",
  "export-controls://data-provenance",
  {
    title: "Bundled regulation snapshot vintage",
    description:
      "Which EAR datasets this server bundles, the eCFR issue date each was built from, and the command to rebuild it.",
    mimeType: "application/json"
  },
  async () => ({
    contents: [
      {
        uri: "export-controls://data-provenance",
        mimeType: "application/json",
        text: JSON.stringify(datasetProvenance(), null, 2)
      }
    ]
  })
);

server.registerResource(
  "china-framework",
  "export-controls://china-framework",
  {
    title: "PRC export-control framework reference",
    description:
      "The instrument register, the numbered MOFCOM announcement register with the November 2025 suspension, the Announcement No. 61 extraterritorial tests, the entity mechanisms and what this server does not hold for this regime. Held as a resource because it is constant, so assess_china_export_controls does not repeat it on every call.",
    mimeType: "application/json"
  },
  async () => ({
    contents: [
      {
        uri: "export-controls://china-framework",
        mimeType: "application/json",
        text: JSON.stringify(
          {
            provenance: CHINA_PROVENANCE,
            instruments: INSTRUMENTS,
            announcements: ANNOUNCEMENTS,
            suspension: SUSPENSION,
            extraterritorialRoutes: EXTRATERRITORIAL_ROUTES,
            no61EndUserRule: NO61_END_USER_RULE,
            controlledRareEarthsInForce: CONTROLLED_RARE_EARTHS_IN_FORCE,
            entityMechanisms: ENTITY_MECHANISMS,
            knownDesignations: KNOWN_DESIGNATIONS,
            notModelled: NOT_MODELLED
          },
          null,
          2
        )
      }
    ]
  })
);

server.registerTool(
  "regime_overview",
  {
    title: "Summarize export-control regimes",
    description:
      "Orientation map of the export-control regimes that bear on a Korean semiconductor or battery transaction, and — importantly — which of them this server actually models against the regulation text versus merely flags for manual review. Read the coverageInThisServer field of each regime before relying on any other tool.",
    inputSchema: {
      focus: z.string().optional().describe("Research focus, e.g. semiconductor equipment exports to China or battery technology licensing.")
    }
  },
  async ({ focus = "Korean semiconductor and battery companies" }) => asJson({
    focus,
    coverageLegend: {
      modelled:
        "Evaluated against bundled snapshots of the regulation text, with citations and a data vintage.",
      partial: "Some provisions modelled, others only pointed at. See the notes.",
      pointer_only:
        "This server holds NO data for this regime and performs NO analysis of it. It only reminds you that the regime may apply. Do not read any output as covering it."
    },
    regimes: [
      {
        name: "U.S. Export Administration Regulations (EAR)",
        coverageInThisServer: "partial",
        modelledParts: [
          "Part 734 — § 734.4 de minimis and all thirteen § 734.9 Foreign Direct Product rules (assess_ear_jurisdiction)",
          "Part 738 — the Commerce Country Chart and the § 738.4(a)(2) determination procedure, including the § 738.3(b) territory inheritance rule and the § 738.3(a)(1) entries that bypass the chart (determine_license_requirement)",
          "Part 740 — License Exceptions and the § 740.2 mandatory restrictions (analyze_license_exceptions)",
          "Part 740 Supplement No. 1 — Country Groups",
          "Part 744 — end-use and end-user controls, including the 50 percent affiliates rule (check_part744_enduse)",
          "Part 774 Supplement No. 1 — Commerce Control List text search (classify_eccn)"
        ],
        notModelledParts: [
          "Part 736 general prohibitions. § 738.4(a)(2)(ii)(B) makes the absence of a Country Chart requirement conditional on General Prohibitions Four through Ten not applying, so a 'no_chart_requirement' result is never clearance",
          "Part 742 licence review policy, and the § 742 provisions that some ECCN entries cite instead of a chart column",
          "Part 746 embargoes and other special controls. The four embargoed destinations are identified but their requirements are not modelled",
          "Parts 748, 758, 762, 764 — applications, clearance, recordkeeping, enforcement"
        ],
        transactionRelevance:
          "Determines whether U.S.-origin items, software, technology, or certain foreign-produced items trigger U.S. authorization requirements."
      },
      {
        name: "U.S. restricted-party lists",
        coverageInThisServer: "modelled",
        modelledParts: [
          "Consolidated Screening List: BIS Entity List, Denied Persons, Unverified and MEU; OFAC SDN, SSI, CMIC, NS-MBS, PLC, Capta; State ITAR Debarred and Nonproliferation Sanctions (screen_restricted_party)"
        ],
        notModelledParts: [
          "Ownership. The Consolidated Screening List contains no ownership data, so the 50 percent affiliates rule cannot be discharged by name screening",
          "Address-based Entity List entries",
          "Non-U.S. designations (EU, UK, Japan, Korea)"
        ],
        transactionRelevance:
          "Turns counterparty status into a contract-performance risk, including suspension, termination, and indemnity issues."
      },
      {
        name: "People's Republic of China export controls (MOFCOM)",
        coverageInThisServer: "partial",
        modelledParts: [
          "The instrument register: Export Control Law (2020-12-01), Regulations on Export Control of Dual-Use Items (2024-12-01), Unreliable Entity List Provisions, Blocking Rules, Anti-Foreign Sanctions Law, State Council Decree No. 835 (2026)",
          "The numbered announcement register with live in-force or suspended status computed against a date, including the Announcement No. 70 of 2025 suspension of Nos. 55, 56, 57, 58, 61 and 62 until 2026-11-10",
          "Announcement No. 18 of 2025, which is NOT suspended: seven medium and heavy rare earths in the listed forms",
          "Announcement No. 61 of 2025 extraterritorial reach: the 0.1 percent Chinese-origin content floor, the Chinese-technology production route, Chinese origin, the military end-user prohibition and the 50 percent affiliates rule (assess_china_export_controls)"
        ],
        notModelledParts: [
          "两用物项出口管制清单, the Export Control List for Dual-Use Items — not bundled, so this server cannot classify an item under Chinese export control. That is the Chinese equivalent of the ECCN question and is usually the first thing an exporter needs",
          "管控名单, Unreliable Entity List and Malicious Entity List designations — no complete machine-readable list exists to bundle, so entity screening is not offered rather than offered badly",
          "Catch-all controls on unlisted items, which turn on the exporter's knowledge",
          "Licence procedure, general licences, documentation and review timelines",
          "The separate military and nuclear item regimes",
          "Article-level citations of the Export Control Law and the 2024 Regulations, which were not verified to the standard used elsewhere in this server and are therefore not asserted"
        ],
        whatThisServerActuallyDoes:
          "Tells you which numbered announcements bear on a fact pattern, whether each is in force on a given date, and which of the Announcement No. 61 extraterritorial routes the stated facts meet. It classifies nothing and screens nobody.",
        transactionRelevance:
          "Binds non-Chinese parties directly. Announcement No. 61 requires a MOFCOM permit for a shipment between two points both outside China, and a 管控名单 designation prohibits suppliers in any country from providing the listed entity with Chinese-origin dual-use items. A Korean exporter with no Chinese entity and no U.S. nexus can be squarely inside this regime.",
        dataVintageCaution:
          "Hand-transcribed, not generated: MOFCOM publishes no versioned machine-readable text. The framework moved six times in the twelve months to July 2026 and the current suspension expires 2026-11-10, so this is the fastest-decaying dataset in this server and carries a 14-day staleness threshold.",
        source: OFFICIAL_SOURCES.chinaMofcom
      },
      {
        name: "EU Regulation 2021/821 (dual-use)",
        coverageInThisServer: "pointer_only",
        modelledParts: [],
        notModelledParts: [
          "Annex I control list — not bundled, so this server cannot classify an item under EU law",
          "EU authorisation types, catch-all controls, brokering and technical assistance provisions",
          "Member State implementing measures"
        ],
        whatThisServerActuallyDoes:
          "Flags that an EU touchpoint exists (EU subsidiary, EU-origin item, EU technical assistance, brokering or transit) and reminds you to review the Regulation. Nothing more.",
        transactionRelevance:
          "Applies to EU touchpoints such as EU subsidiaries, EU-origin items, technical assistance, and brokering services.",
        source: OFFICIAL_SOURCES.euDualUse
      },
      {
        name: "Korean Foreign Trade Act (대외무역법)",
        coverageInThisServer: "partial",
        modelledParts: [
          "Full current article text of 대외무역법 and 국제사법, with promulgation and per-article effective dates (get_korean_law_article)"
        ],
        notModelledParts: [
          "전략물자수출입고시 — the Korean control list itself is NOT bundled. This server cannot determine whether an item is a 전략물자, which is usually a Korean exporter's first question. Use the KOSTI (무역안보관리원) 전략물자관리시스템 or apply for a 전문판정 under Article 20"
        ],
        legalTouchpoints: [
          "제19조 — designation and publication of 전략물자 by the Minister of Trade and Industry",
          "제19조의2 — 수출허가 (export authorisation), including intangible technology transfer. Added by the 2024-02-20 전문개정, which split the former 제19조",
          "제19조의3 — 상황허가 (situational authorisation / catch-all), with its enumerated red-flag list",
          "제20조 — 전문판정 (expert classification ruling), which may be delegated to 무역안보관리원",
          "제53조 — criminal penalties, which now cross-reference 제19조의2 and 제19조의3"
        ],
        transactionRelevance:
          "Provides directly applicable Korean authorization, classification, and penalty structure. Note that Korean designations do not track the U.S. CCL, so a U.S. ECCN answer does not settle Korean status."
      }
    ],
    officialSources: OFFICIAL_SOURCES,
    caution:
      "Research support, not a legal opinion. Where coverageInThisServer is 'pointer_only' or a provision appears under notModelledParts, this server has performed no analysis at all and its silence carries no meaning."
  })
);

server.registerTool(
  "classify_transaction_risk",
  {
    title: "Triage transaction export-control risk",
    description:
      "Produce a triage score and review plan for a semiconductor or battery transaction. Terms are matched on word boundaries and negated statements are excluded from the score; the destination is assessed from the Country Group tables rather than from keywords. A 'low' tier is not a clearance -- no screening, classification or Part 744 analysis is performed here.",
    inputSchema: {
      description: z.string().describe("Plain-language transaction description."),
      destinationCountry: z
        .string()
        .optional()
        .describe("Destination country. Matched against 15 C.F.R. Part 740, Supplement No. 1."),
      counterparty: z.string().optional(),
      endUse: z.string().optional(),
      hasUsOriginTechnology: z.boolean().optional(),
      hasEuTouchpoint: z.boolean().optional(),
      involvesTechnologyTransfer: z.boolean().optional()
    }
  },
  async (input) => asJson(classifyTransactionRisk(input), ["country-groups"])
);

server.registerTool(
  "draft_export_control_clause",
  {
    title: "Draft export-control contract clause",
    description:
      "Draft Korean or English export-control and sanctions risk-allocation clauses. riskLevel selects cumulative clause tiers and materially changes the output: 'low' gives baseline compliance and termination provisions, 'medium' adds end-user certification, restricted-party notification and the 50 percent affiliates-rule representation, and 'high' adds conditions precedent tied to pre-shipment re-screening, Foreign Direct Product and de minimis acknowledgement, U.S.-person activity control, technology-access control, and a mandatory-rules provision.",
    inputSchema: {
      language: z.enum(["ko", "en"]).default("ko"),
      transactionType: z
        .string()
        .describe("e.g. equipment supply, technology license, joint development, battery material long-term supply"),
      riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
      includeIndemnity: z.boolean().default(true),
      includeAuditRight: z.boolean().default(true)
    }
  },
  async (input) => asJson(draftExportControlClause(input), [])
);

server.registerTool(
  "build_due_diligence_checklist",
  {
    title: "Build export-control due diligence checklist",
    description:
      "Generate a due-diligence checklist for a transaction stage. The industry parameter materially changes the output: the semiconductor set covers 3B001 subparagraph scoping and the 744.23 advanced-node, SME and ECAD controls, while the battery set covers the absence of CCL entries for battery chemistry and the superficially matching entries to avoid.",
    inputSchema: {
      transactionStage: z
        .enum(["pre_contract", "contracting", "pre_shipment", "technical_support", "post_shipment"])
        .default("pre_contract"),
      industry: z.enum(["semiconductor", "battery", "both"]).default("both")
    }
  },
  async (input) => asJson(buildDueDiligenceChecklist(input), [])
);

server.registerTool(
  "get_korean_law_article",
  {
    title: "Get a Korean statute article",
    description:
      "Retrieve the current text of an article of the Korean Foreign Trade Act (대외무역법) or the Act on Private International Law (국제사법) from the law.go.kr Open API, falling back to a dated snapshot bundled with this server. Sub-articles are supported (제19조의2). Set the LAW_OC environment variable to a law.go.kr Open API account id to enable live retrieval.",
    inputSchema: {
      law: z.enum(["대외무역법", "국제사법"]).describe("Supported statute short name."),
      article: z
        .string()
        .describe(
          "Article label. Accepts 제19조, 제19조의2, 제20조, 제53조, 19조, 19-2. Note that the 2024-02-20 전문개정 split the old 제19조 into 제19조 (전략물자 지정·고시), 제19조의2 (수출허가) and 제19조의3 (상황허가)."
        ),
      source: z
        .enum(["live_then_snapshot", "snapshot_only"])
        .default("live_then_snapshot")
        .describe("Use snapshot_only to avoid any outbound network request."),
      timeoutMs: z.number().int().min(1000).max(60000).default(10000)
    }
  },
  async ({ law, article, source, timeoutMs }) =>
    asJson(await getKoreanLawArticle({ law, article, source, timeoutMs }), [])
);

server.registerTool(
  "classify_eccn",
  {
    title: "Search the Commerce Control List",
    description:
      "Search the text of the Commerce Control List (15 C.F.R. Part 774, Supplement No. 1) for entries and paragraphs that mention the technical terms in an item description, and quote the controlling language verbatim together with the entry's Reason for Control and List Based License Exception flags. This tool does NOT classify the item: a text match means the paragraph is worth reading, and the absence of a match does not establish EAR99 status.",
    inputSchema: {
      itemDescription: z
        .string()
        .describe("Technical description of the item, software or technology. Technical nouns produce better matches than commercial names."),
      itemType: z.enum(["equipment", "material", "software", "technology", "service"]).default("equipment"),
      industry: z
        .enum(["semiconductor", "battery", "both", "other"])
        .default("semiconductor")
        .describe("Narrows which CCL categories are searched. Use 'other' to search all categories."),
      keySpecs: z
        .string()
        .optional()
        .describe("Key technical parameters, e.g. exposure wavelength, etch selectivity, node size, cathode chemistry.")
    }
  },
  async ({ itemDescription, itemType, industry, keySpecs }) =>
    asJson(classifyEccnCandidates({ itemDescription, itemType, industry, keySpecs }), ["ccl"])
);

server.registerTool(
  "check_part744_enduse",
  {
    title: "Review EAR Part 744 end-use and end-user issues",
    description:
      "List the EAR Part 744 end-use and end-user issues that must be reviewed for a transaction: military end use (744.21) including the 50 percent affiliates rule, military-intelligence (744.22), nuclear (744.2), missile (744.3), chemical/biological (744.4), U.S.-person activities (744.6), and the supercomputer / advanced-node IC / semiconductor-manufacturing-equipment controls (744.23). This tool performs NO restricted-party screening and cannot clear a transaction; an empty issue list means the heuristic found nothing, not that the transaction is permissible.",
    inputSchema: {
      destinationCountry: z
        .string()
        .describe("Destination country. Matched against 15 C.F.R. Part 740, Supplement No. 1."),
      endUser: z.string().optional().describe("End-user name or description."),
      endUse: z.string().optional().describe("Stated end-use."),
      additionalParties: z
        .array(z.string())
        .optional()
        .describe(
          "Other named parties to screen: ultimate consignee, intermediate consignees, purchaser, freight forwarders, banks."
        ),
      eccn: z
        .string()
        .optional()
        .describe("ECCN with subparagraph if known, e.g. 3B001.f.1, 3A090.c, or EAR99."),
      flags: z
        .object({
          militaryEndUse: z.boolean().optional().describe("Known or suspected military end use."),
          militaryEndUser: z.boolean().optional().describe("Counterparty is a military end user."),
          militaryIntelligenceEndUse: z.boolean().optional(),
          nuclearActivity: z.boolean().optional(),
          missileActivity: z.boolean().optional().describe("Rocket system or UAV end use."),
          wmdDeliverySystem: z
            .boolean()
            .optional()
            .describe(
              "Set when the rocket/UAV is for delivery of chemical, biological or nuclear weapons. This is what makes 744.3(a)(2) apply worldwide rather than only to Country Group D:4."
            ),
          cbwActivity: z.boolean().optional(),
          maritimeNuclearPropulsion: z.boolean().optional(),
          supercomputerEndUse: z.boolean().optional(),
          semiconductorFabEndUse: z
            .boolean()
            .optional()
            .describe("Item will be used in development or production of ICs at a fabrication facility."),
          advancedNodeProduction: z
            .enum(["yes", "no", "unknown"])
            .optional()
            .describe(
              "Whether the facility produces advanced-node ICs. 'unknown' triggers 744.23(a)(2)(ii) for Category 3 items."
            ),
          smeDevelopmentOrProduction: z
            .boolean()
            .optional()
            .describe("Item is for development or production of semiconductor manufacturing equipment."),
          ecadTcadForAdvancedNodeDesign: z.boolean().optional(),
          usPersonSupport: z
            .boolean()
            .optional()
            .describe("A U.S. person will provide support activities (744.6).")
        })
        .optional(),
      endUserScreening: z
        .object({
          screeningPerformed: z
            .boolean()
            .optional()
            .describe("Set true only after screening every party and address against the relevant lists."),
          listedOnEntityList: z.boolean().optional(),
          listedOnMeuList: z.boolean().optional(),
          listedOnUvl: z.boolean().optional(),
          sdnListed: z.boolean().optional(),
          ownedFiftyPercentOrMoreByListedEntity: z.boolean().optional(),
          ownershipPercentByListedEntity: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe("Aggregate direct or indirect ownership percentage held by listed entities."),
          headquarteredInMacauOrD5: z
            .boolean()
            .optional()
            .describe(
              "Entity is headquartered in, or has an ultimate parent headquartered in, Macau or Country Group D:5. Triggers 744.23(a)(3) wherever the entity is located."
            )
        })
        .optional()
    }
  },
  async (input) => asJson(checkPart744(input), ["country-groups", "screening-list"])
);

server.registerTool(
  "screen_restricted_party",
  {
    title: "Screen a party against the Consolidated Screening List",
    description:
      "Screen one or more party names against the U.S. Consolidated Screening List bundled with this server: BIS Entity List, Denied Persons List, Unverified List and MEU List; OFAC SDN, SSI, CMIC, NS-MBS, PLC and Capta; State ITAR Debarred and Nonproliferation Sanctions. Returns ranked candidate matches with the operative licence requirement and the authority for each list. A no-match result is NOT clearance: ownership is not screened, so the 50 percent affiliates rule under 744.21(a)(3) can catch an unlisted entity that produces no hit here.",
    inputSchema: {
      names: z.array(z.string()).min(1).describe("Party names to screen."),
      country: z
        .string()
        .optional()
        .describe("Destination or party country. Used only to annotate matches, never to exclude them."),
      minScore: z
        .number()
        .int()
        .min(30)
        .max(100)
        .default(60)
        .describe("Confidence floor, 0-100. Lower it for transliterated or non-Latin-script names."),
      maxResults: z.number().int().min(1).max(200).default(25),
      listCodes: z
        .array(z.enum(["EL", "DPL", "UVL", "MEU", "SDN", "CMIC", "SSI", "NS-MBS", "PLC", "CAP", "DTC", "ISN"]))
        .optional()
        .describe("Restrict to specific lists. Omit to screen against all of them.")
    }
  },
  async ({ names, country, minScore, maxResults, listCodes }) => {
    const results = names.map((n) => screenParty(n, { country, minScore, maxResults, listCodes }));
    const strong = results.flatMap((r) => r.matches.filter((m) => m.score >= 85));
    return asJson(
      {
        toolContract:
          "Ranked candidate matches, not identifications. Confirm any hit against the official list entry, and do not read a zero-match result as clearance.",
        screened: names.length,
        results,
        summary: {
          partiesWithStrongMatch: results.filter((r) => r.matches.some((m) => m.score >= 85)).length,
          partiesWithPossibleMatch: results.filter((r) =>
            r.matches.some((m) => m.score >= 60 && m.score < 85)
          ).length,
          partiesWithNoMatch: results.filter((r) => r.matchCount === 0).length,
          strongMatchLists: [...new Set(strong.map((m) => m.listCode))]
        },
        provenance: screeningProvenance(),
        limits: SCREENING_LIMITS,
        nextSteps: [
          "For every hit, open the sourceListUrl and confirm identity against the official entry. Names repeat across unrelated companies.",
          "Trace the ownership chain of each party. A party owned 50 percent or more by a listed entity inherits its restrictions under § 744.21(a)(3) and will not appear here.",
          "Screen the addresses as well; Entity List entries can attach to an address.",
          "Screen non-U.S. designations separately: this dataset covers U.S. lists only.",
          "Record the screening date, the snapshot vintage, who reviewed it and the disposition of each hit."
        ]
      },
      ["screening-list"]
    );
  }
);

server.registerTool(
  "assess_china_export_controls",
  {
    title: "Assess PRC export controls (MOFCOM)",
    description:
      "Identify Chinese export-control exposure under the Export Control Law, the 2024 Regulations on Export Control of Dual-Use Items, and the numbered MOFCOM announcements. Answers the question that decides most cases in this regime first: is the measure currently in force? Announcements Nos. 55, 56, 57, 58, 61 and 62 of 2025 are suspended by Announcement No. 70 of 2025 until 10 November 2026, while Announcement No. 18 of 2025 on seven medium and heavy rare earths is NOT suspended and still requires a licence. A fact pattern that meets a suspended test is reported as license_required_if_reactivated with the expiry date, because the instruments are not repealed. This regime binds non-Chinese parties directly: Announcement No. 61 requires a MOFCOM permit for a shipment between two points both outside China, on a 0.1 percent content floor, and a 管控名单 designation prohibits parties in ANY country from supplying the listed entity with Chinese-origin dual-use items. Do not carry a U.S. de minimis conclusion across; § 734.4 is a 25 or 10 percent ceiling you fall below to escape, while No. 61 is a 0.1 percent floor you rise above to be caught. This tool does NOT classify items and does NOT screen entities, because neither the Export Control List for Dual-Use Items nor any designation list is bundled.",
    inputSchema: {
      asOfDate: z
        .string()
        .optional()
        .describe("ISO date to assess against, e.g. 2026-12-01. Defaults to today. Decides whether a suspended measure is operative."),
      itemDescription: z
        .string()
        .optional()
        .describe("Free-text item description. Scanned for the controlled rare-earth elements, in English or Chinese."),
      itemCategory: z
        .enum(["rare_earth", "rare_earth_technology", "lithium_battery", "graphite_anode", "other", "unknown"])
        .default("unknown"),
      rareEarthElements: z
        .array(z.string())
        .optional()
        .describe("Rare-earth elements present, e.g. ['dysprosium','terbium']."),

      itemOriginChina: z.boolean().optional().describe("Whether the item was originally produced in China. No. 61 § 1(c)."),
      containsChineseOriginRareEarths: z.boolean().optional(),
      chineseOriginRareEarthValuePercent: z
        .number()
        .optional()
        .describe(
          "Value of Chinese-origin rare earths as a percentage of item value. The No. 61 § 1(a) threshold is a 0.1 percent FLOOR, not a ceiling: 0.1 or more is caught."
        ),
      producedOutsideChinaUsingChineseRareEarthTechnology: z
        .boolean()
        .optional()
        .describe("No. 61 § 1(b). The Chinese analogue of the Foreign Direct Product rules, with no percentage test."),
      chineseRareEarthTechnologyTypes: z
        .array(
          z.enum([
            "extraction",
            "smelting_separation",
            "metal_smelting",
            "magnetic_material_manufacturing",
            "secondary_resource_recycling"
          ])
        )
        .optional(),

      exportFromCountry: z.string().optional(),
      exportToCountry: z.string().optional(),
      endUserMilitary: z.boolean().optional().describe("No. 61 § 2: applications for foreign military users are in principle not permitted."),
      counterpartyNames: z.array(z.string()).optional(),
      counterpartyIsSubsidiaryOfListedEntity: z
        .boolean()
        .optional()
        .describe("Whether a parent controlling 50 percent or more of shares is a listed user. No. 61 § 2 reaches such subsidiaries.")
    }
  },
  async (input) => asJson(assessChinaExportControls(input), ["china-export-control"])
);

server.registerTool(
  "determine_license_requirement",
  {
    title: "Determine whether the CCL requires a licence",
    description:
      "Work the Commerce Country Chart (15 C.F.R. Part 738, Supplement No. 1) for an ECCN and a destination, following the 738.4(a)(2) procedure. Reads every Reason for Control in the entry, resolves each to a chart column or to the prose destination scope the entry states instead, and reports each requirement separately because 738.4(a)(2)(ii)(A) requires each one to be overcome on its own. Handles the cases a table lookup misses: the four embargoed destinations whose rows carry no marks at all, the footnotes that require a licence where the grid is empty, destinations that have no row and inherit another country's, and the 738.3(a)(1) entries that bypass the chart entirely. An absent mark is reported as 'no_chart_requirement', never as clearance.",
    inputSchema: {
      eccn: z
        .string()
        .describe(
          "ECCN, ideally with subparagraph, e.g. 3B001.c, 3A090.a, 0A501.y. Rows in one entry are scoped to different subparagraphs and resolve differently, so a bare 3B001 will return a conditional answer."
        ),
      destination: z
        .string()
        .describe(
          "Destination country. Matched against the rows of Supplement No. 1 to Part 738, whose spellings differ from the Part 740 Country Group tables. Hong Kong resolves to the China row."
        )
    }
  },
  async ({ eccn, destination }) =>
    asJson(assessCountryChartRequirement({ eccn, destination }), ["country-chart", "ccl", "country-groups"])
);

server.registerTool(
  "analyze_license_exceptions",
  {
    title: "Review EAR License Exception issues",
    description:
      "Identify which 15 C.F.R. Part 740 License Exceptions are foreclosed, out of scope, or worth reviewing for a transaction, and list the conditions each one requires. Applies the mandatory restrictions in 740.2, including 740.2(a)(9)(i) for semiconductor manufacturing equipment to Macau/Country Group D:5 and 740.2(a)(9)(ii) for advanced computing items. This tool does NOT determine that any exception is available; 'requires_verification' must not be read as 'yes'.",
    inputSchema: {
      eccn: z.string().describe("ECCN with subparagraph, e.g. 3B001.f.1, 3A090.c, or EAR99."),
      destinationCountry: z
        .string()
        .describe("Destination country. Matched against 15 C.F.R. Part 740, Supplement No. 1."),
      transactionType: z.enum(["export", "reexport", "transfer_in_country"]).default("export"),
      itemType: z.enum(["hardware", "software", "technology", "service"]).default("hardware"),
      endUserType: z.enum(["commercial", "government", "military", "unknown"]).default("commercial"),
      valueUsd: z.number().optional().describe("Per-shipment value in USD, used only for the LVS limit check."),
      entityHeadquarteredInMacauOrD5: z
        .boolean()
        .optional()
        .describe(
          "Set when the end user is headquartered in, or has an ultimate parent headquartered in, Macau or Country Group D:5. This triggers 740.2(a)(9)(ii) regardless of the shipping destination."
        ),
      flags: z
        .object({
          temporaryExport: z.boolean().optional(),
          servicingOrReplacementParts: z.boolean().optional(),
          governmentEndUser: z.boolean().optional(),
          highBandwidthMemory: z.boolean().optional(),
          encryption: z.boolean().optional()
        })
        .optional()
    }
  },
  async (input) => asJson(analyzeLicenseExceptions(input), ["country-groups", "license-exception-catalog"])
);

server.registerTool(
  "assess_ear_jurisdiction",
  {
    title: "Assess whether an item is subject to the EAR",
    description:
      "Determine whether an item is subject to the EAR before doing any classification or licence analysis. Applies the de minimis U.S.-content rule (15 C.F.R. 734.4) and all thirteen Foreign Direct Product rules (734.9) as independent routes. The FDP rules have NO percentage test: a foreign-produced item with zero U.S. content is subject to the EAR if a rule's product scope and destination or end-user scope are both met. The SME rule at 734.9(k) and the Footnote 5 rule at 734.9(e)(3) are the ones that reach Korean-manufactured semiconductor equipment.",
    inputSchema: {
      itemOrigin: z
        .enum(["us", "foreign"])
        .default("foreign")
        .describe("U.S.-origin items are subject to the EAR under 734.3 and need no further jurisdiction analysis."),
      destinationCountry: z.string().describe("Destination country, matched against Part 740 Supplement No. 1."),
      foreignItemEccn: z
        .string()
        .optional()
        .describe("The foreign-produced item's own ECCN with subparagraph, e.g. 3B001.c, 3A090.a, or EAR99."),
      foreignItemType: z.enum(["commodity", "software", "technology"]).default("commodity"),

      producedUsingUsTechnologyEccns: z
        .array(z.string())
        .optional()
        .describe(
          "ECCNs of the U.S.-origin technology or software used to PRODUCE the item, e.g. ['3E992']. This is the single most decisive input for FDP and is about production inputs, not the item's own content."
        ),
      producedUsingUsTechnologyInAnyDorE: z
        .boolean()
        .optional()
        .describe("Set when production used U.S.-origin technology or software in any product group D or E ECCN."),
      producedByPlantThatIsDirectProductOfUsTechnology: z
        .boolean()
        .optional()
        .describe(
          "Whether the producing plant, or a major component of it, is itself a direct product of U.S.-origin technology or software."
        ),
      containsIcFromSuchPlant: z
        .boolean()
        .optional()
        .describe(
          "Whether the commodity contains an integrated circuit produced by such a plant. IC production here includes assembly, testing and packaging. Relevant to 734.9(e)(3) and (k)."
        ),

      entityListFootnotes: z
        .array(z.number().int())
        .optional()
        .describe("Entity List footnote designations of any party, e.g. [1], [4], [5]. Footnote 3 is Russia/Belarus MEU."),
      entityListFootnotesKnown: z
        .boolean()
        .optional()
        .describe("Set true once every party's footnote status has actually been checked on the Entity List."),
      recipientAtAdvancedNodeFacilityInMacauOrD5: z
        .boolean()
        .optional()
        .describe("Recipient is at a facility in Macau or Country Group D:5 producing logic or DRAM advanced-node ICs."),
      forSupercomputerInPrcOrMacau: z.boolean().optional(),
      destinedToCrimea: z.boolean().optional(),
      governmentOfIranIsAParty: z.boolean().optional(),

      usControlledContentPercent: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Controlled U.S.-origin content as a percentage, calculated under Supplement No. 2 to Part 734."),
      usSoftwareBundled: z
        .boolean()
        .optional()
        .describe("For software: whether it ships bundled with the item. Separately exported U.S. software is never de minimis eligible."),
      category5Part2UsContent: z.boolean().optional(),
      commingledTechnologyReportFiled: z
        .boolean()
        .optional()
        .describe("Whether the one-time BIS report for commingled technology has been filed. Required before relying on de minimis for technology."),
      noDeMinimisFacts: z
        .object({
          highApppComputerWithUsSemiconductors: z.boolean().optional(),
          incorporates5E002EncryptionTechnology: z.boolean().optional(),
          is3B993f1ForAdvancedNodeProduction: z.boolean().optional(),
          commingles9E003Technology: z.boolean().optional(),
          isMilitaryCommodityWith0A919: z.boolean().optional(),
          incorporates9x515Or600Series: z.enum(["enumerated", "y_items"]).optional(),
          containsUsOriginIntegratedCircuit: z.boolean().optional()
        })
        .optional()
        .describe("Facts bearing on the 734.4(a) categories that have no de minimis level at all."),

      skipDeMinimis: z.boolean().default(false),
      skipFdp: z.boolean().default(false)
    }
  },
  async (input) => asJson(assessEarJurisdiction(input), ["country-groups", "ccl"])
);

server.registerTool(
  "check_data_freshness",
  {
    title: "Check regulation snapshot freshness",
    description:
      "Compare this server's bundled EAR snapshots (Country Groups, the Part 740 License Exception catalog, and the Commerce Control List) against the latest eCFR issue date, and report which datasets need rebuilding. Requires network access to eCFR.",
    inputSchema: {
      timeoutMs: z.number().int().min(1000).max(60000).default(15000)
    }
  },
  async ({ timeoutMs }) => asJson(await checkFreshness({ timeoutMs }), [])
);

const transport = new StdioServerTransport();
await server.connect(transport);
