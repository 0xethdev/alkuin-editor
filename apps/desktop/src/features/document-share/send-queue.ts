/**
 * One document's share send pipeline, as one explicit state per path.
 *
 * A send and an idle-copy refresh take the same per-path lock, so they never
 * overlap and two sends never run on the same outbox, even across a remount.
 * A send asked for while the lock is held is queued (`again`) and runs when
 * the lock frees. Only `run` and `exclusive` move the state.
 */

/**
 * How one send attempt ended. `stopped`: nothing to do, or the document
 * closed. `failed`: worth trying again after a wait. `blocked`: refused for a
 * reason waiting does not fix (the document stays on this Mac, the owner has
 * too many changes waiting); it goes again on the next edit or open.
 */
export type SendOutcome = "sent" | "empty" | "failed" | "stopped" | "blocked";

export interface SendAttempt {
  outcome: SendOutcome;
  /** For `blocked`: the line that says why, and what the person can do. */
  line?: string;
}

export interface ShareSendState {
  phase: "idle" | "sending" | "refreshing";
  /** A send was asked for while the lock was held. */
  again: boolean;
  /** Failed attempts in a row. Drives the retry delay. */
  failures: number;
  /** The line this document put in the banner, or null. */
  notice: string | null;
}

/** Retry delays. The last one repeats: the failure line says Alkuin will keep trying. */
export const SHARE_RETRY_MS = [2000, 8000, 30000] as const;

export interface SendDecision {
  failures: number;
  /** A line to show (it differs from the one up), null to clear this document's, or unset. */
  notice?: string | null;
  /** Try again after this many ms, while the document is open. */
  retryIn: number | null;
  /** Drop a retry already waiting: this outcome does not clear by waiting. */
  cancelRetry: boolean;
}

export function afterSendOutcome(
  state: Pick<ShareSendState, "failures" | "notice">,
  attempt: SendAttempt,
  failedLine: string,
): SendDecision {
  switch (attempt.outcome) {
    case "sent":
    case "empty":
      return {
        failures: 0,
        ...(state.notice ? { notice: null } : {}),
        retryIn: null,
        cancelRetry: true,
      };
    case "failed": {
      const at = Math.min(state.failures, SHARE_RETRY_MS.length - 1);
      return {
        failures: state.failures + 1,
        ...(state.notice === failedLine ? {} : { notice: failedLine }),
        retryIn: SHARE_RETRY_MS[at] ?? null,
        cancelRetry: false,
      };
    }
    case "blocked": {
      const line = attempt.line ?? failedLine;
      return {
        failures: 0,
        ...(state.notice === line ? {} : { notice: line }),
        retryIn: null,
        cancelRetry: true,
      };
    }
    case "stopped":
      return { failures: state.failures, retryIn: null, cancelRetry: false };
  }
}

export interface SendQueueDeps<S> {
  /** The open session for `path`, or null. */
  session(path: string): S | null;
  send(session: S): Promise<SendOutcome | SendAttempt>;
  /** The line a `failed` attempt shows. */
  failedLine: string;
  /**
   * Apply a decision. `session` is null when the document closed or reopened
   * while the attempt ran: only the counters move then, no notice or retry.
   */
  settle(path: string, session: S | null, state: ShareSendState, decision: SendDecision): void;
  /** A send threw instead of returning an outcome. */
  error?(path: string, error: unknown): void;
}

export function createSendQueue<S>(deps: SendQueueDeps<S>) {
  const states = new Map<string, ShareSendState>();

  const stateFor = (path: string): ShareSendState => {
    let state = states.get(path);
    if (!state) {
      state = { phase: "idle", again: false, failures: 0, notice: null };
      states.set(path, state);
    }
    return state;
  };

  /** Send now, or queue one send behind whatever holds the lock. */
  async function run(path: string): Promise<void> {
    const state = stateFor(path);
    if (state.phase !== "idle") {
      state.again = true;
      return;
    }
    state.phase = "sending";
    try {
      do {
        state.again = false;
        const session = deps.session(path);
        if (!session) break;
        let attempt: SendAttempt;
        try {
          const result = await deps.send(session);
          attempt = typeof result === "string" ? { outcome: result } : result;
        } catch (error) {
          deps.error?.(path, error);
          attempt = { outcome: "failed" };
        }
        const decision = afterSendOutcome(state, attempt, deps.failedLine);
        state.failures = decision.failures;
        deps.settle(path, deps.session(path) === session ? session : null, state, decision);
      } while (state.again);
    } finally {
      state.phase = "idle";
    }
  }

  /**
   * Run `work` only while no send holds the lock. A send asked for meanwhile
   * runs right after. Returns `busy` without running when the lock is held.
   */
  async function exclusive<T, B>(path: string, work: () => Promise<T>, busy: B): Promise<T | B> {
    const state = stateFor(path);
    if (state.phase !== "idle") return busy;
    state.phase = "refreshing";
    try {
      return await work();
    } finally {
      state.phase = "idle";
      if (state.again) void run(path);
    }
  }

  return { run, exclusive, stateFor };
}
