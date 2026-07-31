import { classifyEccnCandidates } from "../src/rules/ccl-search.js";

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

function run(desc, opts = {}) {
  return classifyEccnCandidates({
    itemDescription: desc,
    itemType: opts.itemType ?? "equipment",
    industry: opts.industry ?? "semiconductor",
    keySpecs: opts.keySpecs
  });
}

function paragraphs(r) {
  return r.cclTextMatches.flatMap((e) => e.matches.map((m) => m.paragraph ?? e.eccn));
}
function eccns(r) {
  return r.cclTextMatches.map((e) => e.eccn);
}

// 1. Lithography must land on 3B001.f, never 3B001.e
{
  const r = run("EUV lithography scanner for 3nm logic", { keySpecs: "13.5 nm wavelength" });
  const p = paragraphs(r);
  t("CCL1", p.some((x) => x.startsWith("3B001.f")), `paragraphs: ${p.slice(0, 4).join(", ")}`);
  t("CCL2", !p.some((x) => x === "3B001.e"), "3B001.e must not be offered for lithography");
}

// 2. Ion implantation must land on 3B001.b, not 3B001.d
{
  const r = run("Ion implanter for high-dose source/drain doping");
  const p = paragraphs(r);
  t("CCL3", p.some((x) => x.startsWith("3B001.b")), `paragraphs: ${p.slice(0, 4).join(", ")}`);
  t("CCL4", !p.some((x) => x.startsWith("3B001.d")), "3B001.d is deposition, not implantation");
}

// 3. Deposition must land on 3B001.d
{
  const r = run("Atomic layer deposition tool for high-k dielectric");
  const p = paragraphs(r);
  t("CCL5", p.some((x) => x.startsWith("3B001.d") || x.startsWith("3B001.a")), `paragraphs: ${p.slice(0, 4).join(", ")}`);
}

// 4. Metrology / inspection must NOT be reported as 3B001.f
{
  const r = run("CD-SEM overlay metrology and patterned wafer defect inspection system");
  const e = eccns(r);
  const p = paragraphs(r);
  t("CCL6", e.includes("3B002") || e.includes("3B993"), `entries: ${e.slice(0, 5).join(", ")}`);
  t(
    "CCL7",
    !p.some((x) => x === "3B001.f"),
    `3B001.f is lithography; got ${p.filter((x) => x.startsWith("3B001")).slice(0, 3).join(", ") || "no 3B001 hits"}`
  );
}

// 5. Battery cathode must NOT return 1C010
{
  const r = run("NMC811 cathode active material and precursor pCAM", {
    itemType: "material",
    industry: "battery"
  });
  const e = eccns(r);
  t("CCL8", !e.includes("1C010"), `entries: ${e.slice(0, 6).join(", ") || "(none)"}`);
  t(
    "CCL9",
    r.notes.some((n) => /fibrous or filamentary/i.test(n)),
    "battery note explains what 1C010 actually is"
  );
}

// 6. Solid-state electrolyte must NOT return 1C010
{
  const r = run("sulfide solid-state electrolyte powder", { itemType: "material", industry: "battery" });
  t("CCL10", !eccns(r).includes("1C010"), `entries: ${eccns(r).slice(0, 6).join(", ") || "(none)"}`);
}

// 7. Negated terms must not drive the search
{
  const r = run("Marketing deck about the chip market. Contains no software and no simulation tooling.", {
    itemType: "service"
  });
  t("CCL11", r.searchTerms.assertedAbsent.length > 0, `absent: ${r.searchTerms.assertedAbsent.join(", ")}`);
  t(
    "CCL12",
    !r.searchTerms.matchedInDescription.includes("software") &&
      !r.searchTerms.matchedInDescription.includes("simulation"),
    `matched: ${r.searchTerms.matchedInDescription.join(", ")}`
  );
}

// 7b. user-side wording is mapped to regulation-side wording
{
  const r = run("Ion implanter for source/drain doping");
  t(
    "CCL20",
    r.searchTerms.matchedInDescription.includes("implanter") &&
      r.searchTerms.searchedInCcl.includes("ion implantation"),
    `matched=[${r.searchTerms.matchedInDescription}] searched=[${r.searchTerms.searchedInCcl}]`
  );
}

// 7c. battery false friends are called out rather than presented as candidates
{
  const r = run("NMC cathode active material with lithium and a separator film", {
    itemType: "material",
    industry: "battery"
  });
  const ff = r.searchTerms.conceptMapping.filter((m) => m.falseFriendWarning);
  t("CCL21", ff.length >= 2, `false friends flagged: ${ff.map((m) => m.matchedInDescription.join("/")).join("; ")}`);
  t(
    "CCL22",
    r.notes.some((n) => /cathodic arc deposition|metal crude forms/i.test(n)),
    "note explains the CCL's actual use of 'cathode'"
  );
  t(
    "CCL23",
    r.notes.some((n) => /lithium-6/i.test(n)),
    "note explains the CCL's actual use of 'lithium'"
  );
}

// 7d. a term with no CCL wording is reported as such
{
  const r = run("manganese-rich cathode precursor", { itemType: "material", industry: "battery" });
  t(
    "CCL24",
    r.notes.some((n) => /does not appear anywhere in the Commerce Control List/i.test(n)),
    "manganese reported as absent from the CCL"
  );
}

// 8. No vocabulary hit must not be reported as EAR99
{
  const r = run("Plain carbon steel bolts", { industry: "other" });
  t(
    "CCL13",
    !JSON.stringify(r).includes("EAR99 (tentative)"),
    "must not assert a tentative EAR99 classification"
  );
  t("CCL14", r.toolContract.includes("does not establish EAR99"), "contract states non-match is not EAR99");
}

// 9. Output must carry real regulation text and licence flags
{
  const r = run("plasma dry etching equipment with pulsed RF and electrostatic chuck");
  const b001 = r.cclTextMatches.find((e) => e.eccn === "3B001");
  t("CCL15", Boolean(b001?.reasonForControl), `reason: ${b001?.reasonForControl}`);
  t("CCL16", /\$500/.test(b001?.licenceExceptionFlags?.LVS ?? ""), `LVS: ${b001?.licenceExceptionFlags?.LVS}`);
  t(
    "CCL17",
    /c\.1\.a/.test(b001?.staSpecialConditions ?? ""),
    `STA: ${(b001?.staSpecialConditions ?? "").slice(0, 90)}`
  );
  t("CCL18", paragraphs(r).some((x) => x.startsWith("3B001.c")), `paragraphs: ${paragraphs(r).slice(0, 4).join(", ")}`);
}

// 10. Provenance present
{
  const r = run("EUV pellicle");
  t("CCL19", Boolean(r.provenance?.ccl?.ecfrIssueDate), `issue date: ${r.provenance?.ccl?.ecfrIssueDate}`);
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exit(fails ? 1 : 0);
