import { matchTerms, splitClauses } from "../src/lib/text-match.js";

let fails = 0;
const t = (id, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

const SEMI = ["ic", "semiconductor", "wafer", "lithography", "etch", "chip", "integrated circuit"];
const RED = ["military", "nuclear", "missile", "entity list", "advanced node", "supercomputer"];

// 1. "ic" must not match inside other words.
{
  const r = matchTerms("Sale of office stationery to a Japanese trading house.", SEMI);
  t("TM1", !r.present.includes("ic"), `present = [${r.present.join(", ")}]`);
}
{
  const r = matchTerms("No nuclear application is involved.", SEMI);
  t("TM2", !r.present.includes("ic"), `present = [${r.present.join(", ")}]`);
}
// but a standalone IC must match
{
  const r = matchTerms("Supply of IC test handlers", SEMI);
  t("TM3", r.present.includes("ic"), `present = [${r.present.join(", ")}]`);
}
{
  const r = matchTerms("advanced ICs for automotive", SEMI);
  t("TM4", r.present.includes("ic"), `present = [${r.present.join(", ")}]`);
}

// 2. negation
{
  const r = matchTerms(
    "Strictly NO military end use, NO nuclear application, no missile programs. Purely commercial consumer display panel.",
    RED
  );
  t("TM5", r.present.length === 0, `present = [${r.present.join(", ")}]`);
  t("TM6", ["military", "nuclear", "missile"].every((x) => r.negated.includes(x)), `negated = [${r.negated.join(", ")}]`);
}
// 3. negation scope stops at "but"
{
  const r = matchTerms("Not for military use but for supercomputer research", RED);
  t("TM7", r.negated.includes("military") && r.present.includes("supercomputer"), `present=[${r.present}] negated=[${r.negated}]`);
}
// 4. positive assertion anywhere wins over negation elsewhere
{
  const r = matchTerms("No military use stated. Later disclosed as military end use.", RED);
  t("TM8", r.present.includes("military") && !r.negated.includes("military"), `present=[${r.present}] negated=[${r.negated}]`);
}
// 5. multiword and hyphen flexibility
{
  const r = matchTerms("targets advanced-node logic and an Entity List party", RED);
  t("TM9", r.present.includes("advanced node") && r.present.includes("entity list"), `present=[${r.present}]`);
}
// 6. Korean negation
{
  const r = matchTerms("군용 용도는 없음. 상업용 디스플레이 전용.", ["군용", "상업용"]);
  t("TM10", r.negated.includes("군용") && r.present.includes("상업용"), `present=[${r.present}] negated=[${r.negated}]`);
}
// 7. "non-military"
{
  const r = matchTerms("strictly non-military applications", RED);
  t("TM11", !r.present.includes("military"), `present=[${r.present}] negated=[${r.negated}]`);
}
// 8. clause splitting sanity
{
  const c = splitClauses("A; B, C. D but E");
  t("TM12", c.length === 5, `clauses = ${JSON.stringify(c.map((x) => x.text.trim()))}`);
}
// 9. "integrated circuit" phrase
{
  const r = matchTerms("integrated circuits for AI accelerators", SEMI);
  t("TM13", r.present.includes("integrated circuit"), `present=[${r.present}]`);
}
// 10. must not treat "etch" inside "sketch"
{
  const r = matchTerms("a sketch of the layout", SEMI);
  t("TM14", !r.present.includes("etch"), `present=[${r.present}]`);
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
process.exit(fails ? 1 : 0);
