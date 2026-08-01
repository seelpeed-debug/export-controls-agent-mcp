# export-controls-agent-mcp

Local MCP server for export-control legal research and transaction-risk analysis, focused on Korean semiconductor and secondary-battery companies.

## Coverage

The line between what is modelled from the regulation text and what is merely flagged for manual review matters more than the feature list, so it comes first. The `regime_overview` tool reports the same split at runtime.

**Modelled** — evaluated against bundled snapshots of the regulation, with citations and a data vintage:

| Area | Provision |
| --- | --- |
| EAR jurisdiction | § 734.4 de minimis, all thirteen § 734.9 Foreign Direct Product rules |
| Licence requirement | Part 738 Commerce Country Chart and the § 738.4(a)(2) procedure, with the § 738.3(b) territory rule and the § 738.3(a)(1) entries that bypass the chart |
| License Exceptions | Part 740, including the § 740.2 mandatory restrictions |
| Country Groups | Part 740 Supplement No. 1 |
| End-use / end-user | Part 744, including the 50 percent affiliates rule |
| Commerce Control List | Part 774 Supplement No. 1, text search over all 633 entries |
| Restricted parties | U.S. Consolidated Screening List, 25,921 parties across 12 lists |
| PRC (MOFCOM) | Dated instrument and numbered-announcement register, current strategic-mineral/rare-earth packages, the November 2025 suspension, No. 61 extraterritorial reach, and current 2026 designation records |
| Korean statutes | 대외무역법 and 국제사법, full current article text |

**Not modelled** — the server holds no data and performs no analysis; it only raises these as issues to check:

- **General Prohibitions Four through Ten (Part 736).** This matters directly to the Country Chart result. Under § 738.4(a)(2)(ii)(B), an absent mark means no licence is required *only if* those prohibitions do not apply and the entry does not refer you elsewhere. A `no_chart_requirement` answer is therefore never clearance.
- **两用物项出口管制清单, the Chinese Export Control List for Dual-Use Items.** Not bundled, so the server cannot classify an item under Chinese export control. That is the Chinese equivalent of the ECCN question and is usually an exporter's first one.
- **管控名单, the Unreliable Entity List and the Malicious Entity List.** No complete machine-readable list is published in a form that can be bundled and kept current, so Chinese entity screening is not offered rather than offered badly. A name that produces no match has not been checked.
- **EU Regulation 2021/821.** Annex I is not bundled. The server flags that an EU touchpoint exists and reminds you to review the Regulation. It cannot classify an item under EU law or analyse EU authorisations.
- **전략물자수출입고시, the Korean control list.** The statute text is bundled; the control list is not. So the server cannot tell you whether an item is a 전략물자, which is usually a Korean exporter's first question. Use the KOSTI 전략물자관리시스템 or apply for a 전문판정 under Article 20.
- **Part 742 licence requirements, Part 746 embargoes, Parts 748/758/762/764.** Cited where relevant, not evaluated.

## What this server does and does not do

It identifies the issues a reviewer must work through and quotes the governing text. It does not decide them.

Specifically, it **cannot**:

- classify an item — `classify_eccn` searches the text of the Commerce Control List and quotes candidate paragraphs
- determine that a License Exception is available — `analyze_license_exceptions` reports which exceptions are foreclosed, out of scope, or worth reviewing, and lists the conditions each requires
- clear a party — `screen_restricted_party` returns ranked candidate matches against the Consolidated Screening List. It does not screen **ownership**, so the 50 percent affiliates rule in § 744.21(a)(3) can catch an unlisted entity that produces no hit at all
- decide jurisdiction from facts it does not have — `assess_ear_jurisdiction` applies § 734.4 and all thirteen § 734.9 FDP rules, but most FDP prongs turn on which U.S.-origin technology was used in production, which only the manufacturer knows

Two consequences worth stating plainly. An empty issue list means the heuristic found nothing, not that a transaction is permissible. And `requires_verification` never means "yes".

## Install

```bash
git clone https://github.com/seelpeed-debug/export-controls-agent-mcp.git
cd export-controls-agent-mcp
npm install
```

Node 18 or later. The regulation snapshots are committed, so the server runs immediately after `npm install` with no network access and no API key.

## Regulation data

The server bundles dated snapshots of the regulation text rather than hardcoded summaries, because the EAR is amended frequently. Each snapshot records the eCFR issue date it was built from, and every tool response carries that vintage in a `dataProvenance` block.

| Dataset | Source | Rebuild |
| --- | --- | --- |
| Country Groups (Part 740, Supp. No. 1) | eCFR XML | `npm run data:country-groups` |
| Commerce Country Chart (Part 738, Supp. No. 1) | eCFR XML | `npm run data:country-chart` |
| License Exception catalog (Part 740) | eCFR XML | `npm run data:part740` |
| Commerce Control List (Part 774, Supp. No. 1) | eCFR XML | `npm run data:ccl` |
| Consolidated Screening List (25,921 parties, 12 lists) | trade.gov bulk download, no API key | `npm run data:screening` |
| § 734.9 FDP rule scopes (13 rules) | transcribed from eCFR | `npm run validate:fdp` (validates, does not regenerate) |
| PRC framework, announcement register and No. 61 tests | transcribed from MOFCOM announcements | `npm run validate:china` (validates, cannot regenerate) |
| 대외무역법 / 국제사법 full text | law.go.kr Open API | `npm run data:korean-law` |

Rebuild the EAR datasets together with `npm run data:rebuild`, which finishes by running the validators.

Two properties worth knowing:

- Each builder asserts facts verified against the regulation and refuses to write a dataset that fails them, so a change in the upstream document structure fails loudly instead of silently producing wrong compliance data. The Country Chart builder refuses outright if the 16 column identifiers change, because every rule in the CCL names them by string.
- A builder that finds nothing substantively changed leaves the file alone rather than bumping its `retrievedAt` stamp. That keeps the git history meaningful: a commit touching `src/data/` means the regulation moved, not merely that someone re-ran the script. Pass `--force` to rewrite regardless.

The screening snapshot has its own, much shorter staleness threshold of **7 days**, because restricted-party lists change by Federal Register notice rather than by quarterly amendment. The PRC transcription uses **14 days**: MOFCOM publishes no versioned text, the framework moved six times in the twelve months to July 2026, and the current suspension carries a fixed expiry. The other snapshots use 30 days.

The PRC dataset cannot be rebuilt. There is no versioned machine-readable source — MOFCOM publishes numbered announcements as individual pages with no index and no diff mechanism — so `validate:china` instead converts the decay into a failure: once the suspension expiry passes, the validator fails until a human re-reads MOFCOM and updates the transcription.

Check whether the snapshots have fallen behind:

```powershell
# from a client, call the check_data_freshness tool, or:
node -e "import('./src/lib/provenance.js').then(m=>m.checkFreshness()).then(r=>console.log(r.recommendation))"
```

## Configuration

`LAW_OC` is a [law.go.kr Open API](https://open.law.go.kr/) account id. It is optional at run time: without it the Korean statute tool serves the bundled snapshot and says so. It is required to rebuild the Korean law snapshot.

No API key is stored in the source or in the generated data files.

## Run

```powershell
npm start
```

MCP clients normally launch this server over stdio. Example client config, substituting the absolute path to your clone:

```json
{
  "mcpServers": {
    "export-controls-agent": {
      "command": "node",
      "args": ["/absolute/path/to/export-controls-agent-mcp/src/server.js"],
      "env": {
        "LAW_OC": "your-law-go-kr-account-id"
      }
    }
  }
}
```

On Windows, escape the backslashes: `"C:\\\\path\\\\to\\\\export-controls-agent-mcp\\\\src\\\\server.js"`.

`LAW_OC` may be omitted entirely; the Korean statute tool then serves the bundled snapshot.

## Tools

### `regime_overview`

Orientation map of the regimes bearing on a transaction, and which of them this server actually models. Each regime carries a `coverageInThisServer` value of `modelled`, `partial` or `pointer_only`, plus explicit `modelledParts` and `notModelledParts` lists. Worth calling first, because it tells the reader where the server's silence means nothing.

Also records that the 2024-02-20 전문개정 split the former 대외무역법 제19조 into 제19조 (designation), 제19조의2 (수출허가, including intangible technology transfer) and 제19조의3 (상황허가).

### `classify_transaction_risk`

Triage score and review plan. Terms are matched on word boundaries and negated statements ("no military end use") are reported separately and excluded from the score. The destination is assessed from the Country Group tables rather than from keywords.

### `classify_eccn`

Searches the Commerce Control List text and quotes the paragraphs that mention the technical terms in an item description, with the entry's Reason for Control and List Based License Exception flags.

The search separates what a user might write from what the regulation writes — a datasheet says "ion implanter", the CCL says "ion implantation". Terms whose CCL occurrences are in an unrelated sense are flagged: "cathode" in the CCL means metal crude forms and cathodic arc deposition, not battery cathode active material.

### `assess_ear_jurisdiction`

Answers the question that comes before classification: **is this item subject to the EAR at all?** Applies two independent routes.

**De minimis (§ 734.4)** — the threshold is set by the destination: 10 percent for Country Group E:1 and E:2, 25 percent everywhere else. Nine categories in § 734.4(a) have no de minimis level whatsoever, and the tool checks those before running any percentage.

**Foreign Direct Product rules (§ 734.9)** — all thirteen, each evaluated as two independent prongs. A rule applies only if the product scope *and* the destination or end-user scope are both met; an unresolved prong is reported as indeterminate rather than as inapplicable.

The FDP rules are why this matters for a Korean manufacturer. They have **no percentage test at all**:

```
Korean-built etcher, ECCN 3B001.c
  0% U.S. content
  produced using U.S.-origin 3E992 technology
  destination: China

de minimis  → threshold met (0% ≤ 25%)
overall     → SUBJECT TO THE EAR under § 734.9(k), the SME FDP rule
```

Passing de minimis is routinely mistaken for an answer. It is not one, and the tool never reports it as one while any FDP rule remains unresolved. The two rules that reach Korean semiconductor-equipment supply chains most directly are § 734.9(k) (SME) and § 734.9(e)(3) (Footnote 5 and advanced-node IC production, which reaches entities located at logic or DRAM advanced-node fabs in Macau or Country Group D:5).

The § 734.9 rule scopes are transcribed from the regulation rather than machine-parsed, because they are prose mixed with ECCN lists and exclusions. `npm run validate:fdp` checks the transcription against the live section and fails on drift.

### `screen_restricted_party`

Screens party names against the bundled Consolidated Screening List: BIS Entity List, Denied Persons, Unverified and MEU; OFAC SDN, SSI, CMIC, NS-MBS, PLC and Capta; State ITAR Debarred and Nonproliferation Sanctions. Each hit carries the list's authority, the operative licence requirement text, the licence review policy and the Federal Register notice.

Matching is aliased, diacritic-insensitive and tolerant of corporate form words, and it handles acronyms — `SMIC` resolves to Semiconductor Manufacturing International Corporation via its alias. Generic industry words carry no weight, so "Zzyzx Energy Holdings" does not match on `energy` alone.

Scores above 85 are treated as probable identifications; 70 to 84 are red flags to resolve.

### `check_part744_enduse`

Lists Part 744 issues: military end use (§ 744.21) including the 50 percent affiliates rule, military-intelligence (§ 744.22), nuclear (§ 744.2), missile (§ 744.3), chemical and biological (§ 744.4), U.S.-person activities (§ 744.6), and the supercomputer, advanced-node IC and semiconductor-manufacturing-equipment controls (§ 744.23).

Screens `endUser` and `additionalParties` against the Consolidated Screening List automatically, and reports a strong hit as a blocking issue with its licence requirement. It still blocks on incomplete screening, because one name is not a transaction and ownership is not in the list.

### `assess_china_export_controls`

Chinese export controls under the Export Control Law, the 2024 Regulations on Export Control of Dual-Use Items, and the numbered MOFCOM announcements.

This regime differs from the EAR in three ways that shape the tool.

**The operative question is usually whether a measure is in force, not what it says.** Announcements Nos. 55, 56, 57, 58, 61 and 62 of 2025 are suspended by Announcement No. 70 of 2025 until **10 November 2026**. Announcement No. 18 of 2025, covering seven medium and heavy rare earths, is **not** suspended and still requires a licence. So status is computed against a date, and a fact pattern that meets a suspended test returns `license_required_if_reactivated` with the expiry, because the instruments are not repealed. Suspension is not an exemption. Pass `asOfDate` to test a future date.

A detail worth knowing: No. 61 § 1(c), covering Chinese-origin listed items, took effect on publication on 9 October 2025. Its content and technology limbs (§ 1(a) and § 1(b)) were due on 1 December 2025, but the suspension began on 7 November. The delayed limbs therefore never operated; the Chinese-origin limb operated briefly before the suspension. The delayed text still matters on revival.

**It binds non-Chinese parties directly.** Announcement No. 61 requires a MOFCOM permit for a shipment where both ends are outside China, and a 管控名单 designation prohibits parties in *any* country from supplying the listed entity with Chinese-origin dual-use items. A Korean exporter with no Chinese entity and no U.S. nexus can be squarely inside this regime.

**Its content test runs the opposite way to EAR de minimis.**

| | EAR § 734.4 | MOFCOM Announcement No. 61 § 1(a) |
| --- | --- | --- |
| Threshold | 25 percent, or 10 percent for the strictest destinations | 0.1 percent |
| Direction | a **ceiling** you fall below to escape | a **floor** you rise above to be caught |

Clearing U.S. de minimis at 20 percent says nothing about this test. The tool refuses to carry a conclusion across.

Announcement No. 61's other limbs mirror provisions you will recognise: § 1(b) is a Foreign Direct Product analogue reached from the other direction, catching items produced abroad using Chinese rare-earth extraction, smelting separation, metal smelting, magnetic material manufacturing or recycling technology, with no percentage test. § 2 carries a 50 percent affiliates rule and makes applications for military end users impermissible in principle. The register also records the 2025 strategic-mineral package and the 2026 Japan, U.S. and EU measures, but the item list and complete designation lists remain unbundled.

The tool does **not** classify items and does **not** screen entities, because neither list is bundled. Every answer says so.

### `determine_license_requirement`

Works the Commerce Country Chart for an ECCN and a destination, following § 738.4(a)(2). Reads every Reason for Control in the entry and resolves each one to a chart column or to the prose destination scope the entry states instead. Only 1263 of the 1536 License Requirements rows in the CCL name a column; the other 273 say things like "To or within any destination worldwide" or "To or within Macau or a destination specified in Country Group D:5", so a column-only reading would return nothing for 3A090 and for 3B001.c. One row in the whole list cannot be read, and the reason is in the regulation: 1D018's MT row has a blank Country Chart cell and its control text names no requirement.

Each requirement is reported separately, because § 738.4(a)(2)(ii)(A) requires each one to be overcome on its own.

Four things a table lookup gets wrong, all handled here:

- **Cuba, Iran, North Korea and Syria carry no marks at all.** Their rows point to Part 746 instead. An empty row is reported as `embargo_destination`, never as an absence of requirements.
- **The footnotes create requirements the grid does not show.** Australia's row is empty apart from CB 1, yet footnote 10 still requires a licence for a list of firearms entries. Ask about `0A501` to Australia and the footnote fires.
- **Some destinations have no row.** Hong Kong's was removed by 85 FR 83788 and is governed by the China entry; under § 738.3(b) a dependent territory takes its parent's row. A destination that is neither a row nor one of the inheritance cases the EAR names comes back `indeterminate_input`, not clear.
- **Some entries bypass the chart.** § 738.3(a)(1) requires a licence to all destinations for 0A983, 5A980 and others, with no License Exception at all for some of them.

Rows are scoped to subparagraphs, so `3B001.b` resolves cleanly while a bare `3B001` returns a conditional answer and asks which subparagraph applies. Where a row's scope is a physical description — "shotguns with a barrel length less than 18 inches" — no ECCN string can decide it, and the row is reported as conditional rather than dropped.

Statuses are `license_required`, `no_chart_requirement`, `requires_verification`, `embargo_destination`, `indeterminate_input` and `out_of_scope`. `no_chart_requirement` is not clearance; see the Coverage note on General Prohibitions Four through Ten.

### `analyze_license_exceptions`

Applies the mandatory restrictions in § 740.2 — including § 740.2(a)(9)(i), under which semiconductor manufacturing equipment and its associated software and technology going to Macau or Country Group D:5 has no License Exception available other than GOV — then reports each exception's status and the conditions it would require.

Carries a `licenceRequirement` block from the Country Chart, because an exception exists to overcome a licence requirement and an exception analysis with nothing to overcome is moot. Where the chart produces more than one requirement, the block says so: a single exception has to defeat all of them.

### `draft_export_control_clause`

Drafts Korean or English clauses. `riskLevel` selects cumulative tiers: `low` gives baseline compliance and termination provisions, `medium` adds end-user certification and the affiliates-rule representation, `high` adds conditions precedent tied to pre-shipment re-screening, FDP and de minimis acknowledgement, § 744.6 U.S.-person control, and a mandatory-rules provision.

### `build_due_diligence_checklist`

Stage-specific checklist. The `industry` parameter changes the output: the semiconductor set covers 3B001 subparagraph scoping and the § 744.23 controls, the battery set covers the absence of CCL entries for battery chemistry and the superficially matching entries to avoid.

### `get_korean_law_article`

Retrieves an article of 대외무역법 or 국제사법 from the law.go.kr Open API, falling back to the bundled snapshot. Sub-articles are supported.

Note that the 2024-02-20 전문개정 split the former 제19조 into 제19조 (전략물자 지정·고시), 제19조의2 (수출허가) and 제19조의3 (상황허가), and several articles were further amended with effect from 2025-10-01.

### `check_data_freshness`

Compares the bundled snapshots against the latest eCFR issue date and reports which need rebuilding.

## Resources

- `export-controls://official-sources` — canonical official source links
- `export-controls://data-provenance` — bundled snapshot vintage and rebuild commands
- `export-controls://china-framework` — the PRC instrument and announcement register, the November 2025 suspension, the Announcement No. 61 tests and the entity mechanisms. Held as a resource because it is constant, so the tool does not repeat it on every call

## Publishing a change

```bash
npm run preflight
```

One command, seven groups of checks, exit 0 means safe to push. It then prints the commit and push commands.

Each check exists because the corresponding mistake actually happened while building this, not because it seemed prudent:

| Check | What went wrong once |
| --- | --- |
| credentials in tracked files | a law.go.kr account id survived as a default value in a test harness about to be committed |
| tracked file sizes | the 32 MB raw Consolidated Screening List download got staged |
| placeholder in the remote URL | a literal `<사용자명>` ended up as the git remote, so the first push failed |
| runtime data present | `src/data/` is generated but required at startup; a clone without it cannot run |
| snapshot vintage | a "Refresh regulation snapshots" commit changed nothing but a timestamp |
| tests and validators | — |
| server starts over stdio | — |

The snapshot-vintage check uses the same thresholds the server does: 7 days for the screening list, 30 days for everything else.

If preflight warns that a snapshot is stale:

```bash
npm run data:rebuild                 # Country Groups, Part 740 catalog, CCL, screening list
LAW_OC=<your-oc> npm run data:korean-law
npm run preflight
git add -A && git commit -m "Refresh regulation snapshots to eCFR <date>" && git push
```

A commit touching `src/data/` should mean the regulation actually moved. The builders skip writing when only the `retrievedAt` stamp would change, so a clean `git status` after a rebuild is the expected result when nothing has been amended.

## Tests

```powershell
npm test
```

Ten suites, covering term matching and negation, the Part 738 chart determination, the Part 740 and Part 744 gating logic, § 734 jurisdiction, CCL search behaviour, screening, the PRC framework and its suspension arithmetic, the risk and clause tiering, Korean statute retrieval, and the honesty of the coverage claims in this README and in `regime_overview`.

```powershell
npm run validate
```

Four validators, which check assumptions no snapshot can catch:

- `validate:vocabulary` asserts every regulation-side search term actually occurs in the bundled CCL, so a search key that would silently return nothing fails instead.
- `validate:fdp` re-reads § 734.9 and confirms the thirteen hand-transcribed rule scopes still match the section.
- `validate:country-chart` confirms every prose destination scope the chart evaluator recognises still appears in the CCL. This is the one that matters most for the EAR: if BIS rewords a scope such as "To or within any destination worldwide", the pattern stops matching, the affected rows quietly become unreadable, and the tool silently stops reporting a licence requirement it used to catch. It also pins the number of unreadable rows, which may fall but not rise, and re-reads § 738.3 and § 738.4 against the live eCFR.
- `validate:china` fails once the MOFCOM suspension expiry passes, because from that moment every "not currently required" answer about Announcements 55 to 62 is wrong until someone re-reads the source. It also checks the internal cross-references of a hand-transcribed dataset and enforces the honesty invariants: the designation list must keep declaring itself incomplete, a matched counterparty name must not suppress the unscreened question for the others, the 0.1 percent test must stay marked as a floor, and no unverified article number may be added.

## Limitations

This server is a research assistant, not a source of legal advice. It does not guarantee that its bundled snapshots reflect the law in force. Verify every output against official sources, and have export-control counsel confirm any conclusion before shipment.

Three limits are structural rather than incidental, and no amount of further work on this server removes them:

- **Ownership is invisible to name screening.** The 50 percent affiliates rule under § 744.21(a)(3) reaches entities that appear on no list. Only a traced ownership chain answers it.
- **FDP turns on production facts.** Most § 734.9 prongs depend on which U.S.-origin technology or software was used to make the item. Only the manufacturer knows that, which is why § 734.9(a)(2) supplier certifications exist.
- **Part 744 turns on knowledge, including reason to know.** A structured input cannot capture a red flag that a human noticed in a conversation.

See the [Coverage](#coverage) section for what is modelled and what is only flagged. Where something is listed as not modelled, this server has performed no analysis of it and its silence carries no meaning.

Official sources:

- BIS EAR: https://www.bis.gov/regulations/ear
- BIS Entity List: https://www.bis.gov/entity-list
- eCFR Title 15: https://www.ecfr.gov/current/title-15
- EU Regulation 2021/821: https://eur-lex.europa.eu/eli/reg/2021/821/oj?locale=en
- 국가법령정보센터: https://www.law.go.kr/
