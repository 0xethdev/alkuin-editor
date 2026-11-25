import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  ask: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  DELETE_ACCOUNT_BILLING_FAILED,
  DELETE_ACCOUNT_FAILED,
  DELETE_ACCOUNT_CANCEL,
  DELETE_ACCOUNT_CONFIRM,
  DELETE_ACCOUNT_DONE,
  DELETE_ACCOUNT_HEADING,
  DELETE_ACCOUNT_NEED_SIGN_IN,
  CODE_ENTRY_UNREACHABLE,
  CODE_ENTRY_ERROR,
  deleteAccountConfirmText,
} from "../src/lib/account-copy";
import { runDeleteAccount } from "../src/lib/account-delete";
import { subscribeAccountSignIn } from "../src/lib/account-sign-in";

const mockedInvoke = vi.mocked(invoke);

function read(file: string) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("delete my account", () => {
  const events: string[] = [];
  let stop = () => {};

  beforeEach(() => {
    mockedInvoke.mockReset();
    events.length = 0;
    stop();
    stop = subscribeAccountSignIn((event) => {
      events.push(event);
    });
  });

  test("confirm deletes the account and signs out", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "account_status") return { signed_in: true, email: "ada@example.com" };
      if (cmd === "plugin:dialog|message") return DELETE_ACCOUNT_CONFIRM;
      if (cmd === "account_delete") return null;
      throw new Error(`unexpected ${cmd}`);
    });

    const result = await runDeleteAccount();

    expect(result).toEqual({ notice: DELETE_ACCOUNT_DONE, signedOut: true });
    expect(events).toEqual(["signed-out"]);
    expect(mockedInvoke).toHaveBeenCalledWith("plugin:dialog|message", {
      message: deleteAccountConfirmText(),
      title: DELETE_ACCOUNT_HEADING,
      kind: "warning",
      buttons: { OkCancelCustom: [DELETE_ACCOUNT_CONFIRM, DELETE_ACCOUNT_CANCEL] },
    });
    expect(mockedInvoke).toHaveBeenCalledWith("account_delete");
    expect(mockedInvoke).not.toHaveBeenCalledWith("plugin:dialog|ask", expect.anything());

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "account_status") return { signed_in: true };
      if (cmd === "plugin:dialog|message") return { Custom: DELETE_ACCOUNT_CONFIRM };
      if (cmd === "account_delete") return null;
      throw new Error(`unexpected ${cmd}`);
    });
    events.length = 0;
    await expect(runDeleteAccount()).resolves.toMatchObject({ signedOut: true });
  });

  test("cancel leaves the session", async () => {
    for (const dismissed of [
      DELETE_ACCOUNT_CANCEL,
      { Custom: DELETE_ACCOUNT_CANCEL },
      false,
      null,
    ]) {
      mockedInvoke.mockReset();
      events.length = 0;
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "account_status") return { signed_in: true, email: "ada@example.com" };
        if (cmd === "plugin:dialog|message") return dismissed;
        throw new Error(`unexpected ${cmd}`);
      });
      const result = await runDeleteAccount();
      expect(result).toEqual({ notice: null, signedOut: false });
      expect(events).toEqual([]);
      expect(mockedInvoke).not.toHaveBeenCalledWith("account_delete");
    }
  });

  test("a failure is a notice and does not sign out", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "account_status") return { signed_in: true };
      if (cmd === "plugin:dialog|message") return DELETE_ACCOUNT_CONFIRM;
      if (cmd === "account_delete") throw new Error("billing_unavailable");
      throw new Error(`unexpected ${cmd}`);
    });
    const billing = await runDeleteAccount();
    expect(billing).toEqual({ notice: DELETE_ACCOUNT_BILLING_FAILED, signedOut: false });
    expect(events).toEqual([]);

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "account_status") return { signed_in: true };
      if (cmd === "plugin:dialog|message") return DELETE_ACCOUNT_CONFIRM;
      if (cmd === "account_delete") throw new Error("unreachable");
      throw new Error(`unexpected ${cmd}`);
    });
    events.length = 0;
    const offline = await runDeleteAccount();
    expect(offline).toEqual({ notice: CODE_ENTRY_UNREACHABLE, signedOut: false });
    expect(events).toEqual([]);

    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "account_status") return { signed_in: true };
      if (cmd === "plugin:dialog|message") {
        throw new Error("command plugin:dialog|message not found");
      }
      throw new Error(`unexpected ${cmd}`);
    });
    events.length = 0;
    const dialog = await runDeleteAccount();
    expect(dialog.signedOut).toBe(false);
    expect(dialog.notice).toBe(DELETE_ACCOUNT_FAILED);
    expect(dialog.notice).not.toBe(CODE_ENTRY_ERROR);
    expect(events).toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalledWith("account_delete");
  });

  test("a signed-out click says to sign in and does not ask", async () => {
    mockedInvoke.mockResolvedValue({ signed_in: false });
    const result = await runDeleteAccount();
    expect(result).toEqual({ notice: DELETE_ACCOUNT_NEED_SIGN_IN, signedOut: false });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("account_status");
    expect(events).toEqual([]);
  });

  test("preferences and the palette use that flow, not plugin ask", () => {
    const preferences = read("src/components/preferences-panel/index.tsx");
    const palette = read("src/components/command-palette/index.tsx");
    const flow = read("src/lib/account-delete.ts");
    expect(preferences).toContain("runDeleteAccount(");
    expect(preferences).toContain("onDelete={() => void deleteAccount()}");
    expect(palette).toContain("runDeleteAccount(");
    expect(flow).toContain("deleteAccountConfirmText()");
    expect(flow).toContain("deleteAccountFailureMessage(");
    expect(flow).toContain("returnToWelcome()");
    expect(preferences).not.toContain("@tauri-apps/plugin-dialog");
    expect(palette).not.toContain("@tauri-apps/plugin-dialog");
    expect(flow).not.toContain("plugin:dialog|ask");
  });
});
