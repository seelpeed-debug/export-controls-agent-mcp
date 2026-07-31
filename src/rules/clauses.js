// Export-control contract clause drafting and due-diligence checklists.
//
// WHAT CHANGED AND WHY
// Both tools previously accepted a parameter they then ignored:
//   draft_export_control_clause    echoed `riskLevel` but produced byte-identical
//                                  clause text for "low" and "high"
//   build_due_diligence_checklist  echoed `industry` but never used it
// A parameter that does nothing is worse than an absent one, because the caller
// reasonably believes it took effect. Both now drive the output.

/**
 * Clause tiers are cumulative: medium includes low, high includes medium.
 * Each clause records the tier that introduced it so a reviewer can see what
 * the risk setting actually bought.
 */
const CLAUSES = {
  ko: {
    baseline: [
      (t) => `당사자는 ${t}와 관련하여 적용 가능한 수출통제, 경제제재, 관세, 전략물자 및 대외무역 관련 법령을 준수하여야 한다.`,
      () => "매수인 또는 수령인은 물품, 소프트웨어, 기술자료 및 기술지원이 금지된 최종용도 또는 제한된 최종사용자에게 사용·제공되지 않음을 진술하고 보증한다.",
      () => "매수인 또는 수령인은 필요한 허가 및 매도인의 사전 서면동의 없이 물품, 소프트웨어, 기술자료를 재수출, 재이전, 공개하거나 제3자에게 접근권한을 부여하여서는 아니 된다.",
      () => "매도인은 계약 이행이 적용 가능한 수출통제 또는 제재 법령에 위반될 합리적 우려가 있는 경우 해당 이행을 정지할 수 있다.",
      () => "필요한 허가가 거절, 취소, 현저히 지연되거나 상업적으로 수용하기 어려운 조건이 부과된 경우, 당사자는 영향을 받는 부분을 책임 없이 해제 또는 종료할 수 있다. 다만 이미 발생한 대금지급의무와 비밀유지의무는 존속한다."
    ],
    medium: [
      () => "매수인 또는 수령인은 매도인이 요구하는 양식에 따라 최종사용자확인서(End-User Certificate) 및 최종용도확인서를 제공하고, 그 기재사항의 정확성에 대하여 책임을 진다.",
      () => "매수인 또는 수령인은 자신 또는 그 계열회사가 제한대상자 목록(미국 Entity List, MEU List, Unverified List, OFAC SDN List, EU 제재명단 등)에 등재되거나, 지배구조·최종사용자·설치장소에 변경이 발생한 경우 지체 없이 서면으로 통지하여야 한다.",
      () => "매수인 또는 수령인은 제한대상자에 의하여 직접 또는 간접으로, 개별적 또는 합산하여 50퍼센트 이상 소유되지 않음을 진술하고 보증하며, 소유구조 확인에 필요한 자료를 제공하여야 한다.",
      () => "당사자는 허가 신청에 필요한 자료 제공 및 협력 의무를 부담하고, 허가 취득에 소요되는 비용·기간과 허가 지연 또는 거절로 인한 위험의 분담을 별도로 정한다."
    ],
    high: [
      () => "선행조건: 매도인의 인도의무는 (i) 선적 직전 시점에 재실시한 제한대상자 스크리닝 결과 이상이 없고, (ii) 필요한 모든 수출허가가 유효하게 존속하며, (iii) 최종용도·최종사용자 정보에 변경이 없음을 조건으로 한다.",
      () => "매수인 또는 수령인은 물품, 소프트웨어, 기술자료가 미국 외국직접생산품규칙(Foreign Direct Product Rules, 15 C.F.R. § 734.9) 또는 최소기준(de minimis, 같은 법 § 734.4)에 따라 미국 수출관리규정의 적용대상이 될 수 있음을 인식하고, 해당 규칙의 적용 여부 판단에 필요한 정보를 제공하여야 한다.",
      () => "매수인 또는 수령인은 미국인(U.S. person)에 해당하는 임직원·파견자가 15 C.F.R. § 744.6에서 정한 활동을 지원하지 않도록 관리하고, 관련 인원의 국적·체류자격 정보를 법령이 허용하는 범위에서 제공하여야 한다.",
      () => "기술자료의 제공은 사전 승인된 범위로 한정하며, 원격접속, 클라우드 저장소, 협업도구 및 회의자료에 대한 접근권한은 사전 승인된 개인에게만 부여한다. 매수인 또는 수령인은 접근기록을 보존하여야 한다.",
      () => "매수인 또는 수령인 또는 그 지배주주가 제한대상자 목록에 등재되거나, 허가가 거절·취소되거나, 진술·보증에 중대한 부실이 있는 경우 매도인은 별도의 최고 없이 계약 전부 또는 일부를 즉시 해지할 수 있다.",
      () => "매도인은 사전 통지 후 매수인 또는 수령인의 수출통제 준수 상태에 대하여 연 1회 이상 감사를 실시할 수 있으며, 매수인 또는 수령인은 관련 기록을 최소 5년간 보존하여야 한다.",
      () => "본 조에 따른 대한민국 대외무역법 및 적용 가능한 외국 수출통제법령상의 의무는 준거법 선택에 관계없이 적용되며, 이는 국제사법 제20조에 따른 대한민국 강행규정 및 관련국 강행규정의 적용을 배제하지 아니한다."
    ],
    auditRight: () =>
      "매수인 또는 수령인은 최종용도, 최종사용자, 재수출 및 법령준수 상태를 확인할 수 있는 기록을 보존하고, 매도인의 합리적 요청이 있는 경우 이를 제공하여야 한다.",
    indemnity: () =>
      "매수인 또는 수령인은 부정확한 최종용도 정보, 무단 재수출, 제한대상자 거래 또는 본 조 위반으로 인하여 매도인에게 발생한 손해(제재금, 방어비용 및 합리적인 법률비용을 포함한다)를 배상하고 면책하여야 한다."
  },
  en: {
    baseline: [
      (t) => `The Parties shall comply with all applicable export control, sanctions, customs and strategic trade laws in connection with the ${t}.`,
      () => "The Buyer represents and warrants that the items, software, technology and technical assistance will not be used for any prohibited end use or by any restricted end user.",
      () => "The Buyer shall not reexport, retransfer, disclose or provide access to the items, software or technology without all required authorisations and the Seller's prior written consent.",
      () => "The Seller may suspend performance if it reasonably determines that performance may violate applicable export-control or sanctions laws.",
      () => "If any required authorisation is denied, revoked, materially delayed or conditioned in a commercially impracticable manner, either Party may terminate the affected portion without liability, except for accrued payment and confidentiality obligations."
    ],
    medium: [
      () => "The Buyer shall provide an End-User Certificate and end-use statement in the form required by the Seller, and is responsible for the accuracy of their contents.",
      () => "The Buyer shall notify the Seller in writing without delay if the Buyer or any of its affiliates is added to a restricted-party list (including the U.S. Entity List, MEU List, Unverified List and OFAC SDN List, and EU designations), or if there is any change in its ownership, its end users or the installation site.",
      () => "The Buyer represents and warrants that it is not owned, directly or indirectly, individually or in aggregate, 50 percent or more by any listed party, and shall provide the information necessary to verify its ownership structure.",
      () => "The Parties shall cooperate in any licence application, and shall allocate between them the cost and time of obtaining authorisation and the risk of delay or denial."
    ],
    high: [
      () => "Conditions precedent: the Seller's delivery obligation is conditional on (i) restricted-party screening repeated immediately before shipment returning no adverse result, (ii) all required export authorisations remaining valid and in force, and (iii) no change in the end-use or end-user information.",
      () => "The Buyer acknowledges that the items, software or technology may become subject to the U.S. Export Administration Regulations under the Foreign Direct Product rules (15 C.F.R. § 734.9) or the de minimis rules (15 C.F.R. § 734.4), and shall provide the information required to assess whether those rules apply.",
      () => "The Buyer shall ensure that its personnel and secondees who are U.S. persons do not engage in activities described in 15 C.F.R. § 744.6, and shall provide nationality and immigration-status information for relevant personnel to the extent permitted by law.",
      () => "Disclosure of technology shall be limited to a pre-approved scope. Access to remote connections, cloud storage, collaboration tools and meeting materials shall be granted only to pre-approved individuals, and the Buyer shall retain access logs.",
      () => "The Seller may terminate this agreement in whole or in part with immediate effect and without further notice if the Buyer or its controlling shareholder is added to a restricted-party list, if an authorisation is denied or revoked, or if any representation or warranty proves materially inaccurate.",
      () => "The Seller may audit the Buyer's export-control compliance not more than once per year on prior notice, and the Buyer shall retain the relevant records for at least five years.",
      () => "The obligations in this clause under the Korean Foreign Trade Act and any applicable foreign export-control law apply irrespective of the governing law chosen by the Parties, and nothing in this agreement excludes the application of Korean mandatory rules under Article 20 of the Korean Act on Private International Law or the mandatory rules of any other connected State."
    ],
    auditRight: () =>
      "The Buyer shall maintain complete records and, upon reasonable request, provide documents sufficient to verify end use, end user, reexport and compliance status.",
    indemnity: () =>
      "The Buyer shall indemnify the Seller against losses (including penalties, defence costs and reasonable legal fees) arising from the Buyer's inaccurate end-use information, unauthorised reexport, transaction with a restricted party, or breach of this clause."
  }
};

const TIER_ORDER = ["baseline", "medium", "high"];

export function draftExportControlClause({
  language = "ko",
  transactionType,
  riskLevel = "medium",
  includeIndemnity = true,
  includeAuditRight = true
}) {
  const set = CLAUSES[language] ?? CLAUSES.ko;
  const tiersIncluded = riskLevel === "low" ? ["baseline"] : riskLevel === "medium" ? ["baseline", "medium"] : TIER_ORDER;

  const clauses = [];
  for (const tier of tiersIncluded) {
    for (const build of set[tier] ?? []) {
      clauses.push({ tier, text: build(transactionType) });
    }
  }
  if (includeAuditRight) clauses.push({ tier: "option", text: set.auditRight() });
  if (includeIndemnity) clauses.push({ tier: "option", text: set.indemnity() });

  const byTier = {};
  for (const c of clauses) byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;

  return {
    toolContract:
      "Drafting support, not legal advice. Clause text must be adapted to the transaction and reviewed by counsel before use.",
    language,
    transactionType,
    riskLevel,
    riskLevelEffect: {
      tiersIncluded,
      clauseCountByTier: byTier,
      explanation:
        riskLevel === "low"
          ? "Baseline compliance, no-reexport, suspension and termination provisions only."
          : riskLevel === "medium"
            ? "Baseline plus end-user certification, restricted-party and ownership-change notification, a 50 percent affiliates-rule representation, and licence-cooperation allocation."
            : "Baseline and medium provisions plus conditions precedent tied to pre-shipment re-screening, Foreign Direct Product and de minimis acknowledgement, U.S.-person activity control under § 744.6, technology-access control, immediate termination on listing, an annual audit right with a five-year retention period, and an express mandatory-rules provision."
    },
    clauses: clauses.map((c) => c.text),
    clausesByTier: clauses,
    drafterNotes: [
      "Align the defined terms (Buyer, Recipient, Seller) with the rest of the agreement before insertion.",
      "The 50 percent ownership representation tracks the EAR affiliates rule; verify the current threshold and scope in 15 C.F.R. § 744.21(a)(3) and Supplement No. 8 to Part 744 before relying on the wording.",
      "Where a licence is a condition precedent, state expressly which Party applies, the application deadline, and the consequence of a pending decision at the delivery date.",
      "Record-retention periods should be set against the longest applicable limitation period; five years is a common floor, not a legal maximum."
    ]
  };
}

// ---------------------------------------------------------------------------
// Due-diligence checklist
// ---------------------------------------------------------------------------

const BASE_CHECKLIST = [
  "Identify the contracting parties, actual recipients, affiliates, banks, freight forwarders, final users and final use.",
  "Collect product specifications, software scope, a technical data list, the service scope and the support channels.",
  "Check Korean strategic-item and catch-all status, and whether a 전문판정 (expert classification) under Foreign Trade Act Article 20 is needed.",
  "Determine whether each item is subject to the EAR, including under § 734.4 de minimis and § 734.9 Foreign Direct Product rules.",
  "Establish the ECCN against the Commerce Control List, and record the Order of Review reasoning.",
  "Screen all parties and addresses against the Entity List, MEU List, Unverified List and OFAC SDN List, and trace ownership for the 50 percent affiliates rule.",
  "Assess Part 744 end-use and end-user controls, which apply to EAR99 items as well.",
  "Check EU Regulation 2021/821 if EU-origin items, EU subsidiaries, EU technical assistance, brokering or transit is involved.",
  "Document the decision logic, the evidence, the reviewer, the approval date and the resulting contract controls."
];

const STAGE_CHECKLIST = {
  pre_contract: [
    "Insert information-request obligations into the term sheet or RFP response.",
    "Refuse vague end-use descriptions for sensitive equipment, materials, software or technology.",
    "Confirm whether the counterparty's ultimate parent is headquartered in Macau or Country Group D:5, which triggers controls irrespective of the shipping destination."
  ],
  contracting: [
    "Add export-control representations, an end-use certificate covenant, reexport restrictions, suspension, termination, audit and indemnity clauses.",
    "Allocate licence-application cooperation, cost, delay and denial risk.",
    "Make pre-shipment re-screening a condition precedent to delivery where the risk tier warrants it."
  ],
  pre_shipment: [
    "Refresh restricted-party screening immediately before shipment; a screen performed at contract signature is stale.",
    "Confirm licence conditions, quantity, destination, consignee and logistics route.",
    "Block shipment if final-user or final-use information has changed."
  ],
  technical_support: [
    "Approve technical data before sharing, and keep the approved scope narrower than the contract's outer limit.",
    "Control remote access, cloud folders, meeting materials and foreign-person access; a release to a foreign national can be a deemed export.",
    "Identify which support personnel are U.S. persons and assess § 744.6 before they provide support.",
    "Keep support logs and records of transferred files."
  ],
  post_shipment: [
    "Monitor reexport, ownership change, site relocation and unusual technical-support requests.",
    "Re-verify any authorisation that was relied on, including Validated End User status, which was revoked for foreign-owned fabs in China effective 31 December 2025.",
    "Retain documents and escalate red flags for legal review."
  ]
};

const INDUSTRY_CHECKLIST = {
  semiconductor: [
    "Identify the specific 3B001 subparagraph, not just the entry. Restrictions are scoped to particular paragraphs -- 3B001.a.4, c, d, f.1, f.5, f.6, k to n, p.2, p.4 and r are treated far more restrictively than the rest of the entry.",
    "If any destination or facility is in Macau or Country Group D:5, assess § 744.23: (a)(2)(i) reaches ANY item destined for a facility producing advanced-node ICs, including EAR99 items, regardless of who owns the fab.",
    "Establish the fabrication facility's technology node. Where the node is unknown, § 744.23(a)(2)(ii) applies to Category 3 Product Group B, C, D and E items.",
    "Check whether the item is for the development or production of semiconductor manufacturing equipment, which triggers § 744.23(a)(4).",
    "For ECAD or TCAD software and technology, assess § 744.23(a)(2)(iii).",
    "For memory products, distinguish 3A090.c and consider License Exception HBM (§ 740.25); note that 3A090.c is not eligible for NAC/ACA.",
    "Confirm whether the SME Foreign Direct Product rule captures Korean-manufactured tools or parts with no U.S. content.",
    "Check Footnote 5 designations and General Order No. 4 in Supplement No. 1 to Part 736 before concluding that a licence is required."
  ],
  battery: [
    "Do not assume a CCL entry exists for battery chemistry. Cathode and anode active materials, precursors and most electrolytes are commonly EAR99, but that must be reached through a documented Order of Review, not by default.",
    "Be wary of superficially matching CCL entries: 1C010 controls fibrous or filamentary materials, and the CCL's uses of \"cathode\", \"anode\", \"lithium\" and \"separator\" refer to metal forms, nuclear material and isotope separation rather than battery components.",
    "Check ECCN 3A001.e and 3A991.j for cells and batteries as such, against the actual electrical parameters.",
    "Assess catch-all and end-use controls, which apply to EAR99 material. Part 744 does not depend on the ECCN.",
    "Assess Korean strategic-item status separately; Korean designations do not track the CCL.",
    "For joint ventures and licensing, treat process know-how and equipment recipes as technology transfer even where the material itself is EAR99.",
    "Check critical-minerals and customs measures separately; they are outside the export-control analysis but often govern the same shipment."
  ]
};

export function buildDueDiligenceChecklist({ transactionStage = "pre_contract", industry = "both" }) {
  const industries = industry === "both" ? ["semiconductor", "battery"] : [industry];
  const industrySpecific = industries.flatMap((i) =>
    (INDUSTRY_CHECKLIST[i] ?? []).map((item) => ({ industry: i, item }))
  );

  const stageItems = STAGE_CHECKLIST[transactionStage] ?? [];

  return {
    toolContract:
      "A working checklist, not a compliance programme. Adapt it to the organisation's own procedures and record the outcome of each item.",
    transactionStage,
    industry,
    industryEffect: {
      industriesCovered: industries,
      industrySpecificItemCount: industrySpecific.length,
      explanation:
        industry === "both"
          ? "Includes both the semiconductor and battery specific items."
          : `Includes the ${industry} specific items only.`
    },
    checklist: {
      alwaysApplicable: BASE_CHECKLIST,
      stageSpecific: stageItems,
      industrySpecific
    },
    flatChecklist: [...BASE_CHECKLIST, ...stageItems, ...industrySpecific.map((x) => `[${x.industry}] ${x.item}`)],
    itemCount: BASE_CHECKLIST.length + stageItems.length + industrySpecific.length
  };
}
