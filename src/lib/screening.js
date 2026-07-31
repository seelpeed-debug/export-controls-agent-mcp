// Restricted-party screening against the U.S. Consolidated Screening List.
//
// DESIGN CONTRACT
// The dangerous error here is the false NEGATIVE: reporting no match for a party
// that is in fact listed. Name data carries transliteration variance, corporate
// suffix noise, word-order differences and acronyms, so candidate generation is
// deliberately generous and the caller is shown ranked candidates rather than a
// yes/no verdict.
//
// A zero-match result is reported as "no match in the snapshot dated X". It is
// never reported as clearance, for three reasons that no name matcher can fix:
//
//   1. The 50 percent affiliates rule turns on OWNERSHIP, which is not in the
//      CSL at all. An unlisted subsidiary of a listed parent is caught by
//      § 744.21(a)(3) and will never appear here.
//   2. A snapshot goes stale. The Entity List changes by Federal Register
//      notice, sometimes weekly.
//   3. Screening a transaction means screening every party -- consignees,
//      freight forwarders, banks, and the addresses themselves -- not one name.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DATA = require("../data/screening-list.json");

/**
 * Screening data ages faster than the regulation text, so it gets a much
 * shorter staleness threshold than the CCL snapshots.
 */
export const SCREENING_STALE_AFTER_DAYS = 7;

// Corporate form noise. Stripped to build a secondary comparison key, never
// used to reject a candidate.
const CORPORATE_SUFFIXES = new Set([
  "co", "company", "corp", "corporation", "inc", "incorporated", "ltd", "limited",
  "llc", "lp", "llp", "plc", "gmbh", "mbh", "ag", "sa", "sas", "sarl", "srl", "spa",
  "bv", "nv", "oy", "oyj", "ab", "as", "asa", "aps", "kg", "kgaa", "pte", "pty",
  "kk", "kabushiki", "kaisha", "jsc", "ojsc", "cjsc", "pjsc", "ooo", "oao", "zao",
  "holdings", "holding", "group", "groupe", "international", "intl", "trading",
  "technologies", "technology", "tech", "industries", "industry", "enterprises",
  "enterprise", "sdn", "bhd", "and", "the", "of", "for"
]);

const TOKEN_STOPWORDS = new Set(["and", "the", "of", "for", "a", "an"]);

/** Fold case, strip diacritics and punctuation, collapse whitespace. */
export function normalizeName(input) {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(normalized) {
  return normalized.split(" ").filter((t) => t && !TOKEN_STOPWORDS.has(t));
}

/**
 * Tokens that actually distinguish one company from another.
 *
 * Generic corporate vocabulary must carry no matching weight. Without this,
 * "Completely Fictional Trading Company" matched 22 listed parties purely on
 * "trading" and "company", which is the false-positive mirror of the substring
 * bug this project already fixed elsewhere.
 */
function significantTokens(normalized) {
  return tokens(normalized).filter((x) => !CORPORATE_SUFFIXES.has(x) && x.length > 1);
}

/** Comparison key with corporate form words removed. */
function coreKey(normalized) {
  const t = significantTokens(normalized);
  return (t.length ? t : tokens(normalized)).join(" ");
}

/** First letters of significant tokens, for acronym matching (SMIC). */
function acronymOf(normalized) {
  const t = significantTokens(normalized);
  return t.length >= 2 ? t.map((x) => x[0]).join("") : "";
}

// ---------------------------------------------------------------------------
// Index, built once on first use.
// ---------------------------------------------------------------------------
let INDEX = null;

function buildIndex() {
  const names = []; // { entryIdx, name, isAlt, norm, core, acr }
  const byToken = new Map();

  const push = (entryIdx, name, isAlt) => {
    const norm = normalizeName(name);
    if (!norm) return;
    const rec = {
      entryIdx,
      name,
      isAlt,
      norm,
      core: coreKey(norm),
      sig: significantTokens(norm),
      acr: acronymOf(norm)
    };
    const i = names.length;
    names.push(rec);
    for (const t of new Set(tokens(norm))) {
      let bucket = byToken.get(t);
      if (!bucket) byToken.set(t, (bucket = []));
      bucket.push(i);
    }
  };

  DATA.entries.forEach((e, idx) => {
    push(idx, e.n, false);
    for (const a of e.a ?? []) push(idx, a, true);
  });

  return { names, byToken };
}

function index() {
  if (!INDEX) INDEX = buildIndex();
  return INDEX;
}

/** Resolve an entry's interned fields into readable form. */
function hydrate(entry) {
  const t = DATA.tables;
  const sourceName = t.sources[entry.s];
  const authority = DATA.listAuthority[sourceName] ?? null;
  return {
    name: entry.n,
    altNames: entry.a ?? [],
    sourceList: sourceName,
    listCode: authority?.code ?? null,
    authority: authority
      ? { citation: authority.citation, effect: authority.effect }
      : { citation: null, effect: "This list is not mapped to an authority in the dataset." },
    type: entry.t ?? null,
    countries: entry.c ?? [],
    entityNumber: entry.e ?? null,
    licenceRequirement: entry.lr !== undefined ? t.licenceRequirements[entry.lr] : null,
    licencePolicy: entry.lp !== undefined ? t.licencePolicies[entry.lp] : null,
    programmes: entry.pg !== undefined ? t.programmes[entry.pg] : null,
    federalRegisterNotice: entry.fr ?? null,
    sourceListUrl: entry.u !== undefined ? t.urls[entry.u] : null
  };
}

/** Token coverage of the shorter name by the longer one, 0..1. */
function coverage(aTokens, bTokens) {
  const [short, long] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (short.length === 0) return 0;
  const set = new Set(long);
  let hit = 0;
  for (const t of short) if (set.has(t)) hit++;
  return hit / short.length;
}

/**
 * A shared token is only evidence of identity if it is rare. "electronics",
 * "energy" and "materials" appear across hundreds of unrelated companies, so a
 * single shared token of that kind must not produce a match. Document frequency
 * from the token index decides this empirically rather than by guesswork.
 */
const RARE_TOKEN_MAX_DF = 4;

/** Shortest name length for which a substring relationship means anything. */
const MIN_CONTAINS_LENGTH = 6;

/**
 * Score a query against one indexed name. Returns null below the floor.
 * @returns {{score:number, basis:string}|null}
 */
function scoreAgainst(q, rec, df) {
  if (q.norm === rec.norm) return { score: 100, basis: "exact name match" };
  if (q.core && q.core === rec.core) {
    return { score: 95, basis: "exact match after removing corporate form words" };
  }

  // One name fully contained in the other, as a phrase. Requires the shorter
  // name to be long enough to be distinctive: a four-character query sitting
  // inside a longer alias is coincidence, not evidence.
  const shorterLen = Math.min(q.norm.length, rec.norm.length);
  const ratio = shorterLen / Math.max(q.norm.length, rec.norm.length);
  if (
    (rec.norm.includes(q.norm) || q.norm.includes(rec.norm)) &&
    shorterLen >= MIN_CONTAINS_LENGTH &&
    ratio >= 0.34
  ) {
    return { score: Math.round(68 + 27 * ratio), basis: "one name contains the other" };
  }

  // Coverage over DISTINCTIVE words. At least two must be shared, unless the
  // single shared word is rare enough to identify a company on its own
  // ("yangtze", "huawei") rather than describe an industry ("electronics").
  if (q.sig.length > 0 && rec.sig.length > 0) {
    const shared = q.sig.filter((x) => rec.sig.includes(x));
    const rareShared = shared.filter((x) => (df.get(x) ?? Infinity) <= RARE_TOKEN_MAX_DF);
    const enough = shared.length >= 2 || rareShared.length >= 1;
    if (enough) {
      const cov = coverage(q.sig, rec.sig);
      if (cov >= 0.6) {
        const lenPenalty =
          Math.min(q.sig.length, rec.sig.length) / Math.max(q.sig.length, rec.sig.length);
        return {
          score: Math.round(55 + 35 * cov * Math.max(lenPenalty, 0.5)),
          basis:
            `${Math.round(cov * 100)}% of the shorter name's distinctive words appear in the other ` +
            `(shared: ${shared.join(", ")}${rareShared.length ? `; rare: ${rareShared.join(", ")}` : ""})`
        };
      }
    }
  }

  // Acronym in either direction: "SMIC" vs "Semiconductor Manufacturing ...".
  if (q.norm.length >= 2 && q.norm.length <= 8 && rec.acr && rec.acr === q.norm.replace(/\s/g, "")) {
    return { score: 78, basis: "query matches the initials of the listed name" };
  }
  if (rec.norm.length >= 2 && rec.norm.length <= 8 && q.acr && q.acr === rec.norm.replace(/\s/g, "")) {
    return { score: 78, basis: "listed name matches the initials of the query" };
  }

  return null;
}

/**
 * Screen one party name against the snapshot.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.country]     ISO-2 or country name, used only to annotate.
 * @param {number} [opts.minScore]    Default 60.
 * @param {number} [opts.maxResults]  Default 25.
 * @param {string[]} [opts.listCodes] Restrict to these list codes, e.g. ["EL","MEU"].
 */
export function screenParty(name, opts = {}) {
  const { minScore = 60, maxResults = 25, country = null, listCodes = null } = opts;
  const raw = String(name ?? "").trim();
  const norm = normalizeName(raw);

  if (!norm) {
    return {
      query: raw,
      usable: false,
      reason: "empty or unusable party name",
      matches: [],
      matchCount: 0
    };
  }

  const q = {
    norm,
    core: coreKey(norm),
    tokens: tokens(norm),
    sig: significantTokens(norm),
    acr: acronymOf(norm)
  };
  const { names, byToken } = index();

  // Candidate generation: any indexed name sharing a token, plus a full scan
  // fallback for very short queries and acronyms where token overlap fails.
  const candidates = new Set();
  for (const t of new Set(q.sig.length ? q.sig : q.tokens)) {
    for (const i of byToken.get(t) ?? []) candidates.add(i);
  }
  if (q.tokens.length <= 1 || q.sig.length === 0) {
    // Short or acronym-like queries need the wider net.
    for (let i = 0; i < names.length; i++) candidates.add(i);
  }

  // Document frequency per token, used to tell a company name from an industry
  // word. byToken already holds exactly this.
  const df = new Map();
  for (const t of new Set([...q.sig, ...q.tokens])) df.set(t, (byToken.get(t) ?? []).length);

  const perEntry = new Map();
  for (const i of candidates) {
    const rec = names[i];
    const scored = scoreAgainst(q, rec, df);
    if (!scored || scored.score < minScore) continue;
    const prev = perEntry.get(rec.entryIdx);
    if (!prev || scored.score > prev.score) {
      perEntry.set(rec.entryIdx, {
        score: scored.score,
        basis: scored.basis,
        matchedOn: rec.name,
        matchedAlias: rec.isAlt
      });
    }
  }

  let matches = [...perEntry.entries()].map(([entryIdx, m]) => {
    const e = hydrate(DATA.entries[entryIdx]);
    const wanted = country ? normalizeName(country) : null;
    const countryNote =
      wanted && e.countries.length
        ? e.countries.some((c) => normalizeName(c) === wanted || wanted.startsWith(normalizeName(c)))
          ? "listed address country matches the stated destination"
          : "listed address country differs from the stated destination, which does not rule out a match"
        : null;
    return { ...m, ...e, countryNote };
  });

  if (listCodes?.length) {
    const want = new Set(listCodes.map((c) => c.toUpperCase()));
    matches = matches.filter((m) => m.listCode && want.has(m.listCode));
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const total = matches.length;

  return {
    query: raw,
    normalized: norm,
    usable: true,
    matchCount: total,
    truncated: total > maxResults,
    matches: matches.slice(0, maxResults)
  };
}

/** Snapshot age and provenance, with a screening-specific staleness rule. */
export function screeningProvenance() {
  const ageDays = DATA.retrievedAt
    ? Math.floor((Date.now() - Date.parse(DATA.retrievedAt)) / 86_400_000)
    : null;
  const stale = ageDays !== null && ageDays > SCREENING_STALE_AFTER_DAYS;
  return {
    citation: DATA.citation,
    sourceUrl: DATA.source?.url ?? null,
    requiresApiKey: false,
    sourceGeneratedAt: DATA.sourceGeneratedAt,
    retrievedAt: DATA.retrievedAt,
    ageDays,
    staleAfterDays: SCREENING_STALE_AFTER_DAYS,
    stale,
    entryCount: DATA.entryCount,
    countsBySource: DATA.countsBySource,
    rebuildCommand: "node scripts/build-screening-list.mjs",
    warning: stale
      ? `This screening snapshot is ${ageDays} days old. Restricted-party lists change by Federal Register notice, often weekly. Rebuild before relying on a no-match result.`
      : null
  };
}

/** The limits a name matcher cannot overcome. Attached to every result. */
export const SCREENING_LIMITS = Object.freeze([
  "A no-match result is NOT clearance. It means this name did not match this snapshot.",
  "Ownership is not screened. The 50 percent affiliates rule in § 744.21(a)(3) catches unlisted entities owned by listed parents, and ownership data is not in the Consolidated Screening List. Trace the ownership chain separately.",
  "One name is not a transaction. Screen the ultimate consignee, intermediate consignees, purchaser, end user, freight forwarders, banks and the listed addresses.",
  "Transliteration and aliasing defeat exact matching. Review the ranked candidates rather than only the top hit, and lower minScore if the party name is non-Latin-script in origin.",
  "Address-based listings exist. An Entity List entry can attach to an ADDRESS rather than a named party, which name screening cannot detect.",
  "This dataset is the Consolidated Screening List only. It does not include EU, UK, Japanese or Korean designations."
]);
