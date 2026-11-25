/**
 * Additions an AI chat suggested through the connector, as the last pull saw
 * them. They are not in any file: each is a margin card until the writer
 * accepts or rejects it. The writers are `notePulledProposals`,
 * `hideAgentProposal` and `recordAgentDecision`. The margin reads through
 * `cards.ts`.
 */

import { create } from "zustand";
import {
  showEditorNotice,
  useEditorNoticeStore,
} from "@/components/editor-area/editor-notice-store";
import { SHARE_DECIDE_FAILED } from "@/features/document-share/copy";
import { getOpenFile } from "@/hooks/editor-api";
import { getFileName } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import type { HistoryPulledProposal } from "@/lib/tauri";
import { agentArrivalLine } from "./copy";

interface AgentProposalState {
  /** The folder the last pull read. A pull of another folder replaces everything. */
  root: string | null;
  /** As Rust sent them. `path` is where the document was at that pull: it names
   *  the document in the arrival line and is never used to place a card. */
  waiting: readonly HistoryPulledProposal[];
}

export const useAgentProposalStore = create<AgentProposalState>(() => ({
  root: null,
  waiting: [],
}));

/**
 * Ids decided in this window. A pull that started before the decision was
 * recorded can still name one, and it must not paint the card again.
 */
const decidedHere = new Set<string>();
/** Decisions whose record failed. Each pull tries them again. */
const unrecorded = new Map<string, HistoryPulledProposal>();
/** Ids already announced in this window, so a folder switched back to says nothing new. */
const announced = new Set<string>();

function sameWaiting(
  a: readonly HistoryPulledProposal[],
  b: readonly HistoryPulledProposal[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        item.proposal_id === other.proposal_id &&
        item.path === other.path &&
        item.text === other.text
      );
    })
  );
}

function documentName(path: string): string {
  return getOpenFile(path)?.title.trim() || getFileName(path);
}

/** One line for suggestions not announced before. It never replaces a line that is up. */
function announce(next: readonly HistoryPulledProposal[]): void {
  const fresh = next.filter((item) => !announced.has(item.proposal_id));
  if (fresh.length === 0) return;
  if (useEditorNoticeStore.getState().toast !== null) return;
  for (const item of fresh) announced.add(item.proposal_id);
  const documents = new Set(fresh.map((item) => item.document_id));
  const names = [...documents].map((id) =>
    documentName(fresh.find((item) => item.document_id === id)?.path ?? ""),
  );
  showEditorNotice(agentArrivalLine(names));
}

/**
 * What a pull of `root` saw. `pulled` null means the pull could not say, and
 * nothing changes. A document named in `unread` (by its sync id) keeps the
 * suggestions it had. A decision that could not be recorded is tried again.
 */
export function notePulledProposals(
  root: string,
  pulled: readonly HistoryPulledProposal[] | null | undefined,
  unread: readonly string[] = [],
): void {
  for (const item of [...unrecorded.values()]) recordAgentDecision(item, { quiet: true });
  if (pulled == null) return;
  const state = useAgentProposalStore.getState();
  const before = state.root === root ? state.waiting : [];
  const kept = before.filter((item) => unread.includes(item.document_id));
  const held = new Set(kept.map((item) => item.proposal_id));
  const next = [
    ...kept,
    ...pulled.filter((item) => !decidedHere.has(item.proposal_id) && !held.has(item.proposal_id)),
  ];
  if (state.root !== root || !sameWaiting(before, next)) {
    useAgentProposalStore.setState({ root, waiting: next });
  }
  announce(next);
}

/**
 * The writer decided this card in this window. It leaves the list at once and
 * is not painted again. Nothing is recorded yet: that is `recordAgentDecision`.
 * Returns the suggestion, or null when it is not waiting (another Mac decided it).
 */
export function hideAgentProposal(proposalId: string): HistoryPulledProposal | null {
  decidedHere.add(proposalId);
  const { waiting } = useAgentProposalStore.getState();
  const item = waiting.find((each) => each.proposal_id === proposalId);
  if (!item) return null;
  useAgentProposalStore.setState({
    waiting: waiting.filter((each) => each.proposal_id !== proposalId),
  });
  return item;
}

/**
 * Record the decision so the card does not come back after a relaunch. Rust
 * writes it to a queue and sends it when it can, so this works offline. It is
 * not awaited. A record that fails is kept and tried again by the next pull.
 */
export function recordAgentDecision(
  item: HistoryPulledProposal,
  options: { quiet?: boolean } = {},
): void {
  void tauri.historyProposalDecide(item.project_id, item.document_id, item.proposal_id).then(
    () => {
      unrecorded.delete(item.proposal_id);
    },
    () => {
      unrecorded.set(item.proposal_id, item);
      if (!options.quiet) showEditorNotice(SHARE_DECIDE_FAILED);
    },
  );
}

/** Reject: nothing has to reach the disk first, so the decision is recorded at once. */
export function settleAgentProposal(proposalId: string): void {
  const item = hideAgentProposal(proposalId);
  if (item) recordAgentDecision(item);
}

/** Test-only. A launch starts with nothing waiting, decided, or announced. */
export function resetAgentProposals(): void {
  decidedHere.clear();
  unrecorded.clear();
  announced.clear();
  useAgentProposalStore.setState({ root: null, waiting: [] });
}
