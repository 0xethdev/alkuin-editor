import { useEffect } from "react";
import { StateEffect, type Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  dismissEditorNotice,
  showEditorNotice,
  useEditorNoticeStore,
} from "@/components/editor-area/editor-notice-store";
import {
  addRedlineNote,
  markAccepted,
  redlineFilePathFacet,
  redlineNotesField,
  removeRedlineNote,
  setNoteThread,
  setProposed,
} from "@/features/redline-spike/notes";
import { cameFromElsewhere, type RedlineNote } from "@/features/redline-spike/model";
import { threadKey } from "@/features/note-mention/thread";
import { refreshOpenMentions } from "@/features/note-mention/sync";
import { reloadFromDisk } from "@/hooks/editor-api";
import { subscribeAccountSignIn } from "@/lib/account-sign-in";
import { parseDocument } from "@/lib/frontmatter";
import { isSaveActive } from "@/lib/save";
import * as tauri from "@/lib/tauri";
import type { ShareChangeView, ShareSendReport } from "@/lib/tauri";
import { hostedCopy, liveSyncs, parseShareAccess } from "./access";
import { KEEP_ON_MAC_FOLDER, KEEP_ON_MAC_SHARE, KEEP_ON_MAC_UNREADABLE } from "@/lib/keep-on-mac";
import { SHARE_SEND_FAILED, SHARE_SEND_FULL } from "./copy";
import {
  createSendQueue,
  SHARE_RETRY_MS,
  type SendAttempt,
  type SendOutcome,
  type ShareSendState,
} from "./send-queue";
import {
  addRetiredRefs,
  addSettledRefs,
  adoptHostedText,
  applyHostStamp,
  clearOutbox,
  dropRetiredRefs,
  ensureBaseline,
  ledgerCloses,
  loadHeldProposals,
  loadOutbox,
  loadRetiredRefs,
  loadSentRefs,
  loadSettledRefs,
  loadShare,
  rememberShare,
  saveHeldProposals,
  saveOutbox,
  saveSentRefs,
  type StoredOutbox,
} from "./baseline";
import {
  carryHeld,
  noteRefs,
  notesFromHeld,
  notesFromPending,
  ownNotesToSend,
  passagesWithSpans,
  proposalsToSend,
  restoreHeldProposals,
  shareRefKind,
  type OutgoingPassage,
  type OwnNote,
} from "./place";

export const SHARE_SYNC_MS = 1500;
export const SHARE_POLL_MS = 4000;

/** The owner's text when this page still matches its baseline and nothing is queued.
 *  ponytail: a sent edit leaves the page different from the baseline, so a later
 *  owner save waits for the next open. Upgrade is to adopt once the buffer is clean. */
export function idleHostedText(input: {
  role: string;
  doc: string;
  baseline: string;
  pending: number;
  latest: string | null;
}): string | null {
  if (input.role !== "invitee" || input.pending > 0 || input.doc !== input.baseline) return null;
  if (input.latest == null || input.latest === input.doc) return null;
  return input.latest;
}

export function shouldLiveSync(role: {
  role: string;
  share_id?: string | null;
  status?: string | null;
}): boolean {
  return liveSyncs(
    parseShareAccess({
      role: role.role,
      share_id: role.share_id ?? null,
      document_id: "",
      status: role.status,
    }),
  );
}

/** The stamp written beside a hosted copy. A different stamp means that copy was just opened. */
export async function hostStamp(path: string): Promise<string | null> {
  const copy = hostedCopy(path);
  if (!copy) return null;
  const stampPath = `${copy.dir}/.${copy.name}.host`;
  try {
    const file = await tauri.readFile(stampPath);
    const text = file.content.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function passageSpan(passage: string): [number, number] | null {
  const match = /^(\d+):(\d+)$/.exec(passage);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
  return [start, end];
}

function passagesOverlap(left: string, right: string): boolean {
  const a = passageSpan(left);
  const b = passageSpan(right);
  if (!a || !b) return false;
  return a[0] < b[1] && b[0] < a[1];
}

/** Share a boundary. A diff hunk of an insertion starts where the suggestion ends. */
function passagesMeet(left: string, right: string): boolean {
  const a = passageSpan(left);
  const b = passageSpan(right);
  if (!a || !b) return false;
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Edit on a saved comment keeps the saved words in `proposed` until Save or Cancel. */
function isEditingComment(note: OwnNote): boolean {
  return (
    note.status === "open" && note.intent == null && note.proposed != null && !note.shareChangeId
  );
}

/** Refs of own notes this transaction removed. An accepted suggestion stays: the text keeps it. */
export function removedNoteRefs(
  before: readonly RedlineNote[],
  after: readonly RedlineNote[],
  shareId: string,
  baseline: string,
  doc: string,
): string[] {
  const kept = new Set(after.map((note) => note.id));
  const gone = before.filter(
    (note) => !kept.has(note.id) && !cameFromElsewhere(note) && note.status !== "accepted",
  );
  if (gone.length === 0) return [];
  return marginRefs(gone, shareId, baseline, doc);
}

/** The refs these margin notes stand for, a comment open for Edit included. */
export function marginRefs(
  notes: readonly OwnNote[],
  shareId: string,
  baseline: string,
  doc: string,
): string[] {
  return noteRefs(
    notes.map((note) =>
      isEditingComment(note)
        ? { ...note, status: "pending" as const, intent: "none" as const, instruction: null }
        : note,
    ),
    shareId,
    baseline,
    doc,
  );
}

/**
 * What the margin can vouch for. A reload, a file swap and a relaunch
 * rebuild the margin without its notes, so a sent comment or suggestion
 * that is missing from it is not a withdraw. Without a ledger the margin is
 * taken as complete, and every sent ref it does not produce is withdrawn.
 */
export interface MarginLedger {
  /** Refs the margin produced since it was last rebuilt. Gone now is the user's edit. */
  seen: ReadonlySet<string>;
  /** Refs whose note the user removed. */
  retired: ReadonlySet<string>;
}

export function planSharePush(input: {
  baseline: string;
  next: string;
  notes: readonly OwnNote[];
  shareId: string;
  sent: readonly string[];
  generation?: number;
  /** Owner Ask cards stay on this Mac. Collaborator proposals go out. */
  proposals?: boolean;
  /** Refs the owner already decided. Those notes are not sent again. */
  settled?: readonly string[];
  /** Comments and suggestions already sent. Kept after the margin note is gone. */
  held?: readonly OutgoingPassage[];
  ledger?: MarginLedger;
}): {
  changes: OutgoingPassage[];
  withdraw: string[];
  holds: OutgoingPassage[];
  /** Refs the margin notes produced. */
  margin: string[];
  /** Every live ref, before the 20-change cap on `changes`. */
  live: string[];
} {
  const generation = input.generation ?? 0;
  const skip = new Set(input.settled ?? []);
  const ledger = input.ledger;
  const sendsProposals = input.proposals !== false;
  const held = input.held ?? [];
  const fromNotes = sendsProposals
    ? proposalsToSend(input.notes, input.shareId, generation, input.baseline, input.next)
    : [];
  const restored = sendsProposals
    ? restoreHeldProposals(
        input.baseline,
        input.next,
        held,
        new Set(fromNotes.map((proposal) => proposal.payloadRef)),
      )
    : [];
  const proposals = [...fromNotes, ...restored];
  // ponytail: a text edit that overlaps a proposal waits. An accepted Ask
  // suggestion is that proposal, including after this Mac drops the margin
  // note. Its token diff is the same edit, including when the hunk sits on
  // the next word or the replacement is shorter, so that hunk is not sent
  // beside it. A typed edit of the following word waits until the suggestion
  // is decided. Upgrade is a diff that subtracts the suggestion span.
  // Spans are compared in the same text only: the passage's current span
  // with the note's current span, and the passage's baseline span with an
  // accepted suggestion's baseline span. A pending suggestion's `passage` is
  // in the current text, so comparing it with a baseline span would hold
  // back, and then withdraw, an unrelated delivered edit.
  const passages = passagesWithSpans(input.baseline, input.next, input.shareId, generation)
    .filter(
      ({ here, passage }) =>
        !proposals.some(
          (proposal) =>
            Boolean(here && proposal.live && passagesMeet(here, proposal.live)) ||
            Boolean(proposal.applied && passagesOverlap(passage, proposal.passage)),
        ),
    )
    .map(({ here: _here, ...passage }) => passage);
  // A comment open for Edit still holds its sent words until it is saved again.
  const marginNotes = input.notes.map((note) =>
    isEditingComment(note)
      ? { ...note, status: "pending", intent: "none", instruction: null }
      : note,
  );
  const comments = ownNotesToSend(marginNotes, input.shareId, generation, skip, input.next);
  const margin = [...fromNotes, ...comments].map((change) => change.payloadRef);
  const produced = new Set([...margin, ...restored.map((change) => change.payloadRef)]);
  const carried = ledger
    ? carryHeld(
        held.filter(
          (change) =>
            !produced.has(change.payloadRef) &&
            !ledger.seen.has(change.payloadRef) &&
            !ledger.retired.has(change.payloadRef),
        ),
        input.next,
        skip,
        sendsProposals,
      )
    : [];
  const wire = ({ live: _live, applied: _applied, ...change }: OutgoingPassage) => change;
  const holds = [
    ...proposals.map(({ live: _live, ...proposal }) => proposal),
    ...comments,
    ...carried,
  ].filter((change) => !skip.has(change.payloadRef));
  const all = [...passages, ...holds.map(wire)].filter((change) => !skip.has(change.payloadRef));
  const live = new Set(all.map((change) => change.payloadRef));
  // An accepted suggestion the text no longer holds was edited. That edit is the new change.
  const edited = new Set(
    held
      .filter((change) => change.applied && !produced.has(change.payloadRef))
      .map((change) => change.payloadRef),
  );
  const explicit = (ref: string) =>
    !ledger ||
    ledger.retired.has(ref) ||
    ledger.seen.has(ref) ||
    edited.has(ref) ||
    shareRefKind(input.shareId, ref) === "passage";
  return {
    changes: all.slice(0, 20),
    withdraw: input.sent.filter((ref) => !live.has(ref) && !skip.has(ref) && explicit(ref)),
    holds,
    margin,
    live: [...live],
  };
}

/** Tauri rejects with the error string itself. */
export function sendFailureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The part of a plan one `share_send_report` did not settle. A posted or
 * refused change and a taken withdraw are done; anything else is tried
 * again. Posts and withdraws are idempotent, so a retry is safe.
 */
export function unsettledPlan(plan: StoredOutbox, report: ShareSendReport): StoredOutbox {
  const done = new Set([...report.posted, ...report.refused]);
  const withdrawn = new Set(report.withdrawn);
  return {
    changes: plan.changes.filter((change) => !done.has(change.payloadRef)),
    withdraw: plan.withdraw.filter((ref) => !withdrawn.has(ref)),
  };
}

/**
 * The sent list after a report. A posted ref joins it; a withdrawn or a
 * refused (decided) ref leaves it. An unsettled ref keeps its place: the
 * server still has whatever it had.
 */
export function sentAfterReport(sent: readonly string[], report: ShareSendReport): string[] {
  const gone = new Set([...report.withdrawn, ...report.refused]);
  const out = new Set(sent.filter((ref) => !gone.has(ref)));
  for (const ref of report.posted) if (!gone.has(ref)) out.add(ref);
  return [...out];
}

/** The plan to keep when the role lookup itself cannot reach the server. */
export function offlinePlan(input: {
  baseline: string;
  next: string;
  notes: readonly OwnNote[];
  shareId: string;
  sent: readonly string[];
  saved: StoredOutbox;
  settled?: readonly string[];
  proposals?: boolean;
  held?: readonly OutgoingPassage[];
  ledger?: MarginLedger;
}): StoredOutbox {
  const fresh = planSharePush({
    baseline: input.baseline,
    next: input.next,
    notes: input.notes,
    shareId: input.shareId,
    sent: input.sent,
    settled: input.settled,
    proposals: input.proposals,
    held: input.held,
    ledger: input.ledger,
  });
  return mergeSharePlan(fresh, input.saved, input.next, input.ledger, input.shareId);
}

function alreadyApplied(doc: string, change: OutgoingPassage): boolean {
  if (!change.body) return false;
  const span = passageSpan(change.passage);
  if (!span || span[1] > doc.length) return false;
  return doc.slice(span[0], span[1]) === change.body;
}

/**
 * Fresh plan plus anything a previous launch could not send. With a ledger,
 * an unsent change whose note the user since removed or edited is withdrawn,
 * not sent.
 */
export function mergeSharePlan(
  fresh: {
    changes: readonly OutgoingPassage[];
    withdraw: readonly string[];
    margin?: readonly string[];
    live?: readonly string[];
  },
  saved: StoredOutbox,
  doc: string,
  ledger?: MarginLedger,
  shareId?: string,
): StoredOutbox {
  const freshRefs = new Set(fresh.changes.map((change) => change.payloadRef));
  // The whole live set, not the 20 in `changes`: a ref past the cap is still live.
  const liveNow = new Set(fresh.live ?? freshRefs);
  const marginNow = new Set(fresh.margin ?? []);
  const withdraw = new Set(fresh.withdraw);
  const kept: OutgoingPassage[] = [];
  for (const change of saved.changes) {
    if (freshRefs.has(change.payloadRef)) continue;
    // A passage is the text: one the diff no longer has was reverted. It is not
    // sent; the withdraw covers a copy that reached the server unseen.
    if (
      shareId &&
      !liveNow.has(change.payloadRef) &&
      shareRefKind(shareId, change.payloadRef) === "passage"
    ) {
      withdraw.add(change.payloadRef);
      continue;
    }
    const gone =
      ledger?.retired.has(change.payloadRef) ||
      (ledger?.seen.has(change.payloadRef) && !marginNow.has(change.payloadRef));
    if (gone) {
      withdraw.add(change.payloadRef);
      continue;
    }
    if (alreadyApplied(doc, change)) {
      withdraw.add(change.payloadRef);
      continue;
    }
    if (
      fresh.changes.some(
        (item) => item.passage === change.passage && item.payloadRef !== change.payloadRef,
      )
    ) {
      withdraw.add(change.payloadRef);
      continue;
    }
    kept.push(change);
  }
  for (const ref of saved.withdraw) {
    if (!liveNow.has(ref)) withdraw.add(ref);
  }
  const changes = [...kept, ...fresh.changes];
  for (const change of changes) withdraw.delete(change.payloadRef);
  return { changes, withdraw: [...withdraw] };
}

/**
 * Write the plan before the request, then keep only what the report left
 * unsettled. `kept` is a send to try again: the request itself failed (no
 * report, nothing settled), or the report carries an error. In the second
 * case the refs the report settled still count.
 */
export async function attemptShareSend(input: {
  plan: StoredOutbox;
  persist: (plan: StoredOutbox) => void;
  clear: () => void;
  send: (plan: StoredOutbox) => Promise<ShareSendReport>;
  /** False once the share's ledger was closed: nothing more is written. */
  open?: () => boolean;
}): Promise<{
  result: "empty" | "sent" | "kept" | "closed";
  report: ShareSendReport | null;
  error: unknown;
}> {
  if (input.plan.changes.length === 0 && input.plan.withdraw.length === 0) {
    input.clear();
    return { result: "empty", report: null, error: null };
  }
  input.persist(input.plan);
  let report: ShareSendReport;
  try {
    report = await input.send(input.plan);
  } catch (error) {
    return { result: "kept", report: null, error };
  }
  if (input.open && !input.open()) return { result: "closed", report, error: null };
  const left = unsettledPlan(input.plan, report);
  const unsettled = left.changes.length > 0 || left.withdraw.length > 0;
  if (unsettled) input.persist(left);
  else input.clear();
  if (report.error != null) return { result: "kept", report, error: report.error };
  // No error, yet a ref is in no list: an invalid report. Keep it and try again.
  if (unsettled) return { result: "kept", report, error: "unsettled" };
  return { result: "sent", report, error: null };
}

export function pendingEffects(
  doc: string,
  changes: readonly ShareChangeView[],
  notes: readonly RedlineNote[],
): { add: RedlineNote[]; remove: string[] } {
  const have = new Set(
    notes.map((note) => note.shareChangeId).filter((id): id is string => Boolean(id)),
  );
  const incomingIds = new Set(changes.map((change) => change.id));
  const fresh = changes.filter((change) => !have.has(change.id));
  return {
    add: notesFromPending(doc, fresh).filter(
      (note) => note.shareChangeId && !have.has(note.shareChangeId),
    ),
    remove: notes
      .filter((note) => note.shareChangeId && !incomingIds.has(note.shareChangeId))
      .map((note) => note.id),
  };
}

export function realtimeSocketUrl(base: string, anon: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime/v1/websocket";
  url.search = "";
  url.searchParams.set("apikey", anon);
  url.searchParams.set("vsn", "1.0.0");
  return url.toString();
}

export function realtimeShouldPull(message: string): boolean {
  return realtimeSignal(message, "", "") === "pull";
}

/** The ref `realtimeJoin` sends by default. */
export const REALTIME_JOIN_REF = "1";

/**
 * What one Realtime frame means for the socket. `pull`: a share table
 * changed. `joined`: the server took the join. `dropped`: the channel on
 * our topic is gone while the socket stays open, which is how an expired
 * token shows up (a `system` error, then `phx_close`), or the join was
 * refused. A drop reconnects with a fresh token.
 */
export function realtimeSignal(
  message: string,
  topic: string,
  joinRef: string,
): "pull" | "joined" | "dropped" | null {
  let body: { event?: unknown; topic?: unknown; ref?: unknown; payload?: unknown };
  try {
    body = JSON.parse(message) as typeof body;
  } catch {
    return null;
  }
  if (body.event === "postgres_changes") return "pull";
  if (body.topic !== topic) return null;
  const status =
    body.payload && typeof body.payload === "object"
      ? (body.payload as { status?: unknown }).status
      : undefined;
  if (body.event === "phx_close" || body.event === "phx_error") return "dropped";
  if (body.event === "system" && status === "error") return "dropped";
  if (body.event === "phx_reply" && body.ref === joinRef) {
    return status === "ok" ? "joined" : "dropped";
  }
  return null;
}

export function realtimeJoin(
  shareId: string,
  documentId: string,
  token: string,
  ref = "1",
): string {
  return JSON.stringify({
    topic: `realtime:share:${shareId}`,
    event: "phx_join",
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: "" },
        postgres_changes: [
          {
            event: "*",
            schema: "public",
            table: "document_change",
            filter: `share_id=eq.${shareId}`,
          },
          {
            event: "*",
            schema: "public",
            table: "document_proposal",
            filter: `share_id=eq.${shareId}`,
          },
          {
            event: "*",
            schema: "public",
            table: "note_mention",
            filter: `document_id=eq.${documentId}`,
          },
        ],
      },
      access_token: token,
    },
    ref,
    join_ref: ref,
  });
}

/**
 * Show the comments and pending suggestions this Mac sent that the margin
 * lost in a reload, a file swap, or a relaunch. Each one sends its old ref,
 * so the collaborator can still Dismiss or Edit it.
 */
function restoreHeldNotes(view: EditorView, path: string): void {
  const known = loadShare(path);
  if (!known || view.state.facet(redlineFilePathFacet)() !== path) return;
  const notes = view.state.field(redlineNotesField, false);
  if (!notes) return;
  const doc = view.state.doc.toString();
  const baseline = ensureBaseline(known.shareId, path, doc);
  const present = new Set(noteRefs(notes, known.shareId, baseline, doc));
  const skip = new Set([
    ...loadSettledRefs(known.shareId, path),
    ...loadRetiredRefs(known.shareId, path),
  ]);
  const ids = new Set(notes.map((note) => note.id));
  const add = notesFromHeld(
    doc,
    loadHeldProposals(known.shareId, path).filter(
      (change) => !present.has(change.payloadRef) && !skip.has(change.payloadRef),
    ),
  ).filter((note) => !ids.has(note.id));
  if (add.length === 0) return;
  view.dispatch({ effects: add.map((note) => addRedlineNote.of(note)) });
}

/**
 * Threaded comments whose words on the wire changed (the user typed inside
 * the sentence they mark). The other Mac names the thread from the words it
 * receives, so this Mac's card follows them. Rows opened under the old words
 * stay with the old id, as any edit to a comment's words makes a new thread.
 */
export function threadRekeys(
  notes: readonly RedlineNote[],
  doc: string,
): { id: string; threadId: string }[] {
  const out: { id: string; threadId: string }[] = [];
  for (const note of notes) {
    if (!note.threadId || note.shareChangeId) continue;
    // A saved own comment: what `ownNotesToSend` sends.
    if (note.status !== "pending" || note.intent !== "none" || note.instruction != null) continue;
    const text = note.proposed?.trim() ?? "";
    if (!text || note.to <= note.from) continue;
    const threadId = threadKey(doc.slice(note.from, note.to), text);
    if (threadId !== note.threadId) out.push({ id: note.id, threadId });
  }
  return out;
}

/**
 * What the margin holds now counts as seen. A note edited or dismissed before
 * the first plan of a session (the role lookup is a round trip) is then still
 * the user's edit, not a note a reload lost.
 */
function seedSeen(session: LiveSession): void {
  const { view, path } = session;
  const known = loadShare(path);
  if (!known || view.state.facet(redlineFilePathFacet)() !== path) return;
  const notes = (view.state.field(redlineNotesField, false) ?? []).filter(
    (note) => !cameFromElsewhere(note),
  );
  if (notes.length === 0) return;
  const doc = view.state.doc.toString();
  const baseline = ensureBaseline(known.shareId, path, doc);
  for (const ref of marginRefs(notes, known.shareId, baseline, doc)) session.seen.add(ref);
}

/** The user removed own notes in this transaction. A reload is not the user. */
function retireRemovedNotes(path: string, tr: Transaction): void {
  if (tr.isUserEvent("writer")) return;
  const before = tr.startState.field(redlineNotesField, false) ?? [];
  if (before.length === 0) return;
  const after = tr.state.field(redlineNotesField, false) ?? [];
  if (after.length >= before.length && !tr.effects.some((e) => e.is(removeRedlineNote))) return;
  const known = loadShare(path);
  if (!known) return;
  const doc = tr.startState.doc.toString();
  const refs = removedNoteRefs(
    before,
    after,
    known.shareId,
    ensureBaseline(known.shareId, path, doc),
    doc,
  );
  // Only a ref that left this Mac, or is planned to, has anything to withdraw.
  const out = new Set([
    ...loadSentRefs(known.shareId, path),
    ...loadOutbox(known.shareId, path).changes.map((change) => change.payloadRef),
  ]);
  addRetiredRefs(
    known.shareId,
    path,
    refs.filter((ref) => out.has(ref)),
  );
}

function noteEffect(effect: StateEffect<unknown>): boolean {
  return (
    effect.is(addRedlineNote) ||
    effect.is(removeRedlineNote) ||
    effect.is(setProposed) ||
    effect.is(setNoteThread) ||
    effect.is(markAccepted)
  );
}

/** A card from the other person left the margin by Reject or Dismiss, not by a pull. */
export function removesIncomingCard(tr: Transaction): boolean {
  const before = tr.startState.field(redlineNotesField, false) ?? [];
  if (!before.some((note) => note.shareChangeId)) return false;
  const after = new Set((tr.state.field(redlineNotesField, false) ?? []).map((note) => note.id));
  return before.some((note) => note.shareChangeId && !after.has(note.id));
}

/** A card from the other person or the connector is not the user's own: a pull paints it again. */
function hasOwnNotes(view: EditorView): boolean {
  return (view.state.field(redlineNotesField, false) ?? []).some(
    (note) => !cameFromElsewhere(note),
  );
}

/** One CodeMirror update listener per view. Sessions come and go as subscribers. */
const viewSubscribers = new WeakMap<EditorView, Set<(update: ViewUpdate) => void>>();

/** Exported for tests. A remount subscribes again; the view keeps one listener. */
export function subscribeView(
  view: EditorView,
  listener: (update: ViewUpdate) => void,
): () => void {
  let subscribers = viewSubscribers.get(view);
  if (!subscribers) {
    const fresh = new Set<(update: ViewUpdate) => void>();
    viewSubscribers.set(view, fresh);
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          for (const each of fresh) each(update);
        }),
      ),
    });
    subscribers = fresh;
  }
  subscribers.add(listener);
  const owned = subscribers;
  return () => {
    owned.delete(listener);
  };
}

/** The Realtime socket for one session. One owner: `openSocket` / `closeSocket`. */
type SocketState =
  | { kind: "closed" }
  | { kind: "connecting" }
  | { kind: "open"; ws: WebSocket; beat: number }
  | { kind: "retrying"; timer: number };

/** One open, active editor for one shared path. */
interface LiveSession {
  path: string;
  view: EditorView;
  dead: boolean;
  /** Refs the margin produced since it was last rebuilt. */
  seen: Set<string>;
  /** Bumped by each pull and by a local decision. An older pull drops its result. */
  pullSeq: number;
  /** True while `paintPending` dispatches, so its own removals are not a decision. */
  painting: boolean;
  /** True while the send re-keys mention threads; that changes nothing to send. */
  rekeying: boolean;
  debounce: number;
  retry: number;
  socket: SocketState;
  /** Bumped by every open and close. A stale socket callback does nothing. */
  socketSeq: number;
  socketTries: number;
}

/** The current session per path. A remount replaces it; the send lock stays per path. */
const sessions = new Map<string, LiveSession>();

function alive(session: LiveSession): boolean {
  return !session.dead && sessions.get(session.path) === session;
}

/** The send-failure line is one banner. This path showed the one that is up. */
let noticeOwner: string | null = null;

function releaseNotice(path: string, state: ShareSendState): void {
  const line = state.notice;
  state.notice = null;
  if (noticeOwner !== path) return;
  noticeOwner = null;
  if (line && useEditorNoticeStore.getState().message === line) dismissEditorNotice();
}

/**
 * A refusal that waiting does not fix, as the line to show; null for a
 * failure worth retrying. The stay-on-this-Mac sentences are Rust's own
 * (`mac_only.rs`); the caps are the server's pending-change limits.
 */
export function blockedSendLine(error: unknown): string | null {
  const text = sendFailureText(error).trim();
  if (
    text === KEEP_ON_MAC_SHARE ||
    text === KEEP_ON_MAC_FOLDER ||
    text === KEEP_ON_MAC_UNREADABLE
  ) {
    return text;
  }
  if (text === "change_cap" || text === "send_cap") return SHARE_SEND_FULL;
  return null;
}

const sendQueue = createSendQueue<LiveSession>({
  session: (path) => {
    const session = sessions.get(path);
    return session && !session.dead ? session : null;
  },
  send: (session) => sendOnce(session),
  failedLine: SHARE_SEND_FAILED,
  settle: (path, session, state, decision) => {
    if (decision.notice === null) releaseNotice(path, state);
    if (!session) return;
    if (typeof decision.notice === "string") {
      state.notice = decision.notice;
      noticeOwner = path;
      showEditorNotice(decision.notice, { sticky: true });
    }
    if (decision.cancelRetry) window.clearTimeout(session.retry);
    if (decision.retryIn != null) {
      window.clearTimeout(session.retry);
      session.retry = window.setTimeout(() => void sendQueue.run(path), decision.retryIn);
    }
  },
  error: (path, error) => {
    console.error(`[share] send failed for ${path}:`, error);
  },
});

/** The plan for this session's text and margin. Sync: read the view and the ledger together. */
function planFor(session: LiveSession, shareId: string, role: string, stamp: string | null) {
  const { path, view } = session;
  const next = view.state.doc.toString();
  const baseline = applyHostStamp(shareId, path, next, stamp);
  const notes = (view.state.field(redlineNotesField, false) ?? []) as readonly OwnNote[];
  const ledger: MarginLedger = {
    seen: session.seen,
    retired: new Set(loadRetiredRefs(shareId, path)),
  };
  const fresh = planSharePush({
    baseline,
    next,
    notes,
    shareId,
    sent: loadSentRefs(shareId, path),
    proposals: role === "invitee",
    settled: loadSettledRefs(shareId, path),
    held: loadHeldProposals(shareId, path),
    ledger,
  });
  for (const ref of fresh.margin) session.seen.add(ref);
  // The user wrote a removed note again. It is live, not retired.
  dropRetiredRefs(
    shareId,
    path,
    fresh.changes.map((change) => change.payloadRef),
  );
  const merged = mergeSharePlan(fresh, loadOutbox(shareId, path), next, ledger, shareId);
  return { fresh, merged, baseline };
}

/** The role lookup could not reach the server. Keep the plan on this Mac. */
async function keepOffline(session: LiveSession, closes: number): Promise<SendOutcome> {
  const known = loadShare(session.path);
  if (!known) return "stopped";
  const stamp = await hostStamp(session.path);
  if (!alive(session) || ledgerCloses() !== closes) return "stopped";
  const { merged } = planFor(session, known.shareId, known.role, stamp);
  if (merged.changes.length === 0 && merged.withdraw.length === 0) return "stopped";
  saveOutbox(known.shareId, session.path, merged);
  return "failed";
}

/**
 * One send. Every await is followed by a liveness check before the view is
 * read again. Once the request has gone, the ledger is written whatever
 * happened to the session: it records what the server now has.
 */
async function sendOnce(session: LiveSession): Promise<SendOutcome | SendAttempt> {
  const { path } = session;
  // A leave or delete while this send waits must not get its ledger back.
  const closes = ledgerCloses();
  const open = () => ledgerCloses() === closes;
  let raw: tauri.ShareRole | null;
  try {
    raw = await tauri.shareRole(path);
  } catch {
    raw = null;
  }
  if (!alive(session) || !open()) return "stopped";
  if (!raw) return keepOffline(session, closes);
  const access = parseShareAccess(raw);
  if (access.role === "none" || !liveSyncs(access)) {
    closeSocket(session);
    return "stopped";
  }
  const shareId = access.shareId;
  rememberShare(shareId, path, access.role);
  const stamp = await hostStamp(path);
  if (!alive(session) || !open()) return "stopped";
  const { fresh, merged, baseline } = planFor(session, shareId, access.role, stamp);
  const rekeys = threadRekeys(
    session.view.state.field(redlineNotesField, false) ?? [],
    session.view.state.doc.toString(),
  );
  if (rekeys.length > 0) {
    session.rekeying = true;
    try {
      session.view.dispatch({ effects: rekeys.map((patch) => setNoteThread.of(patch)) });
    } finally {
      session.rekeying = false;
    }
  }
  const batch: StoredOutbox = {
    changes: merged.changes.slice(0, 20),
    withdraw: merged.withdraw,
  };
  const rest = merged.changes.slice(20);
  const attempt = await attemptShareSend({
    plan: batch,
    persist: (plan) =>
      saveOutbox(shareId, path, {
        changes: [...plan.changes, ...rest],
        withdraw: plan.withdraw,
      }),
    clear: () => {
      if (rest.length > 0) saveOutbox(shareId, path, { changes: rest, withdraw: [] });
      else clearOutbox(shareId, path);
    },
    send: (plan) =>
      tauri.shareSendReport(
        path,
        shareId,
        plan.changes.map((change) => ({
          payload_ref: change.payloadRef,
          passage: change.passage,
          original: change.original,
          body: change.body,
        })),
        plan.withdraw,
        baseline,
      ),
    open,
  });
  if (attempt.result === "closed") return "stopped";
  const report = attempt.report;
  if (report) {
    // Settle exactly what the server took, even when the report has an error.
    if (report.refused.length > 0) addSettledRefs(shareId, path, report.refused);
    saveSentRefs(shareId, path, sentAfterReport(loadSentRefs(shareId, path), report));
    dropRetiredRefs(shareId, path, report.withdrawn);
  }
  if (report || attempt.result === "empty") saveHeldProposals(shareId, path, fresh.holds);
  if (attempt.result === "kept") {
    // No timer for a refusal waiting cannot fix: the next edit or open tries again.
    const line = blockedSendLine(attempt.error);
    return line ? { outcome: "blocked", line } : "failed";
  }
  if (attempt.result === "empty") return "empty";
  // More than 20 changes: the rest is in the outbox and goes next.
  if (rest.length > 0 && alive(session)) void sendQueue.run(path);
  return "sent";
}

/**
 * The owner's text replaces an idle invitee's copy: same text as the
 * baseline, nothing unsent, and no own margin notes. The text is checked
 * again after every await, so a keystroke during the refresh wins.
 */
async function refreshIdleCopy(session: LiveSession, shareId: string): Promise<boolean> {
  const { path, view } = session;
  if (hasOwnNotes(view)) return false;
  return sendQueue.exclusive(
    path,
    async () => {
      const closes = ledgerCloses();
      const doc = view.state.doc.toString();
      const baseline = ensureBaseline(shareId, path, doc);
      const unsent = () => {
        const saved = loadOutbox(shareId, path);
        return saved.changes.length + saved.withdraw.length;
      };
      // Only an untouched copy with nothing unsent takes the owner's text.
      if (doc !== baseline || unsent() > 0) return false;
      const unchanged = () => alive(session) && view.state.doc.toString() === doc;
      let raw = "";
      try {
        raw = await tauri.shareLatest(shareId);
      } catch {
        return false;
      }
      if (!unchanged() || hasOwnNotes(view) || ledgerCloses() !== closes) return false;
      const next = idleHostedText({
        role: "invitee",
        doc,
        baseline,
        pending: unsent(),
        latest: parseDocument(raw).body,
      });
      // A save in flight or waiting would land after the owner's text and
      // undo it. The next poll tries again.
      if (next == null || isSaveActive(path)) return false;
      adoptHostedText(shareId, path, next);
      try {
        await tauri.writeFile(path, raw);
      } catch {
        if (ledgerCloses() === closes) adoptHostedText(shareId, path, baseline);
        return false;
      }
      if (ledgerCloses() !== closes) return false;
      if (!unchanged() || hasOwnNotes(view)) {
        // Typed during the write. Auto-save writes the editor's text back,
        // and the next send is measured from the old baseline.
        adoptHostedText(shareId, path, baseline);
        return false;
      }
      reloadFromDisk(path, raw);
      return true;
    },
    false,
  );
}

function paintPending(session: LiveSession, changes: ShareChangeView[]): void {
  const { view } = session;
  const notes = view.state.field(redlineNotesField, false) ?? [];
  const { add, remove } = pendingEffects(view.state.doc.toString(), changes, notes);
  if (add.length === 0 && remove.length === 0) return;
  session.painting = true;
  try {
    view.dispatch({
      effects: [
        ...remove.map((id) => removeRedlineNote.of(id)),
        ...add.map((note) => addRedlineNote.of(note)),
      ],
    });
  } finally {
    session.painting = false;
  }
}

/** Incoming cards and mentions. The newest pull wins; an older one drops its result. */
async function pull(session: LiveSession): Promise<void> {
  const { path, view } = session;
  session.pullSeq += 1;
  const seq = session.pullSeq;
  const stale = () => !alive(session) || seq !== session.pullSeq;
  try {
    const access = parseShareAccess(await tauri.shareRole(path));
    if (stale()) return;
    if (access.role === "none" || !liveSyncs(access)) {
      closeSocket(session);
      return;
    }
    if (session.socket.kind === "closed") void openSocket(session);
    if (access.role === "invitee" && (await refreshIdleCopy(session, access.shareId))) return;
    if (stale()) return;
    const changes = await tauri.sharePending(path);
    if (stale()) return;
    paintPending(session, changes);
    await refreshOpenMentions(path, view);
  } catch {
    // The next poll retries. A failed read does not clear the margin.
  }
}

function closeSocket(session: LiveSession): void {
  session.socketSeq += 1;
  const socket = session.socket;
  if (socket.kind === "open") {
    window.clearInterval(socket.beat);
    socket.ws.onopen = null;
    socket.ws.onmessage = null;
    socket.ws.onclose = null;
    socket.ws.onerror = null;
    socket.ws.close();
  } else if (socket.kind === "retrying") {
    window.clearTimeout(socket.timer);
  }
  session.socket = { kind: "closed" };
}

/** The socket closed or failed under us. Reconnect with a fresh token, backing off. */
function socketDropped(session: LiveSession, seq: number): void {
  if (seq !== session.socketSeq || !alive(session)) return;
  if (session.socket.kind === "retrying") return;
  closeSocket(session);
  const wait = SHARE_RETRY_MS[Math.min(session.socketTries, SHARE_RETRY_MS.length - 1)]!;
  session.socketTries += 1;
  session.socket = {
    kind: "retrying",
    timer: window.setTimeout(() => void openSocket(session), wait),
  };
}

/** Close whatever socket there is first, then open one for the current role and token. */
async function openSocket(session: LiveSession): Promise<void> {
  const { path, view } = session;
  closeSocket(session);
  const seq = session.socketSeq;
  session.socket = { kind: "connecting" };
  const stale = () => !alive(session) || seq !== session.socketSeq;
  try {
    const access = parseShareAccess(await tauri.shareRole(path));
    if (stale()) return;
    if (access.role === "none" || !liveSyncs(access)) {
      session.socket = { kind: "closed" };
      return;
    }
    ensureBaseline(access.shareId, path, view.state.doc.toString());
    const auth = await tauri.shareRealtimeAuth(access.shareId);
    if (stale()) return;
    if (typeof WebSocket === "undefined") {
      session.socket = { kind: "closed" };
      return;
    }
    const ws = new WebSocket(realtimeSocketUrl(auth.url, auth.anon));
    let ref = 1;
    const beat = window.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ref += 1;
      ws.send(
        JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref) }),
      );
    }, 25_000);
    session.socket = { kind: "open", ws, beat };
    const topic = `realtime:share:${access.shareId}`;
    ws.onopen = () => {
      if (seq !== session.socketSeq) return;
      ws.send(realtimeJoin(access.shareId, access.documentId, auth.token, REALTIME_JOIN_REF));
    };
    ws.onmessage = (event) => {
      if (seq !== session.socketSeq || typeof event.data !== "string") return;
      const signal = realtimeSignal(event.data, topic, REALTIME_JOIN_REF);
      if (signal === "pull") void pull(session);
      // The backoff resets on a join the server took, not on an open socket.
      else if (signal === "joined") session.socketTries = 0;
      else if (signal === "dropped") socketDropped(session, seq);
    };
    ws.onclose = () => socketDropped(session, seq);
    ws.onerror = () => socketDropped(session, seq);
  } catch {
    if (stale()) return;
    session.socket = { kind: "closed" };
    socketDropped(session, session.socketSeq);
  }
}

function push(session: LiveSession, immediate: boolean): void {
  window.clearTimeout(session.debounce);
  if (immediate) {
    void sendQueue.run(session.path);
    return;
  }
  session.debounce = window.setTimeout(() => void sendQueue.run(session.path), SHARE_SYNC_MS);
}

function onViewUpdate(session: LiveSession, update: ViewUpdate): void {
  if (!alive(session) || session.rekeying) return;
  for (const tr of update.transactions) {
    if (tr.isUserEvent("writer")) {
      // The margin was rebuilt without its notes.
      session.seen.clear();
      queueMicrotask(() => {
        if (!alive(session)) return;
        restoreHeldNotes(session.view, session.path);
        seedSeen(session);
      });
      continue;
    }
    // A Reject or Dismiss here beats any pull that started before it.
    if (!session.painting && removesIncomingCard(tr)) session.pullSeq += 1;
    retireRemovedNotes(session.path, tr);
  }
  const noted = update.transactions.some((tr) => tr.effects.some(noteEffect));
  if (noted) push(session, true);
  else if (update.docChanged) push(session, false);
}

/** Debounced text, immediate notes, and a poll plus Realtime while the tab is focused. */
export function useShareLive(path: string, view: EditorView | null): void {
  useEffect(() => {
    if (!view) return;
    const session: LiveSession = {
      path,
      view,
      dead: false,
      seen: new Set(),
      pullSeq: 0,
      painting: false,
      rekeying: false,
      debounce: 0,
      retry: 0,
      socket: { kind: "closed" },
      socketSeq: 0,
      socketTries: 0,
    };
    sessions.set(path, session);
    const unlisten = subscribeView(view, (update) => onViewUpdate(session, update));
    restoreHeldNotes(view, path);
    seedSeen(session);
    void pull(session);
    void openSocket(session);
    void sendQueue.run(path);
    const unsubscribe = subscribeAccountSignIn((event) => {
      if (event === "open" || !alive(session)) return;
      if (event === "signed-out") {
        // The old token must not keep a socket or a pull alive.
        closeSocket(session);
        session.pullSeq += 1;
        return;
      }
      void pull(session);
      void openSocket(session);
      void sendQueue.run(path);
    });
    const poll = window.setInterval(() => {
      if (!alive(session) || (typeof document !== "undefined" && !document.hasFocus())) return;
      void pull(session);
    }, SHARE_POLL_MS);

    return () => {
      session.dead = true;
      if (sessions.get(path) === session) sessions.delete(path);
      session.pullSeq += 1;
      unlisten();
      unsubscribe();
      window.clearTimeout(session.debounce);
      window.clearTimeout(session.retry);
      window.clearInterval(poll);
      closeSocket(session);
      releaseNotice(path, sendQueue.stateFor(path));
    };
  }, [path, view]);
}
