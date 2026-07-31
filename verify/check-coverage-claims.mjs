// Guards the honesty of the coverage claims.
//
// This project overclaimed once: the README and package.json listed "EU
// Regulation 2021/821" beside the EAR in the supported list, when the only EU
// support was a reminder string and a +2 risk-score flag. Claims drift back
// easily, so the things a reader could be misled by are asserted here.
//
// The rule enforced: if a regime is named as supported, either something is
// actually modelled for it, or it is explicitly marked pointer_only.

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

const readme = readFileSync(path.join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// ---- README must separate modelled from not-modelled --------------------
t("R1", /^## Coverage$/m.test(readme), "README has a Coverage section");
t("R2", /\*\*Modelled\*\*/.test(readme) && /\*\*Not modelled\*\*/.test(readme), "both halves present");

// ---- the specific overclaims that were fixed ---------------------------
{
  // EU must appear only under "not modelled", never in a bare supported list.
  const notModelledBlock = readme.slice(readme.indexOf("**Not modelled**"), readme.indexOf("## What this server"));
  t("R3", /2021\/821/.test(notModelledBlock), "EU Regulation 2021/821 is listed under Not modelled");
  t(
    "R4",
    /Annex I is not bundled/.test(notModelledBlock),
    "README says why: Annex I is not bundled"
  );
  t(
    "R5",
    /전략물자수출입고시/.test(notModelledBlock),
    "the Korean control list gap is disclosed"
  );
  // The Country Chart used to sit here as a gap. Now that it is modelled, the
  // README must say so in the Modelled half and must not still be listing it as
  // absent, while the condition that an absent mark is not clearance stays.
  const modelledBlock = readme.slice(readme.indexOf("**Modelled**"), readme.indexOf("**Not modelled**"));
  t("R6", /Part 738/.test(modelledBlock), "the Country Chart is claimed under Modelled");
  t(
    "R6b",
    !/Country Chart.*(?:remains a manual step|is not modelled)/s.test(notModelledBlock),
    "the README must not still describe the Country Chart as a manual step"
  );
  t(
    "R6c",
    /General Prohibitions Four through Ten|736/.test(notModelledBlock),
    "the README must disclose that an absent chart mark is not clearance"
  );
  // PRC: something is modelled, so it must appear in the Modelled half, and the
  // two absences must appear in the Not modelled half.
  t("R7a", /MOFCOM|PRC|China/.test(modelledBlock), "the PRC regime is claimed under Modelled");
  t(
    "R7b",
    /两用物项出口管制清单|Chinese control list|Export Control List for Dual-Use Items/.test(notModelledBlock),
    "the absence of the Chinese control list is disclosed in the README"
  );
  t(
    "R7c",
    /管控名单|Chinese designation|Unreliable Entity List/.test(notModelledBlock),
    "the absence of Chinese designation screening is disclosed in the README"
  );
}
{
  // package.json description must not put EU beside the EAR as if modelled.
  const d = pkg.description;
  t("R7", !/2021\/821/.test(d), `package.json description: ${d.slice(0, 70)}...`);
  t("R8", /de minimis|FDP/.test(d), "description names what is actually modelled");
}
{
  // Keywords may mention domains, but the headline claim list must be accurate.
  t(
    "R9",
    !/Parts 730[-–]774/.test(readme),
    'README no longer claims the whole of "Parts 730-774"'
  );
}

// ---- the running server must report the same split ---------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "server.js")],
  env: { ...process.env },
  cwd: root
});
const client = new Client({ name: "coverage-claims-check", version: "1.0.0" });
await client.connect(transport);

const res = await client.callTool({ name: "regime_overview", arguments: {} });
const payload = JSON.parse(res.content[0].text);
await client.close();

t("T1", Array.isArray(payload.regimes) && payload.regimes.length >= 4, `${payload.regimes?.length} regimes`);
t("T2", Boolean(payload.coverageLegend?.pointer_only), "legend defines pointer_only");

const byName = (frag) => payload.regimes.find((r) => r.name.includes(frag));

{
  const eu = byName("2021/821");
  t("T3", Boolean(eu), "EU regime present");
  t("T4", eu.coverageInThisServer === "pointer_only", `coverage=${eu.coverageInThisServer}`);
  t("T5", Array.isArray(eu.modelledParts) && eu.modelledParts.length === 0, `modelledParts=${eu.modelledParts?.length}`);
  t("T6", /Annex I/.test(eu.notModelledParts.join(" ")), "Annex I named as absent");
  t("T7", Boolean(eu.whatThisServerActuallyDoes), "states what it actually does");
}
{
  const ear = byName("Export Administration Regulations");
  t("T8", ear.coverageInThisServer === "partial", `coverage=${ear.coverageInThisServer}`);
  t("T9", ear.modelledParts.some((p) => /734\.9/.test(p)), "FDP listed as modelled");

  // Part 738 became modelled. The assertion here used to require it to be listed
  // as NOT modelled, and it went on passing after the change because a different
  // not-modelled line cites § 738.4(a)(2)(ii)(B) and matched a bare /738/. Test
  // the claim, not the digits.
  t("T10", ear.modelledParts.some((p) => /^Part 738\b/.test(p)), "Country Chart listed as modelled");
  t(
    "T10b",
    !ear.notModelledParts.some((p) => /Part 738 Commerce Country Chart/.test(p)),
    "the stale 'Country Chart not modelled' claim must be gone"
  );
  // Modelling the chart makes a new overclaim available: that an absent mark is
  // clearance. 738.4(a)(2)(ii)(B) says it is not, so the condition has to stay
  // visible in the coverage map.
  t(
    "T10c",
    ear.notModelledParts.some((p) => /General Prohibitions Four through Ten/.test(p)),
    "the General Prohibitions condition on a no-requirement answer must stay disclosed"
  );
  t("T10d", ear.notModelledParts.some((p) => /Part 746/.test(p)), "Part 746 still disclosed as not modelled");
  t("T10e", ear.notModelledParts.some((p) => /Part 742/.test(p)), "Part 742 still disclosed as not modelled");
}
{
  const kr = byName("대외무역법");
  t("T11", kr.coverageInThisServer === "partial", `coverage=${kr.coverageInThisServer}`);
  t(
    "T12",
    kr.notModelledParts.some((p) => /전략물자수출입고시/.test(p)),
    "Korean control list disclosed as absent"
  );
  // The stale article reference that the 2024 amendment invalidated.
  const touchpoints = kr.legalTouchpoints.join(" ");
  t("T13", /제19조의2/.test(touchpoints) && /제19조의3/.test(touchpoints), "post-2024 article structure reflected");
  t(
    "T14",
    !/Article 19 strategic items designation/.test(touchpoints),
    "the pre-2024 flat reference to Article 19 is gone"
  );
}
{
  // The PRC regime is the easiest place in this server to overclaim, because it
  // has a tool and real analysis but holds neither the control list nor any
  // designation list. Both absences have to stay visible.
  const cn = byName("People's Republic of China");
  t("CN1", Boolean(cn), "PRC regime present in regime_overview");
  t("CN2", cn.coverageInThisServer === "partial", `coverage=${cn.coverageInThisServer}`);
  t(
    "CN3",
    cn.modelledParts.some((p) => /No\. 18 of 2025/.test(p)),
    "the in-force rare-earth announcement is claimed as modelled"
  );
  t(
    "CN4",
    cn.modelledParts.some((p) => /No\. 61 of 2025/.test(p) && /0\.1 percent/.test(p)),
    "the No. 61 extraterritorial reach and its 0.1 percent floor are claimed"
  );
  t(
    "CN5",
    cn.modelledParts.some((p) => /suspend/i.test(p) && /2026-11-10/.test(p)),
    "the suspension and its expiry are claimed as modelled"
  );
  t(
    "CN6",
    cn.notModelledParts.some((p) => /两用物项出口管制清单|Export Control List for Dual-Use Items/.test(p)),
    "the absence of the Chinese control list must be disclosed"
  );
  t(
    "CN7",
    cn.notModelledParts.some((p) => /管控名单/.test(p) && /not offered/i.test(p)),
    "the absence of designation screening must be disclosed"
  );
  t(
    "CN8",
    cn.notModelledParts.some((p) => /[Aa]rticle-level citations/.test(p)),
    "the deliberate omission of unverified article numbers must be disclosed"
  );
  t("CN9", Boolean(cn.whatThisServerActuallyDoes), "must state what it actually does");
  t(
    "CN10",
    /binds non-Chinese parties|any country/i.test(cn.transactionRelevance ?? ""),
    "relevance must say the regime reaches non-Chinese parties"
  );
  t(
    "CN11",
    /[Hh]and-transcribed/.test(cn.dataVintageCaution ?? "") && /2026-11-10/.test(cn.dataVintageCaution ?? ""),
    "the vintage caution must disclose hand transcription and the expiry"
  );
}
{
  const lists = byName("restricted-party");
  t("T15", lists.coverageInThisServer === "modelled", `coverage=${lists.coverageInThisServer}`);
  t(
    "T16",
    lists.notModelledParts.some((p) => /[Oo]wnership/.test(p)),
    "ownership gap disclosed on the screening regime itself"
  );
}
{
  t(
    "T17",
    /silence carries no meaning/.test(payload.caution),
    "caution tells the reader that silence about a non-modelled regime means nothing"
  );
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exitCode = fails ? 1 : 0;
