/** Whether this window is writing as a signed-in account, and whether that account's
 *  server answers. `reduceWritingSession` is the only transition. The sign-in gate
 *  owns sign-in and sign-out; account answers move reach and plan.
 *
 *  The window starts `unknown`: nothing acts as signed in until the gate has read the
 *  keychain. A unit test that needs a signed-in Ask calls `rememberWritingSession(true)`. */
export type WritingPlan = "unknown" | "free" | "paid" | "founding";

export type WritingReach = "online" | "offline";

export type WritingSession =
  | { kind: "unknown" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; reach: WritingReach; plan: WritingPlan };

export type WritingSessionEvent =
  /** The gate is about to read the keychain again. */
  | { type: "reset" }
  /** No `reach` keeps the reach a signed-in session already has. */
  | { type: "signed-in"; reach?: WritingReach }
  | { type: "signed-out" }
  /** The status check could not reach Auth. The keychain session stays. */
  | { type: "unreachable" }
  /** An account check answered. */
  | { type: "reachable" }
  | { type: "plan"; plan: string | null };

const UNKNOWN: WritingSession = { kind: "unknown" };
const SIGNED_OUT: WritingSession = { kind: "signedOut" };

function asWritingPlan(value: string | null): WritingPlan {
  if (value === "free" || value === "paid" || value === "founding") return value;
  return "unknown";
}

export function reduceWritingSession(
  session: WritingSession,
  event: WritingSessionEvent,
): WritingSession {
  switch (event.type) {
    case "reset":
      return session.kind === "unknown" ? session : UNKNOWN;
    case "signed-out":
      return session.kind === "signedOut" ? session : SIGNED_OUT;
    case "signed-in": {
      if (session.kind !== "signedIn") {
        return { kind: "signedIn", reach: event.reach ?? "online", plan: "unknown" };
      }
      const reach = event.reach ?? session.reach;
      return reach === session.reach ? session : { ...session, reach };
    }
    case "unreachable":
    case "reachable": {
      if (session.kind !== "signedIn") return session;
      const reach = event.type === "reachable" ? "online" : "offline";
      return reach === session.reach ? session : { ...session, reach };
    }
    case "plan": {
      if (session.kind !== "signedIn") return session;
      const plan = asWritingPlan(event.plan);
      return plan === session.plan ? session : { ...session, plan };
    }
    default:
      return session;
  }
}

let session: WritingSession = UNKNOWN;

export function applyWritingSession(event: WritingSessionEvent): WritingSession {
  session = reduceWritingSession(session, event);
  return session;
}

export function writingSession(): WritingSession {
  return session;
}

/** An account answer from the server. One that never reached it changes nothing:
 *  a failed fetch is not news about the plan. */
export function rememberAccountAnswer(answer: {
  signed_in: boolean;
  offline: boolean;
  effective?: string | null;
}) {
  if (answer.offline) return;
  if (!answer.signed_in) {
    applyWritingSession({ type: "plan", plan: null });
    return;
  }
  applyWritingSession({ type: "reachable" });
  applyWritingSession({ type: "plan", plan: answer.effective ?? null });
}

export function rememberWritingSession(value: boolean) {
  applyWritingSession(value ? { type: "signed-in" } : { type: "signed-out" });
}

/** Ignored unless signed in. `null` means the plan is not known. */
export function rememberWritingPlan(value: string | null) {
  applyWritingSession({ type: "plan", plan: value });
}

/** The signed-in plan, or `null` while signed out or not yet known. */
export function writingPlan(): string | null {
  if (session.kind !== "signedIn" || session.plan === "unknown") return null;
  return session.plan;
}

export function writingSignedIn(): boolean {
  return session.kind === "signedIn";
}

/** The status check could not reach Auth. The keychain session stays. */
export function rememberWritingOffline(value: boolean) {
  applyWritingSession(value ? { type: "unreachable" } : { type: "reachable" });
}

export function writingOffline(): boolean {
  return session.kind === "signedIn" && session.reach === "offline";
}
