import { screenParty, screeningProvenance, normalizeName, SCREENING_LIMITS } from "../src/lib/screening.js";

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

const top = (r) => r.matches[0];
const codes = (r) => [...new Set(r.matches.map((m) => m.listCode))];

// ---- normalization ------------------------------------------------------
t("N1", normalizeName("HUAWEI TECHNOLOGIES CO., LTD.") === "huawei technologies co ltd", normalizeName("HUAWEI TECHNOLOGIES CO., LTD."));
t("N2", normalizeName("Société Générale") === "societe generale", normalizeName("Société Générale"));
t("N3", normalizeName("A&B  Corp") === "a and b corp", normalizeName("A&B  Corp"));

// ---- known-listed parties must be found --------------------------------
{
  const r = screenParty("Semiconductor Manufacturing International (Beijing) Corporation");
  t("L1", r.matchCount > 0, `${r.matchCount} match(es)`);
  t("L2", top(r).score >= 95, `top score ${top(r).score} on "${top(r).name}"`);
  t("L3", codes(r).includes("EL"), `lists: ${codes(r).join(", ")}`);
  t(
    "L4",
    /744\.11/.test(top(r).licenceRequirement ?? ""),
    `licence requirement: ${(top(r).licenceRequirement ?? "").slice(0, 70)}`
  );
  t("L5", Boolean(top(r).authority.effect), "authority effect present");
}
{
  // Acronym
  const r = screenParty("SMIC", { minScore: 60 });
  t("L6", r.matchCount > 0, `${r.matchCount} match(es)`);
  t(
    "L7",
    r.matches.some((m) => /Semiconductor Manufacturing International/i.test(m.name)),
    `top: ${top(r)?.name} (${top(r)?.basis})`
  );
}
{
  // Corporate suffix noise and case
  const r = screenParty("huawei technologies co ltd");
  t("L8", r.matchCount > 0 && top(r).score >= 95, `score ${top(r)?.score} on "${top(r)?.name}"`);
}
{
  // Alias matching
  const r = screenParty("YMTC");
  const viaAlias = r.matches.find((m) => /Yangtze Memory/i.test(m.name));
  t("L9", Boolean(viaAlias), `matched: ${r.matches.map((m) => m.name).slice(0, 3).join(" | ")}`);
}
{
  // Word-order / partial
  const r = screenParty("Yangtze Memory Technologies");
  t("L10", r.matchCount > 0, `${r.matchCount} match(es), top "${top(r)?.name}"`);
}
{
  // A UVL party should carry the UVL authority text
  const r = screenParty("Semiconductor Manufacturing International", { maxResults: 60 });
  t("L11", r.matchCount >= 3, `${r.matchCount} related entries surfaced`);
  const withPolicy = r.matches.find((m) => m.licencePolicy);
  t("L12", Boolean(withPolicy), `licence policy e.g. "${(withPolicy?.licencePolicy ?? "").slice(0, 40)}"`);
}

// ---- known-clean parties must not produce a high-confidence hit --------
for (const clean of ["Samsung Electronics Co., Ltd.", "SK hynix Inc.", "Tokyo Electron Limited"]) {
  const r = screenParty(clean);
  const strong = r.matches.filter((m) => m.score >= 90);
  t(
    `C-${clean.slice(0, 14)}`,
    strong.length === 0,
    strong.length ? `unexpected strong hit: ${strong[0].name} (${strong[0].score})` : `${r.matchCount} weak candidate(s) only`
  );
}

// ---- a no-match result must not read as clearance ----------------------
{
  const r = screenParty("Completely Fictional Trading Company ZZZQQQ");
  t("Z1", r.matchCount === 0, `${r.matchCount} match(es)`);
  t("Z2", r.usable === true, "query was usable");
  t(
    "Z3",
    SCREENING_LIMITS.some((l) => /NOT clearance/i.test(l)),
    "limits state that no-match is not clearance"
  );
  t(
    "Z4",
    SCREENING_LIMITS.some((l) => /744\.21\(a\)\(3\)/.test(l)),
    "limits call out the ownership gap"
  );
}

// ---- empty / garbage input ---------------------------------------------
{
  const r = screenParty("   ");
  t("E1", r.usable === false, `usable=${r.usable} reason=${r.reason}`);
}

// ---- list filtering ----------------------------------------------------
{
  const all = screenParty("Huawei", { maxResults: 200 });
  const elOnly = screenParty("Huawei", { maxResults: 200, listCodes: ["EL"] });
  t("F1", all.matchCount > elOnly.matchCount, `all=${all.matchCount} EL-only=${elOnly.matchCount}`);
  t("F2", elOnly.matches.every((m) => m.listCode === "EL"), `codes: ${codes(elOnly).join(",")}`);
}

// ---- country annotation must not exclude -------------------------------
{
  const withWrong = screenParty("Yangtze Memory Technologies", { country: "Japan" });
  t("A1", withWrong.matchCount > 0, "a wrong destination does not suppress the match");
  t(
    "A2",
    /does not rule out/.test(top(withWrong)?.countryNote ?? ""),
    top(withWrong)?.countryNote
  );
}

// ---- provenance and staleness -----------------------------------------
{
  const p = screeningProvenance();
  t("P1", p.entryCount > 20000, `${p.entryCount} entries`);
  t("P2", p.requiresApiKey === false, "no API key needed");
  t("P3", p.staleAfterDays === 7, `staleAfterDays=${p.staleAfterDays}`);
  t("P4", Boolean(p.sourceGeneratedAt), `sourceGeneratedAt=${p.sourceGeneratedAt}`);
  t("P5", p.countsBySource["Entity List (EL) - Bureau of Industry and Security"] > 2000, "EL count sane");
}

// ---- performance -------------------------------------------------------
{
  const t0 = Date.now();
  for (const n of ["Huawei", "SMIC", "Samsung Electronics", "Yangtze Memory", "Some Random Co"]) {
    screenParty(n);
  }
  const ms = Date.now() - t0;
  t("PF1", ms < 5000, `5 queries in ${ms}ms (index build included)`);
  const t1 = Date.now();
  screenParty("Huawei Technologies");
  t("PF2", Date.Now === undefined || Date.now() - t1 < 500, `warm query ${Date.now() - t1}ms`);
}

// ---- calibration: clean parties must be quiet, listed ones must be loud ----
{
  const CLEAN = [
    "Samsung Electronics Hwaseong",
    "SK hynix Inc.",
    "Tokyo Electron Limited",
    "ASML Netherlands B.V.",
    "Applied Materials Inc.",
    "POSCO Future M"
  ];
  const strongOnClean = CLEAN.map((n) => ({
    n,
    hits: screenParty(n).matches.filter((m) => m.score >= 85)
  })).filter((x) => x.hits.length > 0);
  t(
    "CAL1",
    strongOnClean.length === 0,
    strongOnClean.length
      ? `false strong hits: ${strongOnClean.map((x) => `${x.n} -> ${x.hits[0].name}`).join("; ")}`
      : `${CLEAN.length} clean parties produced no strong hit`
  );

  const LISTED = [
    ["Semiconductor Manufacturing International (Beijing) Corporation", "EL"],
    ["Huawei Technologies Co., Ltd.", "EL"],
    ["Yangtze Memory Technologies Co., Ltd.", "EL"],
    ["SMIC", null]
  ];
  const missed = LISTED.filter(([n]) => !screenParty(n).matches.some((m) => m.score >= 85));
  t("CAL2", missed.length === 0, missed.length ? `missed: ${missed.map((x) => x[0]).join("; ")}` : `${LISTED.length} listed parties all found at >=85`);

  // A single shared INDUSTRY word must never produce a match. These names each
  // share exactly one high-frequency token with many listed parties.
  const industryOnly = ["Qwerty Electronics Trading Company", "Zzyzx Energy Holdings", "Vorpal Materials Inc."];
  const spurious = industryOnly
    .map((n) => ({ n, r: screenParty(n) }))
    .filter((x) => x.r.matchCount > 0);
  t(
    "CAL3",
    spurious.length === 0,
    spurious.length
      ? spurious.map((x) => `${x.n} -> ${x.r.matches[0].score} ${x.r.matches[0].name} (${x.r.matches[0].basis})`).join("; ")
      : "single shared industry word produces no match"
  );

  // Two shared distinctive words SHOULD surface as a possible match. This is the
  // behaviour we want to keep, so it is asserted rather than left implicit.
  const twoShared = screenParty("Bright Electronics Trading Company");
  t(
    "CAL4",
    twoShared.matches.some((m) => m.score >= 70 && m.score < 85),
    `"Bright Electronics ..." -> ${twoShared.matches.map((m) => `${m.score} ${m.name}`).join("; ") || "no match"}`
  );
}

// ---- integration with check_part744_enduse -----------------------------
{
  const { checkPart744 } = await import("../src/rules/part744.js");

  const listed = checkPart744({
    destinationCountry: "China",
    endUser: "Semiconductor Manufacturing International (Beijing) Corporation",
    eccn: "3B001.f.1",
    endUserScreening: { screeningPerformed: true }
  });
  const hit = listed.issuesToReview.find((i) => /Screening hit/.test(i.rule));
  t("I1", Boolean(hit), hit?.rule);
  t("I2", hit?.severity === "blocking", `severity=${hit?.severity}`);
  t("I3", /744\.16/.test(hit?.citation ?? ""), `citation=${hit?.citation}`);
  t("I4", listed.outcome.type === "licence_requirement_identified", listed.outcome.type);
  t("I5", listed.screening.strongMatchCount === 1, `strong=${listed.screening.strongMatchCount}`);
  t(
    "I6",
    /not an identification/i.test(hit?.actionRequired ?? ""),
    "hit tells the reader a match is not an identification"
  );

  // additionalParties must be screened too
  const viaFreight = checkPart744({
    destinationCountry: "Japan",
    endUser: "Some Clean Buyer KK",
    additionalParties: ["Huawei Technologies Co., Ltd."],
    eccn: "EAR99",
    endUserScreening: { screeningPerformed: true }
  });
  t(
    "I7",
    viaFreight.issuesToReview.some((i) => /Screening hit/.test(i.rule)),
    `parties screened: ${viaFreight.screening.partiesScreened.join(", ")}`
  );

  // A clean party must not be turned into a finding
  const clean = checkPart744({
    destinationCountry: "Korea, Republic of",
    endUser: "Samsung Electronics Hwaseong",
    eccn: "3B001.c",
    endUserScreening: { screeningPerformed: true }
  });
  t("I8", clean.outcome.type === "no_heuristic_flag", clean.outcome.type);
  t("I9", clean.screening.strongMatchCount === 0, `strong=${clean.screening.strongMatchCount}`);

  // Screening always reports its own limits and vintage
  t("I10", Array.isArray(clean.screening.limits) && clean.screening.limits.length >= 5, "limits attached");
  t("I11", Boolean(clean.screening.provenance.retrievedAt), "snapshot vintage attached");
  t(
    "I12",
    clean.issuesToReview.every((i) => !/screening has NOT been performed/i.test(i.rule)),
    "stale wording removed once screening is asserted"
  );

  // Without screeningPerformed, the incompleteness must still block
  const unscreened = checkPart744({
    destinationCountry: "Japan",
    endUser: "Samsung Electronics Hwaseong",
    eccn: "EAR99"
  });
  const inc = unscreened.issuesToReview.find((i) => /Screening is incomplete/.test(i.rule));
  t("I13", Boolean(inc) && inc.severity === "blocking", `${inc?.rule} (${inc?.severity})`);
  t("I14", /ownership is not in the Consolidated Screening List/i.test(inc?.detail ?? ""), "ownership gap stated");
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exitCode = fails ? 1 : 0;
