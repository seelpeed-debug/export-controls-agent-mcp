// Country-group resolution against 15 C.F.R. Part 740, Supplement No. 1.
//
// Design rule: an unrecognised destination NEVER resolves to "no groups". A
// silent empty-group result would read as "no restrictions", which is the exact
// failure mode this module exists to prevent. Unresolved input is reported as
// unresolved so callers can refuse to conclude.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DATA = require("../data/country-groups.json");

export const COUNTRY_GROUP_PROVENANCE = Object.freeze({
  citation: DATA.citation,
  ecfrIssueDate: DATA.ecfrIssueDate,
  retrievedAt: DATA.retrievedAt,
  sourceUrl: DATA.source?.url ?? null
});

export const COUNTRY_GROUP_NOTES = Object.freeze({ ...DATA.notes });

const GROUPS = DATA.groups;
const ALIASES = DATA.aliases ?? {};

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics so "Türkiye" ~ "turkiye"
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build a lookup from every canonical row label plus every alias.
const LOOKUP = new Map();
const CANONICAL = new Set();
for (const list of Object.values(GROUPS)) {
  for (const c of list) CANONICAL.add(c);
}
// Macau and Hong Kong appear in Group D / B respectively; make sure both are
// addressable even if a future dataset drops one of them from every group.
CANONICAL.add("Macau");
CANONICAL.add("Hong Kong");
for (const c of CANONICAL) LOOKUP.set(norm(c), c);
for (const [alias, canonical] of Object.entries(ALIASES)) {
  LOOKUP.set(norm(alias), canonical);
}

/**
 * Resolve a free-text destination to its Country Group memberships.
 * @returns {{
 *   input: string, resolved: boolean, canonical: string|null,
 *   groups: string[], isMacau: boolean, matchType: string
 * }}
 */
export function resolveCountry(input) {
  const raw = String(input ?? "").trim();
  const key = norm(raw);
  if (!key) {
    return { input: raw, resolved: false, canonical: null, groups: [], isMacau: false, matchType: "empty" };
  }

  let canonical = LOOKUP.get(key) ?? null;
  let matchType = canonical ? "exact" : null;

  if (!canonical) {
    // Accept "Korea, South (ROK)" or "China (PRC), Shanghai" style input by
    // testing progressively shorter prefixes, then a contains-match. Anything
    // matching more than one canonical country is treated as ambiguous rather
    // than guessed.
    const hits = [...LOOKUP.entries()].filter(([k]) => k.length > 3 && key.includes(k));
    const unique = new Set(hits.map(([, v]) => v));
    if (unique.size === 1) {
      canonical = [...unique][0];
      matchType = "substring";
    } else if (unique.size > 1) {
      return {
        input: raw,
        resolved: false,
        canonical: null,
        groups: [],
        isMacau: false,
        matchType: "ambiguous",
        candidates: [...unique].sort()
      };
    }
  }

  if (!canonical) {
    return { input: raw, resolved: false, canonical: null, groups: [], isMacau: false, matchType: "unknown" };
  }

  const groups = Object.entries(GROUPS)
    .filter(([, list]) => list.includes(canonical))
    .map(([label]) => label)
    .sort();

  return {
    input: raw,
    resolved: true,
    canonical,
    groups,
    isMacau: canonical === "Macau",
    matchType
  };
}

/** True when the destination is Macau or in Country Group D:5. */
export function isMacauOrD5(resolved) {
  return Boolean(resolved.isMacau || resolved.groups.includes("D:5"));
}

/** True when in A:5 or A:6 (the "close ally" carve-out used across Part 740/744). */
export function isA5orA6(resolved) {
  return resolved.groups.includes("A:5") || resolved.groups.includes("A:6");
}

/**
 * The destination scope used by 740.2(a)(9)(ii) and several 744 rules:
 * D:1, D:4 or D:5, excluding any destination also in A:5 or A:6.
 */
export function isD1D4D5ExclAllies(resolved) {
  const inD = ["D:1", "D:4", "D:5"].some((g) => resolved.groups.includes(g));
  return inD && !isA5orA6(resolved);
}

export function listGroup(label) {
  return [...(GROUPS[label] ?? [])];
}
