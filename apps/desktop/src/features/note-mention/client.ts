import * as tauri from "@/lib/tauri";
import { mentionable, type AccessPerson } from "./logic";
import { MENTION_SEND_FAILED, PICKER_MAC_ONLY } from "./strings";

const picked = new Map<string, { id: string; name: string }[]>();

export function rememberMention(noteId: string, person: { id: string; name: string }): void {
  const list = picked.get(noteId) ?? [];
  if (!list.some((item) => item.id === person.id)) list.push(person);
  picked.set(noteId, list);
}

export function mentionsInText(noteId: string, text: string): { id: string; name: string }[] {
  return (picked.get(noteId) ?? []).filter((person) => text.includes(`@${person.name}`));
}

export async function loadMentionPeople(
  path: string,
): Promise<{ macOnly: boolean; people: AccessPerson[] }> {
  const body = await tauri.mentionPeople(path);
  if (body.mac_only) return { macOnly: true, people: [] };
  const people: AccessPerson[] = (body.people ?? []).flatMap((person) => {
    if (person.role !== "owner" && person.role !== "accepted") return [];
    const name = person.name?.trim() ?? "";
    return [{ id: person.id, email: person.email, name: name || null, role: person.role }];
  });
  return { macOnly: false, people: mentionable(people, "") };
}

export type PeopleLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; macOnly: boolean; people: AccessPerson[] };

/**
 * The @ list's people for one field. Only `ready` has people to list: while
 * loading, or after a failure, the list says nothing rather than "nobody
 * accepted". A failed load is asked again on the next `ensure`, which the
 * field calls on the next keystroke, never in a loop.
 */
export function mentionPeopleLoader(
  path: string,
  load: typeof loadMentionPeople = loadMentionPeople,
): { current(): PeopleLoad; ensure(onReady: () => void): void } {
  let state: PeopleLoad = { kind: "idle" };
  return {
    current: () => state,
    ensure(onReady) {
      if (state.kind === "loading" || state.kind === "ready") return;
      state = { kind: "loading" };
      load(path).then(
        (result) => {
          state = { kind: "ready", macOnly: result.macOnly, people: result.people };
          onReady();
        },
        () => {
          state = { kind: "failed" };
        },
      );
    },
  };
}

type MentionWrite = {
  path: string;
  action: "mention" | "reply" | "wording" | "done";
  noteId: string;
  quote?: string | null;
  mentionedIds: string[];
  noteAuthor?: string | null;
};

/**
 * sent: the server has it. local: there is no one this document can reach
 * (kept on this Mac, or no access), so the step stands on this Mac only.
 * failed: it did not go; the caller leaves the thread as it was.
 */
export type MentionSend = { outcome: "sent" | "local" | "failed"; line: string | null };

/** Tauri rejects with the error string itself. */
function failureCode(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "";
}

export async function sendMention(input: MentionWrite): Promise<MentionSend> {
  try {
    await tauri.mentionWrite(input);
    return { outcome: "sent", line: null };
  } catch (error) {
    const code = failureCode(error);
    if (code === "mac_only") return { outcome: "local", line: PICKER_MAC_ONLY };
    if (code === "no_access") return { outcome: "local", line: MENTION_SEND_FAILED };
    return { outcome: "failed", line: MENTION_SEND_FAILED };
  }
}

export async function submitMention(input: MentionWrite): Promise<string | null> {
  return (await sendMention(input)).line;
}
