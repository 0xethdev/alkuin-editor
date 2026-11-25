import {
  editYamlFrontmatter,
  makeEntryId,
  readYamlFrontmatter,
  type YamlEdit,
  type YamlEntry,
  type YamlStyle,
} from "@/lib/yaml-entries";

// State machine for the frontmatter panel. Pure: every transition returns the
// next panel, and the ones that can change the file also return the store
// write. `useFrontmatterEntries` applies both.
//
// Panel modes:
//   - absent:   the file has no frontmatter block. Nothing renders.
//   - unparsed: the block is invalid YAML, not a mapping, or a mapping the
//               rows can't edit exactly (see `readYamlFrontmatter`). It is
//               shown and edited as raw text and written back verbatim.
//   - entries:  the block is a mapping (or blank), shown as key/value rows.
//               There is always at least one row; a blank block shows one
//               placeholder. `yaml` is the stored text the rows mirror; each
//               edit is applied to it through yaml's Document model, so only
//               the touched property changes.
//
// Rows: `writtenKey` is the key a row holds in `yaml`, or null when it holds
// none (a placeholder, a cleared key). A typed key another property already
// has is refused, so `key` and `writtenKey` differ until the name is unique
// or focus leaves (which shows the stored row again).
//
// The block is removed only by an explicit delete (the row's remove button,
// or Backspace in an empty row) of the last row. Blur only tidies rows locally
// and never writes, so focus moving around (including the editor taking focus
// on mount) can't change the file.

export interface FrontmatterRow extends YamlEntry {
  // Focus the key input when the row mounts. Set once, when the user asks for
  // the row (Add property, Enter on the last value). Never derived from the
  // row's contents, so emptying a row can't flip it and steal focus.
  autoFocus: boolean;
  writtenKey: string | null;
}

export type FrontmatterPanelState =
  | { mode: "absent" }
  | { mode: "unparsed"; text: string }
  | { mode: "entries"; rows: FrontmatterRow[]; yaml: string; style: YamlStyle };

type EntriesPanel = Extract<FrontmatterPanelState, { mode: "entries" }>;

export type FrontmatterWrite =
  | { kind: "none" }
  | { kind: "set"; yaml: string }
  // Only `deleteFrontmatterRow` produces this.
  | { kind: "remove" };

export interface FrontmatterStep {
  panel: FrontmatterPanelState;
  write: FrontmatterWrite;
}

const NO_WRITE: FrontmatterWrite = { kind: "none" };

function placeholderRow(autoFocus: boolean): FrontmatterRow {
  return {
    id: makeEntryId(),
    key: "",
    value: "",
    isComplex: false,
    autoFocus,
    writtenKey: null,
  };
}

function isBlankRow(row: YamlEntry): boolean {
  return row.key === "" && row.value === "";
}

/** The typed key is waiting on a name another property already has. */
export function isPendingKey(row: FrontmatterRow): boolean {
  return row.key.trim() !== "" && row.key !== row.writtenKey;
}

function withRow(panel: EntriesPanel, index: number, row: FrontmatterRow): FrontmatterRow[] {
  return panel.rows.map((r, i) => (i === index ? row : r));
}

/** Apply `edit` to the stored text. A refused edit (a duplicate key, a value
 *  YAML can't read) keeps the typed text on the row and writes nothing. */
function applyEdit(
  panel: EntriesPanel,
  rows: FrontmatterRow[],
  edit: YamlEdit,
  onRefused: FrontmatterRow[],
): FrontmatterStep {
  const result = editYamlFrontmatter(panel.yaml, panel.style, edit);
  if (!result.ok) return { panel: { ...panel, rows: onRefused }, write: NO_WRITE };
  return {
    panel: { ...panel, rows, yaml: result.yaml },
    write: result.yaml === panel.yaml ? NO_WRITE : { kind: "set", yaml: result.yaml },
  };
}

export function frontmatterPanelFromStore(frontmatter: string | null): FrontmatterPanelState {
  if (frontmatter === null) return { mode: "absent" };
  const read = readYamlFrontmatter(frontmatter);
  if (read.kind === "unparsed") return { mode: "unparsed", text: frontmatter };
  const rows =
    read.entries.length === 0
      ? [placeholderRow(false)]
      : read.entries.map((entry) => ({ ...entry, autoFocus: false, writtenKey: entry.key }));
  return { mode: "entries", rows, yaml: frontmatter, style: read.style };
}

export function editFrontmatterRow(
  panel: FrontmatterPanelState,
  index: number,
  field: "key" | "value",
  value: string,
): FrontmatterStep {
  if (panel.mode !== "entries") return { panel, write: NO_WRITE };
  const row = panel.rows[index];
  if (!row) return { panel, write: NO_WRITE };
  const typed: FrontmatterRow = { ...row, [field]: value };
  const refused = withRow(panel, index, typed);

  if (field === "value") {
    if (row.writtenKey === null) return { panel: { ...panel, rows: refused }, write: NO_WRITE };
    return applyEdit(
      panel,
      refused,
      { kind: "set-value", key: row.writtenKey, text: value, isComplex: row.isComplex },
      refused,
    );
  }

  if (value.trim() === "") {
    // Clearing the key takes the property out of the file; the row stays
    // local until focus leaves.
    const cleared = withRow(panel, index, { ...typed, writtenKey: null });
    if (row.writtenKey === null) return { panel: { ...panel, rows: cleared }, write: NO_WRITE };
    return applyEdit(panel, cleared, { kind: "delete", key: row.writtenKey }, refused);
  }

  const written = withRow(panel, index, { ...typed, writtenKey: value });
  if (row.writtenKey !== null) {
    return applyEdit(panel, written, { kind: "rename", from: row.writtenKey, to: value }, refused);
  }
  // A new property goes where the row sits among the written ones.
  const at = panel.rows.slice(0, index).filter((r) => r.writtenKey !== null).length;
  return applyEdit(
    panel,
    written,
    { kind: "add", key: value, text: row.value, isComplex: row.isComplex, at },
    refused,
  );
}

// Explicit delete: the remove button, or Backspace in an empty row. Deleting
// the last row removes the block.
export function deleteFrontmatterRow(panel: FrontmatterPanelState, index: number): FrontmatterStep {
  if (panel.mode !== "entries") return { panel, write: NO_WRITE };
  const row = panel.rows[index];
  if (!row) return { panel, write: NO_WRITE };
  const rows = panel.rows.filter((_, i) => i !== index);
  if (rows.length === 0) return { panel: { mode: "absent" }, write: { kind: "remove" } };
  if (row.writtenKey === null) return { panel: { ...panel, rows }, write: NO_WRITE };
  return applyEdit(panel, rows, { kind: "delete", key: row.writtenKey }, panel.rows);
}

// Focus left a row. A row that holds no property is dropped from the list
// (the panel keeps one placeholder rather than going empty). A written row
// shows what the file holds again, which drops a refused duplicate key or an
// unreadable value. Never writes.
export function blurFrontmatterRow(
  panel: FrontmatterPanelState,
  index: number,
): FrontmatterPanelState {
  if (panel.mode !== "entries") return panel;
  const row = panel.rows[index];
  if (!row) return panel;

  if (row.writtenKey !== null) {
    const read = readYamlFrontmatter(panel.yaml);
    if (read.kind !== "entries") return panel;
    const stored = read.entries.find((entry) => entry.key === row.writtenKey);
    if (!stored || (stored.key === row.key && stored.value === row.value)) return panel;
    return {
      ...panel,
      rows: withRow(panel, index, { ...row, key: stored.key, value: stored.value }),
    };
  }

  const rows = panel.rows.filter((_, i) => i !== index);
  if (rows.length > 0) return { ...panel, rows };
  if (isBlankRow(row)) return panel;
  return { ...panel, rows: [placeholderRow(false)] };
}

export function addFrontmatterRow(panel: FrontmatterPanelState): FrontmatterPanelState {
  if (panel.mode !== "entries") return panel;
  return { ...panel, rows: [...panel.rows, placeholderRow(true)] };
}

// Raw edits are written verbatim; nothing is parsed or rebuilt.
export function editFrontmatterText(panel: FrontmatterPanelState, text: string): FrontmatterStep {
  if (panel.mode !== "unparsed" || text === panel.text) return { panel, write: NO_WRITE };
  return { panel: { mode: "unparsed", text }, write: { kind: "set", yaml: text } };
}

// Focus left the raw text. If the text now reads as rows, show it as rows.
// Display only: the store already holds exactly what the user typed.
export function blurFrontmatterText(panel: FrontmatterPanelState): FrontmatterPanelState {
  if (panel.mode !== "unparsed") return panel;
  const next = frontmatterPanelFromStore(panel.text);
  return next.mode === "entries" ? next : panel;
}
