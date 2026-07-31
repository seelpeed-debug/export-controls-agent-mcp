// Word-boundary, negation-aware term matching.
//
// The previous implementation used String.prototype.includes, which produced
// two whole classes of false positive:
//
//   "ic"       matched off(ic)e, appl(ic)ation, publ(ic), electr(ic) ...
//   "military" matched "strictly NO military end use", scoring a clean
//              commercial transaction as high risk
//
// So matching here is (1) bounded by Unicode letter/digit edges and (2) split
// into clauses so a negation cue can suppress terms in its own clause only.
// Terms asserted to be ABSENT are reported separately from terms asserted to be
// PRESENT; callers must not score the former as if they were the latter.

// English negation is pre-posed ("no military use"), so these are matched in the
// text BEFORE the term.
const NEGATION_CUES = [
  "no", "not", "never", "without", "excluding", "excluded", "exclude", "excludes",
  "except", "absent", "free of", "devoid of", "prohibited", "forbidden", "banned",
  "n't", "cannot", "neither", "nor", "none"
];

// Korean is verb-final: the negation lands at the END of the clause, after the
// term ("군용 용도는 없음"). A forward-only scan would miss every one of these,
// so for clauses containing Hangul these cues are matched anywhere in the clause.
const KOREAN_NEGATION_CUES = [
  "없음", "없이", "없는", "없다", "없습니다", "아님", "아닌", "아니", "않음", "않는", "않을",
  "않습니다", "미포함", "불포함", "제외", "금지", "불가", "배제", "무관", "해당없음"
];

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u;

// Clause breakers. A negation cue's scope ends at the next breaker, so
// "not for military use but for commercial displays" does not negate
// "commercial", and "no nuclear or missile work" negates both.
const CLAUSE_BREAK = /(?:[.!?;:\n]|,|\bbut\b|\bhowever\b|\bwhereas\b|\bwhile\b|\balthough\b|\byet\b|그러나|하지만|다만|반면)/giu;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a Unicode-aware, boundary-anchored matcher for a term.
 * Internal whitespace, hyphens, underscores and slashes are treated as
 * interchangeable so "solid-state" matches "solid state" and "solid_state".
 */
function termRegex(term) {
  const raw = String(term).trim();
  let body = escapeRegex(raw).replace(/(?:\\?[\s\-_/])+/g, "[\\s\\-_/]+");

  // Tolerate regular English plurals so "IC" matches "ICs", "integrated circuit"
  // matches "integrated circuits" and "technology" matches "technologies".
  // Applied only to terms ending in an ASCII letter, so Hangul terms and terms
  // already ending in "s" are left alone.
  if (/[a-z]$/i.test(raw)) {
    if (/y$/i.test(raw)) body = body.replace(/y$/i, "(?:y|ies)");
    else if (!/s$/i.test(raw)) body = `${body}(?:e?s)?`;
  }

  // \p{L}\p{N} boundaries rather than \b so CJK text behaves sensibly.
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

const regexCache = new Map();
function cachedRegex(term) {
  let r = regexCache.get(term);
  if (!r) {
    r = termRegex(term);
    regexCache.set(term, r);
  }
  r.lastIndex = 0;
  return r;
}

/** Split text into clauses, preserving each clause's offset in the original. */
export function splitClauses(text) {
  const s = String(text ?? "");
  const clauses = [];
  let cursor = 0;
  CLAUSE_BREAK.lastIndex = 0;
  let m;
  while ((m = CLAUSE_BREAK.exec(s)) !== null) {
    if (m.index >= cursor) {
      clauses.push({ text: s.slice(cursor, m.index), start: cursor });
      cursor = m.index + m[0].length;
    }
    if (CLAUSE_BREAK.lastIndex === m.index) CLAUSE_BREAK.lastIndex++;
  }
  if (cursor < s.length) clauses.push({ text: s.slice(cursor), start: cursor });
  return clauses.filter((c) => c.text.trim().length > 0);
}

/** Does a negation cue scope over a match at `offset` within this clause? */
function negatedAt(clauseText, offset) {
  const prefix = clauseText.slice(0, offset);
  for (const cue of NEGATION_CUES) {
    if (cachedRegex(cue).test(prefix)) return true;
  }
  // "non-military", "non military"
  if (/(?:^|[\s(])non[\s-]?$/iu.test(prefix)) return true;

  // Verb-final languages: the negation follows the term, so scope the Korean
  // cues to the whole clause rather than to the prefix.
  if (HANGUL.test(clauseText)) {
    for (const cue of KOREAN_NEGATION_CUES) {
      if (clauseText.includes(cue)) return true;
    }
  }
  return false;
}

/**
 * Match a vocabulary against text.
 * @param {string} text
 * @param {string[]} terms
 * @returns {{present: string[], negated: string[], hits: Array<{term:string,negated:boolean,clause:string}>}}
 */
export function matchTerms(text, terms) {
  const clauses = splitClauses(text);
  const present = new Set();
  const negated = new Set();
  const hits = [];

  for (const clause of clauses) {
    for (const term of terms) {
      const r = cachedRegex(term);
      let m;
      while ((m = r.exec(clause.text)) !== null) {
        const isNeg = negatedAt(clause.text, m.index);
        hits.push({ term, negated: isNeg, clause: clause.text.trim() });
        (isNeg ? negated : present).add(term);
        if (r.lastIndex === m.index) r.lastIndex++;
      }
    }
  }

  // A term asserted present somewhere outranks the same term negated elsewhere.
  for (const t of present) negated.delete(t);

  return {
    present: [...present],
    negated: [...negated],
    hits
  };
}

/** True when `term` occurs in `text` on a word boundary, ignoring negation. */
export function containsTerm(text, term) {
  return cachedRegex(term).test(String(text ?? ""));
}

export const NEGATION_CUE_LIST = Object.freeze([...NEGATION_CUES, ...KOREAN_NEGATION_CUES]);
