import {
  ACCEPT,
  draftChange,
  EMAIL_LABEL,
  fromPerson,
  INVITE_FOOTER,
  INVITE_HEADING,
  INVITE_SEND,
  noteFrom,
  ONE_DOCUMENT,
  readyLine,
  REJECT,
  SEND_CHANGES,
  YOUR_COPY,
} from "@/features/document-share/copy";
import { emptyGitStatus, type RedlineNote } from "@/features/redline-spike/model";

export { ACCEPT, INVITE_FOOTER, REJECT, SEND_CHANGES, YOUR_COPY };

/**
 * Throwaway fixture for the invite design preview.
 * Shapes match what the server sends for a share and its changes.
 * A margin note is still one change: passage, original, payload reference.
 */

export const DOCUMENT_TITLE = "The harbor essay";
export const INVITED_EMAIL = "maria@example.com";
const OWNER_EMAIL = "alex@example.com";
const SENDER_NAME = "Maria";

const FROM_MARIA = fromPerson("Maria");
const NOTE_FROM_MARIA = noteFrom("Maria");
export const READY_LINE = readyLine(2, 1);

const HARBOR = "The harbor stays quiet after the boats come in.";
const LEDGER = "Maria's father kept the ledger in pencil.";
const LIGHT = "A light stayed on in the chandlery until the tide turned.";
const WEATHER = "The weather was really very bad, and nobody wanted to go out.";

const HARBOR_TEXT = "The harbor is quiet once the boats are in.";
const LEDGER_TEXT = "Her father kept the ledger in pencil, one line for each boat.";
const NOTE_TEXT = "This already sounds like the room. I would leave it.";
const HELP_ASK = "Drop the extra words.";
const HELP_TEXT = "The weather was bad, and nobody wanted to go out.";

export const OWNER_DOC = `# ${DOCUMENT_TITLE}

${HARBOR}

${LEDGER}

${LIGHT}

${WEATHER}
`;

export const COLLAB_DOC = `# ${DOCUMENT_TITLE}

${HARBOR_TEXT}

${LEDGER_TEXT}

${LIGHT}

${WEATHER}
`;

interface ShareFixture {
  id: string;
  document_id: string;
  title: string;
  invited_email: string;
  owner_email: string;
  status: "pending" | "accepted" | "declined" | "removed";
  role: "owner" | "invitee";
}

interface ChangeFixture {
  id: string;
  share_id: string;
  document_id: string;
  payload_ref: string;
  passage: string;
  passage_start: number;
  passage_end: number;
  original: string;
  sender_email: string;
  /** The resolved payload. */
  text: string;
  kind: "replace" | "note";
}

const SHARE: ShareFixture = {
  id: "share-harbor",
  document_id: "doc-harbor",
  title: DOCUMENT_TITLE,
  invited_email: INVITED_EMAIL,
  owner_email: OWNER_EMAIL,
  status: "accepted",
  role: "invitee",
};

function span(doc: string, original: string) {
  const passage_start = doc.indexOf(original);
  if (passage_start < 0) throw new Error(`missing passage: ${original}`);
  const passage_end = passage_start + original.length;
  return {
    passage_start,
    passage_end,
    passage: `${passage_start}:${passage_end}`,
    original,
  };
}

const CHANGES: ChangeFixture[] = [
  {
    id: "maria-harbor",
    share_id: SHARE.id,
    document_id: SHARE.document_id,
    payload_ref: "payload-harbor",
    ...span(OWNER_DOC, HARBOR),
    sender_email: INVITED_EMAIL,
    text: HARBOR_TEXT,
    kind: "replace",
  },
  {
    id: "maria-ledger",
    share_id: SHARE.id,
    document_id: SHARE.document_id,
    payload_ref: "payload-ledger",
    ...span(OWNER_DOC, LEDGER),
    sender_email: INVITED_EMAIL,
    text: LEDGER_TEXT,
    kind: "replace",
  },
  {
    id: "maria-note",
    share_id: SHARE.id,
    document_id: SHARE.document_id,
    payload_ref: "payload-note",
    ...span(OWNER_DOC, LIGHT),
    sender_email: INVITED_EMAIL,
    text: NOTE_TEXT,
    kind: "note",
  },
];

function note(partial: Omit<RedlineNote, "git" | "publish" | "error" | "status">): RedlineNote {
  return {
    ...partial,
    status: "pending",
    error: null,
    git: emptyGitStatus(),
    publish: null,
  };
}

export const MARGIN_NOTES: RedlineNote[] = [
  ...CHANGES.map((change) =>
    note({
      id: change.id,
      from: change.passage_start,
      to: change.passage_end,
      original: change.original,
      proposed: change.text,
      intent: change.kind === "note" ? "none" : "replace",
      instruction: draftChange(change.text),
      person: "Maria",
      shareAccept: change.kind === "replace",
    }),
  ),
  note({
    id: "help-weather",
    ...(() => {
      const range = span(OWNER_DOC, WEATHER);
      return { from: range.passage_start, to: range.passage_end, original: WEATHER };
    })(),
    proposed: HELP_TEXT,
    intent: "replace",
    instruction: HELP_ASK,
  }),
];

const collabLight = span(COLLAB_DOC, LIGHT);

export const COLLAB_NOTE: RedlineNote = note({
  id: "own-note",
  from: collabLight.passage_start,
  to: collabLight.passage_end,
  original: LIGHT,
  proposed: NOTE_TEXT,
  intent: "none",
  instruction: null,
});

export const VISIBLE_COPY = [
  DOCUMENT_TITLE,
  INVITED_EMAIL,
  OWNER_EMAIL,
  SENDER_NAME,
  INVITE_FOOTER,
  INVITE_HEADING,
  INVITE_SEND,
  EMAIL_LABEL,
  ONE_DOCUMENT,
  YOUR_COPY,
  SEND_CHANGES,
  READY_LINE,
  FROM_MARIA,
  NOTE_FROM_MARIA,
  ACCEPT,
  REJECT,
  HARBOR_TEXT,
  LEDGER_TEXT,
  NOTE_TEXT,
  HELP_ASK,
  HELP_TEXT,
  OWNER_DOC,
  COLLAB_DOC,
];

/** Half-open ranges. End is not covered. */
export function fixtureHolds(): boolean {
  if (SHARE.title.length < 1 || SHARE.title.length > 200) return false;
  if (SHARE.invited_email !== SHARE.invited_email.toLowerCase()) return false;
  if (!SHARE.invited_email.includes("@") || SHARE.invited_email === SHARE.owner_email) return false;
  if (SHARE.status !== "accepted") return false;
  for (const change of CHANGES) {
    if (change.passage !== `${change.passage_start}:${change.passage_end}`) return false;
    if (OWNER_DOC.slice(change.passage_start, change.passage_end) !== change.original) return false;
    if (change.original.length < 1 || change.original.length > 2000) return false;
    if (change.payload_ref.length < 1 || change.payload_ref.length > 200) return false;
    if (change.sender_email !== INVITED_EMAIL) return false;
  }
  const harbor = CHANGES[0];
  const ledger = CHANGES[1];
  if (!harbor || !ledger) return false;
  const touch = harbor.passage_end === ledger.passage_start;
  const overlap =
    harbor.passage_start < ledger.passage_end && ledger.passage_start < harbor.passage_end;
  if (touch || overlap) return false;
  return MARGIN_NOTES.length === 4 && COLLAB_NOTE.instruction === null;
}
