// Korean statute retrieval.
//
// WHAT CHANGED AND WHY
// The previous implementation shelled out to a PowerShell script:
//   execFile("powershell.exe", ["-File", `${APPDATA}\\npm\\korean-law.ps1`, ...])
// On the verification machine that call produced no output at all and never
// returned, so every request burned the full 12-second timeout and then served
// hand-written fallback prose. The same script run under pwsh 7 worked, which
// makes the failure an artefact of the launcher rather than of the data source.
//
// The underlying law.go.kr Open API answers the same query over HTTPS in about
// one second, so the shell hop is removed entirely. That also drops a Windows-
// only dependency, an APPDATA path assumption, and a non-ASCII-argument hazard.
//
// Fallback is now a dated snapshot of the complete statute text
// (src/data/korean-law.json) rather than a prose summary, so an offline answer
// still carries a promulgation date and per-article effective dates.

import { createRequire } from "node:module";
import { LAWS, parseArticleLabel, normalizeArticlePayload } from "./korean-law-parse.js";

const require = createRequire(import.meta.url);
const SNAPSHOT = require("../data/korean-law.json");

export { LAWS, parseArticleLabel };

export const SUPPORTED_LAW_NAMES = Object.keys(LAWS);

const API_BASE = "https://www.law.go.kr/DRF/lawService.do";

export function snapshotProvenance() {
  return {
    source: "law.go.kr Open API snapshot bundled with this server",
    retrievedAt: SNAPSHOT.retrievedAt,
    laws: Object.fromEntries(
      Object.entries(SNAPSHOT.laws).map(([name, l]) => [
        name,
        {
          mst: l.mst,
          promulgationDate: l.promulgationDate,
          competentMinistry: l.competentMinistry,
          articleCount: l.articleCount
        }
      ])
    ),
    rebuildCommand: "LAW_OC=<your-oc> node scripts/build-korean-law.mjs"
  };
}

function fromSnapshot(lawName, label) {
  const law = SNAPSHOT.laws[lawName];
  if (!law) return null;
  const article = law.articles.find((a) => a.label === label);
  if (!article) return null;
  return {
    ...article,
    lawName: law.lawName,
    promulgationDate: law.promulgationDate,
    competentMinistry: law.competentMinistry
  };
}

/** Nearby article labels, to help when a label does not exist. */
function neighbours(lawName, parsed) {
  const law = SNAPSHOT.laws[lawName];
  if (!law) return [];
  return law.articles
    .filter((a) => Math.abs(a.articleNumber - parsed.article) <= 1)
    .map((a) => a.label);
}

/**
 * law.go.kr intermittently answers 404 for a URL that succeeds moments later,
 * apparently when requests arrive in quick succession. Observed directly while
 * building the snapshot: the identical URL returned 404 once and 200 on all
 * twelve immediately following attempts. So a transient status gets one retry
 * before the snapshot fallback is used.
 */
const TRANSIENT_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 600;

async function fetchLiveOnce({ mst, jo, apiKey, timeoutMs }) {
  const url =
    `${API_BASE}?OC=${encodeURIComponent(apiKey)}&target=law&MST=${encodeURIComponent(mst)}` +
    `&type=JSON&JO=${encodeURIComponent(jo)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "export-controls-agent-mcp/korean-law" }
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `law.go.kr returned ${res.status} ${res.statusText}`,
        transient: TRANSIENT_STATUSES.has(res.status)
      };
    }
    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return {
        ok: false,
        error:
          "law.go.kr returned a non-JSON response, which usually means the OC account id was rejected: " +
          body.slice(0, 160).replace(/\s+/g, " ")
      };
    }
    if (!json?.법령) {
      return { ok: false, error: "law.go.kr response contained no 법령 element" };
    }
    return { ok: true, json };
  } catch (e) {
    if (e.name === "AbortError") {
      return { ok: false, error: `law.go.kr request timed out after ${timeoutMs} ms`, transient: false };
    }
    return { ok: false, error: String(e.message ?? e), transient: true };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLive(opts) {
  const first = await fetchLiveOnce(opts);
  if (first.ok || !first.transient) return first;
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  const second = await fetchLiveOnce(opts);
  if (second.ok) return { ...second, retried: true };
  return {
    ...second,
    retried: true,
    error: `${second.error} (retried once after: ${first.error})`
  };
}

/**
 * Retrieve a Korean statute article, live where possible and from the bundled
 * snapshot otherwise.
 *
 * @param {object} opts
 * @param {string} opts.law           One of SUPPORTED_LAW_NAMES.
 * @param {string} opts.article       e.g. 제19조의2, 제20조, 19-2
 * @param {number} [opts.timeoutMs]
 * @param {"live_then_snapshot"|"snapshot_only"} [opts.source]
 */
export async function getKoreanLawArticle({
  law,
  article,
  timeoutMs = 10_000,
  source = "live_then_snapshot"
}) {
  const meta = LAWS[law];
  if (!meta) {
    return {
      ok: false,
      error: "unsupported_law",
      message: `"${law}" is not supported. Supported statutes: ${SUPPORTED_LAW_NAMES.join(", ")}.`,
      supportedLaws: SUPPORTED_LAW_NAMES
    };
  }

  const parsed = parseArticleLabel(article);
  if (!parsed.valid) {
    return {
      ok: false,
      error: "unparseable_article",
      message: parsed.reason,
      hint: "Sub-articles use 의: 제19조의2. Both 제19조의2 and 19-2 are accepted."
    };
  }

  const apiKey = process.env.LAW_OC;
  const attempts = [];
  let live = null;

  if (source === "live_then_snapshot") {
    if (!apiKey) {
      attempts.push({
        stage: "live",
        outcome: "skipped",
        detail:
          "LAW_OC is not set, so no live request was made. Register a law.go.kr Open API account id and set LAW_OC to enable live retrieval."
      });
    } else {
      const r = await fetchLive({ mst: meta.mst, jo: parsed.jo, apiKey, timeoutMs });
      if (r.ok) {
        const normalized = normalizeArticlePayload(r.json, parsed.label);
        if (normalized) {
          live = normalized;
          attempts.push({ stage: "live", outcome: "success", retried: r.retried ?? false });
        } else {
          attempts.push({
            stage: "live",
            outcome: "article_not_found",
            detail: `law.go.kr returned the statute but no article ${parsed.label}.`
          });
        }
      } else {
        attempts.push({
          stage: "live",
          outcome: "failed",
          detail: r.error,
          retried: r.retried ?? false,
          fallback: "Serving the bundled snapshot instead."
        });
      }
    }
  } else {
    attempts.push({ stage: "live", outcome: "skipped", detail: "source was set to snapshot_only" });
  }

  const snapshot = fromSnapshot(law, parsed.label);

  if (!live && !snapshot) {
    const near = neighbours(law, parsed);
    return {
      ok: false,
      error: "article_not_found",
      message: `${law} ${parsed.label} was not found live or in the bundled snapshot.`,
      law,
      requestedArticle: parsed.label,
      jo: parsed.jo,
      attempts,
      nearbyArticles: near,
      snapshotProvenance: snapshotProvenance()
    };
  }

  const chosen = live ?? snapshot;
  const usedSource = live ? "live" : "snapshot";

  // When both are available, surface any divergence rather than hiding it.
  let divergence = null;
  if (live && snapshot) {
    const differs = [];
    if (live.title !== snapshot.title) differs.push(`title: live "${live.title}" vs snapshot "${snapshot.title}"`);
    if (live.effectiveDate !== snapshot.effectiveDate) {
      differs.push(`effectiveDate: live ${live.effectiveDate} vs snapshot ${snapshot.effectiveDate}`);
    }
    if (live.text !== snapshot.text) differs.push("article text differs");
    if (differs.length) {
      divergence = {
        differences: differs,
        action: "The bundled snapshot is out of date. Rebuild it with: LAW_OC=<your-oc> node scripts/build-korean-law.mjs"
      };
    }
  }

  return {
    ok: true,
    law,
    englishName: meta.englishName,
    relevance: meta.relevance,
    requestedArticle: parsed.label,
    jo: parsed.jo,
    retrievedFrom: usedSource,
    article: {
      label: chosen.label,
      title: chosen.title,
      effectiveDate: chosen.effectiveDate,
      amendmentNote: chosen.amendmentNote,
      divisionHeading: chosen.divisionHeading ?? null,
      paragraphCount: chosen.paragraphCount,
      text: chosen.text
    },
    lawMetadata: {
      lawName: chosen.lawName,
      promulgationDate: chosen.promulgationDate,
      competentMinistry: chosen.competentMinistry,
      mst: meta.mst
    },
    attempts,
    snapshotDivergence: divergence,
    snapshotProvenance: usedSource === "snapshot" ? snapshotProvenance() : undefined,
    caution:
      usedSource === "live"
        ? "Retrieved live from law.go.kr. Confirm the 시행일자 shown covers the date relevant to your transaction; an article in force today may not have been in force when the conduct occurred."
        : "Served from the bundled snapshot because live retrieval was skipped or failed. Check the snapshot's retrievedAt date and verify against the current statute before relying on it."
  };
}
