import { getOpenFile, getOpenFiles, type OpenFile } from "@/hooks/editor-api";
import { getFileName } from "@/lib/paths";
import { flushAllSaves } from "@/lib/save";

/** The name on the tab: the document title, or the file name when it has none. */
export function documentName(file: Pick<OpenFile, "path" | "title">): string {
  const title = file.title.trim();
  return title || getFileName(file.path);
}

/**
 * Write every dirty open document. Failed names are the documents still
 * unsaved. `flushAllSaves` looks for dirty documents again after each round
 * of writes, so a document edited while another one was being written is
 * written too (main's own loop missed it).
 */
export async function saveDirtyOpenDocuments(): Promise<string[]> {
  const before = getOpenFiles();
  const failedPaths = await flushAllSaves();
  return failedPaths.map((path) => {
    const file = getOpenFile(path) ?? before.get(path);
    return file ? documentName(file) : getFileName(path);
  });
}
