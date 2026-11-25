import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import * as ipc from "../src/lib/tauri";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("filesystem IPC wrappers", () => {
  test("readDirectory calls correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    await ipc.readDirectory("/test");
    expect(mockedInvoke).toHaveBeenCalledWith("read_directory", {
      path: "/test",
    });
  });

  test("readRecentFiles calls correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    await ipc.readRecentFiles(12, 6);
    expect(mockedInvoke).toHaveBeenCalledWith("read_recent_files", {
      limit: 12,
      offset: 6,
    });
  });

  test("readFileEntries calls correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    await ipc.readFileEntries(["/test/a.md", "/test/b.md"]);
    expect(mockedInvoke).toHaveBeenCalledWith("read_file_entries", {
      paths: ["/test/a.md", "/test/b.md"],
    });
  });

  test("readFile calls correct command", async () => {
    mockedInvoke.mockResolvedValue({ path: "/test.md", content: "", modified_at: 0 });
    await ipc.readFile("/test.md");
    expect(mockedInvoke).toHaveBeenCalledWith("read_file", {
      path: "/test.md",
    });
  });

  test("writeFile calls correct command", async () => {
    mockedInvoke.mockResolvedValue({ path: "/test.md", modified_at: 0 });
    await ipc.writeFile("/test.md", "content");
    expect(mockedInvoke).toHaveBeenCalledWith("write_file", {
      path: "/test.md",
      content: "content",
    });
  });

  test("createFile calls correct command", async () => {
    mockedInvoke.mockResolvedValue({ path: "/new.md", content: "", modified_at: 0 });
    await ipc.createFile("/new.md");
    expect(mockedInvoke).toHaveBeenCalledWith("create_file", {
      path: "/new.md",
    });
  });

  test("createDirectory calls correct command", async () => {
    mockedInvoke.mockResolvedValue({ name: "dir", path: "/dir", is_dir: true });
    await ipc.createDirectory("/dir");
    expect(mockedInvoke).toHaveBeenCalledWith("create_directory", {
      path: "/dir",
    });
  });

  test("createSidebarEntry calls the workspace-scoped command", async () => {
    mockedInvoke.mockResolvedValue({
      name: "Untitled.md",
      path: "/ws/Untitled.md",
      is_dir: false,
      is_markdown: true,
    });
    await ipc.createSidebarEntry("/ws", "file");
    expect(mockedInvoke).toHaveBeenCalledWith("create_sidebar_entry", {
      parentPath: "/ws",
      kind: "file",
    });
  });

  test("renameEntry calls correct command", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.renameEntry("/old.md", "/new.md");
    expect(mockedInvoke).toHaveBeenCalledWith("rename_entry", {
      oldPath: "/old.md",
      newPath: "/new.md",
    });
  });

  test("deleteEntry calls correct command", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.deleteEntry("/test.md");
    expect(mockedInvoke).toHaveBeenCalledWith("delete_entry", {
      path: "/test.md",
    });
  });

  test("fileExists calls correct command", async () => {
    mockedInvoke.mockResolvedValue(true);
    const result = await ipc.fileExists("/test.md");
    expect(mockedInvoke).toHaveBeenCalledWith("file_exists", {
      path: "/test.md",
    });
    expect(result).toBe(true);
  });
});

describe("workspace IPC wrappers", () => {
  test("closeWorkspace invalidates the expected workspace root", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.closeWorkspace("/test");
    expect(mockedInvoke).toHaveBeenCalledWith("close_workspace", { root: "/test" });
  });

  test("openWorkspace calls correct command", async () => {
    mockedInvoke.mockResolvedValue({ root: "/ws", name: "ws", file_count: 0 });
    await ipc.openWorkspace("/ws");
    expect(mockedInvoke).toHaveBeenCalledWith("open_workspace", {
      path: "/ws",
    });
  });

  test("opens the current window workspace in its file manager", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.openWorkspaceInFileManager();
    expect(mockedInvoke).toHaveBeenCalledWith("open_workspace_in_file_manager");
  });

  test("opens the current window workspace root in a terminal", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.openDirectoryInTerminal(null);
    expect(mockedInvoke).toHaveBeenCalledWith("open_workspace_in_terminal", { path: null });
  });

  test("opens a selected workspace directory in a terminal", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.openDirectoryInTerminal("/ws/drafts");
    expect(mockedInvoke).toHaveBeenCalledWith("open_workspace_in_terminal", {
      path: "/ws/drafts",
    });
  });

  test("pickWorkspace opens a directory dialog", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("/selected/folder");
    const result = await ipc.pickWorkspace();
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Open Folder",
    });
    expect(result).toBe("/selected/folder");
  });

  test("getRecentWorkspaces calls correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    await ipc.getRecentWorkspaces();
    expect(mockedInvoke).toHaveBeenCalledWith("get_recent_workspaces");
  });

  test("removeRecentWorkspace calls correct command", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.removeRecentWorkspace("/old");
    expect(mockedInvoke).toHaveBeenCalledWith("remove_recent_workspace", {
      path: "/old",
    });
  });

  test("takePendingOpen calls correct command", async () => {
    mockedInvoke.mockResolvedValue({ workspace: "/ws", file: null });
    await ipc.takePendingOpen();
    expect(mockedInvoke).toHaveBeenCalledWith("take_pending_open");
  });

  test("gitFileStatus calls native git IPC", async () => {
    mockedInvoke.mockResolvedValue({
      repo_root: "/repo",
      clean: false,
      porcelain: " M note.md",
      diff: "diff --git a/note.md b/note.md",
      error: null,
    });
    await ipc.gitFileStatus("/repo/note.md");
    expect(mockedInvoke).toHaveBeenCalledWith("git_file_status", { path: "/repo/note.md" });
  });

  test("gitCommitFile calls native git IPC and does not push", async () => {
    mockedInvoke.mockResolvedValue({
      committed: true,
      commit_sha: "abc",
      error: null,
    });
    await ipc.gitCommitFile("/repo/note.md");
    expect(mockedInvoke).toHaveBeenCalledWith("git_commit_file", { path: "/repo/note.md" });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
  });

  test("gitEnqueueOp and gitFlushQueue call native git IPC", async () => {
    mockedInvoke.mockResolvedValue(true);
    await ipc.gitEnqueueOp("/repo/note.md", "commit");
    expect(mockedInvoke).toHaveBeenCalledWith("git_enqueue_op", {
      path: "/repo/note.md",
      op: "commit",
      message: null,
    });
    mockedInvoke.mockClear();
    await ipc.gitEnqueueOp("/repo/note.md", "push", "Accepted suggestion in note.md");
    expect(mockedInvoke).toHaveBeenCalledWith("git_enqueue_op", {
      path: "/repo/note.md",
      op: "push",
      message: "Accepted suggestion in note.md",
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    mockedInvoke.mockClear();
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.gitFlushQueue("/repo");
    expect(mockedInvoke).toHaveBeenCalledWith("git_flush_queue", { path: "/repo" });
    mockedInvoke.mockClear();
    mockedInvoke.mockResolvedValue({
      updated: false,
      skipped: true,
      conflict: false,
      error: null,
      retry: false,
    });
    await ipc.gitPull("/repo");
    expect(mockedInvoke).toHaveBeenCalledWith("git_pull", { path: "/repo" });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
  });

  test("gitPublishFile calls native git IPC", async () => {
    mockedInvoke.mockResolvedValue({
      committed: true,
      pushed: false,
      commit_sha: "abc",
      error: "no origin remote (GitHub publish skipped)",
    });
    await ipc.gitPublishFile("/repo/note.md", "Accepted suggestion in note.md");
    expect(mockedInvoke).toHaveBeenCalledWith("git_publish_file", {
      path: "/repo/note.md",
      message: "Accepted suggestion in note.md",
    });
  });

  test("redlinePropose calls the native command without a key argument", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: "This is important.", intent: "replace" });
    await ipc.redlinePropose("/notes/draft.md", "This is really very important.", "improve");
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "/notes/draft.md",
      original: "This is really very important.",
      instruction: "improve",
    });
    const first = mockedInvoke.mock.calls.find(([cmd]) => cmd === "redline_propose");
    expect(first?.[1]).not.toHaveProperty("document");
    expect(first?.[1]).not.toHaveProperty("note");
  });

  test("redline learn IPC names the local path and no model fields", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await ipc.accountClearStyle();
    expect(mockedInvoke).toHaveBeenCalledWith("account_clear_style");
    await ipc.redlineLearn(
      "/notes/draft.md",
      "edit",
      "before words",
      "suggested words",
      "final words",
    );
    expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
      path: "/notes/draft.md",
      source: "edit",
      before: "before words",
      suggested: "suggested words",
      finalText: "final words",
    });
    const learnCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === "redline_learn");
    expect(learnCall?.[1]).not.toHaveProperty("model");
    expect(learnCall?.[1]).not.toHaveProperty("messages");
    expect(learnCall?.[1]).not.toHaveProperty("tools");
  });
});
