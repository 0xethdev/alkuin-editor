import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  SYNC_CONFLICT_LINE,
  SYNC_EMPTY_COPY_LINE,
  SYNC_REMOVED_LINE,
} from "../src/features/redline-spike/margin-copy";
import { deskHistory } from "../src/lib/history/desk";
import {
  ACCEPT_LABEL,
  REJECT_LABEL,
  deliverDocument,
  sendWhenOnline,
  showOverlap,
  type SendOutcome,
} from "../src/lib/history/steps";

const mockedInvoke = vi.mocked(invoke);
const PATH = "/notes/draft.md";
const GIT_WORDS = /\bgit\b|commit|push|branch|repository|merge|fetch|pull|remote/i;
const ASSISTANT = /_KEY\b|_MODEL\b|suggestedText|system prompt/i;

const saved: SendOutcome = { sent: true, waiting: false, refused: false, unconfigured: false };

describe("five history steps", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("save, remember, and send run in that order", async () => {
    const order: string[] = [];
    const outcome = await deliverDocument(PATH, true, {
      async saveFile() {
        order.push("save");
      },
      async rememberVersion() {
        order.push("remember");
        return { id: "v1" };
      },
      async sendWhenOnline() {
        order.push("send");
        return saved;
      },
    });
    expect(order).toEqual(["save", "remember", "send"]);
    expect(outcome.sent).toBe(true);
  });

  test("a document that stays on this Mac is never queued or transmitted", async () => {
    let queued = false;
    let transmitted = false;
    const outcome = await sendWhenOnline(PATH, true, true, {
      async queue() {
        queued = true;
      },
      async transmit() {
        transmitted = true;
        return saved;
      },
    });
    expect(outcome.refused).toBe(true);
    expect(queued).toBe(false);
    expect(transmitted).toBe(false);
  });

  test("offline writing remembers the step and waits to send", async () => {
    let queued = false;
    const outcome = await sendWhenOnline(PATH, false, false, {
      async queue() {
        queued = true;
      },
      async transmit() {
        throw new Error("offline must not transmit");
      },
    });
    expect(queued).toBe(true);
    expect(outcome.waiting).toBe(true);
    expect(outcome.sent).toBe(false);
  });

  test("the desk asks the central guard before it sends", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "history_stays_on_this_mac") return true;
      if (command === "history_send") throw new Error("sent");
      return undefined;
    });
    const outcome = await deskHistory.sendWhenOnline(PATH, true);
    expect(outcome.refused).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_send", expect.anything());
  });

  test("an overlap is an Accept or Reject suggestion, with no git words", () => {
    const suggestion = showOverlap("ours\n", "theirs\n");
    expect(suggestion).not.toBeNull();
    expect(suggestion?.accept()).toBe("theirs\n");
    expect(suggestion?.reject()).toBe("ours\n");
    expect(suggestion?.acceptLabel).toBe(ACCEPT_LABEL);
    expect(suggestion?.rejectLabel).toBe(REJECT_LABEL);
    expect(suggestion?.line).toBe(SYNC_CONFLICT_LINE);
    for (const line of [ACCEPT_LABEL, REJECT_LABEL, suggestion?.line ?? ""]) {
      expect(line).not.toMatch(GIT_WORDS);
    }
    expect(showOverlap("same\n", "same\n")).toBeNull();
    const removed = showOverlap("ours\n", "", true);
    expect(removed?.line).toBe(SYNC_REMOVED_LINE);
    expect(removed?.acceptLabel).toBe(ACCEPT_LABEL);
    expect(removed?.rejectLabel).toBe(REJECT_LABEL);
    expect(removed?.line).not.toMatch(GIT_WORDS);
  });

  test("the client history files do not carry assistant internals", () => {
    const files = [
      "../src/lib/history/steps.ts",
      "../src/lib/history/desk.ts",
      "../src/lib/history/settle.ts",
      "../src/components/editor-area/editor-notice-banner.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(ASSISTANT);
    }
  });

  test("accepting an empty conflict with no version does not replace the document", async () => {
    const { settleOverlap } = await import("../src/lib/history/settle");
    const { useEditorNoticeStore } =
      await import("../src/components/editor-area/editor-notice-store");
    const overlap = {
      path: PATH,
      localText: "ours\n",
      otherText: "",
      deleted: false,
      versionId: "",
    };
    useEditorNoticeStore.getState().showOverlap(overlap);
    await settleOverlap(overlap, "accept");
    expect(mockedInvoke).not.toHaveBeenCalled();
    // The choice is not dropped: the user is told why, and Reject is still there.
    expect(useEditorNoticeStore.getState().message).toBe(SYNC_EMPTY_COPY_LINE);
    expect(useEditorNoticeStore.getState().overlaps).toEqual([overlap]);
    useEditorNoticeStore.getState().dismissNotice();
    useEditorNoticeStore.getState().dismissOverlap(PATH);
  });

  test("reject settles in this document and does not write a compare", async () => {
    mockedInvoke.mockResolvedValue({ sent: true, conflict: false });
    const { settleOverlap } = await import("../src/lib/history/settle");
    await settleOverlap(
      {
        path: PATH,
        localText: "ours\n",
        otherText: "theirs\n",
        deleted: false,
        versionId: "v-remote",
      },
      "reject",
    );
    expect(mockedInvoke).toHaveBeenCalledWith("history_settle", {
      path: PATH,
      choice: "reject",
      versionId: "v-remote",
      otherText: "theirs\n",
      deleted: false,
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("write_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_send", expect.anything());
  });

  test("a settle that fails puts the same suggestion back", async () => {
    mockedInvoke.mockRejectedValue(new Error("offline"));
    const { settleOverlap } = await import("../src/lib/history/settle");
    const { useEditorNoticeStore } =
      await import("../src/components/editor-area/editor-notice-store");
    const overlap = {
      path: PATH,
      localText: "ours\n",
      otherText: "theirs\n",
      deleted: false,
      versionId: "v-remote",
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    await settleOverlap(overlap, "accept");

    expect(useEditorNoticeStore.getState().overlap).toEqual(overlap);
  });

  test("deleting a project copy calls the history command", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const { historyDeleteProject } = await import("../src/lib/tauri");
    await historyDeleteProject("project-a");
    expect(mockedInvoke).toHaveBeenCalledWith("history_delete_project", { projectId: "project-a" });
  });
});
