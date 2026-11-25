import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { getActiveFilePath, getOpenFile } from "@/hooks/editor-api";
import { errorSentence } from "@/lib/office-exchange";
import { getFileName, getFileStem } from "@/lib/paths";
import * as tauri from "@/lib/tauri";

export const EXPORT_PDF_NEEDS_DOC = "Open a document to export a PDF.";
export const EXPORT_PDF_FAILED = "Alkuin couldn't export that PDF.";
export const EXPORT_PDF_SAVED_UNOPENED = "The PDF was saved, but Alkuin couldn't open it.";
export const EXPORT_PDF_BUSY = "Alkuin is still exporting the last PDF.";

let exporting = false;

/** Save dialog default: the note's name beside it, with a `.pdf` extension. */
export function pdfDefaultPath(markdownPath: string): string {
  const name = getFileName(markdownPath);
  const dir = markdownPath.slice(0, markdownPath.length - name.length);
  const stem = getFileStem(markdownPath);
  const base = stem.length > 0 ? stem : "document";
  return `${dir}${base}.pdf`;
}

export function withPdfExtension(path: string): string {
  return path.toLowerCase().endsWith(".pdf") ? path : `${path}.pdf`;
}

/** File → Export PDF… for the document that is open. The body is the editor
 * buffer, so unsaved edits are included and the frontmatter is not. */
export async function exportOpenDocumentPdf(): Promise<void> {
  if (exporting) {
    showEditorNotice(EXPORT_PDF_BUSY);
    return;
  }
  exporting = true;
  try {
    const path = getActiveFilePath();
    const file = path ? getOpenFile(path) : null;
    if (!file || file.isLoading) {
      showEditorNotice(EXPORT_PDF_NEEDS_DOC);
      return;
    }
    const chosen = await save({
      title: "Export PDF",
      defaultPath: pdfDefaultPath(file.path),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!chosen) return;
    const dest = withPdfExtension(chosen);
    try {
      await tauri.exportPdf(dest, file.title, file.content, file.path);
    } catch (error) {
      showEditorNotice(errorSentence(error, EXPORT_PDF_FAILED));
      return;
    }
    try {
      await openPath(dest);
    } catch {
      showEditorNotice(EXPORT_PDF_SAVED_UNOPENED);
    }
  } finally {
    exporting = false;
  }
}
