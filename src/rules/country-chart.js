// Commerce Country Chart evaluation -- 15 C.F.R. Part 738.
//
// This answers the question the other tools in this server could not: given an
// ECCN and a destination, does the CCL itself require a licence?
//
// THREE THINGS MAKE THIS HARDER THAN A TABLE LOOKUP
//
// 1. Only 1260 of the 1545 License Requirements rows in the CCL name a chart
//    column. The rest state their scope in prose -- "To or within any
//    destination worldwide", "To or within Macau or a destination specified in
//    Country Group D:5", "China, Russia, or Venezuela". A column-only
//    implementation silently drops those rows, which is precisely how 3A090 and
//    3B001.c would come back clean. Both paths are evaluated here.
//
// 2. Rows are scoped to subparagraphs. "NS applies to 3B001.a.1 to a.3, b, e"
//    and "NS applies to 3B001.a.4, c, d" sit in the same entry and resolve
//    differently. A bare "3B001" cannot choose between them, so the answer is
//    reported per row and the aggregate says the subparagraph is needed. Where a
//    row's scope is a physical description ("shotguns with a barrel length less
//    than 18 inches") no ECCN string can decide it, and the row is reported as
//    conditional rather than dropped.
//
// 3. An absent X is not permission. 738.4(a)(2)(ii)(B) makes it conditional on
//    General Prohibitions Four through Ten not applying and on the entry not
//    referring elsewhere. Cuba, Iran, North Korea and Syria have no marks at all
//    because their rows point to Part 746; reading those as unrestricted is the
//    worst available error in this dataset. And Australia's row is empty apart
//    from CB 1 while footnote 10 still requires a licence for a list of firearms
//    entries.

import { createRequire } from "node:module";
import { resolveCountry, isMacauOrD5, isD1D4D5ExclAllies } from "../lib/countries.js";
import { parseEccn, normalizeEccn, isEar99, expandParagraphList, matchAnySpec } from "../lib/eccn.js";

const require = createRequire(import.meta.url);
const CHART = require("../data/country-chart.json");
const CCL = require("../data/ccl.json");

export const COUNTRY_CHART_PROVENANCE = Object.freeze({
  citation: CHART.citation,
  ecfrIssueDate: CHART.ecfrIssueDate,
  retrievedAt: CHART.retrievedAt,
  sourceUrl: CHART.source?.url ?? null
});

const CCL_BY_ECCN = new Map(CCL.entries.map((e) => [e.eccn.toUpperCase(), e]));

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Destination resolution
// ---------------------------------------------------------------------------

const CHART_LOOKUP = new Map();
for (const name of Object.keys(CHART.countries)) CHART_LOOKUP.set(norm(name), name);
for (const name of Object.keys(CHART.embargoed)) CHART_LOOKUP.set(norm(name), name);
for (const [alias, target] of Object.entries(CHART.aliases ?? {})) {
  CHART_LOOKUP.set(norm(alias), target);
}

/**
 * Resolve a destination to a chart row, applying 738.3(b) inheritance for
 * destinations that have no row of their own.
 *
 * An unresolved destination is reported unresolved. It is never treated as a row
 * with no marks, because that would read as "nothing is required".
 */
export function resolveChartDestination(input) {
  const raw = String(input ?? "").trim();
  const groups = resolveCountry(raw);
  const key = norm(raw);

  if (!key) {
    return { input: raw, resolved: false, reason: "empty", countryGroups: groups };
  }

  const inherit = CHART.territoryInheritance?.[key];
  if (inherit) {
    const row = inherit.row;
    return {
      input: raw,
      resolved: true,
      chartRow: row,
      matchType: "inherited",
      inheritedFrom: raw,
      inheritanceBasis: inherit.basis,
      embargoed: Boolean(CHART.embargoed[row]),
      row: CHART.countries[row] ?? null,
      embargoPointer: CHART.embargoed[row]?.pointer ?? null,
      footnotes: CHART.countries[row]?.footnotes ?? CHART.embargoed[row]?.footnotes ?? [],
      countryGroups: groups
    };
  }

  let row = CHART_LOOKUP.get(key) ?? null;
  let matchType = row ? "exact" : null;

  if (!row) {
    // Accept "Shanghai, China" style input, but refuse to guess when the text
    // matches more than one row.
    const hits = [...CHART_LOOKUP.entries()].filter(([k]) => k.length > 3 && key.includes(k));
    const unique = new Set(hits.map(([, v]) => v));
    if (unique.size === 1) {
      row = [...unique][0];
      matchType = "substring";
    } else if (unique.size > 1) {
      return {
        input: raw,
        resolved: false,
        reason: "ambiguous",
        candidates: [...unique].sort(),
        countryGroups: groups
      };
    }
  }

  if (!row) {
    return {
      input: raw,
      resolved: false,
      reason: "no_chart_row",
      guidance:
        "This destination is not a row in Supplement No. 1 to Part 738 and is not one of the inheritance cases the EAR names. Under 738.3(b) a territory, possession, dependency or department takes the licensing treatment of the country it belongs to; identify that country and re-run. Do not read the absence of a row as the absence of a licence requirement.",
      citation: "15 C.F.R. 738.3(b)",
      countryGroups: groups
    };
  }

  return {
    input: raw,
    resolved: true,
    chartRow: row,
    matchType,
    embargoed: Boolean(CHART.embargoed[row]),
    row: CHART.countries[row] ?? null,
    embargoPointer: CHART.embargoed[row]?.pointer ?? null,
    footnotes: CHART.countries[row]?.footnotes ?? CHART.embargoed[row]?.footnotes ?? [],
    countryGroups: groups
  };
}

// ---------------------------------------------------------------------------
// Parsing the "Control(s)" cell: which reason, and what scope
// ---------------------------------------------------------------------------

const REASON_NAMES = {
  NS: "National Security",
  NP: "Nuclear Nonproliferation",
  CB: "Chemical and Biological Weapons",
  MT: "Missile Technology",
  RS: "Regional Stability",
  FC: "Firearms Convention",
  CC: "Crime Control",
  AT: "Anti-Terrorism",
  UN: "United Nations Sanctions",
  EI: "Encryption Items",
  SL: "Surreptitious Listening",
  CW: "Chemical Weapons Convention",
  SI: "Significant Items",
  SS: "Short Supply",
  XP: "Computers"
};

/** "NS applies to 3B001.a.4, c, d" -> { reason: "NS", scopeText: "3B001.a.4, c, d" } */
function parseControlCell(controlText) {
  const text = String(controlText ?? "").trim();
  const m = /^([A-Z]{2,3})\s+(?:applies|apply)\s*(?:to\s+)?([\s\S]*)$/i.exec(text);
  if (!m) return { reason: null, scopeText: text, raw: text };
  return { reason: m[1].toUpperCase(), scopeText: m[2].trim(), raw: text };
}

/**
 * Decide whether a row's scope covers the item.
 * @returns {{applies: "yes"|"no"|"unknown", basis: string, specs?: string[], excluded?: string[]}}
 */
function evaluateScope(scopeText, baseEccn, candidateEccn) {
  const text = String(scopeText ?? "").trim().replace(/\.$/, "");
  const lower = text.toLowerCase();

  // "entire entry" / "the entire entry", optionally with an exclusion.
  const entire = /^(?:the\s+)?entire\s+entry\b/i.test(lower);
  if (entire) {
    const exceptMatch = /entire\s+entry\s+(?:except|other than)\s+(?:for\s+)?([\s\S]+)$/i.exec(text);
    if (!exceptMatch) {
      return { applies: "yes", basis: "row applies to the entire entry" };
    }
    const exclusion = parseSpecList(exceptMatch[1], baseEccn);
    if (!exclusion.clean) {
      return {
        applies: "unknown",
        basis: `row applies to the entire entry except "${exceptMatch[1].trim()}", which is a description this tool cannot evaluate from an ECCN alone`,
        excluded: exclusion.specs
      };
    }
    if (!candidateEccn.path.length) {
      return {
        applies: "unknown",
        basis: `row applies to the entire entry except ${exclusion.specs.join(", ")}; no subparagraph was supplied so the exclusion cannot be tested`,
        excluded: exclusion.specs
      };
    }
    const r = matchAnySpec(candidateEccn.normalized, exclusion.specs);
    if (r.isMatch) {
      return {
        applies: "no",
        basis: `item falls within the excluded ${r.matched.join(", ")}`,
        excluded: exclusion.specs
      };
    }
    if (r.isIndeterminate) {
      return {
        applies: "unknown",
        basis: `cannot tell whether the item is within the excluded ${r.indeterminate.join(", ")}`,
        excluded: exclusion.specs
      };
    }
    return { applies: "yes", basis: `entire entry, and the item is outside the excluded ${exclusion.specs.join(", ")}` };
  }

  // A pure paragraph list.
  const parsed = parseSpecList(text, baseEccn);
  if (parsed.clean && parsed.specs.length) {
    const r = matchAnySpec(candidateEccn.normalized, parsed.specs);
    if (r.isMatch) return { applies: "yes", basis: `item is within ${r.matched.join(", ")}`, specs: parsed.specs };
    if (r.isIndeterminate) {
      return {
        applies: "unknown",
        basis: `row is scoped to ${parsed.specs.join(", ")}; the supplied ECCN is not specific enough to tell`,
        specs: parsed.specs
      };
    }
    return { applies: "no", basis: `item is outside ${parsed.specs.join(", ")}`, specs: parsed.specs };
  }

  // Anything else is a physical or functional description.
  return {
    applies: "unknown",
    basis: `row scope is stated as a description ("${text.slice(0, 160)}"), which cannot be decided from an ECCN alone`,
    specs: parsed.specs.length ? parsed.specs : undefined
  };
}

/** Wording that only introduces a paragraph list and adds no condition. */
const LIST_PREAMBLE =
  /^(?:the\s+)?(?:items?|commodities|software|technology|equipment|systems)\s+(?:controlled\s+(?:by|in|under)\s+|(?:specified\s+)?in\s+)/i;

/**
 * Try to read a scope string as a paragraph list.
 *
 * `clean` is false when the text carries wording beyond paragraph references.
 * That distinction decides whether the row can be resolved mechanically or has
 * to be handed to a human, so it is deliberately strict: any token that is not
 * a paragraph reference makes the whole scope unclean rather than being ignored.
 * Ignoring an unrecognised token would silently narrow the scope.
 */
function parseSpecList(text, baseEccn) {
  const raw = String(text ?? "")
    .trim()
    .replace(/\.$/, "")
    .replace(LIST_PREAMBLE, "");
  if (!raw) return { clean: false, specs: [], leftover: [] };

  const specs = [];
  const leftover = [];
  let last = null;

  const push = (s) => {
    specs.push(s);
    last = s;
  };

  // Ranges are written with the base entry spelled out on the left only:
  // "3B001.a.1 to a.3". Dropping the base prefix lets one set of range rules
  // handle both "3B001.a.1 to a.3" and a bare "f.2 to f.4".
  const basePrefix = new RegExp(`\\b${baseEccn}\\.`, "gi");

  for (const rawToken of raw.split(/,|\band\b|\bor\b/i)) {
    const t = rawToken.trim().replace(/\.$/, "");
    if (!t) continue;

    // A full ECCN: "3B001.c.1.a", "0A501.y".
    if (/^\d[A-Za-z]\d{3}(?:\.[A-Za-z0-9]+)*$/.test(t)) {
      push(normalizeEccn(t));
      continue;
    }

    const bare = t.replace(basePrefix, "").trim();

    // A numeric sub-range within one letter: "a.1 to a.3", "f.2 through f.4".
    const numRange = /^([a-z])\.(\d+)\s*(?:to|through|-)\s*([a-z])\.(\d+)$/i.exec(bare);
    if (numRange && numRange[1].toLowerCase() === numRange[3].toLowerCase()) {
      const from = Number(numRange[2]);
      const to = Number(numRange[4]);
      if (from <= to) {
        for (let i = from; i <= to; i++) push(`${baseEccn}.${numRange[1].toUpperCase()}.${i}`);
        continue;
      }
      leftover.push(t);
      continue;
    }

    // A letter range: "k to n", "g through j".
    if (/^[a-z]\s*(?:to|through|-)\s*[a-z]$/i.test(bare)) {
      try {
        for (const s of expandParagraphList(baseEccn, bare)) push(s);
      } catch {
        leftover.push(t);
      }
      continue;
    }

    // A bare paragraph relative to the base entry: "c", "f.1", "z.1.a".
    if (/^[a-z](?:\.[a-z0-9]+)*$/i.test(bare)) {
      push(`${baseEccn}.${bare.toUpperCase()}`);
      continue;
    }

    // A continuation of the previous reference: "1C351.d.15 and .16".
    if (/^\.[a-z0-9]+$/i.test(bare) && last) {
      const parts = last.split(".");
      parts.pop();
      push([...parts, bare.slice(1).toUpperCase()].join("."));
      continue;
    }

    leftover.push(t);
  }

  return { clean: leftover.length === 0 && specs.length > 0, specs: [...new Set(specs)], leftover };
}

// ---------------------------------------------------------------------------
// Evaluating the "Country chart" cell
// ---------------------------------------------------------------------------

/**
 * Prose scopes that can be decided deterministically. Order matters: the more
 * specific wording is tested first.
 *
 * Each returns "required" | "not_required".
 */
const PROSE_SCOPES = [
  {
    id: "worldwide",
    test: (c) => /to or within any destination worldwide/i.test(c) || /^worldwide control/i.test(c),
    evaluate: () => "required",
    describe: () => "the control reaches any destination worldwide, so the destination does not matter"
  },
  {
    id: "uae-or-d1-d4-d5-excluding-allies",
    test: (c) =>
      /united arab emirates/i.test(c) &&
      /country groups?\s+d:1/i.test(c) &&
      /excluding/i.test(c),
    evaluate: (dest) =>
      dest.countryGroups.canonical === "United Arab Emirates" ||
      isD1D4D5ExclAllies(dest.countryGroups)
        ? "required"
        : "not_required",
    describe: () =>
      "scope is the United Arab Emirates or Country Groups D:1, D:4 and D:5, excluding destinations also in A:5 or A:6"
  },
  {
    id: "macau-or-d5",
    test: (c) => /macau/i.test(c) && /country group\s+d:5/i.test(c),
    evaluate: (dest) => (isMacauOrD5(dest.countryGroups) ? "required" : "not_required"),
    describe: () =>
      "scope is Macau or Country Group D:5. Macau is named separately because it is not in D:5"
  },
  {
    id: "china-russia-venezuela",
    test: (c) => /^china,?\s+russia,?\s+or\s+venezuela/i.test(c.trim()),
    evaluate: (dest) =>
      ["China", "Russia", "Venezuela"].includes(dest.chartRow) ? "required" : "not_required",
    describe: () => "scope is China, Russia or Venezuela"
  },
  {
    id: "all-destinations-except-canada",
    test: (c) => /license is required for all destinations,?\s*except canada/i.test(c),
    evaluate: (dest) => (dest.chartRow === "Canada" ? "not_required" : "required"),
    describe: () => "a licence is required for all destinations except Canada"
  },
  {
    id: "all-destinations",
    test: (c) => /licen[cs]e is required for all destinations/i.test(c),
    evaluate: () => "required",
    describe: () => "a licence is required for all destinations, so the chart does not apply"
  },
  {
    id: "north-korea-only",
    test: (c) => /to north korea for anti-?terrorism reasons/i.test(c),
    evaluate: (dest) => (dest.chartRow === "Korea, North" ? "required" : "not_required"),
    describe: () => "scope is North Korea only, and the chart is not used for it"
  },
  {
    id: "iraq-and-pakistan",
    test: (c) => /to iraq or pakistan/i.test(c),
    evaluate: (dest) => (["Iraq", "Pakistan"].includes(dest.chartRow) ? "required" : "not_required"),
    describe: () => "scope is Iraq or Pakistan, and the chart is not used for it"
  },
  {
    id: "iraq-only",
    test: (c) => /to iraq (?:or transfer within iraq|and transfer within iraq)/i.test(c),
    evaluate: (dest) => (dest.chartRow === "Iraq" ? "required" : "not_required"),
    describe: () => "scope is Iraq only, and the chart is not used for it"
  },
  {
    id: "pakistan-only",
    test: (c) => /to pakistan or transfer within pakistan/i.test(c),
    evaluate: (dest) => (dest.chartRow === "Pakistan" ? "required" : "not_required"),
    describe: () => "scope is Pakistan only, and the chart is not used for it"
  }
];

/** Extract every "XX Column N" identifier from a cell. */
function extractColumns(cell, fallbackReason) {
  const cols = [];
  for (const m of String(cell).matchAll(/\b([A-Z]{2})\s+Column\s+(\d+)\b/gi)) {
    cols.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  if (cols.length) return cols;
  // 1C351 states "Column 1." with no reason prefix; take it from the Control(s) cell.
  const bare = /^Column\s+(\d+)\s*\.?$/i.exec(String(cell).trim());
  if (bare && fallbackReason) return [`${fallbackReason} ${bare[1]}`];
  return [];
}

const CROSS_REF = /\b(?:see|refer to)\b[^.]*§+\s*\d+\.\d+/i;

/**
 * Evaluate one License Requirements row against a resolved destination.
 */
function evaluateRow(row, dest, baseEccn, candidateEccn) {
  const control = parseControlCell(row.control);
  const cell = String(row.countryChart ?? "").trim();
  const scope = evaluateScope(control.scopeText, baseEccn, candidateEccn);

  const base = {
    control: row.control,
    reason: control.reason,
    reasonName: control.reason ? (REASON_NAMES[control.reason] ?? null) : null,
    countryChartCell: row.countryChart ?? null,
    scope: {
      text: control.scopeText,
      applies: scope.applies,
      basis: scope.basis,
      ...(scope.specs ? { specs: scope.specs } : {}),
      ...(scope.excluded ? { excludedSpecs: scope.excluded } : {})
    }
  };

  if (!cell) {
    return {
      ...base,
      path: "unparsed",
      determination: "unparsed",
      note:
        "The Country chart cell for this row is empty in the source snapshot. Read the entry text directly; this row was not evaluated."
    };
  }

  // The CCL leaves the requirement cell blank on a few rows. Where the control
  // cell states the requirement instead, the builder copies it across and flags
  // it. Where it does not -- 1D018's MT row is the case -- the regulation itself
  // names no requirement, and saying so is more useful than reporting an
  // unrecognised cell format.
  if (row.requirementCellEmptyInSource && !CROSS_REF.test(cell) && !/licen[cs]e is required/i.test(cell)) {
    return {
      ...base,
      path: "unparsed",
      determination: "unparsed",
      requirementCellEmptyInSource: true,
      note:
        "The Country Chart cell for this row is blank in the CCL itself and the control text names no requirement, so no column can be read. Read the entry, and the entries it cross-references, directly."
    };
  }

  const columns = extractColumns(cell, control.reason);

  if (columns.length) {
    const marks = dest.embargoed ? [] : (dest.row?.marks ?? []);
    const perColumn = columns.map((col) => ({
      column: col,
      columnLabel: CHART.columnLabels?.[col] ?? null,
      known: CHART.columns.includes(col),
      marked: marks.includes(col)
    }));
    const unknownColumn = perColumn.find((c) => !c.known);
    if (unknownColumn) {
      return {
        ...base,
        path: "column",
        columns: perColumn,
        determination: "unparsed",
        note: `The entry names ${unknownColumn.column}, which is not a column in the current chart snapshot. The chart or the entry has moved; read both directly.`
      };
    }

    // An embargoed destination has no marks to read. Saying "not marked" here
    // would be the single most dangerous output this module could produce.
    if (dest.embargoed) {
      return {
        ...base,
        path: "column",
        columns: perColumn,
        determination: "embargo_destination",
        note: `${dest.chartRow} carries no marks in the chart. Its row instead states: ${dest.embargoPointer}`
      };
    }

    const anyMarked = perColumn.some((c) => c.marked);
    const outcome = anyMarked ? "required" : "not_required";
    return {
      ...base,
      path: "column",
      columns: perColumn,
      determination: combine(scope.applies, outcome),
      ...(CROSS_REF.test(cell)
        ? {
            alsoSee:
              "This cell also cross-references another section of the EAR; the column result is not the whole requirement."
          }
        : {})
    };
  }

  for (const prose of PROSE_SCOPES) {
    if (!prose.test(cell)) continue;
    const outcome = prose.evaluate(dest);
    return {
      ...base,
      path: "prose",
      proseScope: prose.id,
      proseScopeDescription: prose.describe(),
      determination: combine(scope.applies, outcome)
    };
  }

  if (/^n\/?a\b/i.test(cell)) {
    return {
      ...base,
      path: "not-applicable",
      determination: "no_requirement_stated",
      note: "The entry states no Country Chart requirement for this control."
    };
  }

  if (CROSS_REF.test(cell) || /^(see|refer to)\b/i.test(cell)) {
    return {
      ...base,
      path: "cross-reference",
      determination: "requires_other_provision",
      note: `This control is not determined by the Country Chart. The entry directs you to: ${cell}`
    };
  }

  return {
    ...base,
    path: "unparsed",
    determination: "unparsed",
    note: `This tool does not recognise the form of this Country chart cell, so it was not evaluated: ${cell}`
  };
}

/** Fold the scope result and the chart result into one row determination. */
function combine(scopeApplies, outcome) {
  if (scopeApplies === "no") return "scope_not_applicable";
  if (scopeApplies === "yes") return outcome === "required" ? "license_required" : "no_chart_requirement";
  return outcome === "required" ? "license_required_if_in_scope" : "no_chart_requirement_if_in_scope";
}

// ---------------------------------------------------------------------------
// Footnotes that create requirements the grid does not show
// ---------------------------------------------------------------------------

/** ECCN references appearing in a footnote's text. */
function eccnsInText(text) {
  return [
    ...new Set(
      [...String(text).matchAll(/\b\d[A-Z]\d{3}(?:\.[a-z0-9]+(?:\.[a-z0-9]+)*)?\b/g)].map((m) =>
        normalizeEccn(m[0])
      )
    )
  ];
}

/**
 * Footnotes 7 and 10 impose licence requirements the marks do not show. Rather
 * than re-transcribe their ECCN lists (which would drift from the regulation),
 * the ECCNs are read out of the footnote text and the footnote is quoted so the
 * reader sees the conditions attached to them.
 */
function assessFootnotes(dest, candidateEccn) {
  const out = [];
  for (const n of dest.footnotes ?? []) {
    const text = CHART.footnotes?.[String(n)];
    if (!text) continue;
    const entry = { number: n, text };

    const referenced = eccnsInText(text);
    if (referenced.length) {
      const r = matchAnySpec(candidateEccn.normalized, referenced);
      // Also treat a shared base entry as a hit: footnote 10 writes "0A501
      // (except for 0A501.y)" and a bare 0A501 must not slip past.
      const sameBase = referenced.filter((s) => parseEccn(s).base === candidateEccn.base);
      if (r.isMatch || r.isIndeterminate || sameBase.length) {
        entry.mayApplyToThisEccn = true;
        entry.referencedEccns = referenced;
        entry.matched = r.matched.length ? r.matched : sameBase;
        entry.action =
          "This footnote names the entry you supplied. It can require a licence where the graded row shows no mark, and it carries conditions the chart does not. Read the footnote text.";
      } else {
        entry.mayApplyToThisEccn = false;
        entry.referencedEccns = referenced;
      }
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 738.3(a)(1): entries that bypass the chart entirely
// ---------------------------------------------------------------------------

function allDestinationsEntry(candidateEccn) {
  const spec = CHART.allDestinationsEntries;
  if (!spec) return null;
  const hit = (list) =>
    list.filter((s) => {
      const base = parseEccn(s.split(" ")[0]).base;
      return base && base === candidateEccn.base;
    });
  const noExceptions = hit(spec.noLicenceExceptions ?? []);
  const govOnly = hit(spec.govOnly?.entries ?? []);
  if (!noExceptions.length && !govOnly.length) return null;
  return {
    citation: spec.citation,
    note: spec.note,
    ...(noExceptions.length
      ? {
          matchedNoLicenceExceptionEntries: noExceptions,
          licenceExceptions: "None apply to these entries."
        }
      : {}),
    ...(govOnly.length
      ? { matchedGovOnlyEntries: govOnly, licenceExceptions: spec.govOnly.condition }
      : {}),
    licensingPolicy: spec.licensingPolicy,
    caution:
      "Matching is by base entry, and these provisions are written with nested sub-entry conditions. Confirm against 738.3(a)(1) whether your specific paragraph is covered."
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Determine whether the CCL requires a licence for an ECCN to a destination.
 *
 * @param {{eccn?: string, destination?: string}} input
 */
export function assessCountryChartRequirement({ eccn, destination } = {}) {
  const candidate = parseEccn(eccn);
  const dest = resolveChartDestination(destination);

  const result = {
    input: { eccn: eccn ?? null, destination: destination ?? null },
    citation: CHART.citation,
    procedure: CHART.procedure,
    eccn: {
      supplied: eccn ?? null,
      normalized: candidate.normalized || null,
      base: candidate.base,
      subparagraph: candidate.path.length ? candidate.path.join(".") : null,
      valid: candidate.valid
    },
    destination: dest,
    requirements: [],
    footnotes: [],
    unansweredQuestions: [],
    caveats: []
  };

  // --- input gates ---------------------------------------------------------
  const gaps = [];
  if (!eccn) gaps.push({ field: "eccn", severity: "fatal", why: "Without an ECCN there is no row to read." });
  if (!destination)
    gaps.push({
      field: "destination",
      severity: "fatal",
      why: "The chart is a grid; without a destination no cell can be read."
    });

  if (eccn && isEar99(eccn)) {
    return {
      ...result,
      status: "out_of_scope",
      summary:
        "EAR99 items are not on the Commerce Control List, so the Commerce Country Chart does not apply. That is not a conclusion that no licence is required: Part 744 end-use and end-user controls and the Part 746 embargoes reach EAR99 items, and 744.23 reaches any item.",
      inputGaps: gaps,
      dataProvenance: COUNTRY_CHART_PROVENANCE
    };
  }

  if (eccn && !candidate.valid) {
    gaps.push({
      field: "eccn",
      severity: "fatal",
      why: `"${eccn}" is not shaped like an ECCN (expected a pattern such as 3B001 or 3B001.c).`
    });
  }

  if (gaps.some((g) => g.severity === "fatal")) {
    return {
      ...result,
      status: "indeterminate_input",
      summary: "Not enough usable input to read the chart.",
      inputGaps: gaps,
      dataProvenance: COUNTRY_CHART_PROVENANCE
    };
  }

  if (!dest.resolved) {
    return {
      ...result,
      status: "indeterminate_input",
      summary: `The destination could not be resolved to a row in the Commerce Country Chart (${dest.reason}).`,
      inputGaps: [
        {
          field: "destination",
          severity: "fatal",
          why: dest.guidance ?? `Destination did not resolve (${dest.reason}).`,
          ...(dest.candidates ? { candidates: dest.candidates } : {})
        }
      ],
      dataProvenance: COUNTRY_CHART_PROVENANCE
    };
  }

  // --- 738.3(a)(1) ---------------------------------------------------------
  const bypass = allDestinationsEntry(candidate);
  if (bypass) result.allDestinationsEntry = bypass;

  // --- the entry's own rows -----------------------------------------------
  const entry = CCL_BY_ECCN.get(candidate.base);
  result.eccn.foundInCcl = Boolean(entry);
  if (entry) {
    result.eccn.heading = entry.heading ?? null;
    result.eccn.reasonForControl = entry.reasonForControl ?? null;
  }

  const rows = entry?.countryChart ?? [];
  result.requirements = rows.map((r) => evaluateRow(r, dest, candidate.base, candidate));
  result.footnotes = assessFootnotes(dest, candidate);

  // --- aggregate ----------------------------------------------------------
  const dets = result.requirements.map((r) => r.determination);
  const operative = result.requirements.filter((r) => r.determination === "license_required");
  const conditional = result.requirements.filter(
    (r) => r.determination === "license_required_if_in_scope"
  );
  const elsewhere = result.requirements.filter(
    (r) => r.determination === "requires_other_provision"
  );
  const unparsed = result.requirements.filter((r) => r.determination === "unparsed");
  const footnoteHits = result.footnotes.filter((f) => f.mayApplyToThisEccn);

  if (dest.embargoed) {
    result.status = "embargo_destination";
    result.summary =
      `${dest.chartRow} has no graded row in the Commerce Country Chart. The chart instead states: ${dest.embargoPointer} ` +
      "The absence of marks carries no permissive meaning; a comprehensive embargo is administered under Part 746 and must be read there.";
  } else if (bypass) {
    result.status = "license_required";
    result.summary =
      `Under ${bypass.citation} this entry requires a licence for all destinations without reference to the Country Chart. ` +
      (bypass.licenceExceptions ?? "");
  } else if (!entry) {
    result.status = "indeterminate_input";
    result.summary =
      `${candidate.base} was not found in the Commerce Control List snapshot, so its Reasons for Control and chart columns could not be read. This is a gap in this tool's data, not a finding that the entry is uncontrolled.`;
  } else if (!rows.length) {
    result.status = "requires_verification";
    result.summary =
      `${candidate.base} is in the snapshot but no License Requirements rows were captured for it, so no column could be read. Some entries state their requirements in prose instead of a table (see 738.3(a)(1)); others are gaps in this tool's parsing. Read the entry directly.`;
  } else if (operative.length) {
    result.status = "license_required";
    const cols = [
      ...new Set(operative.flatMap((r) => (r.columns ?? []).filter((c) => c.marked).map((c) => c.column)))
    ];
    const proseReasons = [
      ...new Set(
        operative
          .filter((r) => r.path === "prose")
          .map((r) => `${r.reason} (${r.proseScopeDescription})`)
      )
    ];
    const basis = [
      ...(cols.length ? [`an X in ${cols.join(" and ")}`] : []),
      ...proseReasons.map((p) => `the ${p} scope stated in the entry`)
    ];
    result.summary =
      `A licence is required for ${candidate.normalized} to ${dest.chartRow}` +
      (basis.length ? ` on ${basis.join(", and on ")}` : "") +
      `. Each requirement must be overcome separately by a License Exception, or a licence must be applied for.`;
  } else if (conditional.length) {
    result.status = "requires_verification";
    result.summary =
      `Whether a licence is required for ${candidate.normalized} to ${dest.chartRow} depends on which part of ${candidate.base} the item falls under. ` +
      `${conditional.length} ${conditional.length === 1 ? "row" : "rows"} would require a licence if the item is within ` +
      `${conditional.length === 1 ? "its" : "their"} scope: ` +
      conditional.map((r) => `${r.reason} (${r.scope.text.slice(0, 60)})`).join("; ") +
      ".";
  } else if (footnoteHits.length) {
    result.status = "requires_verification";
    result.summary =
      `No graded mark applies, but footnote ${footnoteHits.map((f) => f.number).join(" and ")} to the chart names this entry and can require a licence to ${dest.chartRow} regardless.`;
  } else if (elsewhere.length || unparsed.length) {
    const n = elsewhere.length + unparsed.length;
    result.status = "requires_verification";
    result.summary =
      `No Country Chart column requires a licence for ${candidate.normalized} to ${dest.chartRow}, but ` +
      `${n} of this entry's controls ${n === 1 ? "is" : "are"} not determined by the chart and ` +
      `${n === 1 ? "was" : "were"} not resolved here.`;
  } else {
    result.status = "no_chart_requirement";
    result.summary =
      `No Country Chart column requires a licence for ${candidate.normalized} to ${dest.chartRow} on the Reasons for Control stated in the entry.`;
  }

  // --- caveats and open questions ------------------------------------------
  if (result.status === "no_chart_requirement" || result.status === "requires_verification") {
    result.caveats.push({
      citation: "15 C.F.R. 738.4(a)(2)(ii)(B)",
      text: CHART.procedure.noMarkCaveat
    });
    result.caveats.push({
      text:
        "This tool models Part 738 only. It does not evaluate the Part 744 end-use and end-user controls, the Part 746 embargoes, the restricted-party lists, or General Prohibitions Four through Ten, every one of which can require a licence where the chart does not."
    });
  }
  if (operative.length) {
    result.caveats.push({
      citation: "15 C.F.R. 738.4(a)(2)(ii)(A)",
      text:
        "Each affirmative requirement must be overcome by a License Exception on its own. An exception that covers one Reason for Control does not answer the others."
    });
  }
  if (elsewhere.length) {
    result.unansweredQuestions.push({
      question: `Do the provisions cross-referenced by this entry require a licence to ${dest.chartRow}?`,
      rows: elsewhere.map((r) => ({ control: r.control, directsTo: r.countryChartCell })),
      why: "738.4(a)(1) allows an entry to state its requirements outside the chart. Those provisions are not modelled here."
    });
  }
  if (unparsed.length) {
    result.unansweredQuestions.push({
      question: "What do the unrecognised License Requirements rows for this entry require?",
      rows: unparsed.map((r) => ({ control: r.control, cell: r.countryChartCell })),
      why: "The wording of these rows is not a form this tool recognises. They are surfaced rather than dropped."
    });
  }
  if (!candidate.path.length && rows.length > 1) {
    result.unansweredQuestions.push({
      question: `Which subparagraph of ${candidate.base} does the item fall under?`,
      why:
        "Rows in this entry are scoped to different subparagraphs and resolve differently. Supplying the full ECCN narrows the answer.",
      citation: "15 C.F.R. 738.4(b)(3)"
    });
  }

  result.determinationCounts = Object.fromEntries(
    [...new Set(dets)].map((d) => [d, dets.filter((x) => x === d).length])
  );
  result.dataProvenance = COUNTRY_CHART_PROVENANCE;
  return result;
}

/**
 * Exposed for drift validation. If BIS rewords a destination scope -- say
 * "To or within any destination worldwide" becomes something else -- the pattern
 * stops matching and the affected rows quietly degrade to "unparsed". The
 * validator asserts every pattern still has at least one hit in the CCL, so the
 * rewording surfaces as a failure instead of a silent loss of coverage.
 */
export const PROSE_SCOPE_PATTERNS = Object.freeze(
  PROSE_SCOPES.map((p) => Object.freeze({ id: p.id, test: p.test }))
);

export const COUNTRY_CHART_COLUMNS = Object.freeze([...CHART.columns]);
export const COUNTRY_CHART_STATUSES = Object.freeze([
  "license_required",
  "no_chart_requirement",
  "requires_verification",
  "embargo_destination",
  "indeterminate_input",
  "out_of_scope"
]);
