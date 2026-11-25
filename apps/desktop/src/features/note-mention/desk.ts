import type { EditorView } from "@codemirror/view";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import {
  addRedlineNote,
  nextRedlineId,
  redlineNotesField,
  removeRedlineNote,
  setNoteThread,
} from "@/features/redline-spike/notes";
import { noteState, type RedlineNote } from "@/features/redline-spike/model";
import {
  mentionPeopleLoader,
  mentionsInText,
  rememberMention,
  sendMention,
  type MentionSend,
} from "./client";
import { insertMention, matchPeople, mentionQuery, type AccessPerson } from "./logic";
import { threadIdFor } from "./thread";
import {
  MARK_DONE_DONE,
  MARKER_MENTIONED,
  OPEN_TAG_LABEL,
  PICKER_EMPTY,
  PICKER_MAC_ONLY,
  REPLY_PLACEHOLDER,
  REPLY_SEND,
  SUGGEST_PLACEHOLDER,
  SUGGEST_SEND,
  SUGGEST_WORDING,
  YOU_LABEL,
  pickerLabel,
} from "./strings";
import "./mention.css";

type Picker = { onKey(event: KeyboardEvent): boolean };

export function bindMentionField(field: HTMLTextAreaElement, noteId: string, path: string): Picker {
  const loader = mentionPeopleLoader(path);
  let open = false;
  let active = 0;
  const list = document.createElement("div");
  list.className = "mention-picker";
  list.hidden = true;
  list.setAttribute("role", "listbox");
  const attach = () => {
    if (list.isConnected) return;
    field.parentElement?.append(list);
  };
  attach();

  const rowsNow = () => {
    const load = loader.current();
    const query = mentionQuery(field.value, field.selectionStart ?? field.value.length);
    if (!query || load.kind !== "ready" || load.macOnly) return [];
    return matchPeople(load.people, query.query);
  };

  const draw = () => {
    attach();
    const query = mentionQuery(field.value, field.selectionStart ?? field.value.length);
    const load = loader.current();
    if (!query || load.kind !== "ready") {
      // Still loading, or the load failed: say nothing rather than "nobody accepted".
      // A failed load is asked again on the next keystroke.
      if (query) loader.ensure(draw);
      list.hidden = true;
      open = false;
      return;
    }
    open = true;
    list.hidden = false;
    list.replaceChildren();
    if (load.macOnly) {
      list.append(emptyLine(PICKER_MAC_ONLY));
      return;
    }
    const rows = rowsNow();
    if (rows.length === 0) {
      list.append(emptyLine(PICKER_EMPTY));
      return;
    }
    if (active >= rows.length) active = 0;
    rows.forEach((person, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mention-picker-row";
      button.setAttribute("role", "option");
      if (index === active) button.setAttribute("aria-selected", "true");
      const name = document.createElement("span");
      name.className = "mention-picker-name";
      name.textContent = pickerLabel(person.name, person.email);
      const email = document.createElement("span");
      email.className = "mention-picker-email";
      email.textContent = person.email;
      button.append(name, email);
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pick(person);
      });
      list.append(button);
    });
  };

  const pick = (person: AccessPerson) => {
    const query = mentionQuery(field.value, field.selectionStart ?? field.value.length);
    if (!query) return;
    const label = pickerLabel(person.name, person.email);
    const caret = field.selectionStart ?? field.value.length;
    field.value = insertMention(field.value, query.start, caret, label);
    rememberMention(noteId, { id: person.id, name: label });
    const next = query.start + label.length + 2;
    field.setSelectionRange(next, next);
    list.hidden = true;
    open = false;
    field.focus();
  };

  field.addEventListener("input", () => {
    active = 0;
    draw();
  });
  field.addEventListener("click", () => draw());
  field.addEventListener("keyup", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") return;
    draw();
  });

  return {
    onKey(event) {
      if (!open || list.hidden) return false;
      const rows = rowsNow();
      if (event.key === "Escape") {
        list.hidden = true;
        open = false;
        return true;
      }
      if (event.key === "ArrowDown") {
        active = Math.min(active + 1, Math.max(rows.length - 1, 0));
        draw();
        return true;
      }
      if (event.key === "ArrowUp") {
        active = Math.max(active - 1, 0);
        draw();
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey && rows[active]) {
        pick(rows[active]);
        return true;
      }
      return false;
    },
  };
}

function emptyLine(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "mention-picker-empty";
  line.textContent = text;
  return line;
}

export function paintMentionText(text: string, mentions: { name: string }[]): HTMLElement {
  const root = document.createElement("span");
  const names = mentions.map((mention) => mention.name).filter((name) => name.length > 0);
  if (names.length === 0) {
    root.textContent = text;
    return root;
  }
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join("|")})`, "g");
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) root.append(text.slice(last, index));
    const chip = document.createElement("span");
    chip.className = "mention-chip";
    chip.textContent = `@${match[1]}`;
    root.append(chip);
    last = index + match[0].length;
  }
  if (last < text.length) root.append(text.slice(last));
  return root;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionMarker(): HTMLElement {
  const marker = document.createElement("p");
  marker.className = "mention-marker";
  marker.dataset.mentionMarker = "true";
  marker.title = MARKER_MENTIONED;
  marker.setAttribute("aria-label", MARKER_MENTIONED);
  marker.textContent = MARKER_MENTIONED;
  return marker;
}

export function openTagDot(): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "mention-dot";
  dot.dataset.openTag = "true";
  dot.title = OPEN_TAG_LABEL;
  dot.setAttribute("aria-label", OPEN_TAG_LABEL);
  dot.setAttribute("role", "img");
  return dot;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "cm-redline-btn";
  el.textContent = label;
  el.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  el.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return el;
}

function noteIsThreaded(note: RedlineNote): boolean {
  return (
    Boolean(note.mentionOpen) || (note.mentions?.length ?? 0) > 0 || (note.replies?.length ?? 0) > 0
  );
}

/** The card as it is now. Positions and replies in a render closure go stale. */
function liveNote(view: EditorView, id: string): RedlineNote | undefined {
  return view.state.field(redlineNotesField, false)?.find((note) => note.id === id);
}

/** One thread step at a time per card, across redraws of its chrome. */
const sending = new Set<string>();

async function sendOnce(noteId: string, send: () => Promise<MentionSend>): Promise<MentionSend> {
  sending.add(noteId);
  try {
    const sent = await send();
    if (sent.line) showEditorNotice(sent.line);
    return sent;
  } finally {
    sending.delete(noteId);
  }
}

/**
 * Done removes the note. A mention thread tells the server first and removes
 * the note once it has; when the send fails the note stays, still open.
 */
export async function finishMentionNote(
  view: EditorView,
  noteId: string,
  path: string,
): Promise<boolean> {
  const note = liveNote(view, noteId);
  if (!note || sending.has(noteId)) return false;
  if (noteIsThreaded(note)) {
    const sent = await sendOnce(noteId, () =>
      sendMention({
        path,
        action: "done",
        noteId: threadIdFor(note, view.state.doc),
        mentionedIds: [],
      }),
    );
    if (sent.outcome === "failed" || !view.dom.isConnected) return false;
  }
  view.dispatch({ effects: removeRedlineNote.of(note.id) });
  return true;
}

/** A reply shows once the server has it. A failed send leaves the thread as it was. */
export async function sendMentionReply(
  view: EditorView,
  noteId: string,
  path: string,
  text: string,
): Promise<boolean> {
  const note = liveNote(view, noteId);
  const body = text.trim();
  if (!note || !body || sending.has(noteId)) return false;
  const threadId = threadIdFor(note, view.state.doc);
  const mentions = mentionsInText(`${noteId}:reply`, body);
  const sent = await sendOnce(noteId, () =>
    sendMention({
      path,
      action: "reply",
      noteId: threadId,
      quote: body,
      mentionedIds: mentions.map((mention) => mention.id),
    }),
  );
  if (sent.outcome === "failed") return false;
  const live = liveNote(view, noteId);
  if (!live || !view.dom.isConnected) return sent.outcome === "sent";
  view.dispatch({
    effects: setNoteThread.of({
      id: noteId,
      threadId,
      replies: [
        ...(live.replies ?? []),
        { id: nextRedlineId(), authorId: "", authorName: YOU_LABEL, text: body },
      ],
      mentionOpen: false,
      mentionDone: true,
    }),
  });
  return true;
}

/**
 * The suggestion is a card on the note's words as they are now. The thread
 * is answered only once that card is in the margin and the server has the
 * wording. A failed send keeps the card and leaves the thread open.
 */
export async function sendMentionWording(
  view: EditorView,
  noteId: string,
  path: string,
  text: string,
): Promise<boolean> {
  const note = liveNote(view, noteId);
  const body = text.trim();
  if (!note || !body || sending.has(noteId)) return false;
  const wordingId = nextRedlineId();
  view.dispatch({
    effects: addRedlineNote.of({
      id: wordingId,
      from: note.from,
      to: note.to,
      original: view.state.doc.sliceString(note.from, note.to),
      proposed: body,
      intent: "replace",
      instruction: null,
      status: "pending",
      error: null,
      git: null,
      publish: null,
      person: YOU_LABEL,
      shareAccept: true,
      mentionOf: noteId,
    }),
  });
  if (!liveNote(view, wordingId)) return false;
  const threadId = threadIdFor(note, view.state.doc);
  const sent = await sendOnce(noteId, () =>
    sendMention({ path, action: "wording", noteId: threadId, mentionedIds: [] }),
  );
  if (sent.outcome === "failed") return false;
  if (liveNote(view, noteId) && view.dom.isConnected) {
    view.dispatch({
      effects: setNoteThread.of({ id: noteId, threadId, mentionOpen: false, mentionDone: true }),
    });
  }
  return true;
}

/** Marker, replies, Done, and a reply or a suggested wording.
 *  The reply field stays shut until Reply is clicked. */
export function appendMentionChrome(
  root: HTMLElement,
  note: RedlineNote,
  view: EditorView,
  path: string,
): void {
  if (note.mentionOpen && !note.mentionDone) root.prepend(mentionMarker());
  const replies = note.replies ?? [];
  for (const reply of replies) {
    const line = document.createElement("p");
    line.className = "mention-reply";
    line.dataset.mentionReply = reply.id;
    const name = document.createElement("span");
    name.className = "mention-reply-name";
    name.textContent = `${reply.authorName} `;
    line.append(name, reply.text);
    root.append(line);
  }
  const state = noteState(note);
  const showThread = note.mentionOpen || state.kind === "own-comment";
  if (!showThread || state.kind === "compose") return;

  const replyField = document.createElement("div");
  replyField.className = "mention-field";
  replyField.hidden = true;
  const reply = document.createElement("textarea");
  reply.className = "cm-redline-instruction";
  reply.rows = 2;
  reply.placeholder = REPLY_PLACEHOLDER;
  reply.setAttribute("aria-label", REPLY_PLACEHOLDER);
  reply.addEventListener("mousedown", (event) => event.stopPropagation());
  const picker = bindMentionField(reply, `${note.id}:reply`, path);
  const sendReply = () => {
    const text = reply.value.trim();
    if (!text || reply.disabled) return;
    // The field keeps the text until the reply is sent, so a failed send can be tried again.
    reply.disabled = true;
    void sendMentionReply(view, note.id, path, text).finally(() => {
      reply.disabled = false;
    });
  };
  reply.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (picker.onKey(event)) {
      event.preventDefault();
      return;
    }
    if (event.isComposing || event.key === "Process" || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      sendReply();
    }
  });
  replyField.append(reply);

  const suggest = document.createElement("textarea");
  suggest.className = "cm-redline-instruction";
  suggest.rows = 2;
  suggest.hidden = true;
  suggest.placeholder = SUGGEST_PLACEHOLDER;
  suggest.setAttribute("aria-label", SUGGEST_PLACEHOLDER);
  suggest.addEventListener("mousedown", (event) => event.stopPropagation());

  const sendSuggest = button(SUGGEST_SEND, () => {
    const text = suggest.value.trim();
    if (!text) return;
    sendSuggest.disabled = true;
    void sendMentionWording(view, note.id, path, text).finally(() => {
      sendSuggest.disabled = false;
    });
  });
  sendSuggest.hidden = true;

  const replyButton = button(REPLY_SEND, () => {
    if (replyField.hidden) {
      replyField.hidden = false;
      reply.focus();
      return;
    }
    sendReply();
  });
  const doneButton = button(MARK_DONE_DONE, () => {
    doneButton.disabled = true;
    void finishMentionNote(view, note.id, path).finally(() => {
      doneButton.disabled = false;
    });
  });

  let actions = root.querySelector<HTMLDivElement>(".cm-redline-note-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "cm-redline-note-actions";
    root.append(actions);
  }
  actions.append(replyButton, doneButton);
  if (note.mentionOpen) {
    actions.append(
      button(SUGGEST_WORDING, () => {
        suggest.hidden = false;
        sendSuggest.hidden = false;
        suggest.focus();
      }),
    );
  }
  actions.append(sendSuggest);
  root.append(replyField, suggest);
}

/** `threadId` is the id both Macs derive for this note (`thread.ts`), never the card id. */
export async function publishNoteMentions(
  path: string,
  threadId: string,
  text: string,
  mentions: readonly { id: string; name: string }[],
): Promise<void> {
  if (mentions.length === 0) return;
  const sent = await sendMention({
    path,
    action: "mention",
    noteId: threadId,
    quote: text,
    mentionedIds: mentions.map((mention) => mention.id),
  });
  if (sent.line) showEditorNotice(sent.line);
}
