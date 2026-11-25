import { placeShareChange, type SharePassage } from "./place";

/**
 * A side-by-side conflict view. Not wired into the app.
 *
 * A passage both people changed. The owner's span in the current text,
 * and what the collaborator wanted there.
 */
export interface ConflictPlacement {
  id: string;
  /** Owner's current span start. */
  from: number;
  /** Owner's current span end. Equal to `from` when the owner deleted the words. */
  to: number;
  /** Owner's current words in that span. Empty when the owner deleted them. */
  mine: string;
  /** The collaborator's proposed words. Empty when the collaborator deleted. */
  theirs: string;
  sender: string;
}

/** An insertion carries its anchor in `original`. It never replaces owner words. */
const INSERTION = /^(ins-before|ins):\d+:/;

/**
 * Find the owner's span that replaced the passage's original, using the
 * collaborator's snapshot as the base. Returns null when the passage is
 * not a conflict (a comment, an insertion, or the original is still in the
 * owner's text) or when no span can be found honestly.
 *
 * The span comes from `placeShareChange`, which lines the snapshot up with
 * the owner's text. This does not run a second diff.
 */
export function placeConflict(owner: string, passage: SharePassage): ConflictPlacement | null {
  if (passage.proposed == null) return null;
  if (INSERTION.test(passage.original)) return null;
  // The original is still there. The normal path places it. When the sentence
  // appears twice this also holds, and the normal path breaks the tie by offset.
  if (passage.original && owner.includes(passage.original)) return null;
  const placed = placeShareChange(owner, passage);
  if (placed.kind === "replace") {
    return {
      id: placed.id,
      from: placed.from,
      to: placed.to,
      mine: placed.current,
      theirs: placed.proposed,
      sender: placed.sender,
    };
  }
  if (placed.kind === "insert") {
    // The snapshot mapped to an empty span: the owner deleted the sentence.
    // No case reaches this today. mapSnapshotSpan returns null for a deletion.
    return {
      id: placed.id,
      from: placed.at,
      to: placed.at,
      mine: "",
      theirs: placed.text,
      sender: placed.sender,
    };
  }
  return null;
}
