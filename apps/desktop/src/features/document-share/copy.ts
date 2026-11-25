/** User-facing lines for one-document invites. Copy owns the final wording. */

export const INVITE_FOOTER = "Invite someone";
export const INVITE_HEADING = "Invite someone to this document";
export const INVITE_SEND = "Send invite";
export const EMAIL_LABEL = "Email";
export const ONE_DOCUMENT = "This invite is for one document.";

export const YOUR_COPY = "Your copy";
export const SEND_CHANGES = "Send changes";

/** '1 passage' / 'N passages' / '1 note' / 'N notes', joined when both are present. */
export function readyLine(passages: number, notes: number): string {
  const part = (count: number, one: string, many: string) =>
    count > 0 ? `${count} ${count === 1 ? one : many}` : "";
  return [part(passages, "passage", "passages"), part(notes, "note", "notes")]
    .filter((line) => line.length > 0)
    .join(" and ");
}

export const ACCEPT = "Accept";
export const REJECT = "Reject";
export const DISMISS = "Dismiss";
export const NO_LONGER_MATCHES = "This no longer matches.";

export const SHARE_DECIDE_FAILED = "Couldn't save that decision.";
export const SHARE_SEND_EMPTY = "Nothing new to send.";
export const SHARE_SEND_DONE = "Changes sent.";
export const SHARE_SEND_FAILED =
  "Couldn't send this change. It's saved on this Mac, and Alkuin will keep trying.";
/** The owner has too many changes waiting. */
export const SHARE_SEND_FULL =
  "This change is saved on this Mac. The owner has too many changes to answer, so Alkuin will send it after your next edit.";
export const SHARE_INVITE_DONE = "Invite sent.";
export const SHARE_INVITE_RATE = "You've sent too many invites. Try again in an hour.";
export const SHARE_INVITE_DUPLICATE =
  "You've already sent several invites to that address. Try again in an hour.";
export const SHARE_INVITE_CAP =
  "You have too many invites waiting for an answer. Remove one, then try again.";
export const SHARE_INVITE_ALREADY = "That person is already invited to this document.";
export const SHARE_INVITE_EMAIL = "That invite couldn't be sent. Check the email address.";
export const SHARE_INVITE_FAILED = "The invite couldn't be sent. Try again in a moment.";
export const SHARE_INVITE_NETWORK =
  "Alkuin can't send an invite from this connection right now. Try again later.";

export const SHARE_INVITE_OPTED_OUT =
  "This person has asked not to get invites from Alkuin. Share the document with them another way.";

const INVITE_FAILURES: Record<string, string> = {
  invite_rate: SHARE_INVITE_RATE,
  invite_duplicate: SHARE_INVITE_DUPLICATE,
  invite_cap: SHARE_INVITE_CAP,
  already_invited: SHARE_INVITE_ALREADY,
  invite_opted_out: SHARE_INVITE_OPTED_OUT,
  validation_failed: SHARE_INVITE_EMAIL,
  mail_failed: SHARE_INVITE_FAILED,
  no_client_ip: SHARE_INVITE_NETWORK,
  unreachable: SHARE_INVITE_FAILED,
  unavailable: SHARE_INVITE_FAILED,
};

/** The sentence for a failed invite. Never the success line. */
export function inviteFailureNotice(raw: string): string {
  const code = raw.trim().replace(/^"|"$/g, "").split(":")[0]?.trim() ?? "";
  return INVITE_FAILURES[code] ?? SHARE_INVITE_FAILED;
}

export function fromPerson(name: string): string {
  return `From ${name}`;
}

export function noteFrom(name: string): string {
  return `Note from ${name}`;
}

export function draftChange(text: string): string {
  return text;
}

export function personName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const word = local.split(/[._-]/)[0] ?? "";
  if (!word) return "Someone";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export const SHARE_COPY = [
  INVITE_FOOTER,
  INVITE_HEADING,
  INVITE_SEND,
  EMAIL_LABEL,
  ONE_DOCUMENT,
  YOUR_COPY,
  SEND_CHANGES,
  readyLine(2, 1),
  readyLine(1, 0),
  readyLine(0, 1),
  ACCEPT,
  REJECT,
  DISMISS,
  NO_LONGER_MATCHES,
  SHARE_DECIDE_FAILED,
  SHARE_SEND_EMPTY,
  SHARE_SEND_DONE,
  SHARE_SEND_FAILED,
  SHARE_SEND_FULL,
  SHARE_INVITE_DONE,
  SHARE_INVITE_RATE,
  SHARE_INVITE_DUPLICATE,
  SHARE_INVITE_CAP,
  SHARE_INVITE_ALREADY,
  SHARE_INVITE_EMAIL,
  SHARE_INVITE_FAILED,
  SHARE_INVITE_NETWORK,
  fromPerson("Maria"),
  noteFrom("Maria"),
  draftChange("The harbor is quiet once the boats are in."),
] as const;
