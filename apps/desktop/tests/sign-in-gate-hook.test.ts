import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react", async () => (await import("./helpers/hook-harness")).reactHooks);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { renderOnce, unmountAll } from "./helpers/hook-harness";
import { useSignInGate } from "../src/components/use-sign-in-gate";
import {
  CODE_ENTRY_EXPIRED,
  INVITE_NOT_ADMITTED_LINE,
  NOT_ADMITTED_LINE,
  signInRefusalMessage,
} from "../src/lib/account-copy";
import { AGE_BLOCKED, AGE_INVALID } from "../src/lib/age-gate";
import { returnToWelcome } from "../src/lib/account-sign-in";
import { editorUnlocked } from "../src/lib/account-gate";
import { writingOffline, writingSession, writingSignedIn } from "../src/lib/account-session";

const mockedInvoke = vi.mocked(invoke);
const wake = new EventTarget();
vi.stubGlobal("window", wake);

function render() {
  return renderOnce(useSignInGate);
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  unmountAll();
  mockedInvoke.mockReset();
});

describe("useSignInGate", () => {
  test("a sign-out while the code is checked keeps the desk locked", async () => {
    const finish = deferred<{ signed_in: boolean; email: string }>();
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") return Promise.resolve({ signed_in: false });
      if (command === "account_sign_in_finish") return finish.promise;
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    let gate = render();
    expect(gate.ready).toBe(true);
    expect(writingSession()).toEqual({ kind: "signedOut" });
    gate.setEmail("ada@example.com");
    gate = render();
    const submitted = gate.submitCode("12345678");
    returnToWelcome();
    finish.resolve({ signed_in: true, email: "ada@example.com" });
    await submitted;
    gate = render();
    expect(editorUnlocked(gate.hasSession, gate.step)).toBe(false);
    expect(gate.step).toBe("welcome");
    expect(gate.busy).toBe(false);
    expect(writingSignedIn()).toBe(false);
  });

  test("a second submit while one is checked sends nothing", async () => {
    const finish = deferred<{ signed_in: boolean }>();
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") return Promise.resolve({ signed_in: false });
      if (command === "account_sign_in_finish") return finish.promise;
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    const gate = render();
    const first = gate.submitCode("12345678");
    const second = gate.submitCode("12345678");
    finish.resolve({ signed_in: true });
    await Promise.all([first, second]);
    const finishes = mockedInvoke.mock.calls.filter(
      ([command]) => command === "account_sign_in_finish",
    );
    expect(finishes).toHaveLength(1);
    const after = render();
    expect(editorUnlocked(after.hasSession, after.step)).toBe(true);
    expect(writingSession()).toEqual({ kind: "signedIn", reach: "online", plan: "unknown" });
  });

  test("a cold start without network goes back online when the network returns", async () => {
    let reachable = false;
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") {
        return Promise.resolve({ signed_in: true, email: "ada@example.com" });
      }
      if (command === "account_status") {
        return reachable
          ? Promise.resolve({ signed_in: true, email: "ada@example.com" })
          : Promise.reject(new Error("unreachable"));
      }
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    let gate = render();
    expect(editorUnlocked(gate.hasSession, gate.step)).toBe(true);
    expect(writingOffline()).toBe(true);

    wake.dispatchEvent(new Event("focus"));
    await settle();
    expect(writingOffline()).toBe(true);

    reachable = true;
    wake.dispatchEvent(new Event("online"));
    await settle();
    gate = render();
    expect(writingOffline()).toBe(false);
    expect(editorUnlocked(gate.hasSession, gate.step)).toBe(true);
  });

  test("an online desk does not ask Auth on focus", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") return Promise.resolve({ signed_in: true });
      if (command === "account_status") return Promise.resolve({ signed_in: true });
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    const before = mockedInvoke.mock.calls.length;
    wake.dispatchEvent(new Event("focus"));
    wake.dispatchEvent(new Event("online"));
    await settle();
    expect(mockedInvoke.mock.calls.length).toBe(before);
  });

  test("a code for an address with no account holds the sign-in and asks the date", async () => {
    const answers: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error("age_required:held-ticket_1")),
      // A date the server cannot read keeps the sign-in held, with a fresh ticket.
      () => Promise.reject(new Error("age_required:held-ticket_2")),
      () => Promise.resolve({ signed_in: true, email: "new@example.com" }),
    ];
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") return Promise.resolve({ signed_in: false });
      if (command === "account_sign_in_start") return Promise.resolve(undefined);
      if (command === "account_sign_in_finish") return answers.shift()!();
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    let gate = render();
    gate.setEmail("new@example.com");
    gate = render();
    await gate.sendCode();
    gate = render();
    expect(gate.step).toBe("code");

    await expect(gate.submitCode("12345678")).resolves.toBe("age_required");
    gate = render();
    expect(gate.step).toBe("age");
    expect(gate.error).toBeNull();
    expect(gate.busy).toBe(false);
    // The code goes alone: no date with it.
    expect(mockedInvoke).toHaveBeenCalledWith("account_sign_in_finish", {
      email: "new@example.com",
      code: "12345678",
      birthDate: "",
      ageTicket: "",
    });

    await expect(gate.submitAge("1990-02-30")).resolves.toBe("age_required");
    gate = render();
    expect(gate.step).toBe("age");
    expect(gate.error).toBe(AGE_INVALID);
    expect(mockedInvoke).toHaveBeenLastCalledWith("account_sign_in_finish", {
      email: "new@example.com",
      code: "",
      birthDate: "1990-02-30",
      ageTicket: "held-ticket_1",
    });

    await gate.submitAge(" 1990-05-17 ");
    gate = render();
    expect(mockedInvoke).toHaveBeenLastCalledWith("account_sign_in_finish", {
      email: "new@example.com",
      code: "",
      birthDate: "1990-05-17",
      ageTicket: "held-ticket_2",
    });
    expect(editorUnlocked(gate.hasSession, gate.step)).toBe(true);
  });

  test("a held sign-in past its time starts again from the email step", async () => {
    const answers: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error("age_required:held-ticket")),
      () => Promise.reject(new Error("expired")),
    ];
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") return Promise.resolve({ signed_in: false });
      if (command === "account_sign_in_start") return Promise.resolve(undefined);
      if (command === "account_sign_in_finish") return answers.shift()!();
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    let gate = render();
    gate.setEmail("new@example.com");
    gate = render();
    await gate.sendCode();
    gate = render();
    await gate.submitCode("12345678");
    gate = render();
    await gate.submitAge("1990-05-17");
    gate = render();
    expect(gate.step).toBe("welcome");
    expect(gate.error).toBe(CODE_ENTRY_EXPIRED);
    // Nothing is held any more: the date step has no ticket to send.
    await gate.submitAge("1990-05-17");
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "account_sign_in_finish").length).toBe(2);
  });

  test("an under-age date is the server's to refuse, and an age answer with nothing held is a failure", async () => {
    let finish: () => Promise<unknown> = () => Promise.reject(new Error("age_required:held"));
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") return Promise.resolve({ signed_in: false });
      if (command === "account_sign_in_start") return Promise.resolve(undefined);
      if (command === "account_sign_in_finish") return finish();
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    let gate = render();
    gate.setEmail("kid@example.com");
    gate = render();
    await gate.sendCode();
    gate = render();
    await gate.submitCode("12345678");
    gate = render();
    finish = () => Promise.reject(new Error("age_blocked"));
    await expect(gate.submitAge("2015-05-17")).resolves.toBe("age_blocked");
    gate = render();
    expect(gate.error).toBe(AGE_BLOCKED);

    // age_required with no ticket: nothing can finish it here.
    gate.differentEmail();
    gate = render();
    await gate.sendCode();
    gate = render();
    finish = () => Promise.reject(new Error("age_required"));
    await gate.submitCode("12345678");
    gate = render();
    expect(gate.step).toBe("code");
    expect(gate.error).toBe(signInRefusalMessage("unreachable"));
  });

  test("an address not on the list is told so, and told about the invite when one is waiting", async () => {
    let refusal = "not_admitted";
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_stored_session") return Promise.resolve({ signed_in: false });
      if (command === "account_sign_in_start") return Promise.resolve(undefined);
      if (command === "account_sign_in_finish") return Promise.reject(new Error(refusal));
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    let gate = render();
    gate.setEmail("ada@example.com");
    gate = render();
    await gate.sendCode();
    gate = render();

    await gate.submitCode("12345678");
    gate = render();
    expect(gate.error).toBe(NOT_ADMITTED_LINE);
    expect(gate.hasSession).toBe(false);
    expect(gate.busy).toBe(false);

    // Rust adds the invite to the code when a link was opened with nobody signed in.
    refusal = "not_admitted:invite";
    await gate.submitCode("12345678");
    gate = render();
    expect(gate.error).toBe(INVITE_NOT_ADMITTED_LINE);
    expect(gate.hasSession).toBe(false);
  });
});
