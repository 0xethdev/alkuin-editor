import type { EditorView } from "@codemirror/view";
import { useEffect } from "react";
import { filePathChange } from "@/components/editor-area/editor-reload";
import { subscribeView } from "@/features/document-share/live";
import {
  addRedlineNote,
  redlineFilePathFacet,
  redlineNotesField,
  removeRedlineNote,
} from "@/features/redline-spike/notes";
import * as tauri from "@/lib/tauri";
import { agentCardEffects } from "./cards";
import { useAgentProposalStore } from "./store";

function shows(path: string, view: EditorView): boolean {
  return view.dom.isConnected && view.state.facet(redlineFilePathFacet)() === path;
}

/**
 * Bring this view's margin in line with the suggestions waiting for the
 * document open at `path`. Which document that is comes from the folder's
 * notes, asked only when something is waiting. Each run adds what is missing
 * and removes what is gone, so runs that overlap end in the same margin.
 */
export async function paintAgentCards(
  path: string,
  view: EditorView,
  alive: () => boolean = () => true,
): Promise<void> {
  if (!shows(path, view)) return;
  let identity: tauri.HistoryDocumentIdentity | null = null;
  if (useAgentProposalStore.getState().waiting.length > 0) {
    try {
      identity = await tauri.historyDocumentIdentity(path);
    } catch {
      // Not known this time. Nothing is added, and the next run asks again.
      identity = null;
    }
    // The view may have moved on to another document while Rust answered.
    if (!alive() || !shows(path, view)) return;
  }
  const notes = view.state.field(redlineNotesField, false);
  if (!notes) return;
  // Read after the wait: a decision made meanwhile has already left the list.
  const { waiting } = useAgentProposalStore.getState();
  const { add, remove } = agentCardEffects(identity, view.state.doc.length, waiting, notes);
  if (add.length === 0 && remove.length === 0) return;
  view.dispatch({
    effects: [
      ...remove.map((id) => removeRedlineNote.of(id)),
      ...add.map((note) => addRedlineNote.of(note)),
    ],
  });
}

/**
 * Suggested additions for the open document show as margin cards. They are
 * painted when the document opens, when a pull changes what is waiting, and
 * again after a reload or a file swap rebuilds the margin. The margin keeps
 * the writer's own notes through those (`parked-notes.ts`) and not these:
 * a card from the connector is painted from the waiting list, by document.
 */
export function useAgentProposals(path: string, view: EditorView | null): void {
  useEffect(() => {
    if (!view) return;
    let alive = true;
    const repaint = () => {
      if (alive) void paintAgentCards(path, view, () => alive);
    };
    repaint();
    const unsubscribe = useAgentProposalStore.subscribe(repaint);
    const unlisten = subscribeView(view, (update) => {
      // New text from disk, or another file in this view. Not every swap carries
      // the `writer` event, so the path change is read too. A view cannot be
      // dispatched to while it is updating.
      const rebuilt = update.transactions.some(
        (tr) => tr.isUserEvent("writer") || tr.annotation(filePathChange) !== undefined,
      );
      if (rebuilt) queueMicrotask(repaint);
    });
    return () => {
      alive = false;
      unsubscribe();
      unlisten();
    };
  }, [path, view]);
}
