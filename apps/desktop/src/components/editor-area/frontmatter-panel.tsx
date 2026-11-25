import { useCallback, useRef, type FocusEvent, type KeyboardEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { useFrontmatterEntries } from "./use-frontmatter-entries";
import {
  isPendingKey,
  type FrontmatterRow as FrontmatterRowState,
} from "./frontmatter-panel-state";

interface FrontmatterPanelProps {
  filePath: string;
}

const FIRST_KEY_SELECTOR = '[data-frontmatter] input[data-field="key"]';
const NO_ROWS: readonly FrontmatterRowState[] = [];

/** Focus the first key field of the frontmatter panel in `view`'s pane once
 *  it renders. The action that opens a new block (the `---` shortcut) calls
 *  this; the panel itself never focuses a row it didn't create, so a block
 *  that is already there on mount can't steal focus from the editor. */
export function focusNewFrontmatter(view: EditorView) {
  const pane = view.dom.closest("[data-pane]");
  requestAnimationFrame(() => {
    pane?.querySelector<HTMLInputElement>(FIRST_KEY_SELECTOR)?.focus();
  });
}

// Stable module-scope ref callback. A stable ref runs only on mount/unmount
// (never per-render), so this focuses the key input exactly once when a row
// the user asked for mounts — matching `autoFocus` without the attribute.
function focusOnMount(el: HTMLInputElement | null) {
  el?.focus();
}

interface FrontmatterRowProps {
  entry: FrontmatterRowState;
  index: number;
  onUpdate: (index: number, field: "key" | "value", value: string) => void;
  onRemove: (index: number) => void;
  onBlur: (index: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>, index: number, field: "key" | "value") => void;
}

function FrontmatterRow({
  entry,
  index,
  onUpdate,
  onRemove,
  onBlur,
  onKeyDown,
}: FrontmatterRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Another property already has the typed name, so it isn't written; focus
  // leaving the row shows the stored name again.
  const duplicate = isPendingKey(entry);

  // Blurs that move focus to another field in the same row (Tab from key to
  // value) should not trigger blur-cleanup. Filter those out via relatedTarget.
  const handleBlur = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      const next = e.relatedTarget as Node | null;
      if (next && rowRef.current?.contains(next)) return;
      onBlur(index);
    },
    [index, onBlur],
  );

  return (
    <div
      ref={rowRef}
      className="group -mx-3 flex items-center gap-4 rounded-lg px-3 py-1.5 focus-within:bg-[var(--surface-subtle)]"
    >
      <input
        data-field="key"
        type="text"
        aria-label="Property name"
        aria-invalid={duplicate || undefined}
        title={duplicate ? "Another property already has this name" : undefined}
        value={entry.key}
        onChange={(e) => onUpdate(index, "key", e.target.value)}
        onKeyDown={(e) => onKeyDown(e, index, "key")}
        onBlur={handleBlur}
        // `autoFocus` is fixed when the row is created, so this ref never
        // flips while the user types.
        ref={entry.autoFocus ? focusOnMount : undefined}
        placeholder="key"
        spellCheck={false}
        className="w-[clamp(5rem,25%,9rem)] shrink-0 bg-transparent text-[13px] leading-[1.15] text-[var(--text-muted)] outline-none placeholder:text-[var(--text-muted)] placeholder:opacity-70 aria-invalid:underline aria-invalid:decoration-dotted"
      />

      <input
        data-field="value"
        type="text"
        aria-label="Property value"
        value={entry.value}
        onChange={(e) => onUpdate(index, "value", e.target.value)}
        onKeyDown={(e) => onKeyDown(e, index, "value")}
        onBlur={handleBlur}
        placeholder="value"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[13px] leading-[1.15] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] placeholder:opacity-70"
      />

      <button
        type="button"
        onClick={() => onRemove(index)}
        aria-label="Remove property"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-icon-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] group-hover:opacity-100"
        tabIndex={-1}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2 2l6 6M8 2l-6 6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

interface FrontmatterTextProps {
  text: string;
  onChange: (text: string) => void;
  onBlur: () => void;
}

// A block the rows can't express (invalid YAML, or not a mapping) is edited as
// its raw text and written back verbatim.
function FrontmatterText({ text, onChange, onBlur }: FrontmatterTextProps) {
  return (
    <div data-frontmatter data-frontmatter-mode="unparsed" className="pb-6">
      <textarea
        aria-label="Frontmatter"
        value={text}
        rows={Math.max(1, text.split("\n").length)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        spellCheck={false}
        className="-mx-3 block w-[calc(100%+1.5rem)] resize-none rounded-lg bg-transparent px-3 py-1.5 font-mono text-[13px] leading-[1.4] text-[var(--text-muted)] outline-none focus:bg-[var(--surface-subtle)]"
      />
    </div>
  );
}

export function FrontmatterPanel({ filePath }: FrontmatterPanelProps) {
  const { panel, updateEntry, removeEntry, addEntry, blurEntry, updateText, blurText } =
    useFrontmatterEntries(filePath);
  const entries = panel.mode === "entries" ? panel.rows : NO_ROWS;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>, index: number, field: "key" | "value") => {
      if (e.key === "Enter" && field === "value" && index === entries.length - 1) {
        e.preventDefault();
        addEntry();
        // focusOnMount on the newly-mounted empty row handles focus — no RAF needed.
        return;
      }
      if (e.key === "Backspace" && entries[index]?.key === "" && entries[index]?.value === "") {
        e.preventDefault();
        removeEntry(index);
      }
    },
    [entries, addEntry, removeEntry],
  );

  if (panel.mode === "absent") return null;
  if (panel.mode === "unparsed") {
    return <FrontmatterText text={panel.text} onChange={updateText} onBlur={blurText} />;
  }

  return (
    <div data-frontmatter data-frontmatter-mode="entries" className="space-y-2 pb-6">
      <div className="flex flex-col gap-1.5">
        {entries.map((entry, index) => (
          <FrontmatterRow
            key={entry.id}
            entry={entry}
            index={index}
            onUpdate={updateEntry}
            onRemove={removeEntry}
            onBlur={blurEntry}
            onKeyDown={handleKeyDown}
          />
        ))}
      </div>

      <div className="flex items-center gap-4 pt-1">
        <button
          type="button"
          onClick={addEntry}
          className="flex items-center gap-1 text-[13px] leading-[1.15] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Add property
        </button>
      </div>
    </div>
  );
}
