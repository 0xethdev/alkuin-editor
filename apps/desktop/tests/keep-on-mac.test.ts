import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { confirmCopy } from "../src/features/document-removal/copy";
import {
  DELETE_ONLINE_DONE,
  KEEP_ON_MAC_OFF,
  MAC_ONLY_LINES,
  copyIsPlain,
  inviteHiddenWhileKept,
  setKeepOnThisMac,
  shareFailureLine,
} from "../src/lib/keep-on-mac";
import { SHARE_FAILED_LINE } from "../src/features/redline-spike/margin-copy";

describe("Keep on this Mac only", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(ask).mockReset();
  });

  test("every sentence is plain English", () => {
    for (const line of MAC_ONLY_LINES) {
      expect(copyIsPlain(line), line).toBe(true);
    }
  });

  test("the footer switch hides invite while the document stays on this Mac", () => {
    const footer = readFileSync(
      new URL("../src/components/editor-area/document-footer.tsx", import.meta.url),
      "utf8",
    );
    expect(inviteHiddenWhileKept(true)).toBe(true);
    expect(inviteHiddenWhileKept(false)).toBe(false);
    expect(footer).toContain('role="switch"');
    expect(footer).toContain("aria-checked={kept}");
    expect(footer).not.toContain("aria-pressed");
    expect(footer).toContain("inviteHiddenWhileKept(keep.kept)");
    expect(footer).not.toContain("data-keep-helper");
    expect(footer).not.toContain("KEEP_ON_MAC_HELPER");
    expect(footer).not.toContain("On blocks sharing");
    expect(footer).toMatch(/share\.role === "invitee" \? null : \(/);
    expect(confirmCopy("mac-only").body).toBe(
      "Turning it on removes existing sharing and deletes the online copy.",
    );
  });

  test("the owner is asked before sharing is removed or the online copy is deleted", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "share_role")
        return { role: "owner", share_id: "share-1", document_id: "doc", status: "accepted" };
      if (cmd === "mac_only_set") return { kept: true, online: true };
      if (cmd === "plugin:dialog|message") return "Keep on this Mac only";
      if (cmd === "share_erase_document") return undefined;
      if (cmd === "mac_only_delete_online") {
        return { deleted: true, missing: false, message: DELETE_ONLINE_DONE };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const result = await setKeepOnThisMac("/notes/Tutorial.md", true);

    expect(result).toEqual({ kept: true, line: DELETE_ONLINE_DONE });
    const asked = calls.indexOf("plugin:dialog|message");
    const erased = calls.indexOf("share_erase_document");
    const deleted = calls.indexOf("mac_only_delete_online");
    // Nothing is turned on before the answer. After it, the switch goes on
    // first, so nothing new is sent while sharing and the online copy go.
    const turnedOn = calls.indexOf("mac_only_set");
    expect(turnedOn).toBeGreaterThan(asked);
    expect(erased).toBeGreaterThan(turnedOn);
    expect(deleted).toBeGreaterThan(turnedOn);
    expect(invoke).toHaveBeenCalledWith(
      "plugin:dialog|message",
      expect.objectContaining({
        title: "Keep on this Mac only?",
        message: "Turning it on removes existing sharing and deletes the online copy.",
        kind: "warning",
        buttons: { OkCancelCustom: ["Keep on this Mac only", "Cancel"] },
      }),
    );
    expect(ask).not.toHaveBeenCalled();
  });

  test("declining the owner confirm changes nothing: the switch stays off and sharing stays", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "share_role")
        return { role: "owner", share_id: "share-1", document_id: "doc", status: "accepted" };
      if (cmd === "mac_only_set") return { kept: true, online: true };
      if (cmd === "plugin:dialog|message") return "Cancel";
      throw new Error(`unexpected ${cmd}`);
    });

    const result = await setKeepOnThisMac("/notes/Tutorial.md", true);

    // Cancel is a cancel. Nothing was turned on, so there is no line to show.
    expect(result).toEqual({ kept: false, line: null });
    expect(calls).toEqual(["share_role", "plugin:dialog|message"]);
  });

  test("an owner confirm that can't be shown changes nothing and says so", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "share_role")
        return { role: "owner", share_id: "share-1", document_id: "doc", status: "accepted" };
      if (cmd === "mac_only_set") return { kept: true, online: true };
      if (cmd === "plugin:dialog|message") throw new Error("plugin:dialog|message not found");
      throw new Error(`unexpected ${cmd}`);
    });

    // The caller shows "Alkuin couldn't change this setting." and reads the switch back.
    await expect(setKeepOnThisMac("/notes/Tutorial.md", true)).rejects.toThrow();

    expect(calls).not.toContain("mac_only_set");
    expect(calls).not.toContain("share_erase_document");
    expect(calls).not.toContain("mac_only_delete_online");
  });

  test("turning the switch off does not ask or delete", async () => {
    vi.mocked(invoke).mockResolvedValue({ kept: false, online: false });
    const result = await setKeepOnThisMac("/notes/Tutorial.md", false);
    expect(result).toEqual({ kept: false, line: KEEP_ON_MAC_OFF });
    expect(invoke).toHaveBeenCalledWith("mac_only_set", {
      path: "/notes/Tutorial.md",
      kept: false,
    });
    expect(invoke).not.toHaveBeenCalledWith("share_erase_document", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("mac_only_delete_online", expect.anything());
  });

  test("a stay-on-this-Mac share failure is shown as written", () => {
    const share = "This document stays on this Mac, so Alkuin didn't share it.";
    expect(shareFailureLine(share)).toBe(share);
    expect(shareFailureLine("git push failed")).toBe(SHARE_FAILED_LINE);
  });
});
