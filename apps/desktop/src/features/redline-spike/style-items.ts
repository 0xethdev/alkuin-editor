/** Which learned items Preferences shows. */

export type StyleItem = {
  id?: string;
  rule: string;
  why: string;
  scope: string;
  seen: number;
};

export function stripTicks(text: string): string {
  return text.replace(/`+/g, "").replace(/\s+/g, " ").trim();
}

export function oneSentence(text: string): boolean {
  if (text.length === 0 || text.length > 120 || /\d/.test(text)) return false;
  // e.g. and i.e. are not a second sentence.
  const softened = text.replace(/\b(?:e\.g|i\.e)\./gi, (hit) => hit.replace(/\./g, ""));
  const parts = softened
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length === 1;
}

function quoteWords(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/ +/g, " ")
    .trim();
  return normalized.length > 0 ? ` ${normalized} ` : " ";
}

/** True when the candidate shares more than five consecutive words with a source. */
export function copiesWords(candidate: string, texts: string[]): boolean {
  const hay = quoteWords(stripTicks(candidate));
  for (const text of texts) {
    const words = quoteWords(text).trim().split(" ").filter(Boolean);
    for (let i = 0; i + 6 <= words.length; i++) {
      if (hay.includes(` ${words.slice(i, i + 6).join(" ")} `)) return true;
    }
  }
  return false;
}

const SCOPES = new Set(["house", "polish", "cite", "research"]);

/** seen under 2 stays hidden. A six-word copy of the draft stays hidden. */
export function shownStyleItems(rows: StyleItem[], sources: string[] = []): StyleItem[] {
  return rows.filter((row) => {
    if (row.seen < 2 || !SCOPES.has(row.scope)) return false;
    if (!oneSentence(row.rule) || !oneSentence(row.why)) return false;
    return !copiesWords(`${row.rule} ${row.why}`, sources);
  });
}
