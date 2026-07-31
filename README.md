# export-controls-agent-mcp

Local MCP server for export-control legal research and transaction-risk analysis, focused on Korean semiconductor and secondary-battery companies.

It supports research and drafting around:

- U.S. EAR (15 C.F.R. Parts 730–774), including Part 740 License Exceptions and Part 744 end-use and end-user controls
- The Commerce Control List
- EU Regulation 2021/821
- The Korean Foreign Trade Act (대외무역법) and Act on Private International Law (국제사법)

## What this server does and does not do

It identifies the issues a reviewer must work through and quotes the governing text. It does not decide them.

Specifically, it **cannot**:

- screen any party against the Entity List, MEU List, Unverified List or OFAC SDN List — it holds no restricted-party data
- classify an item — `classify_eccn` searches the text of the Commerce Control List and quotes candidate paragraphs
- determine that a License Exception is available — `analyze_license_exceptions` reports which exceptions are foreclosed, out of scope, or worth reviewing, and lists the conditions each requires
- assess the Foreign Direct Product rules (§ 734.9) or de minimis (§ 734.4)

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
| License Exception catalog (Part 740) | eCFR XML | `npm run data:part740` |
| Commerce Control List (Part 774, Supp. No. 1) | eCFR XML | `npm run data:ccl` |
| 대외무역법 / 국제사법 full text | law.go.kr Open API | `npm run data:korean-law` |

Rebuild the three EAR datasets together with `npm run data:rebuild`.

Two properties worth knowing:

- Each builder asserts facts verified against the regulation and refuses to write a dataset that fails them, so a change in the upstream document structure fails loudly instead of silently producing wrong compliance data.
- A builder that finds nothing substantively changed leaves the file alone rather than bumping its `retrievedAt` stamp. That keeps the git history meaningful: a commit touching `src/data/` means the regulation moved, not merely that someone re-ran the script. Pass `--force` to rewrite regardless.

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

Summarises EAR, BIS Entity List, EU Regulation 2021/821 and Korean Foreign Trade Act touchpoints.

### `classify_transaction_risk`

Triage score and review plan. Terms are matched on word boundaries and negated statements ("no military end use") are reported separately and excluded from the score. The destination is assessed from the Country Group tables rather than from keywords.

### `classify_eccn`

Searches the Commerce Control List text and quotes the paragraphs that mention the technical terms in an item description, with the entry's Reason for Control and List Based License Exception flags.

The search separates what a user might write from what the regulation writes — a datasheet says "ion implanter", the CCL says "ion implantation". Terms whose CCL occurrences are in an unrelated sense are flagged: "cathode" in the CCL means metal crude forms and cathodic arc deposition, not battery cathode active material.

### `check_part744_enduse`

Lists Part 744 issues: military end use (§ 744.21) including the 50 percent affiliates rule, military-intelligence (§ 744.22), nuclear (§ 744.2), missile (§ 744.3), chemical and biological (§ 744.4), U.S.-person activities (§ 744.6), and the supercomputer, advanced-node IC and semiconductor-manufacturing-equipment controls (§ 744.23).

### `analyze_license_exceptions`

Applies the mandatory restrictions in § 740.2 — including § 740.2(a)(9)(i), under which semiconductor manufacturing equipment and its associated software and technology going to Macau or Country Group D:5 has no License Exception available other than GOV — then reports each exception's status and the conditions it would require.

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

## Tests

```powershell
npm test
```

Covers term matching and negation, the Part 740 and Part 744 gating logic, CCL search behaviour, the risk and clause tiering, and Korean statute retrieval. `npm run validate:vocabulary` additionally asserts that every regulation-side search term actually occurs in the bundled CCL, so a search key that would silently return nothing fails instead.

## Limitations

This server is a research assistant, not a restricted-party screening database and not a source of legal advice. It does not guarantee that its bundled snapshots reflect the law in force. Verify every output against official sources, and have export-control counsel confirm any conclusion before shipment.

Official sources:

- BIS EAR: https://www.bis.gov/regulations/ear
- BIS Entity List: https://www.bis.gov/entity-list
- eCFR Title 15: https://www.ecfr.gov/current/title-15
- EU Regulation 2021/821: https://eur-lex.europa.eu/eli/reg/2021/821/oj?locale=en
- 국가법령정보센터: https://www.law.go.kr/
