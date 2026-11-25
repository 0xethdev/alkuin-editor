import { useEffect, useRef, type ReactNode } from "react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { headingDecorations } from "@/components/editor-area/heading-decorations";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { FileIcon, FolderIcon } from "@/components/sidebar/file-tree-icons";
import { SIDEBAR_SECTION_LABEL_CLASS } from "@/components/sidebar/sidebar-section";
import { InvitePopover } from "@/features/document-share/invite-popover";
import { KEEP_ON_MAC_LABEL } from "@/lib/keep-on-mac";
import { getDocumentStats } from "@/lib/document-stats";
import {
  redlineDecorationsField,
  redlineSelectionTheme,
} from "@/features/redline-spike/decorations";
import { redlineGutter, stackGutterTops } from "@/features/redline-spike/gutter";
import type { RedlineNote } from "@/features/redline-spike/model";
import { redlineNotesField, redlineSeedNotes } from "@/features/redline-spike/notes";
import "@/App.css";
import "@/components/editor-area/prosemark-theme.css";
import "@/components/editor-area/type-altitude.css";
import "@/features/redline-spike/redline-spike.css";
import {
  COLLAB_DOC,
  COLLAB_NOTE,
  DOCUMENT_TITLE,
  INVITE_FOOTER,
  INVITED_EMAIL,
  MARGIN_NOTES,
  OWNER_DOC,
  READY_LINE,
  SEND_CHANGES,
  YOUR_COPY,
} from "./copy";
import "./preview.css";

export type InviteScreen = "invite" | "copy" | "margin";

const FILES = [DOCUMENT_TITLE, "Field notes", "A letter home"];
const COLLAB_NOTES = [COLLAB_NOTE];
const NO_NOTES: readonly RedlineNote[] = [];

function attributeMargin(view: EditorView): boolean {
  const gutter = view.dom.querySelector(".cm-redline-gutter");
  if (!gutter) return false;
  for (const el of gutter.querySelectorAll<HTMLElement>("[data-redline-note]")) {
    const id = el.dataset.redlineNote ?? "";
    if (!id.startsWith("maria")) continue;
    el.dataset.author = "maria";
    el.querySelector("[data-redline-action='edit-ask']")?.remove();
  }
  const help = gutter.querySelector<HTMLElement>('[data-redline-note="help-weather"]');
  if (help) help.dataset.author = "assistant";
  // The gutter's first paint uses a 140px fallback and packs cards off their
  // lines. Place them once the real height is known.
  return alignCards(view, gutter, 28);
}

/** Sit each card on its passage. Drop it only when the previous card is still in the way. */
function alignCards(view: EditorView, gutter: Element, gap: number): boolean {
  const notes = [...view.state.field(redlineNotesField)].sort(
    (a, b) => a.from - b.from || a.id.localeCompare(b.id),
  );
  const cards = notes.map((note) =>
    gutter.querySelector<HTMLElement>(`[data-redline-note="${CSS.escape(note.id)}"]`),
  );
  if (cards.some((el) => !el || el.offsetHeight === 0)) return false;
  const preferred = notes.map((note) => view.lineBlockAt(note.from).top + view.documentPadding.top);
  const heights = cards.map((el) => el?.offsetHeight ?? 0);
  const tops = stackGutterTops(preferred, heights, gap);
  for (const [index, el] of cards.entries()) {
    if (el) el.style.top = `${tops[index]}px`;
  }
  const last = tops.length - 1;
  const needed = last >= 0 ? tops[last] + heights[last] + 12 : 0;
  if (gutter instanceof HTMLElement) {
    gutter.style.height = `${Math.max(gutter.offsetHeight, needed)}px`;
  }
  return true;
}

function Paper({
  doc,
  notes,
  attribute,
}: {
  doc: string;
  notes: readonly RedlineNote[];
  attribute: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [
          EditorView.lineWrapping,
          EditorView.editable.of(false),
          markdown({ extensions: [GFM] }),
          headingDecorations,
          redlineSeedNotes.of(notes),
          redlineNotesField,
          redlineDecorationsField,
          redlineSelectionTheme,
          redlineGutter,
        ],
      }),
    });
    let dead = false;
    let tries = 0;
    const finish = (ready: boolean) => {
      if (dead) return;
      tries += 1;
      const placed = !attribute || attributeMargin(view);
      if (!placed && tries < 8) {
        requestAnimationFrame(() => finish(ready));
        return;
      }
      if (ready) document.body.dataset.shotReady = "1";
    };
    const wait = document.fonts?.ready ?? Promise.resolve();
    void wait.then(async () => {
      await document.fonts?.load('16.5px "Paper Mono"');
      await document.fonts?.load('20px "Nothing You Could Do"');
      // The gutter restacks one frame after fonts, sometimes with a 140px
      // height fallback. Place cards after that frame, then once more.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          finish(false);
          requestAnimationFrame(() => finish(true));
        }),
      );
    });
    return () => {
      dead = true;
      view.destroy();
      delete document.body.dataset.shotReady;
    };
  }, [attribute, doc, notes]);
  return <div ref={host} className="invite-paper-host" />;
}

function FileRow({ name, active }: { name: string; active: boolean }) {
  return (
    <div
      className={`flex h-[32px] w-full items-center gap-1.5 overflow-hidden rounded-lg pr-2 text-left text-[13px] leading-[1.15] ${
        active ? "bg-[var(--surface-subtle)] text-[var(--fg-base)]" : "text-[var(--fg-base)]"
      }`}
      style={{ paddingLeft: 10 }}
    >
      <span
        className={`flex w-5 shrink-0 items-center justify-center ${active ? "" : "opacity-60"}`}
      >
        <FileIcon />
      </span>
      <span className={`min-w-0 truncate ${active ? "opacity-100" : "opacity-60"}`}>{name}</span>
    </div>
  );
}

function DeskChrome({ screen, children }: { screen: InviteScreen; children: ReactNode }) {
  return (
    <div
      className="invite-preview flex h-screen w-screen overflow-hidden text-[var(--text-secondary)]"
      data-variant="a"
      data-screen={screen}
    >
      <aside className="invite-sidebar flex h-full w-[240px] shrink-0 flex-col">
        <div className="shrink-0" style={{ height: 56 }} />
        <div className="min-h-0 flex-1 px-3">
          <div
            className="flex items-center"
            style={{ height: 56, paddingTop: 12, paddingBottom: 12 }}
          >
            <div className="relative flex h-[32px] w-full items-center rounded-lg bg-[var(--surface-input)] pl-[34px] pr-3 text-[13px] text-[var(--text-muted)]">
              <span className="pointer-events-none absolute left-2.5 top-1/2 flex -translate-y-1/2 items-center text-current">
                <HugeiconsIcon icon={Search01Icon} size={16} color="currentColor" strokeWidth={2} />
              </span>
              Search
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px]">
                ⌘P
              </kbd>
            </div>
          </div>
          <div className={SIDEBAR_SECTION_LABEL_CLASS}>Essays</div>
          <div className="mt-1 flex items-center gap-1.5 px-[10px] text-[13px] text-[var(--fg-base)] opacity-80">
            <FolderIcon isExpanded />
            <span>Essays</span>
          </div>
          <div className="mt-1 flex flex-col pl-3">
            {FILES.map((name) => (
              <FileRow key={name} name={name} active={name === DOCUMENT_TITLE} />
            ))}
          </div>
        </div>
        <div className="px-3 py-3 pl-[22px] text-[13px] text-[var(--text-muted)]">Essays</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center gap-3 pr-4"
          style={{ height: 56, paddingLeft: 12 }}
        >
          <span className="text-[var(--text-icon-muted)] opacity-30">←</span>
          <span className="text-[var(--text-icon-muted)] opacity-30">→</span>
          <div className="flex h-[32px] max-w-[180px] items-center rounded-[8px] bg-[var(--tab-active-bg)] px-3.5 text-[13px] text-[var(--text-secondary)]">
            <span className="truncate">{DOCUMENT_TITLE}</span>
          </div>
          <span className="text-[var(--text-icon-muted)]">+</span>
        </header>
        <div data-pane className="relative flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}

function Footer({ doc, left }: { doc: string; left?: ReactNode }) {
  const stats = getDocumentStats(doc);
  const plural = (label: string, count: number) => (count === 1 ? label.slice(0, -1) : label);
  return (
    <div
      data-document-footer
      className="absolute bottom-0 z-10 flex h-11 w-full items-center justify-end gap-5 px-6 text-[13px] leading-[1.15] text-[var(--text-muted)]"
    >
      <div className="mr-auto flex items-center gap-5">{left}</div>
      <span>
        {stats.words.toLocaleString()} {plural("words", stats.words)}
      </span>
      <span>
        {stats.characters.toLocaleString()} {plural("characters", stats.characters)}
      </span>
      <span>
        {stats.paragraphs.toLocaleString()} {plural("paragraphs", stats.paragraphs)}
      </span>
    </div>
  );
}

export function InvitePreview({ screen }: { screen: InviteScreen }) {
  const doc = screen === "copy" ? COLLAB_DOC : OWNER_DOC;
  const notes = screen === "margin" ? MARGIN_NOTES : screen === "copy" ? COLLAB_NOTES : NO_NOTES;
  return (
    <DeskChrome screen={screen}>
      <Paper doc={doc} notes={notes} attribute={screen === "margin"} />
      <Footer
        doc={doc}
        left={
          <>
            <span>{KEEP_ON_MAC_LABEL}</span>
            {screen === "invite" ? (
              <span className="relative text-[var(--fg-base)]">
                {INVITE_FOOTER}
                <InvitePopover
                  title={DOCUMENT_TITLE}
                  email={INVITED_EMAIL}
                  readOnly
                  onSend={() => undefined}
                />
              </span>
            ) : null}
            {screen === "copy" ? (
              <>
                <span>{YOUR_COPY}</span>
                <span className="text-[12px]">{READY_LINE}</span>
                <button type="button" className="invite-send invite-send-quiet">
                  {SEND_CHANGES}
                </button>
              </>
            ) : null}
          </>
        }
      />
    </DeskChrome>
  );
}
