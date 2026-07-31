import { getKoreanLawArticle, parseArticleLabel, snapshotProvenance } from "../src/lib/korean-law.js";

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

// ---- article label parsing ----------------------------------------------
{
  const cases = [
    ["제19조", "제19조", "001900"],
    ["제19조의2", "제19조의2", "001902"],
    ["제19조의3", "제19조의3", "001903"],
    ["19조", "제19조", "001900"],
    ["19", "제19조", "001900"],
    ["19-2", "제19조의2", "001902"],
    ["19의2", "제19조의2", "001902"],
    ["제53조", "제53조", "005300"],
    [" 제 45 조 ", "제45조", "004500"]
  ];
  let ok = true;
  const bad = [];
  for (const [input, label, jo] of cases) {
    const p = parseArticleLabel(input);
    if (!p.valid || p.label !== label || p.jo !== jo) {
      ok = false;
      bad.push(`${input} -> ${p.valid ? p.label + "/" + p.jo : p.reason}`);
    }
  }
  t("L1", ok, bad.length ? bad.join("; ") : `${cases.length} label forms parsed`);
  t("L2", parseArticleLabel("제19조의2").jo === "001902", "sub-article JO encoding is AAAABB");
  t("L3", !parseArticleLabel("나머지").valid, "garbage rejected");
  t("L4", !parseArticleLabel("").valid, "empty rejected");
}

// ---- snapshot_only path must work with no network and no LAW_OC ----------
{
  const saved = process.env.LAW_OC;
  delete process.env.LAW_OC;
  const t0 = Date.now();
  const r = await getKoreanLawArticle({ law: "대외무역법", article: "제20조", source: "snapshot_only" });
  const ms = Date.now() - t0;
  if (saved !== undefined) process.env.LAW_OC = saved;

  t("S1", r.ok === true, `ok=${r.ok}`);
  t("S2", r.retrievedFrom === "snapshot", `retrievedFrom=${r.retrievedFrom}`);
  t("S3", ms < 500, `${ms}ms (must not block; the old path burned 12s)`);
  t("S4", r.article.title === "전문판정", `title=${r.article.title}`);
  t("S5", /전문판정/.test(r.article.text), "text present");
  t("S6", r.article.effectiveDate === "20251001", `effectiveDate=${r.article.effectiveDate}`);
  t("S7", r.lawMetadata.competentMinistry === "산업통상부", `소관부처=${r.lawMetadata.competentMinistry}`);
  t("S8", r.lawMetadata.promulgationDate === "20251001", `공포일자=${r.lawMetadata.promulgationDate}`);
}

// ---- the articles the old fallback could not serve at all ---------------
{
  for (const [label, expectTitle] of [
    ["제19조", "전략물자"],
    ["제19조의2", "수출허가"],
    ["제19조의3", "상황허가"]
  ]) {
    const r = await getKoreanLawArticle({ law: "대외무역법", article: label, source: "snapshot_only" });
    t(
      `S9-${label}`,
      r.ok && r.article.title === expectTitle,
      `${label} -> ${r.ok ? r.article.title : r.error}`
    );
  }
  const r = await getKoreanLawArticle({ law: "대외무역법", article: "제19조의2", source: "snapshot_only" });
  t("S10", /기술이전|이전/.test(r.article.text), "제19조의2 carries the technology-transfer scope");
  t("S11", r.article.amendmentNote === "[본조신설 2024.2.20]", `amendmentNote=${r.article.amendmentNote}`);
}

// ---- 항/호 nesting is rendered ------------------------------------------
{
  const r = await getKoreanLawArticle({ law: "대외무역법", article: "제53조", source: "snapshot_only" });
  t("S12", r.article.paragraphCount === 2, `항 count=${r.article.paragraphCount}`);
  t("S13", /제19조의2에 따른 수출허가/.test(r.article.text), "호 text included and references 제19조의2");
  t("S14", r.article.text.split("\n").length > 5, `rendered ${r.article.text.split("\n").length} lines`);
}
{
  const r = await getKoreanLawArticle({ law: "국제사법", article: "제45조", source: "snapshot_only" });
  t("S15", r.article.title === "당사자 자치", `title=${r.article.title}`);
  t("S16", r.article.paragraphCount === 5, `항 count=${r.article.paragraphCount}`);
  t("S17", r.lawMetadata.competentMinistry === "법무부", `소관부처=${r.lawMetadata.competentMinistry}`);
}

// ---- error taxonomy -----------------------------------------------------
{
  const r = await getKoreanLawArticle({ law: "전략물자수출입고시", article: "제1조", source: "snapshot_only" });
  t("E1", r.ok === false && r.error === "unsupported_law", `error=${r.error}`);
}
{
  const r = await getKoreanLawArticle({ law: "대외무역법", article: "열아홉조", source: "snapshot_only" });
  t("E2", r.ok === false && r.error === "unparseable_article", `error=${r.error}`);
  t("E3", Boolean(r.hint), "hint explains the 의 form");
}
{
  const r = await getKoreanLawArticle({ law: "국제사법", article: "제999조", source: "snapshot_only" });
  t("E4", r.ok === false && r.error === "article_not_found", `error=${r.error}`);
  t("E5", Array.isArray(r.nearbyArticles), `nearby=${JSON.stringify(r.nearbyArticles)}`);
}

// ---- no hardcoded key; missing LAW_OC is reported, not fatal ------------
{
  const saved = process.env.LAW_OC;
  delete process.env.LAW_OC;
  const r = await getKoreanLawArticle({ law: "대외무역법", article: "제20조" });
  if (saved !== undefined) process.env.LAW_OC = saved;
  const liveAttempt = r.attempts.find((a) => a.stage === "live");
  t("K1", r.ok === true, "still answers without LAW_OC");
  t("K2", liveAttempt.outcome === "skipped", `live outcome=${liveAttempt.outcome}`);
  t("K3", /LAW_OC is not set/.test(liveAttempt.detail), liveAttempt.detail?.slice(0, 80));
  t("K4", r.retrievedFrom === "snapshot", `retrievedFrom=${r.retrievedFrom}`);
}

// ---- live path, only when LAW_OC is available ---------------------------
if (process.env.LAW_OC) {
  const t0 = Date.now();
  const r = await getKoreanLawArticle({ law: "대외무역법", article: "제19조의2" });
  const ms = Date.now() - t0;
  const liveAttempt = r.attempts.find((a) => a.stage === "live");
  t("V1", r.ok === true, `ok=${r.ok}`);
  // law.go.kr intermittently 404s under rapid successive requests, so the
  // assertion is that the live path was ATTEMPTED and that any failure is
  // recorded and transparently downgraded -- not that live always wins.
  t("V2", liveAttempt.outcome !== "skipped", `live outcome=${liveAttempt.outcome}`);
  t(
    "V3",
    r.retrievedFrom === "live" || (r.retrievedFrom === "snapshot" && Boolean(liveAttempt.detail)),
    `retrievedFrom=${r.retrievedFrom} detail=${liveAttempt.detail ?? "-"}`
  );
  t("V4", ms < 15000, `${ms}ms (the old shell path never returned)`);
  t("V5", r.article.title === "수출허가", `title=${r.article.title}`);
  t("V6", r.snapshotDivergence === null, `divergence=${JSON.stringify(r.snapshotDivergence)}`);
  if (r.retrievedFrom === "live") {
    console.log(`      (live retrieval succeeded${liveAttempt.retried ? " after one retry" : ""})`);
  }
} else {
  console.log("SKIP  V1-V6  LAW_OC not set, live path not exercised");
}

// ---- provenance ---------------------------------------------------------
{
  const p = snapshotProvenance();
  t("P1", Boolean(p.retrievedAt), `retrievedAt=${p.retrievedAt}`);
  t("P2", p.laws["대외무역법"].articleCount === 75, `대외무역법 ${p.laws["대외무역법"].articleCount} articles`);
  t("P3", p.laws["국제사법"].articleCount === 96, `국제사법 ${p.laws["국제사법"].articleCount} articles`);
  // Compare against the live env value rather than embedding a literal key,
  // so this assertion does not itself put a credential in the repository.
  const oc = process.env.LAW_OC;
  t(
    "P4",
    !oc || !JSON.stringify(p).includes(oc),
    oc ? "no API key leaked into provenance" : "LAW_OC unset, leak check trivially satisfied"
  );
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
// Set the code and let Node drain its keep-alive sockets. Calling process.exit()
// while an undici socket is still open trips a libuv assertion on Windows.
process.exitCode = fails ? 1 : 0;
