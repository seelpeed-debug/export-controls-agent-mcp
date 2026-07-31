#!/usr/bin/env node
// Builds src/data/screening-list.json from the U.S. Consolidated Screening List.
//
// The CSL merges twelve federal restricted-party lists (BIS Entity List, Denied
// Persons, Unverified, MEU; OFAC SDN and the non-SDN lists; State ITAR Debarred
// and ISN). trade.gov publishes it as a keyless bulk download, so this needs no
// API key.
//
// The published file is ~32 MB. Screening only needs names, aliases, which list
// an entry came from, and the operative licence requirement, so the projection
// below drops dates of birth, passport numbers, vessel tonnage and similar, then
// interns the heavily repeated strings (source names, licence requirement text,
// sanctions programmes, URLs) into lookup tables.
//
// Usage:  node scripts/build-screening-list.mjs [--force]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSnapshotIfChanged, forceRequested } from "./write-snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "src", "data", "screening-list.json");

const SOURCE_URL =
  "https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json";

// Which EAR or OFAC provision each list maps to. Hand-curated: the CSL itself
// carries no such mapping, and this is what turns a name hit into a legal
// consequence.
const LIST_AUTHORITY = {
  "Entity List (EL) - Bureau of Industry and Security": {
    code: "EL",
    citation: "15 C.F.R. § 744.16 and Supplement No. 4 to Part 744",
    effect:
      "Licence required to the extent stated in the entry's License Requirement column. Per § 744.16(b) no License Exception is available, apart from the narrow § 740.2(a)(5) civil-aviation carve-out for certain Indian and Pakistani entities and entities listed under § 744.20."
  },
  "Denied Persons List (DPL) - Bureau of Industry and Security": {
    code: "DPL",
    citation: "15 C.F.R. Part 764, Supplement No. 2",
    effect:
      "A denial order prohibits participation in any transaction involving items subject to the EAR. This reaches conduct well beyond exporting, including forwarding, financing and servicing."
  },
  "Unverified List (UVL) - Bureau of Industry and Security": {
    code: "UVL",
    citation: "15 C.F.R. § 744.15 and Supplement No. 6 to Part 744",
    effect:
      "No License Exceptions may be used, and a UVL statement must be obtained from the party before export, reexport or transfer."
  },
  "Military End User (MEU) List - Bureau of Industry and Security": {
    code: "MEU",
    citation: "15 C.F.R. § 744.21 and Supplement No. 7 to Part 744",
    effect:
      "Licence required for items listed in Supplement No. 2 to Part 744. Only License Exception GOV under § 740.11(b)(2)(i) and (ii) is available."
  },
  "Specially Designated Nationals (SDN) - Treasury Department": {
    code: "SDN",
    citation: "31 C.F.R. (OFAC); EAR licence requirement via 15 C.F.R. § 744.8",
    effect:
      "Property is blocked under OFAC authority. § 744.8 additionally imposes an EAR licence requirement where the designation falls under one of the programmes listed in § 744.8(a)(1), so the programme code matters."
  },
  "Non-SDN Chinese Military-Industrial Complex Companies List (CMIC) - Treasury Department": {
    code: "CMIC",
    citation: "E.O. 13959 as amended (OFAC)",
    effect:
      "Restricts dealings in publicly traded securities. Not itself an EAR licence requirement, but a strong diversion red flag and often accompanied by Entity List treatment."
  },
  "Sectoral Sanctions Identifications List (SSI) - Treasury Department": {
    code: "SSI",
    citation: "31 C.F.R. Part 589 (OFAC directives)",
    effect: "Directive-specific prohibitions rather than full blocking. Read the applicable directive."
  },
  "Non-SDN Menu-Based Sanctions List (NS-MBS List) - Treasury Department": {
    code: "NS-MBS",
    citation: "OFAC menu-based sanctions",
    effect: "Specific menu items apply; read the entry."
  },
  "Palestinian Legislative Council List (PLC) - Treasury Department": {
    code: "PLC",
    citation: "OFAC",
    effect: "Read the entry."
  },
  "Capta List (CAP) - Treasury Department": {
    code: "CAP",
    citation: "OFAC (correspondent account / payable-through account sanctions)",
    effect: "Restricts correspondent banking relationships."
  },
  "ITAR Debarred (DTC) - State Department": {
    code: "DTC",
    citation: "22 C.F.R. § 127.7 (ITAR)",
    effect:
      "Debarred from participating in ITAR-controlled activity. Relevant where the item is a defense article rather than subject to the EAR."
  },
  "Nonproliferation Sanctions (ISN) - State Department": {
    code: "ISN",
    citation: "State Department nonproliferation sanctions",
    effect: "Sanctions measures vary by determination; read the Federal Register notice."
  }
};

async function fetchCsl() {
  process.stdout.write("downloading Consolidated Screening List ... ");
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "export-controls-agent-mcp/build-screening-list" }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${SOURCE_URL}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  return JSON.parse(buf.toString("utf8"));
}

/** Interning table: repeated strings become indices. */
function makeInterner() {
  const table = [];
  const index = new Map();
  return {
    table,
    put(value) {
      if (value === null || value === undefined || value === "") return undefined;
      const s = String(value).replace(/\s+/g, " ").trim();
      if (!s) return undefined;
      let i = index.get(s);
      if (i === undefined) {
        i = table.length;
        table.push(s);
        index.set(s, i);
      }
      return i;
    }
  };
}

const raw = await fetchCsl();
const rows = raw.results;
if (!Array.isArray(rows) || rows.length < 20000) {
  throw new Error(`expected 20000+ CSL entries, got ${Array.isArray(rows) ? rows.length : "none"}`);
}

const sources = makeInterner();
const licences = makeInterner();
const policies = makeInterner();
const programmes = makeInterner();
const urls = makeInterner();

const entries = rows.map((r) => {
  const countries = [
    ...new Set(
      (r.addresses ?? [])
        .map((a) => a?.country)
        .filter(Boolean)
        .map((c) => String(c).trim().toUpperCase())
    )
  ];
  const alt = (r.alt_names ?? []).map((a) => String(a ?? "").trim()).filter(Boolean);
  return {
    n: String(r.name ?? "").trim(),
    ...(alt.length ? { a: alt } : {}),
    s: sources.put(r.source),
    ...(r.type ? { t: r.type } : {}),
    ...(countries.length ? { c: countries } : {}),
    ...(r.entity_number ? { e: String(r.entity_number) } : {}),
    ...(licences.put(r.license_requirement) !== undefined
      ? { lr: licences.put(r.license_requirement) }
      : {}),
    ...(policies.put(r.license_policy) !== undefined ? { lp: policies.put(r.license_policy) } : {}),
    ...(programmes.put((r.programs ?? []).join("; ")) !== undefined
      ? { pg: programmes.put((r.programs ?? []).join("; ")) }
      : {}),
    ...(r.federal_register_notice ? { fr: String(r.federal_register_notice).trim() } : {}),
    ...(urls.put(r.source_list_url) !== undefined ? { u: urls.put(r.source_list_url) } : {})
  };
});

// --- sanity checks -------------------------------------------------------
const bySource = new Map();
for (const e of entries) {
  const s = sources.table[e.s];
  bySource.set(s, (bySource.get(s) ?? 0) + 1);
}
const failures = [];
for (const listName of Object.keys(LIST_AUTHORITY)) {
  if (!bySource.has(listName)) failures.push(`source list absent from download: ${listName}`);
}
for (const s of bySource.keys()) {
  if (!LIST_AUTHORITY[s]) {
    failures.push(`download contains an unmapped source list, add it to LIST_AUTHORITY: ${s}`);
  }
}
// Entries we independently confirmed are listed. If a name-matching change or an
// upstream format change silently empties the dataset, these fail loudly rather
// than letting the tool report "no match" for a listed party.
const haystack = entries.map((e) => (e.n + " " + (e.a ?? []).join(" ")).toLowerCase());
for (const probe of ["semiconductor manufacturing international", "huawei", "yangtze memory"]) {
  if (!haystack.some((h) => h.includes(probe))) failures.push(`expected listed party not found: ${probe}`);
}
const elCount = bySource.get("Entity List (EL) - Bureau of Industry and Security") ?? 0;
if (elCount < 2000) failures.push(`BIS Entity List count looks wrong: ${elCount}`);
if (failures.length) {
  throw new Error("sanity check failed, refusing to write dataset:\n  - " + failures.join("\n  - "));
}

const payload = {
  $comment:
    "GENERATED FILE -- do not edit by hand. Regenerate with: node scripts/build-screening-list.mjs",
  citation: "U.S. Consolidated Screening List (Departments of Commerce, State and the Treasury)",
  source: { url: SOURCE_URL, api: "trade.gov bulk download", requiresApiKey: false },
  sourceGeneratedAt: raw.search_performed_at ?? null,
  retrievedAt: new Date().toISOString(),
  entryCount: entries.length,
  countsBySource: Object.fromEntries([...bySource.entries()].sort((a, b) => b[1] - a[1])),
  listAuthority: LIST_AUTHORITY,
  fieldKey: {
    n: "name",
    a: "alt_names",
    s: "source (index into tables.sources)",
    t: "type",
    c: "address countries (ISO-2)",
    e: "entity_number",
    lr: "license_requirement (index into tables.licenceRequirements)",
    lp: "license_policy (index into tables.licencePolicies)",
    pg: "programs (index into tables.programmes)",
    fr: "federal_register_notice",
    u: "source_list_url (index into tables.urls)"
  },
  tables: {
    sources: sources.table,
    licenceRequirements: licences.table,
    licencePolicies: policies.table,
    programmes: programmes.table,
    urls: urls.table
  },
  entries
};

const result = writeSnapshotIfChanged(OUT, payload, {
  force: forceRequested(),
  volatileKeys: ["retrievedAt", "sourceGeneratedAt"]
});

console.log(result.written ? `wrote ${OUT}` : `SKIPPED ${OUT}`);
console.log(`  ${result.reason} (${(result.bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  source generated at: ${payload.sourceGeneratedAt}`);
console.log(`  ${entries.length} entries, ${sources.table.length} source lists`);
for (const [s, n] of Object.entries(payload.countsBySource)) {
  console.log(`    ${String(n).padStart(6)}  ${LIST_AUTHORITY[s]?.code ?? "?"}  ${s}`);
}
