// ECCN parsing and prefix matching for Commerce Control List paragraph lists.
//
// The EAR states restriction scopes as paragraph lists such as
//   "3B001.a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4, r"
// Matching these needs three properties that naive string comparison lacks:
//
//  1. Dot-boundary prefixing. "3B001.c" covers "3B001.c.1.a" but must not
//     match "3B001.ca" (hypothetical) or "3B001.f".
//  2. Range expansion. "k to n" means k, l, m, n.
//  3. Explicit indeterminacy. A bare "3B001" is NOT a statement that the item
//     falls outside "3B001.c" -- the subparagraph is simply unknown. Returning
//     "no match" there is what makes a tool answer "exception available" for a
//     controlled tool. We surface this as `indeterminate` instead.

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Normalise "  3b001.f.1 " -> "3B001.F.1"; EAR99 -> "EAR99". */
export function normalizeEccn(input) {
  return String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^ECCN/, "");
}

export function isEar99(eccn) {
  return normalizeEccn(eccn) === "EAR99";
}

/**
 * Split an ECCN into its base entry and subparagraph path.
 * "3B001.F.1" -> { base: "3B001", path: ["F","1"] }
 */
export function parseEccn(input) {
  const n = normalizeEccn(input);
  const m = n.match(/^(\d[A-Z]\d{3})(?:\.(.+))?$/);
  if (!m) return { base: null, path: [], valid: false, normalized: n };
  return {
    base: m[1],
    path: m[2] ? m[2].split(".").filter(Boolean) : [],
    valid: true,
    normalized: n
  };
}

/**
 * Expand a paragraph list written in EAR shorthand into concrete specs.
 * Input is relative to a base entry, e.g. base "3B001" with
 * "a.4, c, d, f.1, k to n" -> ["3B001.A.4","3B001.C","3B001.D","3B001.F.1",
 *                              "3B001.K","3B001.L","3B001.M","3B001.N"]
 */
export function expandParagraphList(base, list) {
  const out = [];
  for (const rawPart of String(list).split(",")) {
    const part = rawPart.trim().toLowerCase();
    if (!part) continue;
    const range = part.match(/^([a-z])\s*(?:to|through|-)\s*([a-z])$/);
    if (range) {
      const from = LETTERS.indexOf(range[1]);
      const to = LETTERS.indexOf(range[2]);
      if (from < 0 || to < 0 || to < from) throw new Error(`bad range "${part}" in ${base}`);
      for (let i = from; i <= to; i++) out.push(`${base}.${LETTERS[i].toUpperCase()}`);
      continue;
    }
    out.push(`${base}.${part.toUpperCase()}`);
  }
  return out;
}

/**
 * Does `candidate` fall within `spec`?
 * @returns {"match"|"no-match"|"indeterminate"}
 *   "indeterminate" when candidate is a less specific prefix of spec, i.e. the
 *   caller has not said enough to decide.
 */
export function matchEccnSpec(candidate, spec) {
  const c = parseEccn(candidate);
  const s = parseEccn(spec);
  if (!c.valid || !s.valid) return "no-match";
  if (c.base !== s.base) return "no-match";

  const len = Math.min(c.path.length, s.path.length);
  for (let i = 0; i < len; i++) {
    if (c.path[i] !== s.path[i]) return "no-match";
  }
  // candidate is at least as specific as spec -> spec covers it
  if (c.path.length >= s.path.length) return "match";
  // candidate is broader than spec (e.g. "3B001" vs spec "3B001.C")
  return "indeterminate";
}

/**
 * Evaluate a candidate ECCN against a list of specs.
 * @returns {{matched: string[], indeterminate: string[], isMatch: boolean, isIndeterminate: boolean}}
 */
export function matchAnySpec(candidate, specs) {
  const matched = [];
  const indeterminate = [];
  for (const spec of specs) {
    const r = matchEccnSpec(candidate, spec);
    if (r === "match") matched.push(spec);
    else if (r === "indeterminate") indeterminate.push(spec);
  }
  return {
    matched,
    indeterminate,
    isMatch: matched.length > 0,
    isIndeterminate: matched.length === 0 && indeterminate.length > 0
  };
}

/** Category digit + product group letter, e.g. "3B001.F" -> { category: "3", group: "B" }. */
export function eccnCategoryGroup(input) {
  const { base } = parseEccn(input);
  if (!base) return { category: null, group: null };
  return { category: base[0], group: base[1] };
}
