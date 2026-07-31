// Verification harness for export-controls-agent-mcp
// Exercises every registered tool + resource over real MCP stdio and writes a UTF-8 report.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// LAW_OC is passed through from the environment only. Never default it to a
// real account id here: this file is committed, and a credential in a test
// harness is still a credential in the repository.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "server.js")],
  env: { ...process.env },
  cwd: root
});

const client = new Client({ name: "verify-client", version: "1.0.0" });
await client.connect(transport);

const log = [];
function rec(entry) {
  log.push(entry);
}

// ---- capability discovery -------------------------------------------------
const serverVersion = client.getServerVersion();
const serverCaps = client.getServerCapabilities();
rec({ section: "handshake", serverVersion, serverCapabilities: serverCaps });

const toolList = await client.listTools();
rec({
  section: "tools/list",
  count: toolList.tools.length,
  tools: toolList.tools.map((t) => ({
    name: t.name,
    title: t.title ?? t.annotations?.title ?? null,
    required: t.inputSchema?.required ?? [],
    props: Object.keys(t.inputSchema?.properties ?? {}),
    hasOutputSchema: Boolean(t.outputSchema)
  }))
});

let resList = null;
try {
  resList = await client.listResources();
  rec({ section: "resources/list", resources: resList.resources.map((r) => r.uri) });
  const read = await client.readResource({ uri: "export-controls://official-sources" });
  rec({ section: "resources/read", uri: "export-controls://official-sources", ok: true, text: read.contents?.[0]?.text });
} catch (e) {
  rec({ section: "resources", error: String(e) });
}

for (const method of ["listPrompts"]) {
  try {
    const r = await client[method]();
    rec({ section: method, result: r });
  } catch (e) {
    rec({ section: method, error: String(e?.message ?? e) });
  }
}

// ---- helper --------------------------------------------------------------
async function call(id, name, args, expectError = false) {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args });
    let parsed = null;
    let parseError = null;
    const raw = r.content?.[0]?.text ?? null;
    try { parsed = JSON.parse(raw); } catch (e) { parseError = String(e.message); }
    rec({
      section: "tools/call",
      id,
      tool: name,
      args,
      ms: Date.now() - t0,
      isError: r.isError ?? false,
      contentTypes: (r.content ?? []).map((c) => c.type),
      jsonParsable: parsed !== null,
      parseError,
      result: parsed ?? raw,
      verdict: expectError
        ? (r.isError ? "PASS(expected error)" : "FAIL(expected error, got success)")
        : (r.isError ? "FAIL(unexpected isError)" : "OK")
    });
    return parsed ?? raw;
  } catch (e) {
    rec({
      section: "tools/call",
      id,
      tool: name,
      args,
      ms: Date.now() - t0,
      threw: true,
      error: String(e?.message ?? e),
      verdict: expectError ? "PASS(rejected)" : "FAIL(threw)"
    });
    return null;
  }
}

// ================= 1. regime_overview ====================================
await call("T1.1", "regime_overview", {});
await call("T1.2", "regime_overview", { focus: "SME exports to SK hynix Wuxi fab" });

// ================= 2. classify_transaction_risk ==========================
await call("T2.1", "classify_transaction_risk", {
  description: "Sale of office stationery to a Japanese trading house.",
  destinationCountry: "Japan"
});
await call("T2.2", "classify_transaction_risk", {
  description: "EUV lithography scanner spare parts with US-origin software, remote calibration for advanced node fab.",
  destinationCountry: "China",
  counterparty: "SMIC (Entity List)",
  endUse: "advanced node semiconductor fabrication for AI training supercomputer",
  hasUsOriginTechnology: true,
  hasEuTouchpoint: true,
  involvesTechnologyTransfer: true
});
// score-monotonicity / saturation probe
await call("T2.3", "classify_transaction_risk", {
  description: "battery cathode NMC precursor supply, wafer chip semiconductor lithography etch deposition, military missile nuclear russia iran north korea syria cuba crimea entity list sanction supercomputer ai training advanced node restricted party",
  destinationCountry: "Iran",
  hasUsOriginTechnology: true,
  hasEuTouchpoint: true,
  involvesTechnologyTransfer: true
});
// boundary: score exactly at thresholds
await call("T2.4", "classify_transaction_risk", { description: "wafer supply", destinationCountry: "Vietnam" });      // expect 2 -> low
await call("T2.5", "classify_transaction_risk", { description: "wafer supply", hasUsOriginTechnology: true });        // expect 5 -> medium
// negation handling probe
await call("T2.6", "classify_transaction_risk", {
  description: "Strictly NO military end use, NO nuclear application, no missile programs. Purely commercial consumer display panel.",
  destinationCountry: "Taiwan"
});
// empty description
await call("T2.7", "classify_transaction_risk", { description: "" });
// missing required field -> expect validation error
await call("T2.8", "classify_transaction_risk", {}, true);

// ================= 3. draft_export_control_clause ========================
await call("T3.1", "draft_export_control_clause", { transactionType: "equipment supply", riskLevel: "low" });
await call("T3.2", "draft_export_control_clause", { transactionType: "equipment supply", riskLevel: "high" });
await call("T3.3", "draft_export_control_clause", { language: "en", transactionType: "technology license", riskLevel: "high", includeIndemnity: false, includeAuditRight: false });
await call("T3.4", "draft_export_control_clause", { language: "de", transactionType: "x" }, true);

// ================= 4. build_due_diligence_checklist ======================
for (const stage of ["pre_contract", "contracting", "pre_shipment", "technical_support", "post_shipment"]) {
  await call(`T4.${stage}`, "build_due_diligence_checklist", { transactionStage: stage, industry: "semiconductor" });
}
await call("T4.bad", "build_due_diligence_checklist", { transactionStage: "post_contract" }, true);

// ================= 5. get_korean_law_article =============================
await call("T5.1", "get_korean_law_article", { law: "대외무역법", article: "제19조" });
await call("T5.2", "get_korean_law_article", { law: "대외무역법", article: "제53조" });
await call("T5.3", "get_korean_law_article", { law: "국제사법", article: "제45조" });
await call("T5.4", "get_korean_law_article", { law: "국제사법", article: "제99조" }); // no fallback expected
await call("T5.5", "get_korean_law_article", { law: "전략물자수출입고시", article: "제1조" }, true);

// ================= 6. classify_eccn ======================================
await call("T6.1", "classify_eccn", {
  itemDescription: "EUV lithography scanner for 3nm logic",
  itemType: "equipment", industry: "semiconductor", keySpecs: "13.5nm wavelength, NA 0.33"
});
await call("T6.2", "classify_eccn", {
  itemDescription: "Ion implanter for high-dose source/drain doping",
  itemType: "equipment", industry: "semiconductor"
});
await call("T6.3", "classify_eccn", {
  itemDescription: "CMP polishing tool", itemType: "equipment", industry: "semiconductor"
});
await call("T6.4", "classify_eccn", {
  itemDescription: "CD-SEM overlay metrology and defect inspection system", itemType: "equipment", industry: "semiconductor"
});
await call("T6.5", "classify_eccn", {
  itemDescription: "HBM3E high bandwidth memory stack for AI GPU accelerator",
  itemType: "equipment", industry: "semiconductor", keySpecs: "1.2 TB/s bandwidth"
});
await call("T6.6", "classify_eccn", {
  itemDescription: "NMC811 cathode active material and precursor pCAM",
  itemType: "material", industry: "battery"
});
await call("T6.7", "classify_eccn", {
  itemDescription: "sulfide solid-state electrolyte powder", itemType: "material", industry: "battery"
});
await call("T6.8", "classify_eccn", {
  itemDescription: "Process recipe and know-how for DRAM 1b node", itemType: "technology", industry: "semiconductor"
});
await call("T6.9", "classify_eccn", {
  itemDescription: "Plain carbon steel bolts", itemType: "equipment", industry: "other"
});
// cross-contamination probe: industry=both on a battery-only item
await call("T6.10", "classify_eccn", {
  itemDescription: "lithium cell separator film", itemType: "material", industry: "both"
});
// keyword false-positive probe
await call("T6.11", "classify_eccn", {
  itemDescription: "Marketing simulation deck about chip market; no hardware", itemType: "service", industry: "semiconductor"
});

// ================= 7. check_part744_enduse ===============================
await call("T7.1", "check_part744_enduse", { destinationCountry: "Japan", endUser: "Sony", endUse: "consumer image sensors", eccn: "EAR99" });
await call("T7.2", "check_part744_enduse", { destinationCountry: "China", endUser: "SMIC Shanghai", endUse: "advanced node logic foundry", eccn: "3B001.f" });
await call("T7.3", "check_part744_enduse", { destinationCountry: "Russia", endUser: "unknown trading intermediary", endUse: "industrial", eccn: "EAR99" });
await call("T7.4", "check_part744_enduse", { destinationCountry: "China", endUse: "military modernization / PLA procurement", flags: { militaryEndUse: true } });
await call("T7.5", "check_part744_enduse", { destinationCountry: "Pakistan", endUse: "uranium enrichment centrifuge program", flags: { nuclearActivity: true } });
await call("T7.6", "check_part744_enduse", { destinationCountry: "India", endUse: "space launch vehicle stage separation", flags: { missileActivity: true } });
await call("T7.7", "check_part744_enduse", { destinationCountry: "Myanmar", endUser: "state signals intelligence bureau", endUse: "surveillance" });
await call("T7.8", "check_part744_enduse", { destinationCountry: "Korea, Republic of", endUser: "Samsung Electronics Hwaseong", endUse: "commercial DRAM", eccn: "3B001.c" });
// Korean-relevant: China fab of a Korean company (VEU / affiliates rule scenario)
await call("T7.9", "check_part744_enduse", { destinationCountry: "China", endUser: "SK hynix Wuxi (Korean-owned fab)", endUse: "commercial DRAM production", eccn: "3B001.a" });
// subsidiary-of-listed-entity scenario (Affiliates Rule)
await call("T7.10", "check_part744_enduse", { destinationCountry: "Singapore", endUser: "a 60%-owned subsidiary of an Entity List company", endUse: "commercial servers", eccn: "3A090.a" });
await call("T7.11", "check_part744_enduse", {}, true);

// ================= 8. analyze_license_exceptions =========================
await call("T8.1", "analyze_license_exceptions", { eccn: "EAR99", destinationCountry: "Vietnam" });
await call("T8.2", "analyze_license_exceptions", { eccn: "EAR99", destinationCountry: "Iran" });
await call("T8.3", "analyze_license_exceptions", { eccn: "3B001.f", destinationCountry: "China", itemType: "hardware", valueUsd: 2500 });
await call("T8.4", "analyze_license_exceptions", { eccn: "3B001.f", destinationCountry: "Japan", itemType: "hardware", valueUsd: 2500 });
await call("T8.5", "analyze_license_exceptions", { eccn: "3E001", destinationCountry: "Germany", itemType: "technology" });
await call("T8.6", "analyze_license_exceptions", { eccn: "3E001", destinationCountry: "China", itemType: "technology" });
await call("T8.7", "analyze_license_exceptions", { eccn: "3A090.a", destinationCountry: "United Kingdom", itemType: "hardware" });
await call("T8.8", "analyze_license_exceptions", { eccn: "5D002", destinationCountry: "China", itemType: "software", flags: { encryption: true } });
await call("T8.9", "analyze_license_exceptions", { eccn: "3D001", destinationCountry: "China", itemType: "software" });
await call("T8.10", "analyze_license_exceptions", { eccn: "4A003", destinationCountry: "Brazil", itemType: "hardware" });
await call("T8.11", "analyze_license_exceptions", { eccn: "3B001.f", destinationCountry: "Taiwan", itemType: "hardware", valueUsd: 5_000_000 });
await call("T8.12", "analyze_license_exceptions", { eccn: "0A501", destinationCountry: "Canada", itemType: "hardware", endUserType: "government" });
await call("T8.13", "analyze_license_exceptions", { eccn: "ear99", destinationCountry: "korea", itemType: "hardware" }); // case sensitivity probe
await call("T8.14", "analyze_license_exceptions", { eccn: "3B001.f", destinationCountry: "Netherlands", transactionType: "transfer_in_country", itemType: "hardware" });
await call("T8.15", "analyze_license_exceptions", { destinationCountry: "Japan" }, true);

// ============ 9. new input surfaces added during remediation ==============
// These exercise the schema wiring over real MCP, not just the rules modules.
await call("T9.1", "check_part744_enduse", {
  destinationCountry: "Singapore",
  endUser: "60%-owned subsidiary of an Entity List company",
  eccn: "3A090.a",
  endUserScreening: {
    screeningPerformed: true,
    ownershipPercentByListedEntity: 60,
    headquarteredInMacauOrD5: true
  }
});
await call("T9.2", "check_part744_enduse", {
  destinationCountry: "China",
  eccn: "EAR99",
  flags: { semiconductorFabEndUse: true, advancedNodeProduction: "yes" },
  endUserScreening: { screeningPerformed: true }
});
await call("T9.3", "check_part744_enduse", {
  destinationCountry: "China",
  flags: { smeDevelopmentOrProduction: true, usPersonSupport: true },
  endUserScreening: { screeningPerformed: true }
});
await call("T9.4", "check_part744_enduse", {
  destinationCountry: "India",
  flags: { missileActivity: true, wmdDeliverySystem: true },
  endUserScreening: { screeningPerformed: true }
});
await call("T9.5", "analyze_license_exceptions", {
  eccn: "3A090.a",
  destinationCountry: "Malaysia",
  itemType: "hardware",
  entityHeadquarteredInMacauOrD5: true
});
await call("T9.6", "analyze_license_exceptions", {
  eccn: "3A090.c",
  destinationCountry: "Vietnam",
  itemType: "hardware",
  flags: { highBandwidthMemory: true }
});
await call("T9.7", "analyze_license_exceptions", {
  eccn: "3B001.f.1",
  destinationCountry: "Japan",
  itemType: "hardware",
  valueUsd: 400,
  flags: { temporaryExport: true, servicingOrReplacementParts: true }
});
await call("T9.8", "get_korean_law_article", { law: "대외무역법", article: "제19조의2" });
await call("T9.9", "get_korean_law_article", { law: "대외무역법", article: "19-3", source: "snapshot_only" });
await call("T9.10", "get_korean_law_article", { law: "대외무역법", article: "열아홉조", source: "snapshot_only" });
await call("T9.11", "check_data_freshness", {});
await call("T9.12", "classify_eccn", {
  itemDescription: "NMC811 cathode active material with manganese-rich chemistry",
  itemType: "material",
  industry: "battery"
});
await call("T9.13", "draft_export_control_clause", {
  language: "en",
  transactionType: "joint development",
  riskLevel: "high"
});
await call("T9.14", "build_due_diligence_checklist", { transactionStage: "technical_support", industry: "battery" });
await call("T9.15", "classify_transaction_risk", {
  description: "Strictly NO military end use and no nuclear application. Commercial display panels only.",
  destinationCountry: "Taiwan"
});
// invalid nested enum must be rejected
await call("T9.16", "check_part744_enduse", {
  destinationCountry: "China",
  flags: { advancedNodeProduction: "maybe" }
}, true);

// ============ 10. restricted-party screening ==============================
await call("T10.1", "screen_restricted_party", {
  names: ["Semiconductor Manufacturing International (Beijing) Corporation"]
});
await call("T10.2", "screen_restricted_party", { names: ["SMIC"], minScore: 60 });
await call("T10.3", "screen_restricted_party", {
  names: ["Samsung Electronics Co., Ltd.", "SK hynix Inc.", "Tokyo Electron Limited"]
});
await call("T10.4", "screen_restricted_party", {
  names: ["Huawei Technologies Co., Ltd."],
  listCodes: ["EL"],
  maxResults: 5
});
await call("T10.5", "screen_restricted_party", { names: ["Yangtze Memory"], country: "China" });
await call("T10.6", "screen_restricted_party", { names: [] }, true);
await call("T10.7", "check_part744_enduse", {
  destinationCountry: "China",
  endUser: "Semiconductor Manufacturing International (Beijing) Corporation",
  eccn: "3B001.f.1",
  endUserScreening: { screeningPerformed: true }
});
await call("T10.8", "check_part744_enduse", {
  destinationCountry: "Japan",
  endUser: "Clean Buyer KK",
  additionalParties: ["Huawei Technologies Co., Ltd."],
  eccn: "EAR99",
  endUserScreening: { screeningPerformed: true }
});

// ============ 11. EAR jurisdiction: de minimis and FDP ====================
// The headline case: a Korean-built etcher with zero U.S. content.
await call("T11.1", "assess_ear_jurisdiction", {
  destinationCountry: "China",
  foreignItemEccn: "3B001.c",
  producedUsingUsTechnologyEccns: ["3E992"],
  usControlledContentPercent: 0
});
await call("T11.2", "assess_ear_jurisdiction", {
  destinationCountry: "Japan",
  foreignItemEccn: "3B001.c",
  producedUsingUsTechnologyEccns: ["3E992"],
  usControlledContentPercent: 0
});
await call("T11.3", "assess_ear_jurisdiction", {
  destinationCountry: "China",
  foreignItemEccn: "3B002.b",
  producedByPlantThatIsDirectProductOfUsTechnology: true,
  recipientAtAdvancedNodeFacilityInMacauOrD5: true
});
await call("T11.4", "assess_ear_jurisdiction", {
  destinationCountry: "Vietnam",
  foreignItemEccn: "3A090.a",
  producedUsingUsTechnologyEccns: ["3D001"]
});
await call("T11.5", "assess_ear_jurisdiction", {
  itemOrigin: "us",
  destinationCountry: "China",
  foreignItemEccn: "3B001.c"
});
await call("T11.6", "assess_ear_jurisdiction", {
  destinationCountry: "Iran",
  foreignItemType: "commodity",
  usControlledContentPercent: 20
});
await call("T11.7", "assess_ear_jurisdiction", {
  destinationCountry: "China",
  foreignItemEccn: "3B001.c",
  usControlledContentPercent: 1,
  noDeMinimisFacts: { containsUsOriginIntegratedCircuit: true }
});
await call("T11.8", "assess_ear_jurisdiction", {
  destinationCountry: "Germany",
  foreignItemType: "technology",
  commingledTechnologyReportFiled: false
});
await call("T11.9", "assess_ear_jurisdiction", { destinationCountry: "Freedonia" }, false);
await call("T11.10", "assess_ear_jurisdiction", {}, true);

// --- T12: Commerce Country Chart (Part 738) -------------------------------
// Each case has an answer that can be checked against the regulation by hand.
await call("T12.1", "determine_license_requirement", { eccn: "1C010.a", destination: "Japan" });
await call("T12.2", "determine_license_requirement", { eccn: "1C010.a", destination: "China" });
await call("T12.3", "determine_license_requirement", { eccn: "3B001.b", destination: "China" });
await call("T12.4", "determine_license_requirement", { eccn: "3B001.c", destination: "China" });
await call("T12.5", "determine_license_requirement", { eccn: "3B001.c", destination: "Japan" });
await call("T12.6", "determine_license_requirement", { eccn: "3B001", destination: "China" });
await call("T12.7", "determine_license_requirement", { eccn: "3A090.a", destination: "Vietnam" });
await call("T12.8", "determine_license_requirement", { eccn: "3A090.c", destination: "Vietnam" });
await call("T12.9", "determine_license_requirement", { eccn: "5A002", destination: "Japan" });
// No graded mark for Australia, but footnote 10 still requires a licence.
await call("T12.10", "determine_license_requirement", { eccn: "0A501", destination: "Australia" });
// An embargoed destination: no marks at all, and that means nothing permissive.
await call("T12.11", "determine_license_requirement", { eccn: "1C010.a", destination: "Iran" });
await call("T12.12", "determine_license_requirement", { eccn: "1C010.a", destination: "Cuba" });
// Hong Kong has no row and takes China's under 85 FR 83788.
await call("T12.13", "determine_license_requirement", { eccn: "3B001.c", destination: "Hong Kong" });
// A dependent territory inheriting under 738.3(b).
await call("T12.14", "determine_license_requirement", { eccn: "1C010.a", destination: "Cayman Islands" });
// 738.3(a)(1): bypasses the chart, all destinations, no exceptions at all.
await call("T12.15", "determine_license_requirement", { eccn: "0A983", destination: "Germany" });
await call("T12.16", "determine_license_requirement", { eccn: "5A980", destination: "Germany" });
// Footnote 7 preserves an RS Column 2 requirement for India.
await call("T12.17", "determine_license_requirement", { eccn: "6A003.b.4.b", destination: "India" });
await call("T12.18", "determine_license_requirement", { eccn: "EAR99", destination: "China" });
await call("T12.19", "determine_license_requirement", { eccn: "1C010.a", destination: "Freedonia" });
await call("T12.20", "determine_license_requirement", { eccn: "not-an-eccn", destination: "China" });
await call("T12.21", "determine_license_requirement", {}, true);
// The exception tool must now carry the licence determination with it.
await call("T12.22", "analyze_license_exceptions", { eccn: "1C010.a", destinationCountry: "Japan" });

await client.close();

const outPath = path.join(here, "verification-report.json");
writeFileSync(outPath, JSON.stringify(log, null, 2), { encoding: "utf8" });
console.log("WROTE " + outPath + " entries=" + log.length);
