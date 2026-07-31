# Changelog

## 0.3.0 — 2026-07-31

Models the Commerce Country Chart, so the server now answers the question it
previously had to hand back: does the CCL require a licence for this ECCN to
this destination?

### Added

**`determine_license_requirement`** — Part 738, following the § 738.4(a)(2)
procedure. Reads every Reason for Control in the entry, resolves each to a chart
column or to the prose destination scope the entry states instead, and reports
each requirement separately because § 738.4(a)(2)(ii)(A) requires each to be
overcome on its own.

Only 1260 of the 1545 License Requirements rows in the CCL name a chart column.
The rest state their scope in prose — "To or within any destination worldwide",
"To or within Macau or a destination specified in Country Group D:5", "China,
Russia, or Venezuela". A column-only implementation returns nothing for 3A090
and for 3B001.c, which is the same class of false-permissive answer this project
spent 0.2.0 removing. Both paths are evaluated, and 13 of 1545 rows remain
unreadable, all of them a known CCL parsing defect in 2E003 plus three cells
that are empty in the source.

Four cases a table lookup gets wrong:

| Case | What a naive lookup returns | What the regulation says |
| --- | --- | --- |
| Any ECCN → **Iran, Cuba, North Korea, Syria** | no marks found, so no requirement | those rows carry no marks *at all* and point to Part 746 instead |
| **0A501 → Australia** | Australia's row is empty apart from CB 1 | footnote 10 still requires a licence for a list of firearms entries |
| **Anything → Hong Kong** | no such row | BIS removed it (85 FR 83788); the China entry governs |
| **0A983 → anywhere** | no rows in the entry | § 738.3(a)(1) requires a licence to all destinations, with no License Exception at all |

Rows are scoped to subparagraphs, so `3B001.b` resolves cleanly to NS Column 2
with the other four rows reported as out of scope, while a bare `3B001` returns
a conditional answer and asks which subparagraph applies. Where a row's scope is
a physical description — "shotguns with a barrel length less than 18 inches" —
no ECCN string can decide it, and the row is reported as conditional rather than
dropped.

An absent mark is reported as `no_chart_requirement`, never as clearance.
§ 738.4(a)(2)(ii)(B) makes it conditional on General Prohibitions Four through
Ten not applying, and that condition travels with the answer.

### Fixed — Hong Kong escaped every Country Group rule

`country-groups.json` aliased `"hong kong"` to a row label `"Hong Kong"` that no
longer exists, because BIS removed Hong Kong as a separate destination in 2020.
Group membership lookups therefore came back empty, and a Hong Kong destination
passed silently through every rule keyed on a Country Group — including the D:5
gate in the Foreign Direct Product rules and in § 740.2(a)(9)(i). It now resolves
to China, and so to D:1, D:3, D:4 and D:5.

The builder now refuses to write the dataset if any alias points at a label that
is not a row. That check is what found this.

### Fixed — the server advertised the wrong version

`version` was hardcoded as `"0.1.0"` in `src/server.js` and stayed there through
the 0.2.0 release. It is read from `package.json` now.

### Fixed — a coverage test that passed for the wrong reason

`check-coverage-claims.mjs` asserted that the Country Chart was listed as *not*
modelled, matching on a bare `/738/`. After Part 738 became modelled the
assertion kept passing, because a different not-modelled line cites
§ 738.4(a)(2)(ii)(B). It now tests the claim rather than the digits, and also
asserts that the General Prohibitions condition stays disclosed — modelling the
chart makes a new overclaim available, namely that an absent mark is clearance.

### Changed

`analyze_license_exceptions` carries a `licenceRequirement` block from the chart.
An exception exists to overcome a licence requirement, so an exception analysis
with nothing to overcome is moot, and the tool now says so instead of listing
candidates in a vacuum. Where the chart produces more than one requirement, the
block states that a single exception must defeat all of them.

`regime_overview` moves Part 738 from `notModelledParts` to `modelledParts`, and
adds Part 736 to the not-modelled list with the reason it matters: it is the
condition on every `no_chart_requirement` answer.

### Why this is still not 1.0.0

Closing the Country Chart gap removes one of the three reasons given in 0.2.0.
Two remain, and modelling Part 738 exposed a third:

- **EU Regulation 2021/821** is still pointer-only. Annex I is not bundled.
- **전략물자수출입고시**, the Korean control list, is still not bundled.
- **Part 736, Part 742 and Part 746 are not modelled**, and a Country Chart
  answer is incomplete without them. This server cannot produce a final licence
  determination on its own.

## 0.2.0 — 2026-07-31

First version fit for research use. Every tool changed shape, so this is a
breaking release relative to 0.1.0.

### Why this is not 1.0.0

Three gaps remain that a user could reasonably expect to be covered:

- The **Commerce Country Chart (Part 738)** is not modelled, so nothing here
  determines whether a licence is actually required for a given ECCN and
  destination. That is still a manual step.
- **EU Regulation 2021/821** is pointer-only. Annex I is not bundled, so the
  server cannot classify an item under EU law.
- **전략물자수출입고시**, the Korean control list, is not bundled. The statute
  text is, but the server cannot tell you whether an item is a 전략물자.

See the Coverage section of the README, or call `regime_overview`, which reports
the same split at runtime.

### Fixed — answers that were wrong in the permissive direction

These four are the reason for the release. Each one previously told the user a
transaction was more permissible than the regulation allows.

| Scenario | 0.1.0 said | 0.2.0 says |
| --- | --- | --- |
| ECCN 3B001.f → China, $2,500 | License Exception **LVS available** | Only GOV survives; § 740.2(a)(9)(i) forecloses 26 exceptions |
| ECCN 3D001 software → China | License Exception **ENC available** | Only GOV; ENC is for encryption items and is irrelevant here |
| 60%-owned subsidiary of an Entity List company | risk **LOW**, zero controls triggered | Licence requirement identified under the § 744.21(a)(3) affiliates rule |
| Korean-owned fab in China, 3B001.a | "heightened scrutiny" only | § 744.23(a)(2) raised, which reaches **any** item including EAR99 |

### Fixed — citations

- **§ 740.5 is License Exception SPP**, not CIV. CIV was removed and the section
  number reused (90 FR 42320). 0.1.0 attached "CIV" to every response.
- **TSR is § 740.6**, requires NS-only control, a `TSR—Yes` flag in the ECCN, a
  Country Group B destination and a **written assurance from the importer**.
  0.1.0 cited § 740.13 (which is TSU) and inverted the control-reason test.
- **3B001 subparagraphs.** 0.1.0 mapped lithography to `.e`, ion implantation to
  `.d`, CMP to `.b`. The regulation has `.a` epitaxial growth, `.b` ion
  implantation, `.c` etch, `.d` deposition, `.e` wafer handling, `.f`
  lithography, running through `.r`. Only `.c` was right.
- **1C010 is fibrous or filamentary materials**, not battery chemistry. 0.1.0
  pointed battery cathode material at `1C010.e`, which is prepregs.
- **§ 744.21 country scope** is Burma, Cambodia, China, Nicaragua and Venezuela
  for Supplement No. 2 items, plus Belarus and Russia for any item. 0.1.0 used
  the 2020 trio and overstated the China case as reaching EAR99.
- **LVS values are per-ECCN.** 3B001 is $500, not the flat $3,000 0.1.0 assumed.

### Fixed — matching

Term matching was substring-based, which produced two classes of error:

- `"ic"` matched `off(ic)e` and `appl(ic)ation`, so "office stationery to a
  Japanese trading house" scored as a semiconductor transaction.
- Negation was invisible. "Strictly NO military end use, NO nuclear application,
  no missile programs. Purely commercial consumer display panel." scored **high
  risk**. It now scores low, with the negated terms reported separately and
  labelled as an unverified counterparty assertion.

Country risk now comes from the Country Group tables rather than keywords, so a
counterparty named "Russia Trading Company" shipping to Japan is no longer a
country signal, and destinations absent from the old keyword list (Kazakhstan,
D:1) are now caught. Scores are capped and normalised to 0–100; the old scorer
was unbounded and reached 45.

### Added

- **`assess_ear_jurisdiction`** — § 734.4 de minimis and all thirteen § 734.9
  Foreign Direct Product rules. FDP has no percentage test, so a Korean-built
  tool with zero U.S. content is subject to the EAR when a rule's product scope
  and destination or end-user scope are both met. Passing de minimis is never
  reported as a conclusion while an FDP rule is unresolved.
- **`screen_restricted_party`** — real screening against the U.S. Consolidated
  Screening List, 25,921 parties across 12 lists, no API key required. Aliased,
  diacritic-insensitive, tolerant of corporate form words, and acronym-aware
  (`SMIC` resolves through its alias). Generic industry words carry no weight.
- **`check_data_freshness`** and the `export-controls://data-provenance`
  resource.

### Changed — data layer

Hardcoded tables were replaced with dated snapshots generated from eCFR and
trade.gov. Every response carries a `dataProvenance` block naming the eCFR issue
date it was derived from.

Two facts that the old hardcoded tables had wrong, and that plain-text sources
cannot express:

- **Macau is not in Country Group D:5.** It is D:1, D:3 and D:4, which is why the
  EAR writes "Macau or a destination specified in Country Group D:5" throughout.
  Any rule keyed only on D:5 under-reports Macau.
- **China is not in Country Group B**, so LVS and GBS are unavailable to China on
  that ground alone.

Each builder asserts facts verified against the regulation and refuses to write a
dataset that fails them. Builders also skip writing when only the `retrievedAt`
stamp would change, so a commit touching `src/data/` means the regulation
actually moved.

### Changed — tool contracts

`analyze_license_exceptions` and `check_part744_enduse` no longer report that
anything is "available" or "clear". Statuses are `foreclosed`,
`out_of_scope`, `requires_verification`, `indeterminate_input` and
`not_modelled`. `requires_verification` is not a yes.

`draft_export_control_clause`'s `riskLevel` and
`build_due_diligence_checklist`'s `industry` now affect the output. Both were
accepted and ignored in 0.1.0.

`get_korean_law_article` calls law.go.kr over HTTPS instead of shelling out to a
PowerShell script that hung indefinitely on the test machine, burning a 12-second
timeout on every call. Live retrieval now takes about one second, and the offline
fallback is a dated snapshot of the complete statute text rather than a prose
summary. Sub-articles are supported, which matters because the 2024-02-20
전문개정 split 대외무역법 제19조 into 제19조, 제19조의2 (수출허가) and
제19조의3 (상황허가).

### Security

A law.go.kr account id was hardcoded as a default in the source and README. It
has been removed; `LAW_OC` now comes from the environment only and is optional at
run time. `npm run preflight` checks for credential patterns in tracked files
before every push.

### Structural limits

No further work on this server removes these:

- Ownership is invisible to name screening. The 50 percent affiliates rule under
  § 744.21(a)(3) reaches entities on no list.
- Most FDP prongs depend on which U.S.-origin technology was used in production.
  Only the manufacturer knows that, which is why § 734.9(a)(2) supplier
  certifications exist.
- Part 744 turns on knowledge, including reason to know, which a structured input
  cannot capture.

## 0.1.0

Initial version. Eight tools over hardcoded tables.
