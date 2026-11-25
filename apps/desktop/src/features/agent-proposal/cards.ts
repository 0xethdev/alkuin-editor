import { emptyGitStatus, type RedlineNote } from "@/features/redline-spike/model";
import type { HistoryDocumentIdentity, HistoryPulledProposal } from "@/lib/tauri";

/**
 * The card for one suggested addition: an insertion at the end of the
 * document. Nobody asked on this Mac, so it has no instruction. That keeps it
 * out of the style lesson and the cite merge, which both read the instruction.
 * The empty original keeps a shared document from forwarding it before Accept.
 */
export function agentCard(docLength: number, proposal: HistoryPulledProposal): RedlineNote {
  return {
    id: `agent-${proposal.proposal_id}`,
    from: docLength,
    to: docLength,
    original: "",
    proposed: proposal.text,
    intent: "insert",
    instruction: null,
    status: "pending",
    error: null,
    git: emptyGitStatus(),
    publish: null,
    agentProposalId: proposal.proposal_id,
  };
}

/**
 * What the margin of one open document should gain and lose.
 *
 * A suggestion is for this document when its sync ids are this document's,
 * read from the folder's notes: never by path, so a card follows a rename and
 * a new file under an old name does not get it. `identity` null (never
 * synced, or not known yet) adds nothing.
 *
 * A pending card whose suggestion is waiting nowhere was decided on another
 * Mac and goes. An accepted card stays: it is the record of the Accept.
 */
export function agentCardEffects(
  identity: HistoryDocumentIdentity | null,
  docLength: number,
  waiting: readonly HistoryPulledProposal[],
  notes: readonly RedlineNote[],
): { add: RedlineNote[]; remove: string[] } {
  const shown = new Set(
    notes.map((note) => note.agentProposalId).filter((id): id is string => Boolean(id)),
  );
  const open = new Set(waiting.map((item) => item.proposal_id));
  return {
    add: identity
      ? waiting
          .filter(
            (item) =>
              item.project_id === identity.project_id &&
              item.document_id === identity.document_id &&
              !shown.has(item.proposal_id),
          )
          .map((item) => agentCard(docLength, item))
      : [],
    remove: notes
      .filter(
        (note) =>
          note.agentProposalId && note.status === "pending" && !open.has(note.agentProposalId),
      )
      .map((note) => note.id),
  };
}
