import { SUPPORT_EMAIL } from "@/lib/account-copy";

/** A mail draft this long still opens. Longer notes stay on the page. */
export const FEEDBACK_NOTE_MAX = 1500;

export type FeedbackKind = "feature" | "bug";

export const FEEDBACK_KINDS: { kind: FeedbackKind; label: string }[] = [
  { kind: "feature", label: "Request a feature" },
  { kind: "bug", label: "Report a bug" },
];

const EMPTY = "Write a note first.";
const TOO_LONG = `Keep the note under ${FEEDBACK_NOTE_MAX.toLocaleString("en-US")} characters.`;
const OPENED = "Opened in your mail app. Send it from there.";
const FAILED = `Couldn't open your mail app. Write to ${SUPPORT_EMAIL}.`;

export type FeedbackSubmit =
  | { state: "empty" }
  | { state: "too_long" }
  | { state: "opened" }
  | { state: "failed"; url: string };

export function feedbackNotice(result: FeedbackSubmit): string {
  switch (result.state) {
    case "empty":
      return EMPTY;
    case "too_long":
      return TOO_LONG;
    case "opened":
      return OPENED;
    case "failed":
      return FAILED;
  }
}

function labelFor(kind: FeedbackKind): string {
  return FEEDBACK_KINDS.find((item) => item.kind === kind)?.label ?? FEEDBACK_KINDS[0].label;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Null when the note should not leave the page. */
export function feedbackMailto(input: {
  kind: FeedbackKind;
  note: string;
  email?: string | null;
  build?: string | null;
}): string | null {
  const note = input.note.trim();
  if (!note || note.length > FEEDBACK_NOTE_MAX) return null;
  const from = oneLine(input.email ?? "");
  const build = oneLine(input.build ?? "");
  const context = [from ? `From: ${from}` : "", build && build !== "Version" ? build : ""].filter(
    (line) => line.length > 0,
  );
  const body = context.length > 0 ? `${note}\n\n${context.join("\n")}` : note;
  const query = `subject=${encodeURIComponent(labelFor(input.kind))}&body=${encodeURIComponent(body)}`;
  return `mailto:${SUPPORT_EMAIL}?${query}`;
}

/**
 * ponytail: opens the writer's mail app; it does not confirm they pressed Send.
 * Upgrade path: send it from the server.
 */
export async function submitFeedback(
  input: {
    kind: FeedbackKind;
    note: string;
    email?: string | null;
    build?: string | null;
  },
  open: (url: string) => Promise<unknown>,
): Promise<FeedbackSubmit> {
  const url = feedbackMailto(input);
  if (!url) {
    const tooLong = input.note.trim().length > FEEDBACK_NOTE_MAX;
    return tooLong ? { state: "too_long" } : { state: "empty" };
  }
  try {
    await open(url);
    return { state: "opened" };
  } catch {
    return { state: "failed", url };
  }
}
