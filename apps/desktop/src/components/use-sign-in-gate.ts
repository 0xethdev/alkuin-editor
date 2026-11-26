import { useEffect, useRef, useState } from "react";
import { codeRequestNotice, EMAIL_INVALID, signInRefusalMessage } from "@/lib/account-copy";
import {
  enterFromStoredSession,
  offlineRecheck,
  reduceSignIn,
  RESEND_WAIT_SECONDS,
  type DeskArrival,
  type SignInStep,
} from "@/lib/account-gate";
import { noteAccountSignedIn, subscribeAccountSignIn } from "@/lib/account-sign-in";
import { applyWritingSession, writingOffline } from "@/lib/account-session";
import {
  accountRegisterStart,
  accountSignInFinish,
  accountSignInStart,
  accountStatus,
  accountStoredSession,
} from "@/lib/tauri";

type AgeRefusal = "age_required" | "age_blocked";

function codeName(raw: string): string {
  return raw.trim().split(":")[0] ?? "";
}

/** The server's age answer, from the error's `code:` prefix. */
function ageRefusal(raw: string): AgeRefusal | undefined {
  const name = codeName(raw);
  return name === "age_required" || name === "age_blocked" ? name : undefined;
}

/** The held sign-in in `age_required:<ticket>`: the code matched an address with no account. */
function heldTicket(raw: string): string | null {
  const trimmed = raw.trim();
  if (codeName(trimmed) !== "age_required") return null;
  const ticket = trimmed.slice("age_required:".length);
  return ticket || null;
}

export function useSignInGate() {
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [step, setStep] = useState<SignInStep>("welcome");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  /** Sign-out and unmount bump this. An answer started before either is dropped. */
  const flight = useRef(0);
  /** One code request or code submit at a time. */
  const sending = useRef(false);
  /** A new account's sign-in, held by the server after its code until the date of birth passes. */
  const held = useRef<string | null>(null);
  /** Create account's date of birth: it goes back with the code, and with a resend. Null for Sign in. */
  const registration = useRef<string | null>(null);

  /** The one place a session answer moves the gate. Steps go through `reduceSignIn`. */
  function arrive(entry: DeskArrival) {
    applyWritingSession(
      entry.signedIn
        ? { type: "signed-in", reach: entry.offline ? "offline" : "online" }
        : { type: "signed-out" },
    );
    setHasSession(entry.signedIn);
    if (entry.email) setEmail(entry.email);
    setStep((current) =>
      reduceSignIn(current, { type: entry.signedIn ? "signed-in" : "signed-out" }),
    );
    setReady(true);
  }

  useEffect(() => {
    const mine = ++flight.current;
    applyWritingSession({ type: "reset" });
    void enterFromStoredSession(accountStoredSession, accountStatus, (entry) => {
      if (flight.current !== mine) return;
      arrive(entry);
    });
    return () => {
      flight.current += 1;
    };
  }, []);

  // An offline desk asks Auth again when the network comes back or the window is
  // used again. An answer moves it back online, or to welcome if the session is gone.
  useEffect(() => {
    const check = offlineRecheck(accountStatus, writingOffline);
    function recheck() {
      const mine = flight.current;
      void check((entry) => {
        if (flight.current !== mine) return;
        arrive(entry);
      });
    }
    window.addEventListener("online", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      window.removeEventListener("online", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, []);

  useEffect(() => {
    return subscribeAccountSignIn((event) => {
      if (event === "signed-in") return;
      setError(null);
      setReady(true);
      if (event === "signed-out") {
        flight.current += 1;
        sending.current = false;
        held.current = null;
        registration.current = null;
        applyWritingSession({ type: "signed-out" });
        setHasSession(false);
        setBusy(false);
        setResendIn(0);
        setStep((current) => reduceSignIn(current, { type: "signed-out" }));
        return;
      }
      setStep((current) => reduceSignIn(current, { type: "open" }));
    });
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setInterval(() => {
      setResendIn((left) => (left <= 1 ? 0 : left - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendIn > 0]);

  /**
   * Ask for a code through a door: Sign in (`birthDate` null) or Create account.
   * Resolves to `age_blocked` when Create account's date is refused: nothing
   * was sent, and the caller keeps the device's under-age answer.
   */
  async function requestCode(birthDate: string | null): Promise<"age_blocked" | undefined> {
    if (sending.current) return;
    if (!email.trim() || !email.includes("@")) {
      setError(EMAIL_INVALID);
      return;
    }
    const mine = flight.current;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (birthDate === null) await accountSignInStart(email.trim());
      else await accountRegisterStart(email.trim(), birthDate);
      if (flight.current !== mine) return;
      registration.current = birthDate;
      setResendIn(RESEND_WAIT_SECONDS);
      setStep((current) => reduceSignIn(current, { type: "code-sent" }));
    } catch (caught) {
      if (flight.current !== mine) return;
      const raw = caught instanceof Error ? caught.message : String(caught);
      setError(codeRequestNotice(raw));
      return codeName(raw) === "age_blocked" ? "age_blocked" : undefined;
    } finally {
      if (flight.current === mine) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  /** Sign in: a code to the address's account. */
  function sendCode() {
    return requestCode(null);
  }

  /** Create account: the date of birth goes first, then a registration code. */
  function register(birthDate: string) {
    return requestCode(birthDate.trim());
  }

  /** Another code through the same door as the last. */
  function resend() {
    return requestCode(registration.current);
  }

  /**
   * Check the code. A sign-in code signs in. A registration code goes with its
   * date of birth and opens the account. A code that comes back
   * `age_required` with a held sign-in moves to the date step.
   */
  async function submitCode(code: string): Promise<AgeRefusal | undefined> {
    if (sending.current) return;
    const mine = flight.current;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const status = await accountSignInFinish(email.trim(), code, registration.current ?? "");
      // A sign-out while the code was checked wins. The desk stays locked.
      if (flight.current !== mine) return;
      opened(status);
    } catch (caught) {
      if (flight.current !== mine) return;
      const raw = caught instanceof Error ? caught.message : String(caught);
      const ticket = heldTicket(raw);
      if (ticket) {
        held.current = ticket;
        setStep((current) => reduceSignIn(current, { type: "age-check" }));
        return "age_required";
      }
      // An age answer with nothing held cannot be finished here: say sign-in failed.
      setError(signInRefusalMessage(ageRefusal(raw) ? "unreachable" : raw));
      return ageRefusal(raw);
    } finally {
      if (flight.current === mine) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  /**
   * The date step: the held sign-in and the date of birth. Resolves to
   * `age_blocked` when the date is refused (the held sign-in is erased), and to
   * `age_required` when the date is not one that can be read (the sign-in stays
   * held). A ticket past its time goes back to the email step.
   */
  async function submitAge(birthDate: string): Promise<AgeRefusal | undefined> {
    if (sending.current) return;
    const ticket = held.current;
    if (!ticket) {
      setError(signInRefusalMessage("unreachable"));
      return;
    }
    const mine = flight.current;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const status = await accountSignInFinish(email.trim(), "", birthDate, ticket);
      if (flight.current !== mine) return;
      opened(status);
    } catch (caught) {
      if (flight.current !== mine) return;
      const raw = caught instanceof Error ? caught.message : String(caught);
      const kept = heldTicket(raw);
      if (kept) held.current = kept;
      if (codeName(raw) === "expired") {
        held.current = null;
        setResendIn(0);
        setStep((current) => reduceSignIn(current, { type: "different-email" }));
      }
      if (codeName(raw) === "age_blocked") held.current = null;
      setError(signInRefusalMessage(kept ? "age_required" : raw));
      return ageRefusal(raw);
    } finally {
      if (flight.current === mine) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  /** A session answered: the desk opens. Shared by the code and the date step. */
  function opened(status: { signed_in: boolean; email?: string | null }) {
    setHasSession(status.signed_in);
    if (status.email) setEmail(status.email);
    if (!status.signed_in) return;
    held.current = null;
    registration.current = null;
    applyWritingSession({ type: "signed-in", reach: "online" });
    noteAccountSignedIn();
    setResendIn(0);
    setStep((current) => reduceSignIn(current, { type: "signed-in" }));
  }

  function differentEmail() {
    held.current = null;
    registration.current = null;
    setError(null);
    setResendIn(0);
    setStep((current) => reduceSignIn(current, { type: "different-email" }));
  }

  return {
    ready,
    hasSession,
    step,
    email,
    setEmail,
    error,
    busy,
    resendIn,
    sendCode,
    register,
    resend,
    submitCode,
    submitAge,
    differentEmail,
  };
}
