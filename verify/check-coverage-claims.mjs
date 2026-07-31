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
  t(
    "R6",
    /Country Chart/.test(notModelledBlock),
    "the Part 738 Country Chart gap is disclosed"
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
  t(
    "T10",
    ear.notModelledParts.some((p) => /738/.test(p)),
    "Country Chart listed as not modelled"
  );
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
