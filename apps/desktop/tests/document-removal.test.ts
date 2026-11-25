import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  SHARED_REMOVE,
  TOMBSTONE_REMOVED_BY_OWNER,
  confirmCopy,
  deleteKind,
} from "../src/features/document-removal/copy";
import {
  cloudRemovalFailure,
  confirmPlaceholder,
  deleteDocument,
  dialogAccepted,
  leaveAcceptedShare,
  trashEntry,
} from "../src/features/document-removal/delete";
import {
  loadSentRefs,
  loadShare,
  rememberShare,
  saveSentRefs,
} from "../src/features/document-share/baseline";
import { sameDocumentPath } from "../src/lib/paths";
import { isSaveActive, scheduleSave } from "../src/lib/save";
import { useEditorStore } from "../src/stores/editor-store";

describe("document removal copy", () => {
  test("confirm, tombstone, and restore lines are Copy's locked sentences", () => {
    const source = readFileSync(
      new URL("../src/features/document-removal/copy.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\{\{copy\./);
    expect(confirmCopy("owner")).toEqual({
      title: "Delete this document?",
      body: "This removes it from your Mac and from Alkuin. Everyone you invited loses access. Their unsent words stay on their Mac only.",
      confirm: "Delete",
      cancel: "Cancel",
    });
    expect(confirmCopy("invitee")).toEqual({
      title: "Remove this document?",
      body: "This only removes it from your list. The owner and anyone else invited keep their copy.",
      confirm: "Remove",
      cancel: "Cancel",
    });
    expect(confirmCopy("mac-only")).toEqual({
      title: "Keep on this Mac only?",
      body: "Turning it on removes existing sharing and deletes the online copy.",
      confirm: "Keep on this Mac only",
      cancel: "Cancel",
    });
    expect(confirmCopy("restore")).toEqual({
      title: "Restore this document?",
      body: "Sharing comes back as it was. You have 30 days after it left your Mac.",
      confirm: "Restore",
      cancel: "Cancel",
    });
    expect(TOMBSTONE_REMOVED_BY_OWNER).toBe("Removed by the owner.");
    expect(SHARED_REMOVE).toBe("Remove");
    expect(deleteKind("invitee", "/notes/essay.md")).toBe("invitee");
    expect(deleteKind("owner", "/notes/essay.md")).toBe("owner");
    expect(deleteKind("none", "/notes/essay.md")).toBe("owner");
    expect(
      deleteKind(
        "none",
        "/Users/me/Library/Application Support/app/shares/11111111-1111-4111-8111-111111111111.md",
      ),
    ).toBe("invitee");
  });

  test("delete, restore, and the tombstone use those sentences", () => {
    const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const desk = read("src/features/shared-with-you/desk.tsx");
    const hook = read("src/features/shared-with-you/use-desk.ts");
    const keep = read("src/lib/keep-on-mac.ts");
    const menus = read("src/components/sidebar/use-file-tree-context-menus.ts");
    const sidebar = read("src/components/sidebar/sidebar-navigator.tsx");
    // Both deletes read the Rust report; neither guesses from the disk.
    const remove = read("src/features/document-removal/delete.ts");
    for (const source of [menus, remove]) {
      expect(source).toContain("deleteEntryReport(");
      expect(source).not.toContain("fileExists(");
    }
    const folderAt = menus.indexOf("deleteEntryReport(entry.path)");
    const folder = menus.slice(folderAt, menus.indexOf("})();", folderAt));
    expect(folder.indexOf("refreshDirectory(parent)")).toBeLessThan(
      folder.indexOf("report.cloud_error"),
    );
    expect(desk).toContain("TOMBSTONE_REMOVED_BY_OWNER");
    expect(desk).toContain("RESTORE_CONFIRM");
    expect(desk).toContain("SHARED_REMOVE");
    const removedAt = desk.indexOf("row.removed ?");
    const pendingAt = desk.indexOf("row.pending ?", removedAt);
    const removedBranch = desk.slice(removedAt, pendingAt);
    const openBranch = desk.slice(pendingAt);
    expect(removedBranch).toContain("onLeave(row.id)");
    expect(removedBranch).toContain("SHARED_REMOVE");
    expect(removedBranch).not.toContain("onOpen");
    expect(openBranch).toContain("onLeave(row.id)");
    expect(openBranch).toContain("SHARED_REMOVE");
    expect(openBranch).toContain("onOpen(row.id)");
    expect(desk).toContain("Accept");
    expect(desk).toContain("Decline");
    expect(hook).toContain("leaveAcceptedShare");
    expect(read("src/features/document-removal/delete.ts")).toContain(
      'confirmPlaceholder("invitee")',
    );
    expect(hook).toContain('confirmPlaceholder("restore")');
    expect(keep).toContain('confirmPlaceholder("mac-only")');
    expect(keep).toContain("DELETE_ONLINE_LEFT");
    expect(menus).toContain('confirmPlaceholder("owner")');
    expect(menus).toContain("deleteDocument");
    expect(sidebar).toContain("deleteDocument");
    expect(hook).toContain("window.alert");
    expect(hook).not.toContain("A failed leave keeps the row");
  });
});

describe("delete confirm", () => {
  const ask = vi.mocked(invoke);

  beforeEach(() => {
    ask.mockReset();
  });

  test("a dialog failure is not a cancelled delete", async () => {
    ask.mockRejectedValue(new Error("command plugin:dialog|ask not found"));
    await expect(confirmPlaceholder("owner")).rejects.toThrow(/plugin:dialog\|ask/);
  });

  test("confirm uses the message command and the button label", async () => {
    ask.mockResolvedValue("Delete");
    await expect(confirmPlaceholder("owner")).resolves.toBe(true);
    expect(ask).toHaveBeenCalledWith(
      "plugin:dialog|message",
      expect.objectContaining({
        title: "Delete this document?",
        kind: "warning",
        buttons: { OkCancelCustom: ["Delete", "Cancel"] },
      }),
    );
    ask.mockResolvedValue("Cancel");
    await expect(confirmPlaceholder("owner")).resolves.toBe(false);
    expect(dialogAccepted({ Custom: "Remove" }, "Remove")).toBe(true);
    expect(dialogAccepted({ Custom: "Cancel" }, "Remove")).toBe(false);
    const sharedCopy = "Alkuin couldn't update the shared copy. It will try again.";
    expect(cloudRemovalFailure(new Error("unavailable"))).toBe(sharedCopy);
    expect(cloudRemovalFailure(new Error("unreachable"))).toBe(sharedCopy);
    expect(cloudRemovalFailure(new Error("not_found"))).toBeNull();
  });
});

const SHARE_ID = "11111111-1111-4111-8111-111111111111";
const SHARE_PATH = `/Users/me/Library/Application Support/app/shares/${SHARE_ID}.md`;

function tabPaths() {
  return useEditorStore
    .getState()
    .tabs.flatMap((tab) => (tab.location.kind === "file" ? [tab.location.path] : []));
}

function fileTab(id: string, path: string) {
  return { id, location: { kind: "file" as const, path }, back: [], forward: [] };
}

function openBuffer(path: string) {
  return {
    path,
    frontmatter: null,
    content: "words",
    title: "Words",
    titleSource: "h1" as const,
    diskContent: "words",
    isDirty: false,
    isLoading: false,
    saveError: null,
    reloadVersion: 0,
    scrollPos: 0,
    cursorPos: 0,
    displayDate: null,
    stats: { words: 1, characters: 5, paragraphs: 1 },
  };
}

describe("delete and remove close the open tab", () => {
  test("a typed name and the macOS alias are the same document", () => {
    expect(sameDocumentPath("/var/notes/a.md", "/private/var/notes/a.md")).toBe(true);
    expect(sameDocumentPath("/private/notes/a.md", "/notes/a.md")).toBe(false);
    expect(sameDocumentPath("/notes/e\u0301.md", "/notes/\u00e9.md")).toBe(true);
  });

  const ask = vi.mocked(invoke);

  beforeEach(() => {
    ask.mockReset();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });
  });

  function open(paths: string[], active = paths[0] ?? null) {
    const tabs = paths.map((path, index) => fileTab(`tab-${index}`, path));
    const openFiles = new Map(paths.map((path) => [path, openBuffer(path)]));
    const activeTab = tabs.find((tab) => tab.location.path === active) ?? null;
    useEditorStore.setState({
      openFiles,
      tabs,
      activeTabId: activeTab?.id ?? null,
      activeFilePath: activeTab ? active : null,
    });
  }

  test("trashing waits for an in-flight save and drops the queued one, so the file cannot come back", async () => {
    vi.useFakeTimers();
    try {
      const path = "/notes/a.md";
      open([path]);
      let finishWrite!: () => void;
      const writing = new Promise<{ path: string; modified_at: number }>((resolve) => {
        finishWrite = () => resolve({ path, modified_at: 2 });
      });
      ask.mockImplementation(async (cmd: string) => {
        if (cmd === "write_file") return writing;
        if (cmd === "delete_entry_report") return { trashed: true, cloud_error: null };
        if (cmd === "history_send") return undefined;
        throw new Error(`unexpected ${cmd}`);
      });
      const dirty = (content: string) => {
        const openFiles = new Map(useEditorStore.getState().openFiles);
        openFiles.set(path, { ...openFiles.get(path)!, content, isDirty: true });
        useEditorStore.setState({ openFiles });
      };
      // One write is in flight; newer keystrokes queue behind it.
      dirty("first");
      scheduleSave(path);
      dirty("second");
      scheduleSave(path);
      expect(isSaveActive(path)).toBe(true);

      const trashed = trashEntry(path);
      await vi.advanceTimersByTimeAsync(100);
      expect(ask.mock.calls.map((call) => call[0])).not.toContain("delete_entry_report");

      finishWrite();
      await vi.advanceTimersByTimeAsync(5000);
      await trashed;

      const commands = ask.mock.calls.map((call) => call[0]);
      expect(commands.filter((command) => command === "write_file")).toHaveLength(1);
      expect(commands.indexOf("delete_entry_report")).toBeGreaterThan(
        commands.indexOf("write_file"),
      );
      expect(isSaveActive(path)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("owner delete closes that tab and leaves the others", async () => {
    open(["/notes/a.md", "/notes/b.md", "/notes/a.md"]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "share_role") return { role: "owner", share_id: null, document_id: "doc" };
      if (cmd === "plugin:dialog|message") return "Delete";
      if (cmd === "delete_entry_report") return { trashed: true, cloud_error: null };
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(deleteDocument("/notes/a.md")).resolves.toBe(true);

    expect(tabPaths()).toEqual(["/notes/b.md"]);
    expect(useEditorStore.getState().openFiles.has("/notes/a.md")).toBe(false);
    expect(useEditorStore.getState().activeFilePath).toBe("/notes/b.md");
  });

  test("a canonical macOS path closes the tab that was opened under the alias", async () => {
    open(["/var/notes/a.md", "/private/notes/kept.md"]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "share_role") return { role: "owner", share_id: null, document_id: "doc" };
      if (cmd === "plugin:dialog|message") return "Delete";
      if (cmd === "delete_entry_report") return { trashed: true, cloud_error: null };
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(deleteDocument("/private/var/notes/a.md")).resolves.toBe(true);

    expect(tabPaths()).toEqual(["/private/notes/kept.md"]);
    expect(useEditorStore.getState().openFiles.has("/var/notes/a.md")).toBe(false);
  });

  test("delete with no open tab still succeeds", async () => {
    open(["/notes/b.md"]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "share_role") return { role: "none", share_id: null, document_id: "doc" };
      if (cmd === "plugin:dialog|message") return "Delete";
      if (cmd === "delete_entry_report") return { trashed: true, cloud_error: null };
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(deleteDocument("/notes/a.md")).resolves.toBe(true);

    expect(tabPaths()).toEqual(["/notes/b.md"]);
    expect(useEditorStore.getState().activeFilePath).toBe("/notes/b.md");
  });

  test("cancel leaves the tab open and does not trash the file", async () => {
    open(["/notes/a.md", "/notes/b.md"]);
    const calls: string[] = [];
    ask.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "share_role") return { role: "owner", share_id: null, document_id: "doc" };
      if (cmd === "plugin:dialog|message") return "Cancel";
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(deleteDocument("/notes/a.md")).resolves.toBe(false);

    expect(calls).not.toContain("delete_entry_report");
    expect(tabPaths()).toEqual(["/notes/a.md", "/notes/b.md"]);
  });

  test("a cloud error after the file is gone still closes the tab and is shown", async () => {
    open(["/notes/a.md", "/notes/b.md"]);
    const calls: string[] = [];
    ask.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "share_role") return { role: "owner", share_id: null, document_id: "doc" };
      if (cmd === "plugin:dialog|message") return "Delete";
      if (cmd === "delete_entry_report") return { trashed: true, cloud_error: "unavailable" };
      throw new Error(`unexpected ${cmd}`);
    });

    const failure = await deleteDocument("/notes/a.md").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("unavailable");
    // The sidebar maps the reported code to its sentence, as before.
    expect(cloudRemovalFailure(failure)).toBe(
      "Alkuin couldn't update the shared copy. It will try again.",
    );
    expect(tabPaths()).toEqual(["/notes/b.md"]);
    // The report says what happened, so the disk is not asked.
    expect(calls).not.toContain("file_exists");
  });

  test("a save on its way lands before the trash, and typing during the trash writes nothing", async () => {
    open(["/notes/a.md", "/notes/b.md"]);
    const calls: string[] = [];
    let landWrite: (value: unknown) => void = () => {};
    let trash: (value: unknown) => void = () => {};
    ask.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === "write_file") return new Promise((resolve) => (landWrite = resolve));
      if (cmd === "share_role")
        return Promise.resolve({ role: "none", share_id: null, document_id: "doc" });
      if (cmd === "plugin:dialog|message") return Promise.resolve("Delete");
      if (cmd === "delete_entry_report") return new Promise((resolve) => (trash = resolve));
      return Promise.resolve(null);
    });

    useEditorStore.getState().updateContent("/notes/a.md", "words, edited");
    expect(calls).toEqual(["write_file"]);

    const deleting = deleteDocument("/notes/a.md");
    await vi.waitFor(() => expect(calls).toContain("plugin:dialog|message"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).not.toContain("delete_entry_report");

    landWrite({ path: "/notes/a.md", modified_at: 2 });
    await vi.waitFor(() => expect(calls).toContain("delete_entry_report"));
    useEditorStore.getState().updateContent("/notes/a.md", "typed while trashing");
    trash({ trashed: true, cloud_error: null });
    await expect(deleting).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(calls.filter((cmd) => cmd === "write_file")).toHaveLength(1);
    expect(tabPaths()).toEqual(["/notes/b.md"]);
  });

  test("a failed trash leaves the tab open and erases nothing", async () => {
    open(["/notes/a.md", "/notes/b.md"]);
    const calls: string[] = [];
    ask.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "share_role") return { role: "owner", share_id: null, document_id: "doc" };
      if (cmd === "plugin:dialog|message") return "Delete";
      if (cmd === "delete_entry_report") throw new Error("IO error: permission denied");
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(deleteDocument("/notes/a.md")).rejects.toThrow("IO error: permission denied");
    expect(tabPaths()).toEqual(["/notes/a.md", "/notes/b.md"]);
    expect(calls).not.toContain("file_exists");
  });

  test("a failed trash gives autosave back, so words typed during it still save", async () => {
    open(["/notes/a.md"]);
    const calls: string[] = [];
    let refuse: (error: Error) => void = () => {};
    ask.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === "delete_entry_report") {
        return new Promise((_, reject) => (refuse = reject));
      }
      if (cmd === "write_file") return Promise.resolve({ path: "/notes/a.md", modified_at: 2 });
      return Promise.resolve(null);
    });

    const trashing = trashEntry("/notes/a.md");
    await vi.waitFor(() => expect(calls).toContain("delete_entry_report"));
    // Held while the Trash runs: nothing may re-create the file.
    useEditorStore.getState().updateContent("/notes/a.md", "typed while trashing");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).not.toContain("write_file");

    refuse(new Error("IO error: permission denied"));
    await expect(trashing).rejects.toThrow("IO error: permission denied");
    await vi.waitFor(() => expect(calls).toContain("write_file"), { timeout: 2000 });
    expect(tabPaths()).toEqual(["/notes/a.md"]);
    await vi.waitFor(() =>
      expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.isDirty).toBe(false),
    );
  });

  test("trashing a selected folder closes the documents inside it", async () => {
    open(["/notes/dir/a.md", "/notes/dir/sub/b.md", "/notes/dir-two/c.md", "/notes/d.md"]);
    useEditorStore.getState().updateContent("/notes/dir/a.md", "unsaved inside the folder");
    const calls: string[] = [];
    ask.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "delete_entry_report") return { trashed: true, cloud_error: null };
      return { path: "/notes/dir/a.md", modified_at: 2 };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls.length = 0;

    await trashEntry("/notes/dir");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(tabPaths()).toEqual(["/notes/dir-two/c.md", "/notes/d.md"]);
    expect(useEditorStore.getState().openFiles.has("/notes/dir/a.md")).toBe(false);
    expect(calls).toEqual(["delete_entry_report"]);
  });

  test("remove and tombstone dismiss close that share's tab", async () => {
    open([SHARE_PATH, "/notes/b.md"]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:dialog|message") return "Remove";
      if (cmd === "share_leave") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(leaveAcceptedShare(SHARE_ID)).resolves.toBe(true);

    expect(tabPaths()).toEqual(["/notes/b.md"]);
    expect(useEditorStore.getState().openFiles.has(SHARE_PATH)).toBe(false);
  });

  test("remove with no open tab still succeeds", async () => {
    open(["/notes/b.md"]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:dialog|message") return "Remove";
      if (cmd === "share_leave") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(leaveAcceptedShare(SHARE_ID)).resolves.toBe(true);
    expect(tabPaths()).toEqual(["/notes/b.md"]);
  });

  test("a cancelled or failed remove leaves every tab open", async () => {
    open([SHARE_PATH, "/notes/b.md"]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:dialog|message") return "Cancel";
      throw new Error(`unexpected ${cmd}`);
    });
    await expect(leaveAcceptedShare(SHARE_ID)).resolves.toBe(false);
    expect(tabPaths()).toEqual([SHARE_PATH, "/notes/b.md"]);

    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:dialog|message") return "Remove";
      if (cmd === "share_leave") throw new Error("unavailable");
      throw new Error(`unexpected ${cmd}`);
    });
    await expect(leaveAcceptedShare(SHARE_ID)).rejects.toThrow("unavailable");
    expect(tabPaths()).toEqual([SHARE_PATH, "/notes/b.md"]);
  });

  test("leaving a share or deleting its file closes that share's ledger", async () => {
    saveSentRefs(SHARE_ID, SHARE_PATH, ["sent-ref"]);
    rememberShare(SHARE_ID, SHARE_PATH, "invitee");
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:dialog|message") return "Remove";
      if (cmd === "share_leave") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    await expect(leaveAcceptedShare(SHARE_ID)).resolves.toBe(true);
    expect(loadSentRefs(SHARE_ID, SHARE_PATH)).toEqual([]);
    expect(loadShare(SHARE_PATH)).toBeNull();

    const owner = "/notes/shared.md";
    const ownerShare = "22222222-2222-4222-8222-222222222222";
    rememberShare(ownerShare, owner, "owner");
    saveSentRefs(ownerShare, owner, ["note-ref"]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "share_role") {
        return { role: "owner", share_id: ownerShare, document_id: "doc", status: "accepted" };
      }
      if (cmd === "plugin:dialog|message") return "Delete";
      if (cmd === "delete_entry_report") return { trashed: true, cloud_error: null };
      throw new Error(`unexpected ${cmd}`);
    });
    await expect(deleteDocument(owner)).resolves.toBe(true);
    expect(loadSentRefs(ownerShare, owner)).toEqual([]);
    expect(loadShare(owner)).toBeNull();
  });

  test("a second delete of a file being trashed waits for the first", async () => {
    open(["/notes/a.md", "/notes/b.md"]);
    let release!: () => void;
    const calls: string[] = [];
    ask.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "delete_entry_report") {
        await new Promise<void>((done) => {
          release = done;
        });
        return { trashed: true, cloud_error: null };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const first = trashEntry("/notes/a.md");
    const second = trashEntry("/notes/a.md");
    await vi.waitFor(() => expect(calls).toContain("delete_entry_report"));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(calls).toEqual(["delete_entry_report"]);
    expect(tabPaths()).toEqual(["/notes/b.md"]);
    // Once it settles, the path can be trashed again. A rejection is a failed Trash.
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "delete_entry_report") throw new Error("Not found: /notes/a.md");
      throw new Error(`unexpected ${cmd}`);
    });
    await expect(trashEntry("/notes/a.md")).rejects.toThrow("Not found");
  });

  test("a file named like a share id outside shares/ stays open", async () => {
    const decoy = `/notes/${SHARE_ID}.md`;
    open([decoy]);
    ask.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:dialog|message") return "Remove";
      if (cmd === "share_leave") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });

    await expect(leaveAcceptedShare(SHARE_ID)).resolves.toBe(true);
    expect(tabPaths()).toEqual([decoy]);
  });
});
