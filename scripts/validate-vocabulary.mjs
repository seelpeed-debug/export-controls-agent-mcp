#!/usr/bin/env node
// Asserts that every regulation-side search term in the classify_eccn vocabulary
// actually occurs in the bundled Commerce Control List.
//
// This catches the failure that a plain keyword list hides: "implanter" is a
// perfectly reasonable word, it just never appears in the CCL, so searching for
// it returns nothing and the tool looks like it found no controls. A dead search
// key is a silent false negative, so it fails here instead.
//
// Usage:  node scripts/validate-vocabulary.mjs

import { createRequire } from "node:module";
import { CONCEPT_LIST } from "../src/rules/ccl-search.js";
import { containsTerm } from "../src/lib/text-match.js";

const require = createRequire(import.meta.url);
const CCL = require("../src/data/ccl.json");

// Flatten every searchable string in the dataset once.
const corpus = [];
for (const e of CCL.entries) {
  corpus.push(e.heading);
  if (e.relatedControls) corpus.push(e.relatedControls);
  for (const it of e.items ?? []) corpus.push(it.text);
}
console.log(`CCL corpus: ${CCL.entries.length} entries, ${corpus.length} searchable strings`);
console.log(`eCFR issue date: ${CCL.ecfrIssueDate}\n`);

const dead = [];
const alive = [];
const declaredAbsent = [];
const undocumented = [];

for (const concept of CONCEPT_LIST) {
  // A concept may legitimately have no CCL wording at all, but it must say so
  // explicitly via noCclWording so the tool can explain the gap to the user.
  if (concept.search.length === 0) {
    if (concept.noCclWording) declaredAbsent.push(concept);
    else undocumented.push(concept);
    continue;
  }
  for (const term of concept.search) {
    const hits = corpus.reduce((n, s) => n + (containsTerm(s, term) ? 1 : 0), 0);
    (hits === 0 ? dead : alive).push({
      group: concept.group,
      term,
      hits,
      match: concept.match,
      falseFriend: concept.falseFriend
    });
  }
}

alive.sort((a, b) => b.hits - a.hits);
console.log("live search terms (term -> CCL strings containing it):");
for (const a of alive) {
  console.log(`  ${String(a.hits).padStart(4)}  [${a.group}] ${a.term}${a.falseFriend ? "   (flagged false friend)" : ""}`);
}

if (declaredAbsent.length) {
  console.log("\nconcepts declared to have no CCL wording:");
  for (const c of declaredAbsent) console.log(`  [${c.group}] ${c.match.join(", ")}`);
}

if (undocumented.length) {
  console.error("\nconcept(s) with an empty search list and no noCclWording explanation:");
  for (const c of undocumented) console.error(`  [${c.group}] ${c.match.join(", ")}`);
  console.error("Add noCclWording so the tool can tell the user why nothing was searched.");
  process.exit(1);
}

if (dead.length) {
  console.error(`\n${dead.length} DEAD search term(s) -- these occur nowhere in the CCL:`);
  for (const d of dead) {
    console.error(`  [${d.group}] "${d.term}"  (reachable from: ${d.match.join(", ")})`);
  }
  console.error(
    "\nA dead search term makes the tool silently return no candidates. Replace it with the wording the regulation actually uses, or drop the concept."
  );
  process.exit(1);
}

console.log(`\nOK: all ${alive.length} search terms occur in the CCL.`);
