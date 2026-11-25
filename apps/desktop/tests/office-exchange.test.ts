import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
  readStoredAppearance: () => null,
}));

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useEditorNoticeStore } from "../src/components/editor-area/editor-notice-store";
import { rememberWritingSession } from "../src/lib/account-session";
import { MENU_EVENT_HANDLERS } from "../src/hooks/use-menu-events";
import {
  EXPORT_DOCX_FAILED,
  EXPORT_DOCX_NEEDS_DOC,
  EXPORT_DOCX_SAVED_UNOPENED,
  EXPORT_GOOGLE_BROWSER_FAILED,
  GOOGLE_DRIVE_URL,
  IMPORT_OPEN_FAILED,
  IMPORT_UNSAVED,
  OFFICE_BUSY,
  isGoogleDocImportOpen,
  useGoogleDocImportStore,
  docxDefaultPath,
  exportOpenDocumentDocx,
  exportOpenDocumentGoogleDoc,
  googleExportNotice,
  importGoogleDoc,
  importWordDocument,
  importedNotePath,
  importedNoteStem,
  markdownBeside,
  withDocxExtension,
  withMarkdownExtension,
} from "../src/lib/office-exchange";
import { useEditorStore, type OpenFile } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const mockedSave = vi.mocked(save);
const mockedOpen = vi.mocked(open);
const mockedInvoke = vi.mocked(invoke);
const mockedOpenPath = vi.mocked(openPath);
const mockedOpenUrl = vi.mocked(openUrl);

const MARKDOWN = "# Harbor\n\nThe dock is **long**.\n";

function openNote(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    path: "/notes/Harbor.md",
    frontmatter: "title: Secret\n",
    content: "The dock is long.",
    title: "Harbor",
    titleSource: "h1",
    diskContent: "previous",
    isDirty: true,
    isLoading: false,
    saveError: null,
    reloadVersion: 0,
    scrollPos: 0,
    cursorPos: 0,
    displayDate: null,
    stats: { words: 4, characters: 17, paragraphs: 1 },
    ...overrides,
  };
}

function putFile(file: OpenFile) {
  useEditorStore.setState({
    openFiles: new Map([[file.path, file]]),
    tabs: [],
    activeTabId: null,
    activeFilePath: file.path,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditorNoticeStore.setState({ message: null, overlap: null });
  useGoogleDocImportStore.setState({ phase: { kind: "closed" } });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
  useWorkspaceStore.setState({ root: "/notes" });
  rememberWritingSession(true);
  mockedSave.mockResolvedValue("/notes/Harbor.md");
  mockedOpen.mockResolvedValue("/notes/Harbor.docx");
  mockedOpenPath.mockResolvedValue(undefined);
  mockedOpenUrl.mockResolvedValue(undefined);
  mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
    const payload = (args ?? {}) as { path?: string };
    if (command === "file_exists") return false;
    if (command === "create_file" || command === "write_file" || command === "read_file") {
      return {
        path: payload.path,
        content: command === "read_file" ? MARKDOWN : "# ",
        modified_at: 1,
      };
    }
    if (command === "docx_to_markdown" || command === "google_doc_to_markdown") return MARKDOWN;
    return undefined;
  });
});

describe("office paths", () => {
  test("sits the note beside the word file and keeps a docx extension", () => {
    expect(markdownBeside("/notes/Harbor.docx")).toBe("/notes/Harbor.md");
    expect(markdownBeside("C:\\Notes\\Harbor.docx")).toBe("C:\\Notes\\Harbor.md");
    expect(docxDefaultPath("/notes/Harbor.md")).toBe("/notes/Harbor.docx");
    expect(withDocxExtension("/out/Draft")).toBe("/out/Draft.docx");
    expect(withDocxExtension("/out/Draft.DOCX")).toBe("/out/Draft.DOCX");
    expect(withMarkdownExtension("/out/Draft")).toBe("/out/Draft.md");
    expect(withMarkdownExtension("/out/Draft.docx")).toBe("/out/Draft.md");
    expect(withMarkdownExtension("/out/Draft.markdown")).toBe("/out/Draft.markdown");
    expect(importedNoteStem("# Harbor\n\nThe dock.", "Google Doc")).toBe("Harbor");
    expect(importedNoteStem("No heading\n", "Google Doc")).toBe("Google Doc");
    expect(importedNotePath("Harbor")).toBe("/notes/Harbor.md");
  });
});

describe("word and google docs menus", () => {
  test("the File menu imports and exports Word and Google Docs beside PDF", () => {
    const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const fileMenu = lib.slice(
      lib.indexOf('SubmenuBuilder::new(app, "File")'),
      lib.indexOf('SubmenuBuilder::new(app, "Edit")'),
    );
    expect(lib).toContain('MenuItemBuilder::with_id("file.import-docx", "Import Word…")');
    expect(lib).toContain(
      'MenuItemBuilder::with_id("file.import-google-doc", "Import Google Docs…")',
    );
    expect(lib).toContain('MenuItemBuilder::with_id("file.export-docx", "Export Word…")');
    expect(lib).toContain(
      'MenuItemBuilder::with_id("file.export-google-doc", "Export Google Docs…")',
    );
    expect(lib).toContain('MenuItemBuilder::with_id("file.export-pdf", "Export PDF…")');
    expect(fileMenu).toContain(".item(&import_word)");
    expect(fileMenu).toContain(".item(&import_google)");
    expect(fileMenu).toContain(".item(&export_word)");
    expect(fileMenu).toContain(".item(&export_google)");
    expect(fileMenu).toContain(".item(&export_pdf)");
    expect(lib).toContain('"file.import-docx" => emit_to_focused_window(app, "menu:import-docx")');
    expect(lib).toContain(
      '"file.export-google-doc" => emit_to_focused_window(app, "menu:export-google-doc")',
    );
  });

  test("import and export do nothing while signed out", () => {
    rememberWritingSession(false);
    MENU_EVENT_HANDLERS["menu:import-docx"]!();
    MENU_EVENT_HANDLERS["menu:import-google-doc"]!();
    MENU_EVENT_HANDLERS["menu:export-docx"]!();
    MENU_EVENT_HANDLERS["menu:export-google-doc"]!();
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
    expect(isGoogleDocImportOpen(useGoogleDocImportStore.getState())).toBe(false);
  });
});

describe("import word", () => {
  test("turns the word file into a note and opens it", async () => {
    await importWordDocument();
    expect(mockedOpen).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      title: "Import Word",
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    expect(mockedInvoke).toHaveBeenCalledWith("docx_to_markdown", { path: "/notes/Harbor.docx" });
    expect(mockedSave).toHaveBeenCalledWith({
      title: "Import into Alkuin",
      defaultPath: "/notes/Harbor.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    expect(mockedInvoke).toHaveBeenCalledWith("write_file", {
      path: "/notes/Harbor.md",
      content: MARKDOWN,
    });
    await vi.waitFor(() =>
      expect(useEditorStore.getState().activeFilePath).toBe("/notes/Harbor.md"),
    );
    const file = useEditorStore.getState().openFiles.get("/notes/Harbor.md");
    expect(file?.content).toContain("**long**");
    expect(file?.title).toBe("Harbor");
    expect(file?.content).not.toContain("Secret");
  });

  test("cancel does not write", async () => {
    mockedOpen.mockResolvedValue(null);
    await importWordDocument();
    expect(mockedInvoke).not.toHaveBeenCalled();
    mockedOpen.mockResolvedValue("/notes/Harbor.docx");
    mockedSave.mockResolvedValue(null);
    await importWordDocument();
    expect(mockedInvoke).toHaveBeenCalledWith("docx_to_markdown", { path: "/notes/Harbor.docx" });
    expect(mockedInvoke).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  test("typing into the open note while the import is written keeps the typing", async () => {
    putFile(
      openNote({
        isDirty: false,
        frontmatter: null,
        content: "old words",
        diskContent: "old words",
      }),
    );
    const writes: string[] = [];
    let landImport: () => void = () => {};
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const payload = (args ?? {}) as { path?: string; content?: string };
      if (command === "file_exists") return true;
      if (command === "docx_to_markdown") return MARKDOWN;
      if (command === "write_file") {
        writes.push(payload.content ?? "");
        if (writes.length === 1) await new Promise<void>((resolve) => (landImport = resolve));
        return { path: payload.path, modified_at: 2 };
      }
      return undefined;
    });

    const importing = importWordDocument();
    await vi.waitFor(() => expect(writes).toEqual([MARKDOWN]));
    useEditorStore.getState().updateContent("/notes/Harbor.md", "typed during import");
    landImport();
    await importing;

    expect(useEditorNoticeStore.getState().message).toBe(IMPORT_UNSAVED);
    expect(useEditorStore.getState().openFiles.get("/notes/Harbor.md")?.content).toBe(
      "typed during import",
    );
    await vi.waitFor(() => expect(writes).toEqual([MARKDOWN, "typed during import"]));
  });

  test("refuses to replace a note that has unsaved edits", async () => {
    putFile(openNote({ path: "/notes/Harbor.md", isDirty: true }));
    mockedSave.mockResolvedValue("/notes/Harbor.md");
    await importWordDocument();
    expect(useEditorNoticeStore.getState().message).toBe(IMPORT_UNSAVED);
    expect(mockedInvoke).not.toHaveBeenCalledWith("write_file", expect.anything());
  });
});

describe("import google docs", () => {
  test("the menu opens the link dialog", () => {
    MENU_EVENT_HANDLERS["menu:import-google-doc"]!();
    expect(isGoogleDocImportOpen(useGoogleDocImportStore.getState())).toBe(true);
  });

  test("downloads the word export and opens the note", async () => {
    const result = await importGoogleDoc("https://docs.google.com/document/d/abc/edit");
    expect(result).toBe("saved");
    expect(mockedInvoke).toHaveBeenCalledWith("google_doc_to_markdown", {
      url: "https://docs.google.com/document/d/abc/edit",
    });
    expect(mockedSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "/notes/Harbor.md" }),
    );
    await vi.waitFor(() =>
      expect(useEditorStore.getState().activeFilePath).toBe("/notes/Harbor.md"),
    );
    expect(useEditorStore.getState().openFiles.get("/notes/Harbor.md")?.content).toContain(
      "**long**",
    );
  });

  test("a failed download does not ask where to save", async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === "google_doc_to_markdown") {
        throw "Alkuin couldn't download that Google Doc. Share it so anyone with the link can view it, or import the Word file.";
      }
      return undefined;
    });
    await expect(importGoogleDoc("https://docs.google.com/document/d/abc/edit")).rejects.toThrow(
      /anyone with the link/,
    );
    expect(mockedSave).not.toHaveBeenCalled();
  });

  test("Escape during an import does nothing, and the result lands on that opening", async () => {
    let finishDownload: (markdown: string) => void = () => {};
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const payload = (args ?? {}) as { path?: string };
      if (command === "google_doc_to_markdown") {
        return new Promise<string>((resolve) => (finishDownload = resolve));
      }
      if (command === "file_exists") return false;
      if (command === "create_file" || command === "write_file" || command === "read_file") {
        return { path: payload.path, content: MARKDOWN, modified_at: 1 };
      }
      return undefined;
    });
    mockedSave.mockResolvedValue(null);
    const dialog = useGoogleDocImportStore.getState();

    dialog.openDialog();
    const session = useGoogleDocImportStore.getState().phase;
    const importing = dialog.submit("https://docs.google.com/document/d/abc/edit");
    expect(useGoogleDocImportStore.getState().phase.kind).toBe("importing");

    dialog.closeDialog();
    dialog.openDialog();
    expect(useGoogleDocImportStore.getState().phase.kind).toBe("importing");

    finishDownload(MARKDOWN);
    await importing;
    expect(useGoogleDocImportStore.getState().phase).toEqual(session);
  });

  test("an import while another one runs says so instead of looking cancelled", async () => {
    let finishWord: (path: string | null) => void = () => {};
    mockedOpen.mockImplementation(
      () => new Promise((resolve) => (finishWord = resolve as (path: string | null) => void)),
    );
    const word = importWordDocument();

    expect(await importGoogleDoc("https://docs.google.com/document/d/abc/edit")).toBe("busy");

    const dialog = useGoogleDocImportStore.getState();
    dialog.openDialog();
    await dialog.submit("https://docs.google.com/document/d/abc/edit");
    const phase = useGoogleDocImportStore.getState().phase;
    expect(phase.kind === "editing" && phase.error).toBe(OFFICE_BUSY);

    await exportOpenDocumentDocx();
    expect(useEditorNoticeStore.getState().message).toBe(OFFICE_BUSY);

    finishWord(null);
    await word;
  });
});

describe("export word and google docs", () => {
  test("exports the open body, not the frontmatter, and opens the file", async () => {
    putFile(openNote());
    mockedSave.mockResolvedValue("/out/Harbor.docx");
    await exportOpenDocumentDocx();
    expect(mockedSave).toHaveBeenCalledWith({
      title: "Export Word",
      defaultPath: "/notes/Harbor.docx",
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    expect(mockedInvoke).toHaveBeenCalledWith("export_docx", {
      path: "/out/Harbor.docx",
      title: "Harbor",
      body: "The dock is long.",
      notePath: "/notes/Harbor.md",
    });
    const body = mockedInvoke.mock.calls.find((call) => call[0] === "export_docx")?.[1] as {
      body: string;
    };
    expect(body.body).not.toContain("Secret");
    expect(body.body).not.toBe("previous");
    expect(mockedOpenPath).toHaveBeenCalledWith("/out/Harbor.docx");
  });

  test("asks for a document when none is open", async () => {
    await exportOpenDocumentDocx();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_DOCX_NEEDS_DOC);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  test("cancel does not write", async () => {
    putFile(openNote());
    mockedSave.mockResolvedValue(null);
    await exportOpenDocumentDocx();
    expect(mockedInvoke).not.toHaveBeenCalledWith("export_docx", expect.anything());
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  test("a failed write shows the export's reason and does not open the file", async () => {
    putFile(openNote());
    mockedInvoke.mockRejectedValue("Alkuin can't put an SVG in the file. Use a PNG or JPEG.");
    await exportOpenDocumentDocx();
    expect(useEditorNoticeStore.getState().message).toContain("SVG");
    expect(useEditorNoticeStore.getState().message).not.toBe(EXPORT_DOCX_FAILED);
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  test("a failed write with no sentence uses the generic notice", async () => {
    putFile(openNote());
    mockedInvoke.mockRejectedValue({ message: "  " });
    await exportOpenDocumentDocx();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_DOCX_FAILED);
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  test("a saved file that cannot be opened says so", async () => {
    putFile(openNote());
    mockedOpenPath.mockRejectedValue("no app");
    await exportOpenDocumentDocx();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_DOCX_SAVED_UNOPENED);
  });

  test("google docs saves the same word file, reveals it, and opens drive", async () => {
    putFile(openNote());
    mockedSave.mockResolvedValue("/out/Harbor");
    await exportOpenDocumentGoogleDoc();
    expect(mockedInvoke).toHaveBeenCalledWith(
      "export_docx",
      expect.objectContaining({ path: "/out/Harbor.docx", body: "The dock is long." }),
    );
    expect(mockedInvoke).toHaveBeenCalledWith("reveal_in_file_manager", {
      path: "/out/Harbor.docx",
    });
    expect(mockedOpenUrl).toHaveBeenCalledWith(GOOGLE_DRIVE_URL);
    expect(useEditorNoticeStore.getState().message).toBe(googleExportNotice("Harbor.docx", true));
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  test("google docs still says the file was saved when drive does not open", async () => {
    putFile(openNote());
    mockedOpenUrl.mockRejectedValue("no browser");
    await exportOpenDocumentGoogleDoc();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_GOOGLE_BROWSER_FAILED);
  });

  test("a failed open of the saved file says so", async () => {
    putFile(openNote());
    await exportOpenDocumentDocx();
    expect(mockedOpenPath).toHaveBeenCalled();
    mockedOpenPath.mockRejectedValueOnce("no app");
    await exportOpenDocumentDocx();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_DOCX_SAVED_UNOPENED);
  });
});

describe("import open failure", () => {
  test("says the note was saved when it cannot be opened", async () => {
    mockedInvoke.mockImplementation(async (command: string, args?: unknown) => {
      const payload = (args ?? {}) as { path?: string };
      if (command === "file_exists") return false;
      if (command === "create_file" || command === "write_file") {
        return { path: payload.path, content: "# ", modified_at: 1 };
      }
      if (command === "docx_to_markdown") return MARKDOWN;
      if (command === "read_file") throw "missing";
      return undefined;
    });
    await importWordDocument();
    await vi.waitFor(() =>
      expect(useEditorNoticeStore.getState().message).toBe(IMPORT_OPEN_FAILED),
    );
  });
});
