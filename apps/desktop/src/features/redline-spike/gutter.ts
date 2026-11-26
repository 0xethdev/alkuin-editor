import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import {
  askErrorOf,
  isAgentCard,
  isDeciding,
  isOwnCommentNote,
  isToolCautionHold,
  noteShowsLocus,
  noteState,
  type NoteStateFields,
  type RedlineNote,
} from "./model";
import { redlineHandlersFacet, type RedlineHandlers } from "./decorations";
import { redlineFilePathFacet, redlineNotesField } from "./notes";
import {
  appendMentionChrome,
  bindMentionField,
  paintMentionText,
} from "@/features/note-mention/desk";
import { mentionQuery } from "@/features/note-mention/logic";
import { SIGN_IN_LABEL } from "@/lib/account-copy";
import { openAccountSignIn } from "@/lib/account-sign-in";
import { AGENT_CARD_LABEL } from "@/features/agent-proposal/copy";
import { DISMISS, fromPerson, NO_LONGER_MATCHES, noteFrom } from "@/features/document-share/copy";
import { startSubscription } from "@/lib/account-billing";
import {
  ACCEPTED_NOT_ADDED_LINE,
  AI_BADGE,
  AI_BADGE_TITLE,
  ASK_AI_HINT,
  ASK_ALKUIN_LABEL,
  BUY_CREDIT_LABEL,
  buyCreditFor,
  COMPOSE_ASK_ARIA,
  COMPOSE_CANCEL_LABEL,
  COMPOSE_NOTE_LABEL,
  COMPOSE_PLACEHOLDER,
  isCalmStatusLine,
  LEAVE_NOTE_LABEL,
  PLANS_URL,
  SEE_PLANS_LABEL,
  SHARE_CHANGES_LABEL,
  TRY_AGAIN_LABEL,
  seePlansFor,
  shareChangesOffered,
} from "./margin-copy";

export const REDLINE_GUTTER_WIDTH = 268;
const NOTE_GAP = 36;

/** ponytail: first paint can measure 0 before the hand loads; restack after fonts.
 *  A measured card uses its real height. Flooring every card at 140px pushed
 *  a short note off the next sentence. */
const NOTE_HEIGHT_FALLBACK = 140;

/** Zero means the card has not been laid out yet. A positive height is the card. */
export function measuredNoteHeight(measured: number): number {
  return measured > 0 ? measured : NOTE_HEIGHT_FALLBACK;
}

/** Dot on the gutter rule. CSS `.cm-redline-gutter-stub` diameter must match. */
export const GUTTER_STUB_WIDTH = 6;

/** First line of the compose hand. A tall textarea would drop the dot into the box. */
export function composeStubSpan(
  box: { top: number; height: number },
  lineHeight: number,
): { top: number; bottom: number } {
  const line = lineHeight > 0 && lineHeight <= box.height ? lineHeight : box.height;
  return { top: box.top, bottom: box.top + line };
}

/** ponytail: greedy Y-pack, O(n) in note count. Upgrade: collide against other chrome. */
export function stackGutterTops(
  preferred: readonly number[],
  heights: readonly number[],
  gap: number,
): number[] {
  const tops: number[] = [];
  let nextFree = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < preferred.length; i++) {
    const y = Math.max(preferred[i] ?? 0, nextFree);
    tops.push(y);
    nextFree = y + (heights[i] ?? 0) + gap;
  }
  return tops;
}

/** B2 stub y: last-glyph midline, relative to the gutter overlay. */
export function gutterStubTop(span: { top: number; bottom: number }, gutterTop: number): number {
  return (span.top + span.bottom) / 2 - gutterTop;
}

/** Accepted cards stay out of the margin unless Share changes is actually offered. */
export function marginNoteVisible(note: Pick<RedlineNote, "status" | "git">): boolean {
  if (note.status !== "accepted") return true;
  return shareChangesOffered(note.git?.sharing);
}

type NotesCountHost = { dataset: DOMStringMap };

/**
 * How many cards the margin shows, as `data-redline-notes`. The editor's copy sets the
 * draft's pads. The pane's copy sets the properties panel's, which sits outside the
 * editor in the same column (redline-spike.css). The pane is written only when the
 * count changes, so a redraw restyles nothing above the editor.
 */
export function markNotesShown(
  editor: NotesCountHost,
  pane: NotesCountHost | null,
  count: number,
): void {
  const shown = String(count);
  editor.dataset.redlineNotes = shown;
  if (pane && pane.dataset.redlineNotes !== shown) pane.dataset.redlineNotes = shown;
}

export function redlineNoteClassName(note: RedlineNote): string {
  const intent = note.intent ?? (note.status === "accepted" ? "accepted" : "open");
  return `cm-redline-note cm-redline-ink cm-redline-note-${intent}`;
}

/** These read the failed ask's code. The line on the card is never compared. */
export function isSignInPrompt(note: NoteStateFields): boolean {
  return askErrorOf(note) === "sign-in";
}

export function isCalmStatusNote(note: NoteStateFields): boolean {
  return askErrorOf(note) === "calm";
}

export function isCancelledAsk(note: NoteStateFields): boolean {
  return askErrorOf(note) === "cancelled";
}

/** An Ask's answer, or an addition from the connector: a model wrote it. A person's
 *  card and the writer's own plain note are not. */
export function aiWritten(note: RedlineNote): boolean {
  if (isAgentCard(note)) return true;
  return !note.person && typeof note.instruction === "string" && note.instruction.trim() !== "";
}

export function redlineNoteLabel(note: RedlineNote): string {
  const state = noteState(note);
  switch (state.kind) {
    case "accepted":
      return "accepted";
    case "error":
      return state.code === "sign-in" || state.code === "calm" ? "" : "Couldn't finish";
    case "asking":
      return "asking";
    default:
      // The connector's card says where it came from, as a person's card does.
      if (isAgentCard(note)) return AGENT_CARD_LABEL;
      return note.intent === "replace" || note.intent === "insert" ? note.intent : "note";
  }
}

/** Open notes show the Ask compose field, and so does a plain failed ask. Not the in-flight wait. */
export function noteShowsCompose(note: RedlineNote): boolean {
  const state = noteState(note);
  return state.kind === "compose" || (state.kind === "error" && state.code === "failed");
}

/** The search-held line under a suggestion. Empty when this ask searched. */
export function cautionNoteText(note: Pick<RedlineNote, "caution">): string | null {
  const line = note.caution?.trim() ?? "";
  return line.length > 0 ? line : null;
}

/** Gutter copy: scribble / instruction, never the highlighted span (`original`). */
export function redlineGutterBody(note: RedlineNote): string {
  if (note.error) return note.error;
  if (note.shareStale) return NO_LONGER_MATCHES;
  if (note.intent === "insert" || note.intent === "replace") {
    const instruction = (note.instruction ?? "").trim();
    const proposed = (note.proposed ?? "").trim();
    if (note.person && proposed) return proposed;
    if (!instruction || instruction === proposed) return "";
    return instruction;
  }
  if (note.intent === "none") return note.proposed ?? "";
  if (note.status === "pending" && note.intent == null) return "Thinking…";
  return "";
}

/** True when this wheel delta can still move the note body's own scrollTop. */
export function noteBodyConsumesDelta(
  body: { scrollTop: number; clientHeight: number; scrollHeight: number },
  deltaY: number,
): boolean {
  if (deltaY < 0) return body.scrollTop > 0;
  if (deltaY > 0) return body.scrollTop + body.clientHeight < body.scrollHeight;
  return false;
}

/** Isolate the editor scroller while the note can still scroll. Leave native wheel default alone. */
export function isolateNoteBodyScroll(
  event: { type: string; deltaY?: number; stopPropagation: () => void },
  body: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
  if (event.type === "wheel") {
    if (noteBodyConsumesDelta(body, event.deltaY ?? 0)) event.stopPropagation();
    return;
  }
  if (event.type === "touchmove" && body.scrollHeight > body.clientHeight) {
    event.stopPropagation();
  }
}

function noteFingerprint(note: RedlineNote): string {
  return [
    note.id,
    note.status,
    note.intent,
    note.original,
    note.proposed,
    note.instruction,
    note.error,
    note.errorCode,
    note.notice,
    note.caution,
    note.hold,
    note.deciding,
    note.notApplied,
    note.person,
    note.shareAccept,
    note.shareStale,
    note.mentionOpen,
    note.mentionDone,
    note.mentionOf,
    (note.mentions ?? []).map((mention) => mention.id).join(","),
    (note.replies ?? []).map((reply) => reply.id).join(","),
    note.git?.sharing,
    note.publish?.pushed,
    note.publish?.committed,
    note.publish?.error,
  ].join("\0");
}

function bindButton(button: HTMLButtonElement, view: EditorView, run: () => void) {
  button.type = "button";
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!active || active === view.contentDOM || !view.scrollDOM.contains(active)) {
      view.focus();
    }
  });
}

function inkButton(
  view: EditorView,
  className: string,
  label: string,
  run: () => void,
  extra?: { action?: string; disabled?: boolean; title?: string },
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  if (extra?.title) button.title = extra.title;
  if (extra?.action) button.dataset.redlineAction = extra.action;
  if (extra?.disabled) button.disabled = true;
  bindButton(button, view, run);
  return button;
}

/** The `@` name being typed at the caret, or null when the caret is not in one.
 *  `""` means the user just typed `@`. The people picker uses this match.
 *  Alkuin is not a picker row. The Ask button is the only ask. */
export function composeMentionQuery(text: string, caret: number | null): string | null {
  if (caret == null) return null;
  return mentionQuery(text, caret)?.query ?? null;
}

/** Enter saves. Shift+Enter and Alt+Enter stay in the field. Escape cancels.
 *  A composition (IME) does not save. */
export function composeKeyAction(event: {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): "save" | "cancel" | null {
  if (event.isComposing || event.key === "Process" || event.keyCode === 229) return null;
  if (event.key === "Escape") return "cancel";
  if (event.key === "Enter" && !event.shiftKey && !event.altKey) return "save";
  return null;
}

function calmStatus(text: string): HTMLElement {
  const status = document.createElement("p");
  status.className = "cm-redline-saved";
  status.textContent = text;
  return status;
}

export function renderRedlineNote(view: EditorView, note: RedlineNote): HTMLElement {
  const root = document.createElement("div");
  root.className = redlineNoteClassName(note);
  root.dataset.redlineNote = note.id;
  root.dataset.redlineStatus = note.status;
  if (note.intent) root.dataset.redlineIntent = note.intent;
  if (note.person) root.dataset.person = note.person;
  root.contentEditable = "false";

  const handlers: RedlineHandlers = view.state.facet(redlineHandlersFacet);
  const state = noteState(note);
  if (isDeciding(note)) root.dataset.redlineDeciding = "true";

  if (isSignInPrompt(note)) {
    const actions = document.createElement("div");
    actions.className = "cm-redline-note-actions";
    actions.append(
      inkButton(
        view,
        "cm-redline-btn cm-redline-btn-primary",
        SIGN_IN_LABEL,
        () => {
          openAccountSignIn();
        },
        { action: "sign-in" },
      ),
    );
    root.append(actions);
    return root;
  }

  if (note.error && isCalmStatusNote(note)) {
    root.append(calmStatus(note.error));
    const actions = document.createElement("div");
    actions.className = "cm-redline-note-actions";
    if (seePlansFor(note.error)) {
      actions.append(
        inkButton(
          view,
          "cm-redline-btn",
          SEE_PLANS_LABEL,
          () => {
            void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(PLANS_URL));
          },
          { action: "plans" },
        ),
      );
    }
    if (buyCreditFor(note.error)) {
      actions.append(
        inkButton(
          view,
          "cm-redline-btn",
          BUY_CREDIT_LABEL,
          () => {
            void startSubscription("topup", true);
          },
          { action: "buy-credit" },
        ),
      );
    }
    actions.append(
      inkButton(
        view,
        "cm-redline-btn",
        "Dismiss",
        () => {
          handlers.reject(view, note.id);
        },
        { action: "dismiss" },
      ),
    );
    root.append(actions);
    return root;
  }

  if (note.status === "accepted") {
    if (shareChangesOffered(note.git?.sharing)) {
      const actions = document.createElement("div");
      actions.className = "cm-redline-note-actions";
      actions.append(
        inkButton(
          view,
          "cm-redline-btn cm-redline-btn-primary",
          SHARE_CHANGES_LABEL,
          () => {
            handlers.publish(view, note.id);
          },
          { action: "share" },
        ),
      );
      root.append(actions);
    }
    return root;
  }

  if (note.notice && isCalmStatusLine(note.notice)) root.append(calmStatus(note.notice));
  // Accepted on the server, not written here. The suggestion is the body, then Dismiss.
  if (state.kind === "not-applied") root.append(calmStatus(ACCEPTED_NOT_ADDED_LINE));

  const composing = noteShowsCompose(note);
  if (composing) root.classList.add("cm-redline-compose");

  const label = document.createElement("span");
  label.className = "cm-redline-note-label";
  label.textContent = composing
    ? COMPOSE_NOTE_LABEL
    : note.person
      ? note.intent === "none" && state.kind !== "not-applied"
        ? noteFrom(note.person)
        : fromPerson(note.person)
      : redlineNoteLabel(note);
  if (!composing && label.textContent && aiWritten(note)) {
    const badge = document.createElement("span");
    badge.className = "cm-redline-ai";
    badge.textContent = AI_BADGE;
    badge.title = AI_BADGE_TITLE;
    label.prepend(badge, " · ");
  }
  root.append(label);

  const body = document.createElement("div");
  body.className = "cm-redline-note-body";
  body.addEventListener("wheel", (event) => {
    isolateNoteBodyScroll(event, body);
  });
  body.addEventListener("touchmove", (event) => {
    isolateNoteBodyScroll(event, body);
  });
  const bodyText = redlineGutterBody(note);
  if (bodyText) {
    if (note.error) {
      const err = document.createElement("p");
      err.className = "cm-redline-error";
      err.textContent = bodyText;
      body.append(err);
    } else if (note.mentions && note.mentions.length > 0) {
      body.append(paintMentionText(bodyText, note.mentions));
    } else {
      body.textContent = bodyText;
    }
  }
  root.append(body);

  const cautionText = cautionNoteText(note);
  if (cautionText) {
    const caution = document.createElement("p");
    caution.className = "cm-redline-caution";
    caution.textContent = cautionText;
    root.append(caution);
  }

  const canAsk = composing;
  const prompt = canAsk ? document.createElement("textarea") : null;
  if (prompt) {
    const field = document.createElement("div");
    field.className = "cm-redline-compose-field";
    const mark = document.createElement("span");
    mark.className = "cm-redline-compose-mark";
    mark.setAttribute("aria-hidden", "true");
    prompt.className = "cm-redline-instruction";
    prompt.rows = 2;
    prompt.placeholder = COMPOSE_PLACEHOLDER;
    prompt.setAttribute("aria-label", COMPOSE_ASK_ARIA);
    prompt.value = note.instruction ?? "";
    prompt.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    const mentionPicker = bindMentionField(
      prompt,
      note.id,
      view.state.facet(redlineFilePathFacet)(),
    );
    prompt.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (
        composeMentionQuery(prompt.value, prompt.selectionStart) !== null &&
        mentionPicker.onKey(event)
      ) {
        event.preventDefault();
        return;
      }
      const action = composeKeyAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "cancel") handlers.reject(view, note.id);
      else handlers.leave(view, note.id, prompt?.value);
    });
    field.append(mark, prompt);
    root.append(field);
    const rule = document.createElement("div");
    rule.className = "cm-redline-compose-rule";
    rule.setAttribute("aria-hidden", "true");
    root.append(rule);
  }

  const actions = document.createElement("div");
  actions.className = canAsk
    ? "cm-redline-note-actions cm-redline-compose-actions"
    : "cm-redline-note-actions";
  const personNote = Boolean(note.person);

  if (prompt) {
    actions.append(
      inkButton(
        view,
        "cm-redline-btn cm-redline-btn-primary",
        ASK_ALKUIN_LABEL,
        () => {
          handlers.ask(view, note.id, prompt?.value);
        },
        { action: "ask", title: ASK_AI_HINT },
      ),
      inkButton(
        view,
        "cm-redline-btn",
        LEAVE_NOTE_LABEL,
        () => {
          handlers.leave(view, note.id, prompt?.value);
        },
        { action: "leave" },
      ),
      inkButton(
        view,
        "cm-redline-btn cm-redline-btn-aside",
        COMPOSE_CANCEL_LABEL,
        () => {
          handlers.reject(view, note.id);
        },
        { action: "cancel" },
      ),
    );
    root.append(actions);
  } else if (isOwnCommentNote(note)) {
    actions.append(
      inkButton(
        view,
        "cm-redline-btn",
        "Edit",
        () => {
          handlers.editAsk(view, note.id);
        },
        { action: "edit" },
      ),
      inkButton(
        view,
        "cm-redline-btn",
        "Delete",
        () => {
          handlers.reject(view, note.id);
        },
        { action: "delete" },
      ),
    );
    root.append(actions);
  } else if (personNote && note.intent === "none") {
    // A shared Dismiss is a decision too. While it saves, a second click sends nothing.
    actions.append(
      inkButton(
        view,
        "cm-redline-btn",
        DISMISS,
        () => {
          handlers.reject(view, note.id);
        },
        { action: "dismiss", disabled: isDeciding(note) },
      ),
    );
    root.append(actions);
  } else if (noteShowsLocus(note) || isToolCautionHold(note)) {
    const caution = isToolCautionHold(note);
    // A shared decision is being saved. Neither button may send another.
    const deciding = isDeciding(note);
    if (note.shareAccept !== false) {
      actions.append(
        inkButton(
          view,
          "cm-redline-btn cm-redline-btn-primary",
          "Accept",
          () => {
            handlers.accept(view, note.id);
          },
          { action: "accept", disabled: deciding },
        ),
      );
    }
    actions.append(
      inkButton(
        view,
        "cm-redline-btn",
        "Reject",
        () => {
          handlers.reject(view, note.id);
        },
        { action: "reject", disabled: deciding },
      ),
    );
    // Edit ask reopens the ask made here. A person's card and the connector's have none.
    if (!caution && !personNote && !isAgentCard(note)) {
      actions.append(
        inkButton(
          view,
          "cm-redline-btn cm-redline-btn-aside",
          "Edit ask",
          () => {
            handlers.editAsk(view, note.id);
          },
          { action: "edit-ask" },
        ),
      );
    }
    root.append(actions);
  } else if (isCancelledAsk(note)) {
    actions.append(
      inkButton(
        view,
        "cm-redline-btn cm-redline-btn-primary",
        TRY_AGAIN_LABEL,
        () => {
          handlers.ask(view, note.id, note.instruction ?? undefined);
        },
        { action: "try-again" },
      ),
    );
    root.append(actions);
  } else if (state.kind === "asking") {
    // The wait has a way out. Cancel goes back to the field; a late answer is dropped.
    actions.append(
      inkButton(
        view,
        "cm-redline-btn",
        COMPOSE_CANCEL_LABEL,
        () => {
          handlers.reject(view, note.id);
        },
        { action: "cancel-ask" },
      ),
    );
    root.append(actions);
  } else if (state.kind === "comment") {
    // An Ask that came back as a plain note (not the caution hold) has no text to write.
    // Dismiss clears it, the same way Reject clears a suggestion.
    actions.append(
      inkButton(
        view,
        "cm-redline-btn",
        DISMISS,
        () => {
          handlers.reject(view, note.id);
        },
        { action: "dismiss" },
      ),
    );
    root.append(actions);
  }

  if (!composing) {
    appendMentionChrome(root, note, view, view.state.facet(redlineFilePathFacet)());
  }

  return root;
}

function needsRedraw(update: ViewUpdate): boolean {
  return update.docChanged || update.viewportChanged || update.geometryChanged;
}

type StubMeasure = {
  id: string;
  top: number;
};

class RedlineGutter {
  readonly gutter: HTMLElement;
  // CodeMirror mounts the editor in its parent before it builds plugins, so the pane is
  // there to find. One editor per pane.
  private readonly pane: HTMLElement | null;
  private nodes = new Map<string, { el: HTMLElement; fingerprint: string }>();
  private stubs = new Map<string, HTMLElement>();
  private resize: ResizeObserver | null = null;

  constructor(view: EditorView) {
    this.pane = view.dom.closest<HTMLElement>("[data-pane]");
    this.gutter = document.createElement("div");
    this.gutter.className = "cm-redline-gutter";
    this.gutter.contentEditable = "false";
    view.scrollDOM.append(this.gutter);
    this.draw(view);
    const restack = () => {
      if (this.gutter.isConnected) this.draw(view);
    };
    void document.fonts?.ready.then(() => requestAnimationFrame(restack));
    void document.fonts
      ?.load('20px "Nothing You Could Do"')
      .then(() => requestAnimationFrame(restack));
    // CodeMirror drops a resize that lands within 75ms of its last update, so
    // a single window-width change can leave the dots on the old lines.
    let width = view.scrollDOM.clientWidth;
    this.resize = new ResizeObserver(() => {
      const next = view.scrollDOM.clientWidth;
      if (next === width) return;
      width = next;
      restack();
    });
    this.resize.observe(view.scrollDOM);
  }

  update(update: ViewUpdate) {
    const notes = update.state.field(redlineNotesField);
    const prev = update.startState.field(redlineNotesField);
    if (!needsRedraw(update) && notes === prev) return;
    this.draw(update.view);
  }

  destroy() {
    this.resize?.disconnect();
    this.gutter.remove();
    this.nodes.clear();
    this.stubs.clear();
    // The pane outlives the editor while the next file loads, and React does not own this.
    if (this.pane) delete this.pane.dataset.redlineNotes;
  }

  private draw(view: EditorView) {
    const notes = view.state.field(redlineNotesField).filter(marginNoteVisible);
    markNotesShown(view.dom, this.pane, notes.length);
    if (notes.length === 0) {
      this.gutter.replaceChildren();
      this.gutter.hidden = true;
      this.nodes.clear();
      this.stubs.clear();
      return;
    }
    this.gutter.hidden = false;
    this.layoutFrame(view);

    const seen = new Set<string>();
    const ordered = [...notes].sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
    for (const note of ordered) {
      seen.add(note.id);
      const fingerprint = noteFingerprint(note);
      const kept = this.nodes.get(note.id);
      let el = kept?.el;
      if (!el || kept?.fingerprint !== fingerprint) {
        el?.remove();
        el = renderRedlineNote(view, note);
        this.gutter.append(el);
        this.nodes.set(note.id, { el, fingerprint });
      }
      el.style.setProperty("--redline-tilt", "0deg");
    }
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.el.remove();
        this.nodes.delete(id);
      }
    }
    for (const note of ordered) this.ensureStub(note.id);
    for (const [id, stub] of this.stubs) {
      if (!seen.has(id)) {
        stub.remove();
        this.stubs.delete(id);
      }
    }

    const preferred: number[] = [];
    const heights: number[] = [];
    for (const note of ordered) {
      preferred.push(view.lineBlockAt(note.from).top + view.documentPadding.top);
      const el = this.nodes.get(note.id)?.el;
      heights.push(measuredNoteHeight(el?.offsetHeight ?? 0));
    }
    const tops = stackGutterTops(preferred, heights, NOTE_GAP);
    for (const [index, note] of ordered.entries()) {
      const el = this.nodes.get(note.id)?.el;
      if (el) el.style.top = `${tops[index]}px`;
    }
    // coordsAtPos is illegal during a CodeMirror update — schedule into requestMeasure.
    this.scheduleStubLayout(view, ordered);
  }

  private ensureStub(id: string): HTMLElement {
    let el = this.stubs.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = "cm-redline-gutter-stub";
      el.dataset.redlineStub = id;
      el.setAttribute("aria-hidden", "true");
      el.hidden = true;
      this.gutter.append(el);
      this.stubs.set(id, el);
    }
    return el;
  }

  /** Defer coordsAtPos out of ViewPlugin.update (Mac Ask crash). */
  private scheduleStubLayout(view: EditorView, ordered: readonly RedlineNote[]) {
    const notes = ordered;
    view.requestMeasure({
      read: (v) => {
        const gutterTop = this.gutter.getBoundingClientRect().top;
        const out: StubMeasure[] = [];
        for (const note of notes) {
          const instruction = this.nodes.get(note.id)?.el.querySelector(".cm-redline-instruction");
          if (instruction) {
            const box = instruction.getBoundingClientRect();
            if (box.height > 0) {
              const lineHeight = Number.parseFloat(getComputedStyle(instruction).lineHeight);
              out.push({
                id: note.id,
                top: gutterStubTop(composeStubSpan(box, lineHeight), gutterTop),
              });
              continue;
            }
          }
          const span = v.coordsAtPos(Math.max(note.from, note.to - 1));
          if (!span) continue;
          out.push({ id: note.id, top: gutterStubTop(span, gutterTop) });
        }
        return out;
      },
      write: (measured) => {
        const placed = new Set(measured.map((item) => item.id));
        for (const [id, el] of this.stubs) el.hidden = !placed.has(id);
        for (const item of measured) {
          const el = this.stubs.get(item.id);
          if (!el) continue;
          el.hidden = false;
          el.style.top = `${item.top}px`;
        }
      },
    });
  }

  private layoutFrame(view: EditorView) {
    const scroll = view.scrollDOM;
    const content = view.contentDOM;
    const s = scroll.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    // Width and right inset are the CSS unit. An inline left would pin the rail.
    this.gutter.style.top = `${c.top - s.top + scroll.scrollTop}px`;
    this.gutter.style.height = `${content.offsetHeight}px`;
  }
}

export const redlineGutter = ViewPlugin.fromClass(RedlineGutter);
