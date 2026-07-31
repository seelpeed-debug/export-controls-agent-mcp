#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkPart744 } from "./rules/part744.js";
import { analyzeLicenseExceptions } from "./rules/license-exceptions.js";
import { classifyEccnCandidates } from "./rules/ccl-search.js";
import { classifyTransactionRisk } from "./rules/transaction-risk.js";
import { draftExportControlClause, buildDueDiligenceChecklist } from "./rules/clauses.js";
import { getKoreanLawArticle } from "./lib/korean-law.js";
import { datasetProvenance, checkFreshness, ALL_DATASET_IDS } from "./lib/provenance.js";

const server = new McpServer({
  name: "export-controls-agent-mcp",
  version: "0.1.0"
});

const OFFICIAL_SOURCES = {
  bisEar: "https://www.bis.gov/regulations/ear",
  bisEarToc: "https://www.bis.gov/regulations/ear/table-of-contents",
  entityList: "https://www.bis.gov/entity-list",
  euDualUse: "https://eur-lex.europa.eu/eli/reg/2021/821/oj?locale=en",
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

server.registerTool(
  "regime_overview",
  {
    title: "Summarize export-control regimes",
    description: "Return a Korean legal research overview of EAR, BIS Entity List, EU Regulation 2021/821, and Korean Foreign Trade Act touchpoints.",
    inputSchema: {
      focus: z.string().optional().describe("Research focus, e.g. semiconductor equipment exports to China or battery technology licensing.")
    }
  },
  async ({ focus = "Korean semiconductor and battery companies" }) => asJson({
    focus,
    regimes: [
      {
        name: "U.S. Export Administration Regulations (EAR)",
        legalTouchpoints: [
          "15 C.F.R. Parts 730-774",
          "subject to the EAR analysis",
          "ECCN and Commerce Control List classification",
          "end-use and end-user controls under Part 744",
          "reexport and transfer(in-country) controls"
        ],
        transactionRelevance: "Determines whether U.S.-origin items, software, technology, or certain foreign-produced items trigger U.S. authorization requirements."
      },
      {
        name: "BIS Entity List",
        legalTouchpoints: [
          "Supplement No. 4 to Part 744 of the EAR",
          "license requirement and license review policy by listed entity",
          "restricted-party screening before contract, shipment, payment, and technical support"
        ],
        transactionRelevance: "Turns counterparty status into a contract-performance risk, including suspension, termination, and indemnity issues."
      },
      {
        name: "EU Regulation 2021/821",
        legalTouchpoints: [
          "dual-use items including software and technology",
          "export, brokering, technical assistance, transit, and transfer",
          "catch-all controls and recordkeeping"
        ],
        transactionRelevance: "Applies to EU touchpoints such as EU subsidiaries, EU-origin items, technical assistance, and brokering services."
      },
      {
        name: "Korean Foreign Trade Act",
        legalTouchpoints: [
          "Article 19 strategic items designation",
          "Article 20 expert classification ruling",
          "export, transit, transshipment, brokering, and catch-all authorization",
          "Article 53 criminal penalties"
        ],
        transactionRelevance: "Provides directly applicable Korean authorization, classification, and penalty structure."
      }
    ],
    officialSources: OFFICIAL_SOURCES,
    caution: "This tool produces research support, not a final legal opinion. Verify current law and lists before relying on outputs."
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
  async (input) => asJson(checkPart744(input), ["country-groups"])
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
