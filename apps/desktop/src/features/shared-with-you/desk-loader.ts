import type { AccountStatus, ShareDesk } from "@/lib/tauri";

/**
 * The Shared with you list. `loading` and `signedOut` both show no section,
 * but they are different states: a signed-out read never lands as a list.
 */
export type DeskState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | {
      kind: "ready";
      desk: ShareDesk;
      /** Whose list this is: the signed-in email, lowercased. */
      account: string;
      /** The last refresh failed. The list is the one before it. */
      stale: boolean;
    };

export interface DeskLoaderDeps {
  status(): Promise<AccountStatus>;
  desk(paths: string[]): Promise<ShareDesk>;
  set(state: DeskState): void;
}

/**
 * Loads are numbered. Only the newest one may write the state, so an
 * answer's refresh beats a poll that started before it, and a load still
 * running at sign-out or an account switch never shows the old list.
 */
export function createDeskLoader(deps: DeskLoaderDeps) {
  let seq = 0;
  let state: DeskState = { kind: "loading" };
  const put = (next: DeskState) => {
    state = next;
    deps.set(next);
  };

  async function load(paths: string[]): Promise<void> {
    seq += 1;
    const mine = seq;
    try {
      const status = await deps.status();
      if (mine !== seq) return;
      if (!status.signed_in) {
        put({ kind: "signedOut" });
        return;
      }
      const account = (status.email ?? "").trim().toLowerCase();
      // Another account: the previous person's list goes now, not after the read.
      if (state.kind === "ready" && state.account !== account) put({ kind: "loading" });
      const desk = await deps.desk(paths);
      if (mine !== seq) return;
      put({ kind: "ready", desk, account, stale: false });
    } catch {
      // A failed read keeps the last list. The empty line is only a real empty list.
      if (mine !== seq) return;
      if (state.kind === "ready" && !state.stale) put({ ...state, stale: true });
    }
  }

  /** Sign-out: drop any load in flight and show no list. */
  function signedOut(): void {
    seq += 1;
    put({ kind: "signedOut" });
  }

  /** The hook went away. A load still in flight writes nothing. */
  function stop(): void {
    seq += 1;
  }

  return { load, signedOut, stop, current: () => state };
}

/** One action per row at a time. Returns false when that row is already busy. */
export function createRowGuard() {
  const busy = new Set<string>();
  return {
    async run(key: string, work: () => Promise<void>): Promise<boolean> {
      if (busy.has(key)) return false;
      busy.add(key);
      try {
        await work();
      } finally {
        busy.delete(key);
      }
      return true;
    },
    has: (key: string) => busy.has(key),
  };
}
