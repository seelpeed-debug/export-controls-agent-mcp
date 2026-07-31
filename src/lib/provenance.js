// Dataset provenance and staleness reporting.
//
// Every generated dataset records the eCFR issue date it was built from. The
// EAR changes often -- Country Group A membership, Part 740 section numbering
// and the Category 3 entries all moved within the last two years -- so a tool
// answer without a data-vintage stamp cannot be audited. These helpers attach
// that stamp and flag when a snapshot has gone stale.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const COUNTRY_GROUPS = require("../data/country-groups.json");
const LICENCE_CATALOG = require("../data/license-exception-catalog.json");
const CCL = require("../data/ccl.json");
const SCREENING = require("../data/screening-list.json");
const { FDP_PROVENANCE } = require("../data/fdp-rules.js");

/** Snapshots older than this many days are reported as stale. */
export const STALE_AFTER_DAYS = 30;

/**
 * Restricted-party lists change by Federal Register notice, often weekly, so
 * the screening snapshot gets its own much shorter threshold.
 */
export const SCREENING_STALE_AFTER_DAYS = 7;

const DATASETS = [
  {
    id: "country-groups",
    citation: COUNTRY_GROUPS.citation,
    ecfrIssueDate: COUNTRY_GROUPS.ecfrIssueDate,
    retrievedAt: COUNTRY_GROUPS.retrievedAt,
    sourceUrl: COUNTRY_GROUPS.source?.url ?? null,
    rebuildCommand: "node scripts/build-country-groups.mjs"
  },
  {
    id: "license-exception-catalog",
    citation: LICENCE_CATALOG.citation,
    ecfrIssueDate: LICENCE_CATALOG.ecfrIssueDate,
    retrievedAt: LICENCE_CATALOG.retrievedAt,
    sourceUrl: LICENCE_CATALOG.source?.url ?? null,
    rebuildCommand: "node scripts/build-part740-catalog.mjs"
  },
  {
    id: "ccl",
    citation: CCL.citation,
    ecfrIssueDate: CCL.ecfrIssueDate,
    retrievedAt: CCL.retrievedAt,
    sourceUrl: CCL.source?.url ?? null,
    rebuildCommand: "node scripts/build-ccl.mjs"
  },
  {
    id: "screening-list",
    citation: SCREENING.citation,
    ecfrIssueDate: null, // not an eCFR document
    sourceGeneratedAt: SCREENING.sourceGeneratedAt,
    retrievedAt: SCREENING.retrievedAt,
    sourceUrl: SCREENING.source?.url ?? null,
    staleAfterDays: SCREENING_STALE_AFTER_DAYS,
    rebuildCommand: "node scripts/build-screening-list.mjs"
  },
  {
    // Not a generated snapshot: the § 734.9 rule scopes are transcribed by hand
    // because they are prose mixed with ECCN lists. There is nothing to rebuild,
    // so the check is a drift validation against the live section instead.
    id: "fdp-rules",
    citation: FDP_PROVENANCE.citation,
    ecfrIssueDate: FDP_PROVENANCE.ecfrIssueDate,
    retrievedAt: null,
    sourceUrl: "https://www.ecfr.gov/current/title-15/part-734/section-734.9",
    handTranscribed: true,
    note: FDP_PROVENANCE.transcribedNotParsed,
    rebuildCommand: "node scripts/validate-fdp-rules.mjs (validates; does not regenerate)"
  }
];

function daysSince(iso) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/** Provenance for the datasets a tool actually relied on. */
export function datasetProvenance(ids = DATASETS.map((d) => d.id)) {
  const chosen = DATASETS.filter((d) => ids.includes(d.id));
  const ages = chosen.map((d) => daysSince(d.retrievedAt)).filter((n) => n !== null);
  const oldest = ages.length ? Math.max(...ages) : null;
  const anyStale = chosen.some(
    (d) => (daysSince(d.retrievedAt) ?? 0) > (d.staleAfterDays ?? STALE_AFTER_DAYS)
  );
  return {
    datasets: chosen.map((d) => {
      const threshold = d.staleAfterDays ?? STALE_AFTER_DAYS;
      const age = daysSince(d.retrievedAt);
      return {
        id: d.id,
        citation: d.citation,
        ecfrIssueDate: d.ecfrIssueDate,
        ...(d.sourceGeneratedAt ? { sourceGeneratedAt: d.sourceGeneratedAt } : {}),
        ...(d.handTranscribed ? { handTranscribed: true, note: d.note } : {}),
        retrievedAt: d.retrievedAt,
        ageDays: age,
        staleAfterDays: threshold,
        stale: (age ?? 0) > threshold,
        rebuildCommand: d.rebuildCommand
      };
    }),
    oldestSnapshotAgeDays: oldest,
    stale: anyStale,
    warning: anyStale
      ? "At least one dataset snapshot has exceeded its staleness threshold. The EAR is amended frequently and restricted-party lists change weekly; rebuild and re-run before relying on this output."
      : null,
    verifyAgainst:
      "Regenerated data is only as current as the eCFR issue date shown. For a legally operative answer, read the Federal Register for amendments published after that date."
  };
}

/** Compare the snapshot issue dates against the live eCFR issue date. */
export async function checkFreshness({ timeoutMs = 15_000 } = {}) {
  const local = datasetProvenance();
  let liveIssueDate = null;
  let error = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://www.ecfr.gov/api/versioner/v1/titles", {
      signal: controller.signal,
      headers: { "User-Agent": "export-controls-agent-mcp/freshness" }
    });
    if (!res.ok) throw new Error(`eCFR returned ${res.status} ${res.statusText}`);
    const json = await res.json();
    const t15 = json.titles?.find((t) => t.number === 15);
    liveIssueDate = t15?.latest_issue_date ?? null;
    if (!liveIssueDate) throw new Error("title 15 issue date missing from eCFR response");
  } catch (e) {
    error = e.name === "AbortError" ? `eCFR request timed out after ${timeoutMs} ms` : String(e.message ?? e);
  } finally {
    clearTimeout(timer);
  }

  const behind = liveIssueDate
    ? local.datasets.filter((d) => d.ecfrIssueDate && d.ecfrIssueDate < liveIssueDate)
    : [];

  return {
    checkedAt: new Date().toISOString(),
    ecfrLatestIssueDate: liveIssueDate,
    ecfrQueryError: error,
    localDatasets: local.datasets,
    datasetsBehindLiveEcfr: behind.map((d) => ({
      id: d.id,
      snapshotIssueDate: d.ecfrIssueDate,
      liveIssueDate,
      rebuildCommand: d.rebuildCommand
    })),
    upToDate: Boolean(liveIssueDate) && behind.length === 0,
    recommendation: error
      ? "Could not reach eCFR. Treat the local snapshot dates as the only vintage information and verify manually."
      : behind.length
        ? `Rebuild these datasets: ${behind.map((d) => d.rebuildCommand).join("; ")}`
        : "Local snapshots match the latest eCFR issue date. Still check the Federal Register for amendments published after that date.",
    limitation:
      "This checks the eCFR issue date only. It does not detect substantive amendments, and it cannot tell you whether a rule published in the Federal Register has taken effect."
  };
}

export const ALL_DATASET_IDS = DATASETS.map((d) => d.id);
