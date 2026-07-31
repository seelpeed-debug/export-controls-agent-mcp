// Parsing helpers for the law.go.kr Open API payload, shared by the runtime
// client and the snapshot builder.
//
// The payload is irregular in ways that break naive access:
//
//   조문단위  object when the response holds one unit, array when it holds more
//   조문여부  "조문" for an actual article, "전문" for the 장/절 heading that
//             precedes the first article of a division -- so requesting
//             대외무역법 제19조 returns TWO units, and reading 조문단위.조문내용
//             yields undefined
//   항/호/목  each independently object, array, or absent
//
// Every accessor below normalises through `arr()` for that reason.

/** Statutes this server supports, with their law.go.kr MST identifiers. */
export const LAWS = {
  대외무역법: {
    mst: "276491",
    englishName: "Foreign Trade Act",
    relevance: "Korean strategic-item designation, export and situational authorisation, and penalties."
  },
  국제사법: {
    mst: "238791",
    englishName: "Act on Private International Law",
    relevance: "Governing-law selection and the mandatory-rules questions that arise in export-control clauses."
  }
};

/** Normalise object | array | undefined into an array. */
function arr(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function clean(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Turn "제19조의2" / "19조의2" / "19-2" / "19의2" / "19" into a canonical label
 * and the six-digit JO parameter the API expects (AAAABB: article, sub-article).
 */
export function parseArticleLabel(input) {
  const raw = clean(input);
  if (!raw) return { valid: false, reason: "empty article label" };

  const m = raw.match(/^제?\s*(\d{1,4})\s*조?\s*(?:의\s*(\d{1,2})|-\s*(\d{1,2}))?\s*$/);
  if (!m) {
    return {
      valid: false,
      reason: `could not parse "${raw}". Expected forms: 제19조, 제19조의2, 19조, 19-2, 19`
    };
  }
  const article = Number(m[1]);
  const sub = m[2] ?? m[3] ? Number(m[2] ?? m[3]) : 0;
  if (article < 1 || article > 9999) return { valid: false, reason: `article number out of range: ${article}` };

  return {
    valid: true,
    article,
    sub,
    label: sub > 0 ? `제${article}조의${sub}` : `제${article}조`,
    jo: String(article).padStart(4, "0") + String(sub).padStart(2, "0")
  };
}

/** Render one article's 항/호/목 tree as readable text. */
function renderArticle(unit) {
  const lines = [];
  const head = clean(unit.조문내용);
  if (head) lines.push(head);

  for (const h of arr(unit.항)) {
    const hText = clean(h.항내용);
    if (hText) lines.push(hText);
    for (const ho of arr(h.호)) {
      const hoText = clean(ho.호내용);
      if (hoText) lines.push("  " + hoText);
      for (const mok of arr(ho.목)) {
        const mokText = clean(mok.목내용 ?? mok.목내용문자열 ?? "");
        if (mokText) lines.push("    " + mokText);
      }
    }
  }
  return lines.join("\n");
}

function articleLabelOf(unit) {
  const n = Number(unit.조문번호);
  const sub = Number(unit.조문가지번호 ?? 0) || 0;
  return sub > 0 ? `제${n}조의${sub}` : `제${n}조`;
}

/** Extract the structured form of a single article unit. */
export function extractArticle(unit) {
  return {
    label: articleLabelOf(unit),
    articleNumber: Number(unit.조문번호),
    subArticleNumber: Number(unit.조문가지번호 ?? 0) || 0,
    title: clean(unit.조문제목) || null,
    effectiveDate: clean(unit.조문시행일자) || null,
    amendmentNote: clean(unit.조문참고자료) || null,
    text: renderArticle(unit),
    paragraphCount: arr(unit.항).length
  };
}

/**
 * Normalise a whole-law payload.
 * @returns {{lawName, promulgationDate, competentMinistry, articles, divisionHeadings}}
 */
export function normalizeLawPayload(json) {
  const info = json?.법령?.기본정보 ?? {};
  const units = arr(json?.법령?.조문?.조문단위);

  const ministry = info.소관부처;
  const competentMinistry = Array.isArray(ministry)
    ? clean(ministry[0]?.content ?? ministry[0])
    : clean(ministry?.content ?? ministry);

  const articles = [];
  const divisionHeadings = [];
  for (const u of units) {
    if (u.조문여부 === "조문") articles.push(extractArticle(u));
    else {
      const t = clean(u.조문내용);
      if (t) divisionHeadings.push({ afterArticleNumber: Number(u.조문번호), heading: t });
    }
  }

  return {
    lawName: clean(info.법령명_한글 ?? info["법령명_한자"]) || null,
    promulgationDate: clean(info.공포일자) || null,
    competentMinistry: competentMinistry || null,
    articles,
    divisionHeadings
  };
}

/**
 * Normalise a single-article payload (a request with a JO parameter).
 * Returns null when the law exists but the article does not.
 */
export function normalizeArticlePayload(json, wantedLabel) {
  const units = arr(json?.법령?.조문?.조문단위);
  const articles = units.filter((u) => u.조문여부 === "조문");
  if (articles.length === 0) return null;

  // Prefer an exact label match; the API sometimes returns a neighbouring
  // article plus the division heading.
  const exact = articles.find((u) => articleLabelOf(u) === wantedLabel);
  const chosen = exact ?? articles[0];

  const info = json?.법령?.기본정보 ?? {};
  const ministry = info.소관부처;
  const heading = units.find((u) => u.조문여부 !== "조문");

  return {
    ...extractArticle(chosen),
    exactMatch: Boolean(exact),
    divisionHeading: heading ? clean(heading.조문내용) : null,
    lawName: clean(info.법령명_한글 ?? info["법령명_한자"]) || null,
    promulgationDate: clean(info.공포일자) || null,
    competentMinistry: Array.isArray(ministry)
      ? clean(ministry[0]?.content ?? ministry[0])
      : clean(ministry?.content ?? ministry) || null
  };
}
