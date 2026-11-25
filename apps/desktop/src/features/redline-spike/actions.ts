import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { settleSaved } from "@/lib/history/desk";
import { SaveFailedError } from "@/lib/save";
import { notePendingGitOp } from "@/lib/git-queue";
import * as tauri from "@/lib/tauri";
import type { RedlineIntent, RedlineNote } from "./model";
import { citationChanges, instructionIsCiteShaped, referenceBearingChanges } from "./cite-apply";
import { SIGN_IN_LABEL } from "@/lib/account-copy";
import { writingOffline, writingPlan, writingSignedIn } from "@/lib/account-session";
import { learnOnDecision } from "./entitlement";
import {
  ACCEPTED_NOT_ADDED_LINE,
  ACCEPT_SAVE_FAILED_LINE,
  ACCEPT_TEXT_CHANGED_LINE,
  BAD_ASK_LINE,
  COMPOSE_EMPTY_ASK,
  COMPOSE_EMPTY_NOTE,
  MODEL_UNREACHABLE_LINE,
  NO_SUGGESTION_LINE,
  SHARE_FAILED_LINE,
  shareFailureLine,
} from "./margin-copy";
import { shareFailureLine as macOnlyShareLine } from "@/lib/keep-on-mac";
import { SHARE_DECIDE_FAILED } from "@/features/document-share/copy";
import {
  coerceIntent,
  emptyGitStatus,
  isAgentCard,
  isAskInFlight,
  isDeciding,
  isOwnCommentNote,
  noteShowsLocus,
  noteState,
  proposalChange,
  selectionRange,
  TOOL_CAUTION_NOTE,
  type AskErrorCode,
  type NoteStateFields,
} from "./model";
import { publishNoteMentions } from "@/features/note-mention/desk";
import { mentionsInText } from "@/features/note-mention/client";
import { threadKey } from "@/features/note-mention/thread";
import {
  hideAgentProposal,
  recordAgentDecision,
  settleAgentProposal,
} from "@/features/agent-proposal/store";
import {
  addRedlineNote,
  clearInkTick,
  flashInkTick,
  markAccepted,
  markAsking,
  markNotApplied,
  nextAskId,
  nextRedlineId,
  noteAtExactRange,
  REDLINE_INK_TICK_MS,
  redlineFilePathFacet,
  redlineInkTickField,
  redlineMotionMs,
  redlineNotesField,
  removeRedlineNote,
  reopenCompose,
  setAskError,
  setDeciding,
  setGitStatus,
  setNoteThread,
  setProposed,
  setPublishResult,
} from "./notes";

/** ponytail: one pending clear per view. Reset on re-flash so the first Accept cannot cut
 *  the second tick short. Another pane's Accept does not cancel this one's clear. */
const inkTickTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

function armInkTickClear(view: EditorView, id: string): void {
  const pending = inkTickTimers.get(view);
  if (pending != null) globalThis.clearTimeout(pending);
  const timer = globalThis.setTimeout(() => {
    if (inkTickTimers.get(view) === timer) inkTickTimers.delete(view);
    if (!view.dom.isConnected) return;
    if (view.state.field(redlineInkTickField, false) !== id) return;
    view.dispatch({ effects: clearInkTick.of(id) });
  }, redlineMotionMs(REDLINE_INK_TICK_MS));
  inkTickTimers.set(view, timer);
}

function filePath(view: EditorView): string {
  return view.state.facet(redlineFilePathFacet)();
}

function noteById(view: EditorView, id: string) {
  return view.state.field(redlineNotesField).find((note) => note.id === id);
}

export function addNoteAtRange(view: EditorView, from: number, to: number): boolean {
  const range = selectionRange(from, to);
  if (!range || range.to > view.state.doc.length) return false;
  const existing = noteAtExactRange(view.state.field(redlineNotesField), range.from, range.to);
  if (existing) return true;
  const original = view.state.doc.sliceString(range.from, range.to);
  if (!original) return false;
  view.dispatch({
    effects: addRedlineNote.of({
      id: nextRedlineId(),
      from: range.from,
      to: range.to,
      original,
      proposed: null,
      intent: null,
      instruction: null,
      status: "open",
      error: null,
      git: null,
      publish: null,
    }),
  });
  return true;
}

function askPromptEl(view: EditorView, id: string): HTMLTextAreaElement | null {
  const field = view.scrollDOM?.querySelector(
    `[data-redline-note="${id}"] textarea.cm-redline-instruction`,
  );
  if (!field || typeof (field as HTMLTextAreaElement).focus !== "function") return null;
  return field as HTMLTextAreaElement;
}

function focusAskPrompt(view: EditorView, id: string): HTMLTextAreaElement | null {
  const el = askPromptEl(view, id);
  if (!el) return null;
  el.focus();
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      const again = askPromptEl(view, id);
      again?.focus();
    });
  }
  return el;
}

function composeText(instruction?: string): string {
  return instruction?.trim() ?? "";
}

function focusEmptyCompose(view: EditorView, id: string, notice: string): void {
  const el = askPromptEl(view, id);
  const already = Boolean(el) && typeof document !== "undefined" && document.activeElement === el;
  focusAskPrompt(view, id);
  if (already) showEditorNotice(notice);
}

/** Ask Alkuin. The text is the instruction. No tag required. */
export function askAlkuinOnNote(view: EditorView, id: string, instruction?: string): boolean {
  const note = noteById(view, id);
  if (!note || note.status === "accepted") return false;
  if (isAskInFlight(note)) return true;
  const text = composeText(instruction);
  if (!text) {
    focusEmptyCompose(view, id, COMPOSE_EMPTY_ASK);
    return true;
  }
  const mentions = mentionsInText(id, text);
  if (mentions.length > 0) {
    const threadId = threadKey(view.state.doc.sliceString(note.from, note.to), text);
    view.dispatch({ effects: setNoteThread.of({ id, threadId }) });
    void publishNoteMentions(filePath(view), threadId, text, mentions);
  }
  void askAgentOnNote(view, id, text);
  return true;
}

/** Save a plain note. `@` text stays text. Only Ask Alkuin calls the model. */
export function leaveNoteOnNote(view: EditorView, id: string, instruction?: string): boolean {
  const note = noteById(view, id);
  if (!note || note.status === "accepted") return false;
  if (isAskInFlight(note)) return true;
  const text = composeText(instruction);
  if (!text) {
    focusEmptyCompose(view, id, COMPOSE_EMPTY_NOTE);
    return true;
  }
  const mentions = mentionsInText(id, text);
  // The thread is named by these words on this span, which is what the share sends.
  // The other Mac reads the same id back from the card it paints.
  const threadId = threadKey(view.state.doc.sliceString(note.from, note.to), text);
  const threaded = mentions.length > 0 || Boolean(note.threadId);
  view.dispatch({
    effects: [
      setProposed.of({
        id,
        proposed: text,
        intent: "none",
        instruction: null,
      }),
      ...(threaded
        ? [setNoteThread.of({ id, threadId, ...(mentions.length > 0 ? { mentions } : {}) })]
        : []),
    ],
  });
  void publishNoteMentions(filePath(view), threadId, text, mentions);
  return true;
}

/** Open compose, or route a prefilled instruction the way Leave note does. */
export function beginAskOnNote(view: EditorView, id: string, instruction?: string): boolean {
  return leaveNoteOnNote(view, id, instruction);
}

export function askErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; payload?: unknown };
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.payload === "string" && record.payload.trim()) {
      return record.payload.trim();
    }
  }
  return NO_SUGGESTION_LINE;
}

/** A refusal the desk knows before it asks. The line is shown; `code` is what the card is. */
class AskRefused extends Error {
  readonly code: AskErrorCode;

  constructor(message: string, code: AskErrorCode) {
    super(message);
    this.code = code;
  }
}

/** The ask the app makes: the native command. Never filler-strips. This is the IPC boundary:
 *  Rust's caution sentinel becomes `hold` here and nowhere else. */
export async function requestRewrite(
  original: string,
  instruction: string,
  path = "",
): Promise<{
  suggested_text: string;
  intent: RedlineIntent;
  notice?: string | null;
  caution?: string | null;
  hold?: boolean;
}> {
  if (instruction.trim().length > 500) throw new AskRefused(BAD_ASK_LINE, "failed");
  if (!writingSignedIn()) throw new AskRefused(SIGN_IN_LABEL, "sign-in");
  if (writingOffline()) throw new AskRefused(MODEL_UNREACHABLE_LINE, "failed");
  try {
    const result = await tauri.redlinePropose(path, original, instruction);
    const notice = result.notice?.trim() ? result.notice : null;
    const caution = result.caution?.trim() ? result.caution : null;
    const intent = coerceIntent(result.intent);
    const hold = intent === "none" && result.suggested_text === TOOL_CAUTION_NOTE;
    return {
      suggested_text: result.suggested_text,
      intent,
      ...(notice ? { notice } : {}),
      ...(caution ? { caution } : {}),
      ...(hold ? { hold } : {}),
    };
  } finally {
    void import("@/lib/account-billing").then((mod) => mod.noteWriterAsk());
  }
}

export async function askAgentOnNote(
  view: EditorView,
  id: string,
  instruction = "improve",
): Promise<boolean> {
  const note = noteById(view, id);
  if (!note || note.status === "accepted") return false;
  if (isAskInFlight(note)) return true;
  if (!writingSignedIn()) {
    view.dispatch({
      effects: setAskError.of({ id, error: SIGN_IN_LABEL, code: "sign-in" }),
    });
    return true;
  }
  if (writingOffline()) {
    view.dispatch({
      effects: setAskError.of({ id, error: MODEL_UNREACHABLE_LINE, code: "failed" }),
    });
    return true;
  }
  // The reducer drops an answer whose ask is no longer the one the note waits on
  // (Cancel, then a second Ask), so a late answer cannot land on the wrong ask.
  const ask = nextAskId();
  view.dispatch({
    effects: markAsking.of({ id, instruction, ask }),
  });
  const stillAsking = () => view.dom.isConnected && noteById(view, id)?.askId === ask;
  try {
    const proposal = await requestRewrite(note.original, instruction, filePath(view));
    if (!stillAsking()) return true;
    view.dispatch({
      effects: setProposed.of({
        id,
        ask,
        proposed: proposal.suggested_text,
        intent: proposal.intent,
        instruction,
        notice: proposal.notice,
        caution: proposal.caution,
        hold: proposal.hold,
      }),
    });
  } catch (error) {
    if (!stillAsking()) return true;
    view.dispatch({
      effects: setAskError.of({
        id,
        ask,
        error: askErrorMessage(error),
        ...(error instanceof AskRefused ? { code: error.code } : {}),
      }),
    });
  }
  return true;
}

/** Place a note on the range. A passed instruction asks. No instruction opens compose. */
export function askAgentAtRange(
  view: EditorView,
  from: number,
  to: number,
  instruction?: string,
): boolean {
  if (!addNoteAtRange(view, from, to)) return false;
  const range = selectionRange(from, to);
  if (!range) return false;
  const note = noteAtExactRange(view.state.field(redlineNotesField), range.from, range.to);
  if (!note) return false;
  const text = instruction?.trim() ?? "";
  if (text) return askAlkuinOnNote(view, note.id, text);
  return beginAskOnNote(view, note.id);
}

export function askAgentAtSelection(view: EditorView, instruction?: string): boolean {
  return askAgentAtRange(
    view,
    view.state.selection.main.from,
    view.state.selection.main.to,
    instruction,
  );
}

/** Context menu Ask: captured mousedown range, not live selection.
 *  Skip view.focus() — EditorView.focus() writes the current CM selection to
 *  the DOM (often a caret after WKWebView) and focuses contentDOM, so
 *  beginAskOnNote's compose textarea never keeps focus. */
export function askAgentFromMenu(
  view: EditorView,
  from: number,
  to: number,
  instruction?: string,
): boolean {
  return askAgentAtRange(view, from, to, instruction);
}

export function rejectNote(view: EditorView, id: string): boolean {
  const note = noteById(view, id);
  if (!note || isDeciding(note)) return false;
  const state = noteState(note);
  if (note.shareChangeId) {
    // Deciding until the server answers, so a second click cannot send a second decision.
    view.dispatch({ effects: setDeciding.of({ id, deciding: true }) });
    void tauri.shareDecide(note.shareChangeId, false).then(
      () => {
        view.dispatch({
          effects: [setDeciding.of({ id, deciding: false }), removeRedlineNote.of(id)],
        });
      },
      () => {
        view.dispatch({ effects: setDeciding.of({ id, deciding: false }) });
        showEditorNotice(SHARE_DECIDE_FAILED);
      },
    );
    return true;
  }
  // Cancel while Alkuin is thinking: back to the field with the ask. The answer is dropped.
  if (state.kind === "asking") {
    view.dispatch({ effects: reopenCompose.of(id) });
    focusAskPrompt(view, id);
    return true;
  }
  // Own-note Edit keeps `proposed` as the restore snapshot. Cancel must not Delete.
  if (state.kind === "compose" && note.proposed != null) {
    view.dispatch({
      effects: setProposed.of({
        id,
        proposed: note.proposed,
        intent: "none",
        instruction: null,
      }),
    });
    return true;
  }
  // Dismissing a note someone left is not a lesson about the writer's style.
  // A shared card left above; this is the Tutorial's note from Alkuin.
  if (!note.person) recordPreferenceLesson(view, note, false);
  view.dispatch({ effects: removeRedlineNote.of(id) });
  // The connector's addition was turned down. It must not be offered again.
  if (note.agentProposalId) settleAgentProposal(note.agentProposalId);
  return true;
}

/** Re-open margin compose on a pending body proposal or a saved human note. */
export function editAskOnNote(view: EditorView, id: string): boolean {
  const note = noteById(view, id);
  if (!note || isDeciding(note)) return false;
  // No ask was made here for the connector's card. It is only accepted or rejected.
  if (isAgentCard(note)) return false;
  if (!noteShowsLocus(note) && !isOwnCommentNote(note)) return false;
  view.dispatch({ effects: reopenCompose.of(id) });
  focusAskPrompt(view, id);
  return true;
}

/** Pending agent proposal only. Never original/proposed, and never Dismiss/Cancel/error. */
export function preferenceRecordArgs(
  note: NoteStateFields,
  accepted: boolean,
): { accepted: boolean; intent: RedlineIntent; instruction: string } | null {
  const kind = noteState(note).kind;
  if (kind !== "suggestion" && kind !== "comment") return null;
  if (note.instruction == null || note.intent == null) return null;
  return {
    accepted,
    intent: note.intent,
    instruction: note.instruction,
  };
}

function recordPreferenceLesson(
  view: EditorView,
  note: NoteStateFields & Pick<RedlineNote, "from" | "to">,
  accepted: boolean,
): void {
  const args = preferenceRecordArgs(note, accepted);
  if (!args) return;
  if (!learnOnDecision(writingPlan())) return;
  const before = view.state.sliceDoc(note.from, note.to);
  const suggested = note.proposed ?? "";
  void tauri
    .redlineLearn(
      filePath(view),
      accepted ? "accept" : "reject",
      before,
      suggested,
      accepted ? suggested : "",
    )
    .catch(() => {
      // ponytail: the learn call is best-effort; Accept/Reject must still complete.
    });
}

/**
 * Where a shared card writes, as the person saw it when they clicked Accept: the words
 * a replacement covers, or the line and column of an insertion. An insertion card
 * carries no anchor text (its wire anchor stays in document-share), so its line is the
 * anchor. Null when the words under a replacement have already changed.
 */
type ShareSpot = { kind: "span" } | { kind: "caret"; line: string; column: number };

function shareSpotOf(
  doc: Text,
  note: Pick<RedlineNote, "from" | "to" | "original">,
): ShareSpot | null {
  if (note.from === note.to) {
    const line = doc.lineAt(note.from);
    return { kind: "caret", line: line.text, column: note.from - line.from };
  }
  return doc.sliceString(note.from, note.to) === note.original ? { kind: "span" } : null;
}

/** The card, mapped through the edits made while the decision saved, still writes there. */
function shareSpotHolds(doc: Text, live: RedlineNote, spot: ShareSpot): boolean {
  if (spot.kind === "span") {
    return live.from < live.to && doc.sliceString(live.from, live.to) === live.original;
  }
  if (live.from !== live.to) return false;
  const line = doc.lineAt(live.from);
  return line.text === spot.line && live.from - line.from === spot.column;
}

/** An own replacement whose words were edited since the suggestion was made. */
function ownWordsChanged(
  doc: Text,
  note: Pick<RedlineNote, "from" | "to" | "intent" | "original">,
): boolean {
  return (
    (note.intent ?? "replace") === "replace" &&
    Boolean(note.original) &&
    doc.sliceString(note.from, note.to) !== note.original
  );
}

/**
 * Save a shared Accept, then read the card again. Deciding keeps it in the margin and
 * disables its buttons until the server answers. Its position has been mapped through
 * any edit made meanwhile. Words already changed under it are refused before the server
 * hears anything. An edit at its spot during the save writes nothing over the edit; the
 * server has the Accept by then and has no undo, so the card stays as a note that says
 * so and keeps the suggestion. Returns the card to apply, or null to stop.
 */
async function decideSharedAccept(
  view: EditorView,
  note: RedlineNote & { shareChangeId: string },
): Promise<RedlineNote | null> {
  const id = note.id;
  const spot = shareSpotOf(view.state.doc, note);
  if (!spot) {
    showEditorNotice(ACCEPT_TEXT_CHANGED_LINE);
    return null;
  }
  view.dispatch({ effects: setDeciding.of({ id, deciding: true }) });
  try {
    await tauri.shareDecide(note.shareChangeId, true);
  } catch {
    if (view.dom.isConnected) view.dispatch({ effects: setDeciding.of({ id, deciding: false }) });
    showEditorNotice(SHARE_DECIDE_FAILED);
    return null;
  }
  const live = view.dom.isConnected ? noteById(view, id) : undefined;
  // The tab closed, or a file swap or reload replaced the notes: nowhere to write it.
  if (!live?.deciding) {
    showEditorNotice(ACCEPTED_NOT_ADDED_LINE);
    return null;
  }
  if (!shareSpotHolds(view.state.doc, live, spot)) {
    view.dispatch({ effects: markNotApplied.of(id) });
    showEditorNotice(ACCEPTED_NOT_ADDED_LINE);
    return null;
  }
  return live;
}

export async function acceptNote(view: EditorView, id: string): Promise<boolean> {
  let note = noteById(view, id);
  if (!note || isDeciding(note)) return false;
  const state = noteState(note);
  if (
    state.kind === "compose" ||
    state.kind === "asking" ||
    state.kind === "error" ||
    state.kind === "not-applied" ||
    state.kind === "accepted"
  ) {
    return false;
  }
  const intent = note.intent ?? "replace";
  if (intent !== "none" && !note.proposed) return false;
  if (note.shareChangeId && note.shareAccept === false) return false;
  if (note.shareChangeId) {
    const live = await decideSharedAccept(view, { ...note, shareChangeId: note.shareChangeId });
    if (!live) return false;
    note = live;
  } else if (ownWordsChanged(view.state.doc, note)) {
    // Refused before anything changes: Accept would write over the edit.
    showEditorNotice(ACCEPT_TEXT_CHANGED_LINE);
    return false;
  }

  recordPreferenceLesson(view, note, true);

  const proposed = note.proposed ?? "";
  const citeMerge =
    !note.caution?.trim() &&
    intent !== "none" &&
    note.instruction != null &&
    instructionIsCiteShaped(note.instruction);
  const citeEdits = citeMerge
    ? citationChanges(view.state.doc.toString(), note.from, note.to, proposed)
    : [];
  // The connector's text is written as it was sent. The reference lift is for
  // Alkuin's own answers: it trims, re-punctuates, and drops what it does not know.
  const grounded =
    !citeMerge && !isAgentCard(note) && (intent === "insert" || intent === "replace")
      ? referenceBearingChanges(view.state.doc.toString(), note.from, note.to, proposed, intent)
      : null;
  const change =
    citeMerge || grounded ? null : proposalChange(note.from, note.to, proposed, intent);
  const effects = [markAccepted.of(id)];
  const tick = intent !== "none" && view.state.field(redlineInkTickField, false) !== undefined;
  if (tick) effects.push(flashInkTick.of(id));
  if (citeEdits.length > 0) {
    view.dispatch({
      changes: citeEdits,
      effects,
    });
  } else if (grounded && grounded.length > 0) {
    view.dispatch({
      changes: grounded,
      effects,
    });
  } else if (change) {
    const current = view.state.doc.sliceString(change.from, change.to);
    if (current !== change.insert) {
      view.dispatch({
        changes: change,
        effects,
      });
    } else {
      view.dispatch({ effects });
    }
  } else {
    view.dispatch({ effects });
  }
  // The connector's addition is in the text now, so its card leaves the list at once.
  // The decision is recorded below, only when the words are on disk: recorded first,
  // a failed save would leave them in no file and on no server.
  const decided = note.agentProposalId ? hideAgentProposal(note.agentProposalId) : null;

  if (tick) armInkTickClear(view, id);

  // Comment-only: Accept must not touch disk (no flushSave, no commit).
  if (intent === "none") return true;

  const path = filePath(view);
  if (!path) {
    // No file to save to. The words are on the page, which is all there is.
    if (decided) recordAgentDecision(decided);
    return true;
  }

  try {
    // Save, remember a version, then send when online. A thrown save leaves the page.
    await settleSaved(path, decided ? () => recordAgentDecision(decided) : undefined);
  } catch (error) {
    showEditorNotice(
      error instanceof SaveFailedError
        ? ACCEPT_SAVE_FAILED_LINE
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  let git = emptyGitStatus();
  try {
    git = await tauri.gitFileStatus(path);
  } catch (error) {
    git = {
      ...emptyGitStatus(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (view.dom.isConnected) {
    view.dispatch({ effects: setGitStatus.of({ id, git }) });
  }
  return true;
}

export async function publishNote(view: EditorView, id: string): Promise<boolean> {
  const note = noteById(view, id);
  if (!note || note.status !== "accepted") return false;
  const path = filePath(view);
  if (!path) {
    if (shareFailureLine()) showEditorNotice(SHARE_FAILED_LINE);
    return false;
  }
  const message = `Accepted suggestion in ${path.split("/").pop() || "file"}`;
  try {
    const publish = await tauri.gitPublishFile(path, message);
    if (publish.retry && !publish.pushed) {
      await notePendingGitOp(path, "push", message);
    }
    if (view.dom.isConnected) {
      view.dispatch({ effects: setPublishResult.of({ id, publish }) });
    }
    if (publish.error && !publish.pushed) {
      const line = macOnlyShareLine(publish.error);
      if (line !== SHARE_FAILED_LINE || shareFailureLine()) showEditorNotice(line);
    }
  } catch {
    if (shareFailureLine()) showEditorNotice(SHARE_FAILED_LINE);
    if (view.dom.isConnected) {
      view.dispatch({
        effects: setPublishResult.of({
          id,
          publish: { committed: false, pushed: false, commit_sha: null, error: shareFailureLine() },
        }),
      });
    }
  }
  return true;
}
