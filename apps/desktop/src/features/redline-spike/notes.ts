import { EditorState, Facet, StateEffect, StateField } from "@codemirror/state";
import { filePathChange } from "@/components/editor-area/editor-reload";
import { askErrorCode, type AskErrorCode } from "./margin-copy";
import {
  cameFromElsewhere,
  isOwnCommentNote,
  type GitFileStatus,
  type GitPublishResult,
  type RedlineIntent,
  type RedlineNote,
} from "./model";
import { mapNote, ownNote, parkedNotes, relocateNotes } from "./parked-notes";
import { tutorialMarginSeeds } from "./tutorial-seeds";

export const redlineFilePathFacet = Facet.define<() => string, () => string>({
  combine: (values) => values[0] ?? (() => ""),
});

/** Screenshot / test seed. Empty in the running app. */
export const redlineSeedNotes = Facet.define<readonly RedlineNote[], readonly RedlineNote[]>({
  combine: (values) => values[values.length - 1] ?? [],
});

/** Unique across launches and Macs. A mention thread is named by `threadKey`, not by this id. */
export function nextRedlineId(): string {
  return `redline-${crypto.randomUUID()}`;
}

let askSeq = 0;

/** Names one Ask Alkuin request. Local to this launch; it never leaves the Mac. */
export function nextAskId(): string {
  askSeq += 1;
  return `ask-${askSeq}`;
}

/** An answer carrying `ask` is for this note only while the note still waits on that ask. */
function answersAsk(note: RedlineNote, ask: string | undefined): boolean {
  return ask === undefined || note.askId === ask;
}

export const addRedlineNote = StateEffect.define<RedlineNote>();
export const removeRedlineNote = StateEffect.define<string>();
/** `ask` names this request. Its answer lands only while the note still waits on it. */
export const markAsking = StateEffect.define<{
  id: string;
  instruction: string | null;
  ask?: string;
}>();
/** `code` when the caller knows it; otherwise the line is read once, here, by `askErrorCode`. */
export const setAskError = StateEffect.define<{
  id: string;
  error: string;
  code?: AskErrorCode;
  ask?: string;
}>();
export const setProposed = StateEffect.define<{
  id: string;
  proposed: string;
  intent: RedlineIntent;
  instruction: string | null;
  notice?: string | null;
  caution?: string | null;
  hold?: boolean;
  ask?: string;
}>();
/** Pending → accepted. Any other note is left as it is. */
export const markAccepted = StateEffect.define<string>();
/** A shared Accept is saving (`deciding: true`) or failed (`false`). Pending notes only. */
export const setDeciding = StateEffect.define<{ id: string; deciding: boolean }>();
/**
 * Deciding → not-applied: the server saved the Accept but the text it was for changed
 * here, so nothing was written. The card becomes a note holding the suggestion. It
 * drops `shareChangeId`, so a pull does not remove it and Dismiss sends no decision,
 * and its intent is `none`, so the share never sends it.
 */
export const markNotApplied = StateEffect.define<string>();
export const reopenCompose = StateEffect.define<string>();
export const flashInkTick = StateEffect.define<string>();
export const clearInkTick = StateEffect.define<string>();
export const setGitStatus = StateEffect.define<{ id: string; git: GitFileStatus }>();
export const setPublishResult = StateEffect.define<{ id: string; publish: GitPublishResult }>();
export const setNoteThread = StateEffect.define<{
  id: string;
  mentions?: { id: string; name: string }[];
  replies?: { id: string; authorId: string; authorName: string; text: string }[];
  mentionOpen?: boolean;
  mentionDone?: boolean;
  threadId?: string;
  mentionRows?: string[];
}>();

/** Ink tick paints then fades. Keep in lockstep with `redline-ink-tick` in CSS. */
export const REDLINE_INK_TICK_MS = 720;

export function redlineMotionMs(full: number): number {
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return 1;
  }
  return full;
}

/** ponytail: one tick id at a time. Clear-timer is reset in actions so a second flash is not cut short. */
export const redlineInkTickField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    if (tr.isUserEvent("writer")) return null;
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(flashInkTick)) next = effect.value;
      else if (effect.is(clearInkTick) && effect.value === next) next = null;
    }
    return next;
  },
});

/** `hit` is true only when the patch changed the note. A guarded patch returns it unchanged. */
function patchById(
  notes: RedlineNote[],
  id: string,
  patch: (note: RedlineNote) => RedlineNote,
): { notes: RedlineNote[]; hit: boolean } {
  let hit = false;
  const next = notes.map((note) => {
    if (note.id !== id) return note;
    const patched = patch(note);
    if (patched !== note) hit = true;
    return patched;
  });
  return { notes: hit ? next : notes, hit };
}

function notesAfterFileSwap(state: EditorState): RedlineNote[] {
  return tutorialMarginSeeds(state.facet(redlineFilePathFacet)(), state.doc.toString());
}

/** The Tutorial seeds for this text, then the writer's own notes for the same file. */
function seedsThenOwn(
  current: readonly RedlineNote[],
  seeds: RedlineNote[],
  own: RedlineNote[],
): readonly RedlineNote[] {
  if (seeds.length === 0 && own.length === 0) return current.length === 0 ? current : [];
  if (own.length === 0) return seeds;
  const seedIds = new Set(seeds.map((note) => note.id));
  return [...seeds, ...own.filter((note) => !seedIds.has(note.id))];
}

export const redlineNotesField = StateField.define<readonly RedlineNote[]>({
  create: (state) => {
    const seeded = state.facet(redlineSeedNotes);
    if (seeded.length > 0) return seeded;
    return seedsThenOwn(
      [],
      notesAfterFileSwap(state),
      parkedNotes(state.facet(redlineFilePathFacet)(), state.doc),
    );
  },
  update(notes, tr) {
    // One EditorView is reused across files. A swap/reload is a covering
    // replace; mapped whole-doc notes would otherwise land on the next file.
    // The writer's own notes wait in `parked-notes.ts` while their file is not
    // shown, and come back with it. Tutorial.md is seeded again from the text,
    // so a dismissed seed lasts until the next swap.
    const pathChange = tr.annotation(filePathChange);
    if (pathChange?.kind === "swap") {
      return seedsThenOwn(
        notes,
        notesAfterFileSwap(tr.state),
        parkedNotes(pathChange.to, tr.state.doc),
      );
    }
    // This buffer under a new path. Its notes are still its notes. The text is replaced
    // only when the store held other line endings, and then every passage is where it was.
    if (pathChange?.kind === "rename") {
      if (!tr.docChanged) return notes;
      return relocateNotes(notes, tr.startState.doc.toString(), tr.state.doc.toString());
    }
    if (tr.isUserEvent("writer.reload")) {
      // The same file with new text from disk. A note stays when its passage does, and so
      // does an Ask in flight: this view is still here for its answer.
      const own = notes.filter(ownNote);
      return seedsThenOwn(
        notes,
        notesAfterFileSwap(tr.state),
        own.length === 0
          ? own
          : relocateNotes(own, tr.startState.doc.toString(), tr.state.doc.toString()),
      );
    }
    if (tr.isUserEvent("writer")) {
      const seeds = notesAfterFileSwap(tr.state);
      if (seeds.length === 0) return notes.length === 0 ? notes : [];
      return seeds;
    }
    let next: RedlineNote[] = [];
    let changed = false;
    for (const note of notes) {
      const mapped = tr.changes.empty ? note : mapNote(note, tr.changes);
      if (mapped !== note) changed = true;
      if (mapped) next.push(mapped);
      else changed = true;
    }
    for (const effect of tr.effects) {
      if (effect.is(addRedlineNote)) {
        const incoming = effect.value;
        // One draft per highlight: a second plain note on the same words is the first one,
        // unless the note there came from elsewhere. A shared change is the same card when
        // it has the same change id, wherever a reload placed it, and so is an addition
        // from the connector: two of those sit at the same caret and are two cards. A
        // suggested wording for a thread (`mentionOf`) is a different card on purpose,
        // so it matches by id only.
        const exists = next.some((note) => {
          if (note.id === incoming.id) return true;
          if (incoming.shareChangeId) return note.shareChangeId === incoming.shareChangeId;
          if (incoming.agentProposalId) return note.agentProposalId === incoming.agentProposalId;
          if (incoming.mentionOf) return false;
          return !cameFromElsewhere(note) && note.from === incoming.from && note.to === incoming.to;
        });
        if (!exists) {
          next.push(incoming);
          changed = true;
        }
      } else if (effect.is(removeRedlineNote)) {
        // A shared Accept being saved leaves only through its own outcome.
        const filtered = next.filter((note) => note.id !== effect.value || note.deciding === true);
        if (filtered.length !== next.length) {
          next = filtered;
          changed = true;
        }
      } else if (effect.is(markAsking)) {
        const patched = patchById(next, effect.value.id, (note) => ({
          ...note,
          instruction: effect.value.instruction,
          proposed: null,
          intent: null,
          error: null,
          errorCode: undefined,
          notice: null,
          caution: null,
          hold: undefined,
          askId: effect.value.ask ?? null,
          status: "pending" as const,
        }));
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(setAskError)) {
        const failure = effect.value;
        const patched = patchById(next, failure.id, (note) => {
          if (!answersAsk(note, failure.ask)) return note;
          return {
            ...note,
            proposed: null,
            intent: null,
            notice: null,
            caution: null,
            hold: undefined,
            askId: undefined,
            error: failure.error,
            errorCode: failure.code ?? askErrorCode(failure.error),
            status: "error" as const,
          };
        });
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(setProposed)) {
        const answer = effect.value;
        const patched = patchById(next, answer.id, (note) => {
          if (!answersAsk(note, answer.ask)) return note;
          if (answer.intent !== "none") {
            const live = tr.state.doc.sliceString(note.from, note.to);
            if (live !== note.original) {
              return {
                ...note,
                proposed: null,
                intent: null,
                notice: null,
                caution: null,
                hold: undefined,
                askId: undefined,
                error: "The selected text changed while Alkuin was rewriting.",
                errorCode: "failed" as const,
                status: "error" as const,
              };
            }
          }
          return {
            ...note,
            proposed: answer.proposed,
            intent: answer.intent,
            instruction: answer.instruction,
            notice: answer.notice ?? null,
            caution: answer.caution ?? null,
            hold: answer.hold === true ? true : undefined,
            askId: undefined,
            error: null,
            errorCode: undefined,
            status: "pending" as const,
          };
        });
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(markAccepted)) {
        const patched = patchById(next, effect.value, (note) =>
          note.status === "pending"
            ? { ...note, status: "accepted" as const, deciding: undefined }
            : note,
        );
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(setDeciding)) {
        const { id, deciding } = effect.value;
        const patched = patchById(next, id, (note) => {
          if (note.status !== "pending" || (note.deciding === true) === deciding) return note;
          return { ...note, deciding: deciding ? true : undefined };
        });
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(markNotApplied)) {
        const patched = patchById(next, effect.value, (note) => {
          if (note.status !== "pending" || note.deciding !== true) return note;
          const suggestion = note.proposed ?? "";
          return {
            ...note,
            intent: "none" as const,
            proposed: suggestion,
            instruction: suggestion,
            shareChangeId: undefined,
            shareAccept: false,
            shareStale: undefined,
            deciding: undefined,
            notApplied: true,
          };
        });
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(reopenCompose)) {
        const patched = patchById(next, effect.value, (note) => {
          if (note.deciding) return note;
          if (isOwnCommentNote(note)) {
            return {
              ...note,
              intent: null,
              error: null,
              errorCode: undefined,
              status: "open" as const,
              instruction: note.proposed,
            };
          }
          // From an ask in flight this is Cancel: the answer, when it comes, is dropped.
          return {
            ...note,
            proposed: null,
            intent: null,
            error: null,
            errorCode: undefined,
            hold: undefined,
            askId: undefined,
            status: "open" as const,
          };
        });
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(setGitStatus)) {
        const patched = patchById(next, effect.value.id, (note) => ({
          ...note,
          git: effect.value.git,
        }));
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(setPublishResult)) {
        const patched = patchById(next, effect.value.id, (note) => ({
          ...note,
          publish: effect.value.publish,
        }));
        next = patched.notes;
        if (patched.hit) changed = true;
      } else if (effect.is(setNoteThread)) {
        const patch = effect.value;
        const patched = patchById(next, patch.id, (note) => ({
          ...note,
          ...(patch.mentions ? { mentions: patch.mentions } : {}),
          ...(patch.replies ? { replies: patch.replies } : {}),
          ...(patch.mentionOpen !== undefined ? { mentionOpen: patch.mentionOpen } : {}),
          ...(patch.mentionDone !== undefined ? { mentionDone: patch.mentionDone } : {}),
          ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
          ...(patch.mentionRows !== undefined ? { mentionRows: patch.mentionRows } : {}),
        }));
        next = patched.notes;
        if (patched.hit) changed = true;
      }
    }
    return changed ? next : notes;
  },
});

export function overlappingNote(
  notes: readonly RedlineNote[],
  from: number,
  to: number,
): RedlineNote | undefined {
  return notes.find((note) => note.from < to && from < note.to);
}

export function noteAtExactRange(
  notes: readonly RedlineNote[],
  from: number,
  to: number,
): RedlineNote | undefined {
  return notes.find((note) => note.from === from && note.to === to);
}
