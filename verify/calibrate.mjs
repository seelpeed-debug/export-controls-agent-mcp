import { screenParty } from "../src/lib/screening.js";

const CLEAN = [
  "Samsung Electronics Hwaseong",
  "Samsung Electronics Co., Ltd.",
  "SK hynix Inc.",
  "Tokyo Electron Limited",
  "ASML Netherlands B.V.",
  "Applied Materials Inc.",
  "LG Energy Solution",
  "POSCO Future M"
];
const LISTED = [
  "Semiconductor Manufacturing International (Beijing) Corporation",
  "Huawei Technologies Co., Ltd.",
  "Yangtze Memory Technologies Co., Ltd.",
  "SMIC"
];

const show = (label, list) => {
  console.log(`\n=== ${label} ===`);
  for (const n of list) {
    const r = screenParty(n, { minScore: 55, maxResults: 5 });
    const band = (lo, hi) => r.matches.filter((m) => m.score >= lo && m.score < hi).length;
    console.log(
      `${n.padEnd(58)} total=${String(r.matchCount).padStart(3)}  ` +
        `>=85:${band(85, 101)}  70-84:${band(70, 85)}  55-69:${band(55, 70)}`
    );
    for (const m of r.matches.slice(0, 3)) {
      console.log(`      ${String(m.score).padStart(3)} [${m.listCode}] ${m.name}`);
      if (m.matchedAlias) console.log(`           matched on alias: "${m.matchedOn}"`);
      console.log(`           ${m.basis}`);
    }
  }
};

show("expected CLEAN", CLEAN);
show("expected LISTED", LISTED);
