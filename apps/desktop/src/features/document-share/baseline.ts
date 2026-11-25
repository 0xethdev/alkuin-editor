/** The text a shared file had when it was first opened this launch. Auto-save
 * writes edits to disk before a later sync reads them, so the baseline has to
 * be taken at open. Opened text stays in memory. The per-share baseline and
 * outbox keys use localStorage; a full store falls back to memory for the
 * launch. Upgrade path is the Tauri store. */

import { hostedCopy } from "./access";

export interface TextStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  keys?(): string[];
}

const OPENED = "alkuin-share-opened";
const memory = new Map<string, string>();
/** Opened text is for this launch only. It is never written to disk. */
const LAUNCH_ONLY = `${OPENED}:`;
let purged = false;

function diskStore(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    localStorage.getItem(OPENED);
    return localStorage;
  } catch {
    return null;
  }
}

/** Older builds kept every opened document here. Drop those copies once per launch. */
function purgeOpenedCopies(disk: Storage): void {
  if (purged) return;
  purged = true;
  try {
    const stale: string[] = [];
    for (let i = 0; i < disk.length; i++) {
      const key = disk.key(i);
      if (key?.startsWith(LAUNCH_ONLY)) stale.push(key);
    }
    for (const key of stale) disk.removeItem(key);
  } catch {
    // The next launch tries again.
  }
}

function backing(): TextStore {
  const disk = diskStore();
  if (disk) purgeOpenedCopies(disk);
  return {
    getItem: (key) => {
      if (key.startsWith(LAUNCH_ONLY) || !disk || memory.has(key)) return memory.get(key) ?? null;
      try {
        return disk.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      if (key.startsWith(LAUNCH_ONLY) || !disk) {
        memory.set(key, value);
        return;
      }
      try {
        disk.setItem(key, value);
        // The disk copy is now the newest. A stale memory copy would shadow it.
        memory.delete(key);
      } catch {
        // ponytail: a full store keeps this launch working from memory.
        memory.set(key, value);
      }
    },
    // A key can sit in either store (a full disk pushed it into memory), so
    // removal clears both. Otherwise a closed ledger comes back from the other one.
    removeItem: (key) => {
      memory.delete(key);
      disk?.removeItem(key);
    },
    /** Every key either store holds: what the disk has, plus what a full disk pushed into memory. */
    keys: () => {
      const keys = new Set(memory.keys());
      if (disk) {
        try {
          for (let i = 0; i < disk.length; i++) {
            const key = disk.key(i);
            if (key) keys.add(key);
          }
        } catch {
          // Memory keys still count.
        }
      }
      return [...keys];
    },
  };
}

export function memoryStore(): TextStore {
  const box = new Map<string, string>();
  return {
    getItem: (key) => box.get(key) ?? null,
    setItem: (key, value) => {
      box.set(key, value);
    },
    removeItem: (key) => {
      box.delete(key);
    },
    keys: () => [...box.keys()],
  };
}

const BASELINE = "alkuin-share-baseline";
const HOST = "alkuin-share-host";
const SENT = "alkuin-share-sent";
const SETTLED = "alkuin-share-settled";
const HELD = "alkuin-share-held";
const SHARE_ACTOR = "alkuin-share-actor";
/** Refs whose margin note the user removed. Withdrawn on the next send. */
const RETIRED = "alkuin-share-retired";
/** Unsent passages. One JSON object per share and file. */
export const SHARE_OUTBOX = "alkuin-share-outbox";

export interface StoredOutbox {
  changes: { payloadRef: string; passage: string; original: string; body: string }[];
  withdraw: string[];
}

export function rememberOpenedText(path: string, text: string, box: TextStore = backing()): void {
  const key = `${OPENED}:${path}`;
  if (box.getItem(key) == null) box.setItem(key, text);
}

export function ensureBaseline(
  shareId: string,
  path: string,
  fallback: string,
  box: TextStore = backing(),
): string {
  const key = `${BASELINE}:${shareId}:${path}`;
  const existing = box.getItem(key);
  if (existing != null) return existing;
  const text = box.getItem(`${OPENED}:${path}`) ?? fallback;
  box.setItem(key, text);
  return text;
}

/** A new host stamp means the file was just rewritten from the hosted copy.
 *  That text becomes the baseline. The same stamp leaves an in-progress edit. */
export function applyHostStamp(
  shareId: string,
  path: string,
  text: string,
  stamp: string | null,
  box: TextStore = backing(),
): string {
  const hostKey = `${HOST}:${shareId}:${path}`;
  if (stamp != null && stamp !== box.getItem(hostKey)) {
    box.setItem(`${OPENED}:${path}`, text);
    box.setItem(`${BASELINE}:${shareId}:${path}`, text);
    box.setItem(hostKey, stamp);
    return text;
  }
  return ensureBaseline(shareId, path, text, box);
}

/** The owner's text replaces the baseline. The host stamp stays, so a later
 *  keystroke is still measured from this text. */
export function adoptHostedText(
  shareId: string,
  path: string,
  text: string,
  box: TextStore = backing(),
): void {
  box.setItem(`${OPENED}:${path}`, text);
  box.setItem(`${BASELINE}:${shareId}:${path}`, text);
}

export function advanceBaseline(
  shareId: string,
  path: string,
  text: string,
  box: TextStore = backing(),
): void {
  box.setItem(`${BASELINE}:${shareId}:${path}`, text);
}

export function loadSentRefs(shareId: string, path: string, box: TextStore = backing()): string[] {
  return readRefs(box.getItem(`${SENT}:${shareId}:${path}`));
}

export function saveSentRefs(
  shareId: string,
  path: string,
  refs: readonly string[],
  box: TextStore = backing(),
): void {
  box.setItem(`${SENT}:${shareId}:${path}`, JSON.stringify(refs));
}

export interface HeldProposal {
  payloadRef: string;
  passage: string;
  original: string;
  body: string;
  /** The wording is in the collaborator's text. Unset on a comment or a pending suggestion. */
  applied?: boolean;
}

/**
 * Sent comments and suggestions, with what the margin needs to show them
 * again. The margin note itself is not stored. A hold written before
 * comments were held has only suggestions, and no `applied` flag.
 */
export function loadHeldProposals(
  shareId: string,
  path: string,
  box: TextStore = backing(),
): HeldProposal[] {
  const raw = box.getItem(`${HELD}:${shareId}:${path}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (
        typeof row.payloadRef !== "string" ||
        typeof row.passage !== "string" ||
        typeof row.original !== "string" ||
        typeof row.body !== "string"
      ) {
        return [];
      }
      return [
        {
          payloadRef: row.payloadRef,
          passage: row.passage,
          original: row.original,
          body: row.body,
          ...(row.applied === true ? { applied: true } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function saveHeldProposals(
  shareId: string,
  path: string,
  holds: readonly HeldProposal[],
  box: TextStore = backing(),
): void {
  box.setItem(
    `${HELD}:${shareId}:${path}`,
    JSON.stringify(
      holds.map((hold) => ({
        payloadRef: hold.payloadRef,
        passage: hold.passage,
        original: hold.original,
        body: hold.body,
        ...(hold.applied ? { applied: true } : {}),
      })),
    ),
  );
}

function readRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Refs the owner already accepted or rejected. Sending them again is refused. */
export function loadSettledRefs(
  shareId: string,
  path: string,
  box: TextStore = backing(),
): string[] {
  return readRefs(box.getItem(`${SETTLED}:${shareId}:${path}`));
}

export function addSettledRefs(
  shareId: string,
  path: string,
  refs: readonly string[],
  box: TextStore = backing(),
): void {
  const have = new Set(loadSettledRefs(shareId, path, box));
  for (const ref of refs) have.add(ref);
  box.setItem(`${SETTLED}:${shareId}:${path}`, JSON.stringify([...have]));
}

export function loadRetiredRefs(
  shareId: string,
  path: string,
  box: TextStore = backing(),
): string[] {
  return readRefs(box.getItem(`${RETIRED}:${shareId}:${path}`));
}

/** The user removed the note that sent these refs. */
export function addRetiredRefs(
  shareId: string,
  path: string,
  refs: readonly string[],
  box: TextStore = backing(),
): void {
  if (refs.length === 0) return;
  const have = new Set(loadRetiredRefs(shareId, path, box));
  for (const ref of refs) have.add(ref);
  box.setItem(`${RETIRED}:${shareId}:${path}`, JSON.stringify([...have]));
}

/** A withdraw that landed, or a note the user wrote again. */
export function dropRetiredRefs(
  shareId: string,
  path: string,
  refs: readonly string[],
  box: TextStore = backing(),
): void {
  if (refs.length === 0) return;
  const drop = new Set(refs);
  const have = loadRetiredRefs(shareId, path, box);
  const kept = have.filter((ref) => !drop.has(ref));
  if (kept.length === have.length) return;
  box.setItem(`${RETIRED}:${shareId}:${path}`, JSON.stringify(kept));
}

export function rememberShare(
  shareId: string,
  path: string,
  role: string,
  box: TextStore = backing(),
): void {
  box.setItem(`${SHARE_ACTOR}:${path}`, JSON.stringify({ shareId, role }));
}

export function loadShare(
  path: string,
  box: TextStore = backing(),
): { shareId: string; role: string } | null {
  const raw = box.getItem(`${SHARE_ACTOR}:${path}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { shareId?: unknown; role?: unknown };
    if (typeof parsed.shareId !== "string" || typeof parsed.role !== "string") return null;
    return { shareId: parsed.shareId, role: parsed.role };
  } catch {
    return null;
  }
}

function outboxKey(shareId: string, path: string): string {
  return `${SHARE_OUTBOX}:${shareId}:${path}`;
}

export function loadOutbox(
  shareId: string,
  path: string,
  box: TextStore = backing(),
): StoredOutbox {
  const raw = box.getItem(outboxKey(shareId, path));
  if (!raw) return { changes: [], withdraw: [] };
  try {
    const parsed = JSON.parse(raw) as {
      changes?: unknown;
      withdraw?: unknown;
    };
    const changes = Array.isArray(parsed.changes)
      ? parsed.changes.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          if (
            typeof row.payloadRef !== "string" ||
            typeof row.passage !== "string" ||
            typeof row.original !== "string" ||
            typeof row.body !== "string"
          ) {
            return [];
          }
          return [
            {
              payloadRef: row.payloadRef,
              passage: row.passage,
              original: row.original,
              body: row.body,
            },
          ];
        })
      : [];
    const withdraw = Array.isArray(parsed.withdraw)
      ? parsed.withdraw.filter((item) => typeof item === "string")
      : [];
    return { changes, withdraw };
  } catch {
    return { changes: [], withdraw: [] };
  }
}

export function saveOutbox(
  shareId: string,
  path: string,
  plan: StoredOutbox,
  box: TextStore = backing(),
): void {
  box.setItem(outboxKey(shareId, path), JSON.stringify(plan));
}

export function clearOutbox(shareId: string, path: string, box: TextStore = backing()): void {
  box.setItem(outboxKey(shareId, path), JSON.stringify({ changes: [], withdraw: [] }));
}

export function outboxHasUnsent(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { changes?: unknown; withdraw?: unknown };
    const changes = Array.isArray(parsed.changes) ? parsed.changes.length : 0;
    const withdraw = Array.isArray(parsed.withdraw) ? parsed.withdraw.length : 0;
    return changes > 0 || withdraw > 0;
  } catch {
    return false;
  }
}

function storedKeys(box: TextStore): string[] {
  try {
    return box.keys?.() ?? [];
  } catch {
    return [];
  }
}

/** True when this share still has a plan that has not been sent. A plan kept
 * in memory because the store was full counts: reopening must not report
 * "nothing unsent" and let the owner's copy replace those edits. */
export function shareHasUnsent(shareId: string, box: TextStore = backing()): boolean {
  const prefix = `${SHARE_OUTBOX}:${shareId}:`;
  return storedKeys(box).some((key) => key.startsWith(prefix) && outboxHasUnsent(box.getItem(key)));
}

/**
 * Opening the share again must keep this Mac's copy. Something is unsent,
 * or a sent change is still waiting for the owner. Rewriting the file would
 * take those edits out of the text the next send is measured on.
 */
export function shareKeepsCopy(shareId: string, box: TextStore = backing()): boolean {
  if (shareHasUnsent(shareId, box)) return true;
  return storedKeys(box).some((key) => {
    if (key.startsWith(`${SENT}:${shareId}:`)) return readRefs(box.getItem(key)).length > 0;
    if (key.startsWith(`${HELD}:${shareId}:`)) {
      return loadHeldProposals(shareId, key.slice(`${HELD}:${shareId}:`.length), box).length > 0;
    }
    return false;
  });
}

const PER_SHARE = [BASELINE, HOST, SENT, SETTLED, HELD, RETIRED, SHARE_OUTBOX];

let closes = 0;

/**
 * Bumped by every `closeLedger`. Work that read the ledger before an await
 * compares it after: a changed value means a share was left or deleted
 * meanwhile, and writing now would bring its ledger back.
 * ponytail: one counter for every share, so a close of share A also makes
 * an in-flight send for share B skip its bookkeeping; that send's plan is
 * still in the outbox and goes again. Upgrade is a counter per share.
 */
export function ledgerCloses(): number {
  return closes;
}

/**
 * The share ended on this Mac: left, removed, or its file deleted. Forget
 * every ledger key for it, so a later invite with the same share id starts
 * clean. A path that pointed at this share also forgets its opened text and
 * its remembered role.
 */
export function closeLedger(shareId: string, box: TextStore = backing()): void {
  if (!shareId || !box.removeItem) return;
  closes += 1;
  const paths = new Set<string>();
  for (const key of storedKeys(box)) {
    for (const prefix of PER_SHARE) {
      const head = `${prefix}:${shareId}:`;
      if (!key.startsWith(head)) continue;
      paths.add(key.slice(head.length));
      box.removeItem(key);
      break;
    }
  }
  for (const key of storedKeys(box)) {
    if (!key.startsWith(`${SHARE_ACTOR}:`)) continue;
    const path = key.slice(SHARE_ACTOR.length + 1);
    if (loadShare(path, box)?.shareId !== shareId) continue;
    paths.add(path);
    box.removeItem(key);
  }
  for (const path of paths) box.removeItem(`${OPENED}:${path}`);
}

/** A deleted folder: the ledger of every share a file under `dir` was remembered with. */
export function closeLedgersUnder(dir: string, box: TextStore = backing()): void {
  const prefix = /[/\\]$/.test(dir) ? dir : `${dir}/`;
  const head = `${SHARE_ACTOR}:`;
  for (const key of storedKeys(box)) {
    if (!key.startsWith(head)) continue;
    const path = key.slice(head.length);
    if (path.startsWith(prefix) || path.startsWith(prefix.replace(/\/$/, "\\"))) {
      closeLedgerForPath(path, box);
    }
  }
}

/** The ledger for the share `path` is a copy of, or was remembered with. */
export function closeLedgerForPath(path: string, box: TextStore = backing()): void {
  const shareId = hostedCopy(path)?.shareId ?? loadShare(path, box)?.shareId;
  if (shareId) closeLedger(shareId, box);
}
