import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { getActiveFilePath, getOpenFile, openFile, reloadFromDisk } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { getFileName, getFileStem } from "@/lib/paths";
import { quiesceSave, resumeSave } from "@/lib/save";
import * as tauri from "@/lib/tauri";

/**
 * The Google Docs link dialog. `session` names one opening of the dialog, so
 * an import's result can only land on the opening that started it.
 * - closed
 * - editing: the link field; `error` is the last import's failure
 * - importing: the download and the save dialog are on their way. Escape and
 *   Cancel do nothing, and the menu cannot start a second import.
 */
export type GoogleDocImportPhase =
  | { kind: "closed" }
  | { kind: "editing"; session: number; error: string | null }
  | { kind: "importing"; session: number };

interface GoogleDocImportState {
  phase: GoogleDocImportPhase;
  openDialog: () => void;
  /** Escape and Cancel. Ignored while an import is on its way. */
  closeDialog: () => void;
  clearError: () => void;
  submit: (url: string) => Promise<void>;
}

const GOOGLE_DOC_DOWNLOAD_FAILED = "Alkuin couldn't download that Google Doc.";

let importSession = 0;

export const useGoogleDocImportStore = create<GoogleDocImportState>((set, get) => ({
  phase: { kind: "closed" },
  openDialog: () => {
    if (get().phase.kind !== "closed") return;
    importSession += 1;
    set({ phase: { kind: "editing", session: importSession, error: null } });
  },
  closeDialog: () => {
    if (get().phase.kind === "importing") return;
    set({ phase: { kind: "closed" } });
  },
  clearError: () => {
    const phase = get().phase;
    if (phase.kind !== "editing" || phase.error === null) return;
    set({ phase: { ...phase, error: null } });
  },
  submit: async (url: string) => {
    const phase = get().phase;
    const link = url.trim();
    if (phase.kind !== "editing" || !link) return;
    const session = phase.session;
    set({ phase: { kind: "importing", session } });

    let next: GoogleDocImportPhase;
    try {
      const result = await importGoogleDoc(link);
      next =
        result === "saved"
          ? { kind: "closed" }
          : { kind: "editing", session, error: result === "busy" ? OFFICE_BUSY : null };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : GOOGLE_DOC_DOWNLOAD_FAILED;
      next = { kind: "editing", session, error };
    }
    const current = get().phase;
    if (current.kind === "importing" && current.session === session) set({ phase: next });
  },
}));

export function openGoogleDocImport() {
  useGoogleDocImportStore.getState().openDialog();
}

export function isGoogleDocImportOpen(state: Pick<GoogleDocImportState, "phase">): boolean {
  return state.phase.kind !== "closed";
}

export const IMPORT_SAVE_FAILED = "Alkuin couldn't save that document.";
export const IMPORT_OPEN_FAILED = "The document was saved, but Alkuin couldn't open it.";
export const IMPORT_UNSAVED = "That note has unsaved edits. Pick another name.";
export const IMPORT_NEEDS_OTHER = "Pick a different file from the Word document.";
export const EXPORT_DOCX_NEEDS_DOC = "Open a document to export.";
export const EXPORT_DOCX_FAILED = "Alkuin couldn't export that Word file.";
export const EXPORT_DOCX_SAVED_UNOPENED = "The Word file was saved, but Alkuin couldn't open it.";
export const EXPORT_GOOGLE_BROWSER_FAILED =
  "The Word file was saved, but Alkuin couldn't open Google Drive.";
export const OFFICE_BUSY = "Alkuin is still finishing the last import or export.";

/** shortcut: upload is the writer's step in Drive. Upgrade when the app has a Google client id. */
export const GOOGLE_DRIVE_URL = "https://drive.google.com/drive/my-drive";

let officeBusy = false;

export function markdownBeside(sourcePath: string): string {
  const name = getFileName(sourcePath);
  const dir = sourcePath.slice(0, sourcePath.length - name.length);
  const stem = getFileStem(sourcePath);
  const base = stem.length > 0 ? stem : "Imported";
  return `${dir}${base}.md`;
}

export function withMarkdownExtension(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return path;
  if (lower.endsWith(".docx")) return `${path.slice(0, path.length - 5)}.md`;
  return `${path}.md`;
}

export function withDocxExtension(path: string): string {
  return path.toLowerCase().endsWith(".docx") ? path : `${path}.docx`;
}

export function docxDefaultPath(markdownPath: string): string {
  const name = getFileName(markdownPath);
  const dir = markdownPath.slice(0, markdownPath.length - name.length);
  const stem = getFileStem(markdownPath);
  const base = stem.length > 0 ? stem : "document";
  return `${dir}${base}.docx`;
}

/** First heading, or `fallback` when the note has none. */
export function importedNoteStem(markdown: string, fallback: string): string {
  for (const raw of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw.trim());
    if (!match) continue;
    const text = match[2]
      .replace(/\\([\\*`_~[])/g, "$1")
      .replace(/[*`_~]/g, "")
      .replace(/[\\/:*?"<>|]/g, "")
      .trim()
      .slice(0, 80)
      .trim();
    if (text) return text;
  }
  return fallback;
}

export function importedNotePath(stem: string): string {
  const root = getWorkspaceRoot();
  if (root) {
    const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    return `${root.replace(/[/\\]+$/, "")}${sep}${stem}.md`;
  }
  const active = getActiveFilePath();
  if (active) {
    const name = getFileName(active);
    const dir = active.slice(0, active.length - name.length);
    return `${dir}${stem}.md`;
  }
  return `${stem}.md`;
}

export function googleExportNotice(fileName: string, revealed: boolean): string {
  if (revealed) {
    return `Saved ${fileName}. Drag it into Google Drive, then open it with Google Docs. Alkuin does not sign in to Google.`;
  }
  return `Saved ${fileName}. Upload it in Google Drive, then open it with Google Docs. Alkuin does not sign in to Google.`;
}

function onePath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function errorSentence(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

/** Write the import over `dest`, with its autosave held. An open note takes the
 *  new text only if it is still clean; words typed meanwhile are kept. */
async function replaceNoteOnDisk(dest: string, markdown: string): Promise<boolean> {
  if (!(await tauri.fileExists(dest))) {
    try {
      await tauri.createFile(dest);
    } catch (error) {
      if (!(await tauri.fileExists(dest))) {
        showEditorNotice(errorSentence(error, IMPORT_SAVE_FAILED));
        return false;
      }
    }
  }
  const before = getOpenFile(dest);
  if (before?.isDirty) {
    showEditorNotice(IMPORT_UNSAVED);
    return false;
  }
  try {
    await tauri.writeFile(dest, markdown);
  } catch (error) {
    showEditorNotice(errorSentence(error, IMPORT_SAVE_FAILED));
    return false;
  }
  const loaded = getOpenFile(dest);
  if (!loaded || loaded.isLoading) return true;
  const replaced = reloadFromDisk(dest, markdown, {
    policy: "if-clean",
    expectedDisk: before?.diskContent,
  });
  if (!replaced) {
    // Typed while the import was written. Those words win when saving resumes.
    showEditorNotice(IMPORT_UNSAVED);
    return false;
  }
  return true;
}

async function writeMarkdownNote(dest: string, markdown: string): Promise<boolean> {
  if (getOpenFile(dest)?.isDirty) {
    showEditorNotice(IMPORT_UNSAVED);
    return false;
  }
  // Autosave must not write an open note while the import replaces it.
  try {
    await quiesceSave(dest);
  } catch (error) {
    showEditorNotice(errorSentence(error, IMPORT_SAVE_FAILED));
    return false;
  }
  try {
    if (!(await replaceNoteOnDisk(dest, markdown))) return false;
  } finally {
    resumeSave(dest);
  }
  await openFile(dest);
  const opened = getOpenFile(dest);
  if (!opened || opened.isLoading) showEditorNotice(IMPORT_OPEN_FAILED);
  return true;
}

async function saveImportedMarkdown(
  markdown: string,
  defaultPath: string,
  source?: string,
): Promise<boolean> {
  const chosen = onePath(
    await save({
      title: "Import into Alkuin",
      defaultPath,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    }),
  );
  if (!chosen) return false;
  const dest = withMarkdownExtension(chosen);
  if (source && dest === source) {
    showEditorNotice(IMPORT_NEEDS_OTHER);
    return false;
  }
  return writeMarkdownNote(dest, markdown);
}

/** File → Import Word… */
export async function importWordDocument(): Promise<void> {
  if (officeBusy) {
    showEditorNotice(OFFICE_BUSY);
    return;
  }
  officeBusy = true;
  try {
    const source = onePath(
      await open({
        directory: false,
        multiple: false,
        title: "Import Word",
        filters: [{ name: "Word", extensions: ["docx"] }],
      }),
    );
    if (!source) return;
    let markdown: string;
    try {
      markdown = await tauri.docxToMarkdown(source);
    } catch (error) {
      showEditorNotice(errorSentence(error, "Alkuin couldn't read that Word file."));
      return;
    }
    await saveImportedMarkdown(markdown, markdownBeside(source), source);
  } finally {
    officeBusy = false;
  }
}

/**
 * File → Import Google Docs… The dialog collects the link, then this runs.
 * `busy`: another import or export is still running, so nothing was done.
 */
export async function importGoogleDoc(url: string): Promise<"saved" | "cancelled" | "busy"> {
  if (officeBusy) return "busy";
  officeBusy = true;
  try {
    let markdown: string;
    try {
      markdown = await tauri.googleDocToMarkdown(url.trim());
    } catch (error) {
      throw new Error(errorSentence(error, GOOGLE_DOC_DOWNLOAD_FAILED));
    }
    const wrote = await saveImportedMarkdown(
      markdown,
      importedNotePath(importedNoteStem(markdown, "Google Doc")),
    );
    return wrote ? "saved" : "cancelled";
  } finally {
    officeBusy = false;
  }
}

async function exportBody(kind: "word" | "google"): Promise<void> {
  if (officeBusy) {
    showEditorNotice(OFFICE_BUSY);
    return;
  }
  officeBusy = true;
  try {
    const path = getActiveFilePath();
    const file = path ? getOpenFile(path) : null;
    if (!file || file.isLoading) {
      showEditorNotice(EXPORT_DOCX_NEEDS_DOC);
      return;
    }
    const chosen = onePath(
      await save({
        title: kind === "word" ? "Export Word" : "Export Google Docs",
        defaultPath: docxDefaultPath(file.path),
        filters: [{ name: "Word", extensions: ["docx"] }],
      }),
    );
    if (!chosen) return;
    const dest = withDocxExtension(chosen);
    try {
      await tauri.exportDocx(dest, file.title, file.content, file.path);
    } catch (error) {
      showEditorNotice(errorSentence(error, EXPORT_DOCX_FAILED));
      return;
    }
    if (kind === "word") {
      try {
        await openPath(dest);
      } catch {
        showEditorNotice(EXPORT_DOCX_SAVED_UNOPENED);
      }
      return;
    }
    let revealed = false;
    try {
      await tauri.revealInFileManager(dest);
      revealed = true;
    } catch {
      revealed = false;
    }
    const name = getFileName(dest);
    try {
      await openUrl(GOOGLE_DRIVE_URL);
    } catch {
      showEditorNotice(EXPORT_GOOGLE_BROWSER_FAILED, { sticky: true });
      return;
    }
    showEditorNotice(googleExportNotice(revealed ? name : dest, revealed), { sticky: true });
  } finally {
    officeBusy = false;
  }
}

export function exportOpenDocumentDocx(): Promise<void> {
  return exportBody("word");
}

export function exportOpenDocumentGoogleDoc(): Promise<void> {
  return exportBody("google");
}
