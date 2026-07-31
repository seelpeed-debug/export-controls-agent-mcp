#!/usr/bin/env node
// Builds src/data/korean-law.json -- a dated, complete snapshot of the Korean
// statutes this server cites, taken from the law.go.kr Open API.
//
// Why a snapshot instead of hand-written fallback text: the previous fallbacks
// were prose summaries written once and never revised. By the time they were
// checked, the 2024-02-20 전문개정 had split 대외무역법 제19조 into 제19조
// (전략물자 고시), 제19조의2 (수출허가) and 제19조의3 (상황허가), and the
// 2025-10-01 amendment had rewritten several of them. A summary cannot be
// audited against a promulgation date; a snapshot can.
//
// Requires the LAW_OC environment variable (a law.go.kr Open API account id).
//
// Usage:  LAW_OC=<your-oc> node scripts/build-korean-law.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAWS, normalizeLawPayload } from "../src/lib/korean-law-parse.js";
import { writeSnapshotIfChanged, forceRequested } from "./write-snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "src", "data", "korean-law.json");

const OC = process.env.LAW_OC;
if (!OC) {
  console.error(
    "LAW_OC is not set.\n" +
      "Register for a law.go.kr Open API account and export the account id, e.g.\n" +
      '  $env:LAW_OC="your-id"   (PowerShell)\n' +
      "  export LAW_OC=your-id   (bash)"
  );
  process.exit(1);
}

async function fetchLaw(mst) {
  const url = `https://www.law.go.kr/DRF/lawService.do?OC=${encodeURIComponent(OC)}&target=law&MST=${mst}&type=JSON`;
  const res = await fetch(url, { headers: { "User-Agent": "export-controls-agent-mcp/build-korean-law" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for MST ${mst}`);
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`law.go.kr returned non-JSON for MST ${mst}: ${body.slice(0, 200)}`);
  }
  // The API answers 200 with an error document when the account id is rejected.
  if (!json?.법령) throw new Error(`unexpected payload for MST ${mst}: ${body.slice(0, 200)}`);
  return json;
}

const laws = {};
for (const [name, meta] of Object.entries(LAWS)) {
  process.stdout.write(`fetching ${name} (MST ${meta.mst}) ... `);
  const json = await fetchLaw(meta.mst);
  const parsed = normalizeLawPayload(json);
  laws[name] = {
    mst: meta.mst,
    lawName: parsed.lawName,
    promulgationDate: parsed.promulgationDate,
    competentMinistry: parsed.competentMinistry,
    articleCount: parsed.articles.length,
    articles: parsed.articles
  };
  console.log(`${parsed.articles.length} articles, 공포일자 ${parsed.promulgationDate}`);
}

// Sanity checks against facts verified directly against the API. These are the
// exact points where the old hand-written fallbacks had drifted.
const ft = laws["대외무역법"];
const byKey = new Map(ft.articles.map((a) => [a.label, a]));
const failures = [];
for (const [label, mustMatch] of [
  ["제19조", /전략물자/],
  ["제19조의2", /수출허가/],
  ["제19조의3", /상황허가/],
  ["제20조", /전문판정/],
  ["제53조", /벌칙/]
]) {
  const a = byKey.get(label);
  if (!a) failures.push(`대외무역법 ${label} missing from snapshot`);
  else if (!mustMatch.test(a.title ?? "")) {
    failures.push(`대외무역법 ${label} title should match ${mustMatch} but is "${a.title}"`);
  }
}
const pil = new Map((laws["국제사법"]?.articles ?? []).map((a) => [a.label, a]));
for (const [label, mustMatch] of [
  ["제20조", /대한민국 법의 강행적 적용/],
  ["제45조", /당사자 자치/]
]) {
  const a = pil.get(label);
  if (!a) failures.push(`국제사법 ${label} missing from snapshot`);
  else if (!mustMatch.test(a.title ?? "")) {
    failures.push(`국제사법 ${label} title should match ${mustMatch} but is "${a.title}"`);
  }
}
if (failures.length) {
  throw new Error("sanity check failed, refusing to write snapshot:\n  - " + failures.join("\n  - "));
}

const payload = {
  $comment:
    "GENERATED FILE -- do not edit by hand. Regenerate with: LAW_OC=<your-oc> node scripts/build-korean-law.mjs",
  source: {
    api: "law.go.kr Open API (DRF/lawService.do)",
    note: "The API account id (OC) is supplied at build time via the LAW_OC environment variable and is deliberately not stored in this file."
  },
  retrievedAt: new Date().toISOString(),
  laws
};

const result = writeSnapshotIfChanged(OUT, payload, { force: forceRequested() });
console.log(`\n${result.written ? "wrote" : "SKIPPED"} ${OUT} (${(result.bytes / 1024).toFixed(0)} KB)`);
console.log(`  ${result.reason}`);
for (const [name, l] of Object.entries(laws)) {
  console.log(`  ${name}: ${l.articleCount} articles, 공포일자 ${l.promulgationDate}, 소관부처 ${l.competentMinistry}`);
}
