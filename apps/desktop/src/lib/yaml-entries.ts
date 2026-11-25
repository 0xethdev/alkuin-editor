import {
  Document,
  Scalar,
  isCollection,
  isMap,
  isScalar,
  parse,
  parseDocument,
  visit,
  type Node,
  type Pair,
  type ToStringOptions,
  type YAMLMap,
} from "yaml";

// Frontmatter as key/value rows, read and edited through yaml's Document
// model so an edit touches only the node it changes: untouched values keep
// their quoting, number format, nulls and comments. A block is offered as
// rows only when the Document reproduces it byte for byte; anything else is
// `unparsed` and edited as raw text.

export interface YamlEntry {
  // Stable identity for React list keys. Generated on creation; never
  // written to the YAML.
  id: string;
  key: string;
  /** Single-line display text. A collection shows in flow style. */
  value: string;
  isComplex: boolean;
}

let nextEntryId = 0;
export function makeEntryId(): string {
  return `fm-${nextEntryId++}`;
}

/** The stringify options that reproduce a block exactly. Edits render with
 *  the same ones, so bytes outside the edited node don't move. */
export type YamlStyle = Readonly<ToStringOptions>;

const BASE_STYLE = { lineWidth: 0, flowCollectionPadding: false } as const;
const STYLES: readonly YamlStyle[] = [
  { ...BASE_STYLE, indentSeq: true },
  { ...BASE_STYLE, indentSeq: false },
];
export const DEFAULT_YAML_STYLE: YamlStyle = STYLES[0]!;

/**
 * What a frontmatter block reads as.
 *
 * - `entries`: a mapping the rows can edit without changing anything they
 *   don't touch (or a blank block).
 * - `unparsed`: invalid YAML (including duplicate keys), YAML that is not a
 *   mapping (a comment-only block, a list, a scalar), or a mapping the rows
 *   can't express exactly (multi-line strings, aliases, complex keys,
 *   formatting the writer wouldn't reproduce). The caller keeps it verbatim.
 */
export type YamlFrontmatter =
  | { kind: "entries"; entries: YamlEntry[]; style: YamlStyle }
  | { kind: "unparsed"; reason: "invalid" | "not-mapping" | "not-editable" };

function render(doc: Document, style: YamlStyle): string {
  return doc.toString(style).replace(/\n$/, "");
}

function keyText(pair: Pair): string | null {
  const key = pair.key;
  if (!isScalar(key)) return null;
  const value = key.value;
  if (typeof value === "string") return value.includes("\n") ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function hasAlias(doc: Document): boolean {
  let found = false;
  visit(doc, {
    Alias() {
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

function rowsCanEdit(doc: Document, map: YAMLMap): boolean {
  if (hasAlias(doc)) return false;
  for (const item of map.items) {
    if (keyText(item) === null) return false;
    const value = item.value;
    if (value === null || value === undefined || isCollection(value)) continue;
    if (!isScalar(value)) return false;
    // A single-line input can't hold a newline; editing would flatten it.
    if (typeof value.value === "string" && value.value.includes("\n")) return false;
  }
  return true;
}

function displayValue(doc: Document, node: unknown): string {
  if (node === null || node === undefined) return "";
  if (isCollection(node)) {
    return new Document(node.toJS(doc)).toString({ ...BASE_STYLE, collectionStyle: "flow" }).trim();
  }
  if (isScalar(node)) {
    if (typeof node.value === "string") return node.value;
    // Numbers, booleans and nulls show as written: `1.10`, `~`, or nothing.
    if (node.source !== undefined) return node.source;
    const value = node.value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }
  return "";
}

export function readYamlFrontmatter(yamlString: string): YamlFrontmatter {
  if (!yamlString.trim()) return { kind: "entries", entries: [], style: DEFAULT_YAML_STYLE };

  const doc = parseDocument(yamlString);
  if (doc.errors.length > 0) return { kind: "unparsed", reason: "invalid" };
  const map = doc.contents;
  if (!isMap(map)) return { kind: "unparsed", reason: "not-mapping" };
  if (!rowsCanEdit(doc, map)) return { kind: "unparsed", reason: "not-editable" };
  const style = STYLES.find((candidate) => render(doc, candidate) === yamlString);
  if (!style) return { kind: "unparsed", reason: "not-editable" };

  const entries = map.items.map(
    (pair): YamlEntry => ({
      id: makeEntryId(),
      key: keyText(pair)!,
      value: displayValue(doc, pair.value),
      isComplex: isCollection(pair.value),
    }),
  );
  return { kind: "entries", entries, style };
}

export type YamlEdit =
  /** Replace a value. `isComplex` rows hold YAML flow text. */
  | { kind: "set-value"; key: string; text: string; isComplex: boolean }
  | { kind: "rename"; from: string; to: string }
  /** Insert a property at position `at` among the written properties. */
  | { kind: "add"; key: string; text: string; isComplex: boolean; at: number }
  | { kind: "delete"; key: string };

export type YamlEditResult =
  | { ok: true; yaml: string }
  | { ok: false; reason: "duplicate-key" | "invalid-value" | "missing-key" | "not-editable" };

function emptyScalar(): Scalar {
  // Renders as `key:` — the way an empty value reads in a file.
  const scalar = new Scalar(null);
  scalar.source = "";
  return scalar;
}

/** The node for a scalar row the user typed `text` into. A value that was
 *  a string stays a string with its quoting; anything else reads the text
 *  the way YAML would read it back (`42`, `true`, `1.10`, `0x1F`, nothing),
 *  and text that isn't a plain scalar stays the literal string. */
function typedScalar(original: unknown, text: string): Node {
  if (isScalar(original) && typeof original.value === "string") {
    original.value = text;
    return original;
  }
  if (text.trim() === "") return emptyScalar();
  const read = parseDocument(text);
  const node = read.contents;
  if (read.errors.length === 0 && isScalar(node)) return node;
  return new Scalar(text);
}

function typedValue(
  doc: Document,
  original: unknown,
  text: string,
  isComplex: boolean,
): Node | null {
  if (!isComplex) return typedScalar(original, text);
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return typedScalar(null, text);
  const node = doc.createNode(parsed);
  // Keep the block or flow style the value was written in.
  if (isCollection(node)) node.flow = isCollection(original) ? (original.flow ?? false) : true;
  return node;
}

function pairIndex(map: YAMLMap, key: string): number {
  return map.items.findIndex((pair) => keyText(pair) === key);
}

function commentLines(comment: string): string {
  return comment
    .split("\n")
    .map((line) => `#${line}`)
    .join("\n");
}

/**
 * Apply one row edit to `yaml` (a block `readYamlFrontmatter` read as
 * entries) and render it with `style`. Only the touched node changes.
 * A key another row already has is refused, never overwritten.
 */
export function editYamlFrontmatter(
  yaml: string,
  style: YamlStyle,
  edit: YamlEdit,
): YamlEditResult {
  const doc = yaml.trim() ? parseDocument(yaml) : new Document({});
  const map = doc.contents;
  if (doc.errors.length > 0 || !isMap(map)) return { ok: false, reason: "not-editable" };

  switch (edit.kind) {
    case "set-value": {
      const pair = map.items[pairIndex(map, edit.key)];
      if (!pair) return { ok: false, reason: "missing-key" };
      const node = typedValue(doc, pair.value, edit.text, edit.isComplex);
      if (!node) return { ok: false, reason: "invalid-value" };
      pair.value = node;
      break;
    }
    case "rename": {
      const pair = map.items[pairIndex(map, edit.from)];
      if (!pair || !isScalar(pair.key)) return { ok: false, reason: "missing-key" };
      if (edit.to === edit.from) break;
      if (pairIndex(map, edit.to) !== -1) return { ok: false, reason: "duplicate-key" };
      pair.key.value = edit.to;
      break;
    }
    case "add": {
      if (pairIndex(map, edit.key) !== -1) return { ok: false, reason: "duplicate-key" };
      const node = typedValue(doc, null, edit.text, edit.isComplex);
      if (!node) return { ok: false, reason: "invalid-value" };
      const at = Math.max(0, Math.min(edit.at, map.items.length));
      map.items.splice(at, 0, doc.createPair(edit.key, node));
      break;
    }
    case "delete": {
      const index = pairIndex(map, edit.key);
      const pair = map.items[index];
      if (!pair) return { ok: false, reason: "missing-key" };
      // A comment above the key (often the block's opening comment) moves to
      // the next key instead of leaving with the property.
      const comment = isScalar(pair.key) ? pair.key.commentBefore : undefined;
      map.items.splice(index, 1);
      if (comment) {
        const next = map.items[index];
        if (next && isScalar(next.key)) {
          next.key.commentBefore = next.key.commentBefore
            ? `${comment}\n${next.key.commentBefore}`
            : comment;
        } else {
          doc.comment = doc.comment ? `${comment}\n${doc.comment}` : comment;
        }
      }
      break;
    }
  }

  if (map.items.length === 0) {
    // No properties left: an empty block, keeping any comments (rendering
    // the empty mapping would write `{}`).
    const comments = [doc.commentBefore, doc.comment].filter(Boolean).join("\n");
    return { ok: true, yaml: comments ? commentLines(comments) : "" };
  }
  return { ok: true, yaml: render(doc, style) };
}
