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
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
  readStoredAppearance: () => null,
}));

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEditorNoticeStore } from "../src/components/editor-area/editor-notice-store";
import { rememberWritingSession } from "../src/lib/account-session";
import { MENU_EVENT_HANDLERS } from "../src/hooks/use-menu-events";
import {
  EXPORT_PDF_BUSY,
  EXPORT_PDF_FAILED,
  EXPORT_PDF_NEEDS_DOC,
  EXPORT_PDF_SAVED_UNOPENED,
  exportOpenDocumentPdf,
  pdfDefaultPath,
  withPdfExtension,
} from "../src/lib/export-pdf";
import { useEditorStore, type OpenFile } from "../src/stores/editor-store";

const mockedSave = vi.mocked(save);
const mockedInvoke = vi.mocked(invoke);
const mockedOpen = vi.mocked(openPath);

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
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
  mockedSave.mockResolvedValue("/out/Harbor.pdf");
  mockedInvoke.mockResolvedValue(undefined);
  mockedOpen.mockResolvedValue(undefined);
});

describe("pdf path", () => {
  test("uses the note name beside the note", () => {
    expect(pdfDefaultPath("/notes/Harbor.md")).toBe("/notes/Harbor.pdf");
    expect(pdfDefaultPath("/notes/Harbor.markdown")).toBe("/notes/Harbor.pdf");
    expect(pdfDefaultPath("C:\\Notes\\Harbor.md")).toBe("C:\\Notes\\Harbor.pdf");
    expect(pdfDefaultPath("/notes/notes.v2.md")).toBe("/notes/notes.v2.pdf");
  });

  test("adds a pdf extension when the save dialog omits one", () => {
    expect(withPdfExtension("/out/Draft")).toBe("/out/Draft.pdf");
    expect(withPdfExtension("/out/Draft.PDF")).toBe("/out/Draft.PDF");
  });
});

describe("export pdf", () => {
  test("the File menu still exports PDF on its own", () => {
    const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    expect(lib).toContain('MenuItemBuilder::with_id("file.export-pdf", "Export PDF…")');
    expect(lib).toContain('"file.export-pdf" => emit_to_focused_window(app, "menu:export-pdf")');
    expect(MENU_EVENT_HANDLERS["menu:export-pdf"]).toEqual(expect.any(Function));
  });

  test("exports the open body, not the frontmatter, and opens the pdf", async () => {
    putFile(openNote());
    rememberWritingSession(true);

    MENU_EVENT_HANDLERS["menu:export-pdf"]!();

    expect(mockedSave).toHaveBeenCalledWith({
      title: "Export PDF",
      defaultPath: "/notes/Harbor.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    await vi.waitFor(() => expect(mockedOpen).toHaveBeenCalledWith("/out/Harbor.pdf"));
    expect(mockedInvoke).toHaveBeenCalledWith("export_pdf", {
      path: "/out/Harbor.pdf",
      title: "Harbor",
      body: "The dock is long.",
      notePath: "/notes/Harbor.md",
    });
    const body = mockedInvoke.mock.calls[0]?.[1] as { body: string };
    expect(body.body).not.toContain("Secret");
    expect(body.body).not.toBe("previous");
  });

  test("asks for a document when none is open or the file is still loading", async () => {
    await exportOpenDocumentPdf();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_PDF_NEEDS_DOC);
    expect(mockedSave).not.toHaveBeenCalled();

    useEditorNoticeStore.setState({ message: null });
    putFile(openNote({ isLoading: true, content: "" }));
    await exportOpenDocumentPdf();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_PDF_NEEDS_DOC);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  test("cancel does not write", async () => {
    putFile(openNote());
    mockedSave.mockResolvedValue(null);
    await exportOpenDocumentPdf();
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("a chosen path without an extension is saved as pdf", async () => {
    putFile(openNote());
    mockedSave.mockResolvedValue("/out/Draft");
    await exportOpenDocumentPdf();
    expect(mockedInvoke).toHaveBeenCalledWith(
      "export_pdf",
      expect.objectContaining({ path: "/out/Draft.pdf" }),
    );
    expect(mockedOpen).toHaveBeenCalledWith("/out/Draft.pdf");
  });

  test("a failed write shows the export's reason and does not open the pdf", async () => {
    putFile(openNote());
    mockedInvoke.mockRejectedValue(
      "Alkuin can't draw \"港\" in the PDF. The page is Times, and that character isn't in the font.",
    );
    await exportOpenDocumentPdf();
    expect(useEditorNoticeStore.getState().message).toContain("can't draw");
    expect(useEditorNoticeStore.getState().message).not.toBe(EXPORT_PDF_FAILED);
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("a failed write with no sentence uses the generic notice", async () => {
    putFile(openNote());
    mockedInvoke.mockRejectedValue("");
    await exportOpenDocumentPdf();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_PDF_FAILED);
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  test("a saved pdf that cannot be opened says so", async () => {
    putFile(openNote());
    mockedOpen.mockRejectedValue("no viewer");
    await exportOpenDocumentPdf();
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_PDF_SAVED_UNOPENED);
  });

  test("a second export waits until the first dialog finishes", async () => {
    putFile(openNote());
    let release: (path: string | null) => void = () => {};
    mockedSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = exportOpenDocumentPdf();
    const second = exportOpenDocumentPdf();
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(useEditorNoticeStore.getState().message).toBe(EXPORT_PDF_BUSY);
    release("/out/Harbor.pdf");
    await first;
    await second;
    expect(mockedSave).toHaveBeenCalledTimes(1);
  });
});
