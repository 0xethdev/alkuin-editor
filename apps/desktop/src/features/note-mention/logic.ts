import { pickerLabel } from "./strings.ts";

export type AccessRole = "owner" | "accepted" | "pending" | "removed" | "declined";

export type AccessPerson = {
  id: string;
  email: string;
  name?: string | null;
  role: AccessRole;
};

/** Owner and accepted invitees, never the current user, never a pending invite. */
export function mentionable(people: readonly AccessPerson[], selfId: string): AccessPerson[] {
  return people.filter(
    (person) => person.id !== selfId && (person.role === "owner" || person.role === "accepted"),
  );
}

export function matchPeople(people: readonly AccessPerson[], query: string): AccessPerson[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...people];
  return people.filter((person) => {
    const name = pickerLabel(person.name, person.email).toLowerCase();
    const local = (person.email.split("@")[0] ?? "").toLowerCase();
    return name.includes(needle) || local.includes(needle);
  });
}

/** The @ being typed, if the caret sits in one. Same match as composeMentionQuery. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  const match = /(?:^|[\s([{"'])@([^\s@]*)$/u.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

export function insertMention(text: string, start: number, caret: number, label: string): string {
  const end = Math.max(start, Math.min(caret, text.length));
  return `${text.slice(0, start)}@${label} ${text.slice(end)}`;
}
