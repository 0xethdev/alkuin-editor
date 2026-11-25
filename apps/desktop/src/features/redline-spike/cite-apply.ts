/**
 * Citation output + the Accept merge.
 * Short markers land on a clause or sentence boundary. Full references
 * are listed once under a References heading. The selected wording stays.
 */

/**
 * Whole words, the same list as Rust's `instruction_is_cite_shaped` in
 * commands/redline.rs. A substring test also took "excited" and "resources", so an
 * ordinary rewrite went into the citation merge, painted nothing, and Accept
 * changed nothing.
 */
const CITE_SHAPED_WORDS = new Set([
  "cite",
  "citation",
  "citations",
  "source",
  "sources",
  "footnote",
  "footnotes",
]);

/** Words cut the way Rust's `cite_words` cuts them. */
function citeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((word) => word.length > 0);
}

const REFERENCES_SPLIT = /\n+#{0,3}[ \t]*references[ \t]*\n+/i;
const URL_RE = /https?:\/\/\S+/g;
const TERMINATOR_RE = /https?:\/\/\S+|\bdoi:\s*10\.\d{4,9}\/\S+/gi;
const MARKER_PARENS = /\([^()\n]{1,80}(?:19|20)\d{2}\)/g;
const MARKER_BRACKETS = /\[\d+\]/g;

type CiteOutput = {
  markers: string;
  references: string[];
};

export function instructionIsCiteShaped(instruction: string): boolean {
  return citeWords(instruction).some((word) => CITE_SHAPED_WORDS.has(word));
}

/** Collapse a doubled colon (and the same class of doubled punctuation). */
export function tidyPunctuation(text: string): string {
  return text
    .replace(/:{2,}/g, ":")
    .replace(/;{2,}/g, ";")
    .replace(/,{2,}/g, ",")
    .replace(/\?{2,}/g, "?")
    .replace(/!{2,}/g, "!");
}

function isShortMarker(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 120 || /https?:\/\//.test(trimmed) || trimmed.includes("\n")) {
    return false;
  }
  return (
    /^\([^()\n]{1,100}\)$/.test(trimmed) ||
    /^\[\d+\](?:\s+\[\d+\])*$/.test(trimmed) ||
    /^\[[^\]\n]{1,60}\]$/.test(trimmed)
  );
}

function extractMarkers(text: string): string[] {
  const found = [...text.matchAll(MARKER_PARENS), ...text.matchAll(MARKER_BRACKETS)].map(
    (match) => match[0],
  );
  return [...new Set(found)];
}

function joinMarkers(markers: string[]): string {
  if (markers.length === 0) return "";
  if (markers.length === 1) return markers[0] ?? "";
  if (markers.every((marker) => marker.startsWith("(") && marker.endsWith(")"))) {
    const inner = markers.map((marker) => marker.slice(1, -1)).join("; ");
    return `(${inner})`;
  }
  return markers.join(" ");
}

/** A later terminator is another reference only when the gap looks like authors. */
function looksLikeNextReference(gap: string): boolean {
  const text = gap.replace(/^[\s.;]+/, "");
  if (!text) return true;
  if (/^[a-z]/.test(text)) return false;
  return /[A-Z][a-zA-Z'’-]{2,}\s+(?:[A-Z]\.?){1,3}(?![a-zA-Z])/.test(text);
}

function terminatorEnd(chunk: string, index: number, raw: string): number {
  // ponytail: `\S+` can swallow ".indicates" when the answer omits the space.
  // A real DOI/URL does not end in a lowercase word. Upgrade: a citation parser.
  const glued = /\.([a-z]{4,})$/i.exec(raw);
  if (glued && !/^(pdf|html|shtml|php|asp|aspx)$/i.test(glued[1] ?? "")) {
    return index + raw.length - glued[0].length;
  }
  let end = index + raw.length;
  if (chunk[end] === "." && (end + 1 >= chunk.length || /\s/.test(chunk[end + 1] ?? ""))) end += 1;
  return end;
}

function splitOnTerminators(chunk: string): string[] {
  const matches = [...chunk.matchAll(TERMINATOR_RE)];
  if (matches.length === 0) return [];
  const entries: string[] = [];
  let start = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    if (entries.length > 0 && !looksLikeNextReference(chunk.slice(start, index))) break;
    const end = terminatorEnd(chunk, index, match[0]);
    const entry = chunk
      .slice(start, end)
      .replace(/^[;\s]+/g, "")
      .replace(/[;\s]+$/g, "")
      .trim();
    if (entry) entries.push(entry);
    start = end;
  }
  return entries;
}

/** Drop a sentence glued on after the bibliography with no blank line. */
function cutGluedProse(chunk: string): string {
  const cleaned = chunk.replace(/^[-*]\s+/, "").trim();
  const cut = /\.\s+(?!https?:\/\/|doi:\s*10\.)[a-z]/.exec(cleaned);
  if (!cut || cut.index == null) return cleaned;
  const head = cleaned.slice(0, cut.index + 1);
  const tail = cleaned.slice(cut.index + 1).trim();
  if (tail.length >= 40 && /\b(?:19|20)\d{2}\b/.test(head) && /[A-Z][a-zA-Z'’-]{2,}/.test(head)) {
    // A lowercase title after the year is still this reference. The URL is in the tail.
    if (!/https?:\/\//.test(head) && /https?:\/\//.test(tail)) return cleaned;
    return head.trim();
  }
  return cleaned;
}

function parseReferenceEntries(body: string): string[] {
  const chunks = body
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const entries: string[] = [];
  for (const chunk of chunks) {
    const split = splitOnTerminators(chunk);
    if (split.length > 0) entries.push(...split.map(cutGluedProse));
    else entries.push(cutGluedProse(chunk));
  }
  return entries.filter(Boolean);
}

function looksLikeBibliography(text: string): boolean {
  if (isShortMarker(text)) return false;
  return (
    /https?:\/\/|doi\.org|\bdoi:\s*10\./i.test(text) ||
    (/\bet al\b/i.test(text) && text.length > 80)
  );
}

function surnames(entry: string): { names: string[]; etAl: boolean } {
  const head = entry.split(/https?:\/\//)[0] ?? entry;
  const etAl = /\bet al\b/i.test(head);
  const scanned = etAl ? (head.split(/\bet al\b/i)[0] ?? head) : head;
  const names: string[] = [];
  const re = /([A-Z][a-zA-Z'’-]{2,})\s+(?:[A-Z]\.?){1,4}(?![a-zA-Z])/g;
  for (const match of scanned.matchAll(re)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return { names, etAl };
}

function publicationYear(entry: string): string | undefined {
  const years = entry.match(/\b(?:19|20)\d{2}\b/g);
  return years?.[years.length - 1];
}

function markerForEntry(entry: string, index: number): string {
  const year = publicationYear(entry);
  const { names, etAl } = surnames(entry);
  if (!year) return `[${index + 1}]`;
  if (etAl || names.length >= 3) {
    const who = names[0] ?? "Source";
    return `(${who} et al., ${year})`;
  }
  if (names.length === 2) return `(${names[0]} & ${names[1]}, ${year})`;
  if (names.length === 1) return `(${names[0]}, ${year})`;
  return `[${index + 1}]`;
}

/** Turn the answer into a short marker plus full references, once each. */
export function formatCiteOutput(raw: string): CiteOutput {
  const text = tidyPunctuation(raw.trim());
  if (!text) return { markers: "", references: [] };

  const parts = text.split(REFERENCES_SPLIT);
  const head = (parts[0] ?? "").trim();
  const refBody = parts.slice(1).join("\n").trim();
  const listed = refBody ? parseReferenceEntries(refBody) : [];

  if (isShortMarker(head) && listed.length === 0 && parts.length === 1) {
    return { markers: head.trim(), references: [] };
  }

  let markers = joinMarkers(extractMarkers(head));
  let references = listed;

  if (references.length === 0 && parts.length === 1 && looksLikeBibliography(text)) {
    references = parseReferenceEntries(text);
  }
  if (!markers && references.length > 0) {
    markers = joinMarkers(references.map((entry, index) => markerForEntry(entry, index)));
  } else if (!markers && isShortMarker(head)) {
    markers = head.trim();
  }

  return { markers: tidyPunctuation(markers), references: dedupeReferences(references) };
}

function normalizeRef(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeReferences(references: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const reference of references) {
    const key = normalizeRef(reference);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(reference.trim());
  }
  return out;
}

function hasReferencesHeading(doc: string): boolean {
  return /(?:^|\n)#{0,3}[ \t]*references[ \t]*(?:\n|$)/i.test(doc);
}

function docHasReference(doc: string, reference: string): boolean {
  if (normalizeRef(doc).includes(normalizeRef(reference))) return true;
  const urls = reference.match(URL_RE) ?? [];
  return urls.some((url) => doc.includes(url.replace(/[.,;]+$/, "")));
}

function referenceSuffix(doc: string, references: string[]): string {
  const fresh = references.filter((reference) => !docHasReference(doc, reference));
  if (fresh.length === 0) return "";
  const block = fresh.join("\n\n");
  if (hasReferencesHeading(doc)) return `\n\n${block}\n`;
  return `\n\n## References\n\n${block}\n`;
}

/** Index in `doc` where the marker should be inserted (before punctuation). */
function markerInsertAt(doc: string, to: number): number {
  const clamped = Math.max(0, Math.min(to, doc.length));
  if (clamped >= doc.length) return doc.length;
  for (let index = clamped; index < doc.length; index++) {
    const ch = doc[index] ?? "";
    if (ch === "\n") return index;
    if (ch === "." && index > 0 && /\d/.test(doc[index - 1] ?? "")) {
      const next = doc[index + 1] ?? "";
      if (/\d/.test(next)) continue;
    }
    if (/[.!?;:]/.test(ch)) return index;
  }
  return doc.length;
}

function withSpacing(doc: string, at: number, marker: string): string {
  const text = marker.trim();
  if (!text) return "";
  const prev = at > 0 ? (doc[at - 1] ?? "") : "";
  const next = at < doc.length ? (doc[at] ?? "") : "";
  const prefix = prev !== "" && !/\s/.test(prev) ? " " : "";
  const suffix = next !== "" && !/\s/.test(next) && !/^[.!?;:,]/.test(next) ? " " : "";
  return `${prefix}${text}${suffix}`;
}

/** A leading space when `text` is inserted at `at` and the previous character is not whitespace. */
function spacedInsert(doc: string, at: number, text: string): string {
  if (!text || /^\s/.test(text)) return text;
  const prev = at > 0 ? (doc[at - 1] ?? "") : "";
  return prev !== "" && !/\s/.test(prev) ? ` ${text}` : text;
}

/** `[n]` becomes a link to the matching numbered reference line. Other markers stay. */
export function linkCiteMarkers(text: string, references: readonly string[]): string {
  const numbered = new Set<string>();
  for (const reference of references) {
    const match = /^\[(\d+)\]\s+\S/.exec(reference.trim());
    if (match?.[1]) numbered.add(match[1]);
  }
  if (numbered.size === 0) return text;
  return text.replace(/\[(\d+)\]/g, (full, n: string) =>
    numbered.has(n) ? `[\\[${n}\\]](#ref-${n})` : full,
  );
}

/** Document offset of the reference line for `#ref-n`, or null. */
export function referenceAnchorPos(content: string, anchor: string): number | null {
  const n = /^ref-(\d+)$/.exec(anchor)?.[1];
  if (!n) return null;
  const match = new RegExp(`^(?:#{1,6}[ \\t]+)?\\[${n}\\][ \\t]+\\S`, "m").exec(content);
  return match?.index ?? null;
}

type TextChange = { from: number; to: number; insert: string };

export function citationChanges(doc: string, _from: number, to: number, raw: string): TextChange[] {
  const cite = formatCiteOutput(raw);
  const at = markerInsertAt(doc, to);
  const markers = linkCiteMarkers(cite.markers, cite.references);
  const spaced = markers ? withSpacing(doc, at, markers) : "";
  const suffix = referenceSuffix(doc, cite.references);
  if (!spaced && !suffix) return [];
  if (at === doc.length) {
    return [{ from: at, to: at, insert: `${spaced}${suffix}` }];
  }
  const changes: TextChange[] = [];
  if (spaced) changes.push({ from: at, to: at, insert: spaced });
  if (suffix) changes.push({ from: doc.length, to: doc.length, insert: suffix });
  return changes;
}

/**
 * A fact check is not cite-shaped, so the cite merge does not run. The
 * corrected sentence stays on the selection. The References block goes to
 * the end of the note. `null` means there is no References heading to lift.
 */
export function referenceBearingChanges(
  doc: string,
  from: number,
  to: number,
  raw: string,
  intent: "insert" | "replace",
): TextChange[] | null {
  const text = tidyPunctuation(raw.trim());
  const parts = text.split(REFERENCES_SPLIT);
  if (parts.length < 2) return null;
  const references = parseReferenceEntries(parts.slice(1).join("\n"));
  const head = linkCiteMarkers((parts[0] ?? "").trim(), references);
  if (!head || references.length === 0) return null;
  // The span is about to be replaced. A URL that lives only there is not already in the note.
  const kept = intent === "replace" ? `${doc.slice(0, from)}${doc.slice(to)}` : doc;
  const suffix = referenceSuffix(kept, references);
  const atEnd = to >= doc.length;
  const insertAt = intent === "insert" ? to : from;
  const body = spacedInsert(doc, insertAt, head);
  if (intent === "insert") {
    if (atEnd) return [{ from: doc.length, to: doc.length, insert: `${body}${suffix}` }];
    const changes: TextChange[] = [{ from: to, to, insert: body }];
    if (suffix) changes.push({ from: doc.length, to: doc.length, insert: suffix });
    return changes;
  }
  if (atEnd) return [{ from, to: doc.length, insert: `${body}${suffix}` }];
  const changes: TextChange[] = [{ from, to, insert: body }];
  if (suffix) changes.push({ from: doc.length, to: doc.length, insert: suffix });
  return changes;
}

/**
 * Pending cite notes preview the Accept merge. `null` means paint `proposed`
 * the ordinary way, including a caution rewrite. An empty list means the cite
 * merge inserts nothing.
 */
export function citePreviewChanges(
  doc: string,
  note: {
    from: number;
    to: number;
    proposed: string | null;
    instruction: string | null;
    intent: string | null;
    status: string;
    caution?: string | null;
  },
): TextChange[] | null {
  if (note.caution?.trim()) return null;
  if (note.status !== "pending") return null;
  if (note.intent !== "insert" && note.intent !== "replace") return null;
  if (!note.proposed || note.instruction == null) return null;
  if (!instructionIsCiteShaped(note.instruction)) return null;
  return citationChanges(doc, note.from, note.to, note.proposed);
}

/** Merge a cite suggestion into the document. Original wording stays put. */
export function applyCitation(doc: string, from: number, to: number, raw: string): string {
  const changes = [...citationChanges(doc, from, to, raw)].sort((a, b) => b.from - a.from);
  let next = doc;
  for (const change of changes) {
    next = next.slice(0, change.from) + change.insert + next.slice(change.to);
  }
  return next;
}
