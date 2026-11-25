import * as tauri from "@/lib/tauri";

/** Which sidebar paths wait on this account's answer. `dots.tsx` paints it. */
const listeners = new Set<() => void>();
let pathIds = new Map<string, string>();
let openIds = new Set<string>();
/** Bumped when the account changes. A read started for the last account is dropped. */
let account = 0;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeMentionDots(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function waitingOnPath(path: string): boolean {
  const id = pathIds.get(path);
  return Boolean(id && openIds.has(id));
}

/** Sign-out or a new sign-in. The dots were the last account's. */
export function forgetMentionDots(): void {
  account += 1;
  pathIds = new Map();
  openIds = new Set();
  emit();
}

/** One read of the dots. Both maps change together, and only for the account that asked. */
export async function refreshMentionDots(
  paths: readonly string[],
  live: () => boolean = () => true,
): Promise<void> {
  const asked = account;
  const current = () => live() && asked === account;
  const keys = await tauri.mentionDocumentIds([...paths]);
  if (!current()) return;
  const open = await tauri.mentionOpen();
  if (!current()) return;
  pathIds = new Map(keys.map((row) => [row.path, row.document_id]));
  openIds = new Set(open.map((row) => row.document_id));
  emit();
}
