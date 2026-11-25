import type { EditorView } from "@codemirror/view";
import { redlineNotesField, setNoteThread } from "@/features/redline-spike/notes";
import * as tauri from "@/lib/tauri";
import { noteThreadId, threadPatch } from "./thread";

/** Paint "You were mentioned" and replies the server is still holding open.
 * The document id is the share's id, including when this file is a copy.
 * A row names its thread by `noteThreadId`, the id both Macs derive for the
 * same comment. Only cards whose thread changed are dispatched. */
export async function refreshOpenMentions(path: string, view: EditorView): Promise<void> {
  if (!view.dom.isConnected) return;
  let documentId = "";
  try {
    const role = await tauri.shareRole(path);
    documentId = role.document_id;
  } catch {
    const keys = await tauri.mentionDocumentIds([path]);
    documentId = keys[0]?.document_id ?? "";
  }
  if (!documentId || !view.dom.isConnected) return;
  const open = await tauri.mentionOpen();
  if (!view.dom.isConnected) return;
  const mine = open.filter((row) => row.document_id === documentId);
  const notes = view.state.field(redlineNotesField, false) ?? [];
  const effects = [];
  for (const note of notes) {
    const thread = noteThreadId(note);
    if (!thread) continue;
    const patch = threadPatch(
      note,
      thread,
      mine.filter((row) => row.note_id === thread),
    );
    if (patch) effects.push(setNoteThread.of(patch));
  }
  if (effects.length > 0) view.dispatch({ effects });
}
