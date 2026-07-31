# Changelog

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
