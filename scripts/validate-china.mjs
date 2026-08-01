#!/usr/bin/env node
// Drift check for the PRC export-control transcription.
//
// The eCFR validators diff a snapshot against a versioned source. There is no
// such source here: MOFCOM publishes numbered announcements as individual pages
// with no index, no issue date and no diff mechanism. So this validator does the
// three things that ARE mechanisable.
//
// 1. It converts the decay into a failure. The central fact in this dataset is a
//    suspension with a fixed expiry of 2026-11-10. Once that date passes, every
//    "not currently required" answer this server gives about Announcements 55 to
//    62 is wrong until a human re-reads MOFCOM. That is a build failure, not a
//    warning.
//
// 2. It checks internal consistency, because a hand-transcribed dataset with
//    cross-references rots by dangling pointer.
//
// 3. It enforces the honesty invariants, so a later edit cannot quietly turn an
//    incomplete designation list into a screening claim, or add an unverified
//    Export Control Law article number.
//
// Usage:  node scripts/validate-china.mjs [--offline]

import {
  CHINA_PROVENANCE,
  INSTRUMENTS,
  ANNOUNCEMENTS,
  ANNOUNCEMENT_BY_ID,
  SUSPENSION,
  EXTRATERRITORIAL_ROUTES,
  NO61_END_USER_RULE,
  CONTROLLED_RARE_EARTHS_IN_FORCE,
  ENTITY_MECHANISMS,
  KNOWN_DESIGNATIONS,
  NOT_MODELLED
} from "../src/data/china-export-control.js";
import { assessChinaExportControls, measureStatusOn } from "../src/rules/china.js";
import { CHINA_STALE_AFTER_DAYS } from "../src/lib/provenance.js";

const offline = process.argv.includes("--offline");
let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, hint) => {
  fails++;
  console.log(`  FAIL  ${m}`);
  if (hint) console.log(`        -> ${hint}`);
};
const warn = (m, hint) => {
  warns++;
  console.log(`  warn  ${m}`);
  if (hint) console.log(`        -> ${hint}`);
};

const today = new Date().toISOString().slice(0, 10);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

const REREAD =
  "Re-read the numbered announcements on https://www.mofcom.gov.cn/ and update src/data/china-export-control.js, including CHINA_PROVENANCE.asOfDate.";

// -------------------------------------------------------------------------
console.log("1. the suspension has not outrun the transcription");
// -------------------------------------------------------------------------
{
  const toExpiry = days(today, SUSPENSION.until);
  if (toExpiry <= 0) {
    bad(
      `the suspension in this dataset expired on ${SUSPENSION.until} and today is ${today}. Every answer this server gives about Announcements ${SUSPENSION.suspends.join(", ")} is now unreliable: they either revived or were extended, and this transcription cannot tell which.`,
      REREAD
    );
  } else if (toExpiry <= 30) {
    warn(
      `the suspension expires in ${toExpiry} day(s), on ${SUSPENSION.until}. Plan the re-read now; the answers flip on that date unless MOFCOM extends it.`,
      REREAD
    );
  } else {
    ok(`suspension runs to ${SUSPENSION.until}, ${toExpiry} days away`);
  }

  const age = days(CHINA_PROVENANCE.asOfDate, today);
  if (age > CHINA_STALE_AFTER_DAYS) {
    warn(
      `transcribed ${age} days ago on ${CHINA_PROVENANCE.asOfDate}, past the ${CHINA_STALE_AFTER_DAYS}-day threshold for this regime`,
      REREAD
    );
  } else {
    ok(`transcription is ${age} day(s) old, threshold ${CHINA_STALE_AFTER_DAYS}`);
  }
}

// -------------------------------------------------------------------------
console.log("2. internal consistency");
// -------------------------------------------------------------------------
{
  const idsSeen = new Set();
  for (const a of ANNOUNCEMENTS) {
    if (idsSeen.has(a.id)) bad(`duplicate announcement id "${a.id}"`);
    idsSeen.add(a.id);
    if (!a.number) bad(`announcement "${a.id}" has no number`);
    if (!a.date) bad(`announcement "${a.id}" has no date`);
    if (a.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(a.effectiveFrom))
      bad(`announcement "${a.id}" has an invalid effectiveFrom "${a.effectiveFrom}"`);
    if (a.source && !/^https:\/\//.test(a.source))
      bad(`announcement "${a.id}" does not carry an HTTPS source URL`);
    if (a.suspendedBy && !ANNOUNCEMENT_BY_ID[a.suspendedBy])
      bad(`"${a.id}" is suspendedBy "${a.suspendedBy}", which is not an announcement in this dataset`);
  }
  ok(`${ANNOUNCEMENTS.length} announcements, ids unique`);

  for (const id of SUSPENSION.suspends) {
    if (!ANNOUNCEMENT_BY_ID[id]) bad(`SUSPENSION.suspends names "${id}", which is not in the register`);
    else if (ANNOUNCEMENT_BY_ID[id].status !== "suspended")
      bad(`"${id}" is in SUSPENSION.suspends but its own status is "${ANNOUNCEMENT_BY_ID[id].status}"`);
  }
  for (const id of SUSPENSION.doesNotSuspend) {
    if (!ANNOUNCEMENT_BY_ID[id]) bad(`SUSPENSION.doesNotSuspend names "${id}", which is not in the register`);
    else if (ANNOUNCEMENT_BY_ID[id].status === "suspended")
      bad(`"${id}" is listed as not suspended but its own status says suspended`);
  }
  ok(`suspension covers ${SUSPENSION.suspends.length} announcements and expressly spares ${SUSPENSION.doesNotSuspend.length}`);

  // Every announcement marked suspended must actually be in the suspension list,
  // or it will be reported as in force by measureStatusOn.
  for (const a of ANNOUNCEMENTS) {
    if (a.status === "suspended" && !SUSPENSION.suspends.includes(a.id))
      bad(
        `"${a.id}" says status "suspended" but is not in SUSPENSION.suspends, so it would be reported as operative`
      );
  }
  ok("no announcement claims suspension without being in the suspension window");

  const mechIds = new Set(ENTITY_MECHANISMS.map((m) => m.id));
  for (const d of KNOWN_DESIGNATIONS.entries) {
    if (!mechIds.has(d.list)) bad(`designation "${d.name}" names list "${d.list}", which is not a mechanism`);
    if (d.announcement && !ANNOUNCEMENT_BY_ID[d.announcement])
      bad(`designation "${d.name}" cites announcement "${d.announcement}", which is not in the register`);
  }
  ok(`${KNOWN_DESIGNATIONS.entries.length} recorded designations resolve to a mechanism`);

  if (CONTROLLED_RARE_EARTHS_IN_FORCE.elements.length !== CONTROLLED_RARE_EARTHS_IN_FORCE.elementsZh.length)
    bad("the English and Chinese rare-earth element lists are different lengths");
  else ok(`${CONTROLLED_RARE_EARTHS_IN_FORCE.elements.length} controlled elements, English and Chinese lists aligned`);

  if (!ANNOUNCEMENT_BY_ID[CONTROLLED_RARE_EARTHS_IN_FORCE.source])
    bad(`the controlled-element list cites source "${CONTROLLED_RARE_EARTHS_IN_FORCE.source}", which is not in the register`);
  else ok(`controlled elements sourced to ${ANNOUNCEMENT_BY_ID[CONTROLLED_RARE_EARTHS_IN_FORCE.source].number}`);

  const no61 = ANNOUNCEMENT_BY_ID["2025-61"];
  const expectedLimbDates = {
    "content-floor": "2025-12-01",
    "technology-route": "2025-12-01",
    "chinese-origin": "2025-10-09",
    "end-user": "2025-10-09"
  };
  for (const [limb, expected] of Object.entries(expectedLimbDates)) {
    if (no61.limbEffectiveFrom?.[limb] !== expected)
      bad(`No. 61 ${limb} starts ${no61.limbEffectiveFrom?.[limb]}, expected ${expected}`);
  }
  ok("No. 61 limb commencement dates are recorded separately");
}

// -------------------------------------------------------------------------
console.log("3. honesty invariants");
// -------------------------------------------------------------------------
{
  if (KNOWN_DESIGNATIONS.complete !== false)
    bad("KNOWN_DESIGNATIONS.complete must stay false; this is not a screening dataset");
  else ok("the designation list still declares itself incomplete");

  if (!/has NOT been cleared/i.test(KNOWN_DESIGNATIONS.completenessWarning))
    bad("the incompleteness warning must state that a non-match is not a clearance");
  else ok("a non-match is documented as not a clearance");

  const r = assessChinaExportControls({ counterpartyNames: ["Definitely Not Listed Ltd"] });
  if (r.entityScreening.status !== "not_screenable")
    bad(`screening status for an unknown name is "${r.entityScreening.status}", expected "not_screenable"`);
  else ok("an unknown counterparty comes back not_screenable");
  if (!r.unansweredQuestions.some((q) => /Definitely Not Listed Ltd/.test(q.question)))
    bad("an unscreened counterparty must be named in unansweredQuestions");
  else ok("unscreened counterparties are named rather than silently dropped");

  // A match on one name must not suppress the question for the others.
  const mixed = assessChinaExportControls({ counterpartyNames: ["Rheinmetall AG", "Other Co"] });
  if (!mixed.unansweredQuestions.some((q) => /Other Co/.test(q.question)))
    bad("a matched name is suppressing the unscreened question for the others");
  else ok("a match on one name does not clear the others");

  const empty = assessChinaExportControls({});
  if (!/not a clearance|Do not read this as an absence/i.test(empty.summary))
    bad("an empty result must disclaim clearance");
  else ok("an empty result disclaims clearance");
  if (!empty.caveats.some((c) => /not bundled/i.test(c.point ?? "")))
    bad("every answer must disclose that no item was classified");
  else ok("every answer discloses that no item was classified");

  for (const want of [/Export Control List for Dual-Use Items/i, /管控名单/, /[Cc]atch-all/]) {
    if (!NOT_MODELLED.some((n) => want.test(n.item)))
      bad(`NOT_MODELLED no longer discloses ${want}`);
  }
  ok("the control list, the designation lists and catch-all controls are disclosed as absent");

  // Article numbers were deliberately not asserted for the ECL and the 2024
  // Regulations. A later edit that adds one without verification is a regression.
  const blob = JSON.stringify([INSTRUMENTS, ANNOUNCEMENTS, NOT_MODELLED, EXTRATERRITORIAL_ROUTES]);
  const suspect = blob.match(/(?:Export Control Law|Regulations on Export Control of Dual-Use Items)[^"]{0,40}Article\s*\d+/gi);
  if (suspect) bad(`unverified article citation(s) added: ${suspect.join("; ")}`, "cite the instrument and the announcement, not an article number, unless verified");
  else ok("no unverified Export Control Law or 2024 Regulations article numbers asserted");

  // The 0.1 percent test must stay marked as a floor. Flipping it to a ceiling
  // would silently invert the answer for every low-content item.
  const contentRoute = EXTRATERRITORIAL_ROUTES.find((x) => x.id === "content-floor");
  if (contentRoute?.thresholdDirection !== "floor")
    bad("the No. 61 content test must stay marked as a floor, not a ceiling");
  else if (contentRoute.thresholdPercent !== 0.1) bad(`the content floor reads ${contentRoute.thresholdPercent}, expected 0.1`);
  else ok("the No. 61 content test is a 0.1 percent floor");
  if (!/ceiling/i.test(contentRoute?.earContrast ?? ""))
    warn("the EAR contrast no longer explains the ceiling-versus-floor inversion");
  else ok("the EAR contrast still explains the inversion");

  if (!/50 percent/i.test(NO61_END_USER_RULE.affiliatesRule)) bad("the No. 61 affiliates rule lost its 50 percent threshold");
  else ok("the No. 61 50 percent affiliates rule is recorded");

  const controlList = ENTITY_MECHANISMS.find((m) => m.id === "control-list");
  if (controlList?.bindsNonChineseParties !== true)
    bad("管控名单 must stay marked as binding non-Chinese parties; that is the reason it matters to a Korean exporter");
  else ok("管控名单 is recorded as binding suppliers in any country");
}

// -------------------------------------------------------------------------
console.log("4. the in-force measure still reports as in force");
// -------------------------------------------------------------------------
{
  const s18 = measureStatusOn("2025-18", today);
  if (!s18.operative)
    bad(`Announcement No. 18 of 2025 reports as not operative on ${today}; it was never suspended`);
  else ok("Announcement No. 18 of 2025 reports as operative");

  const r = assessChinaExportControls({ rareEarthElements: ["dysprosium"] });
  if (r.status !== "license_required")
    bad(`a controlled element returns "${r.status}", expected "license_required"`);
  else ok("a controlled element still produces a live licence requirement");

  const s61 = measureStatusOn("2025-61", today, "content-floor");
  if (s61.suspended !== true && days(today, SUSPENSION.until) > 0)
    bad("Announcement No. 61 should report as suspended while the window is open");
  else ok(`Announcement No. 61 reports suspended=${s61.suspended} on ${today}`);

  const originBeforePause = measureStatusOn("2025-61", "2025-10-20", "chinese-origin");
  if (!originBeforePause.operative)
    bad("No. 61 § 1(c) should have been operative from publication on 2025-10-09");
  else ok("No. 61 § 1(c) is operative before the November suspension");

  const delayedBeforeStart = measureStatusOn("2025-61", "2025-10-20", "content-floor");
  if (!delayedBeforeStart.notYetEffective)
    bad("No. 61 § 1(a) should not be operative before 2025-12-01");
  else ok("No. 61 § 1(a)/(b) delayed limbs are not operative before 2025-12-01");
}

// -------------------------------------------------------------------------
console.log("5. official source reachable");
// -------------------------------------------------------------------------
if (offline) {
  console.log("  skipped (--offline)");
} else {
  try {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 15_000);
    const res = await fetch(CHINA_PROVENANCE.officialSource, {
      signal: c.signal,
      headers: { "User-Agent": "export-controls-agent-mcp/validate-china" }
    });
    clearTimeout(timer);
    if (!res.ok) warn(`${CHINA_PROVENANCE.officialSource} returned ${res.status} ${res.statusText}`);
    else ok(`${CHINA_PROVENANCE.officialSource} reachable (${res.status})`);
  } catch (e) {
    warn(
      `could not reach ${CHINA_PROVENANCE.officialSource}: ${String(e.message ?? e)}`,
      "this is the only source for this regime; if it is unreachable the transcription cannot be refreshed"
    );
  }
}

console.log(
  "\nNOTE: this regime cannot be diffed automatically. Nothing above confirms that MOFCOM has not " +
    "issued a new announcement since " +
    CHINA_PROVENANCE.asOfDate +
    ". That check is manual."
);
console.log(
  `${fails === 0 ? "CHINA VALIDATION PASSED" : fails + " CHECK(S) FAILED"}` + (warns ? `, ${warns} warning(s)` : "")
);
process.exitCode = fails ? 1 : 0;
