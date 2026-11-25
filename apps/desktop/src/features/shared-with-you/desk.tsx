import { SidebarSection } from "@/components/sidebar/sidebar-section";
import {
  TOMBSTONE_REMOVED_BY_OWNER,
  RESTORE_CONFIRM,
  SHARED_REMOVE,
} from "@/features/document-removal/copy";
import { SHARED_EMPTY, SHARED_EMPTY_NEXT, SHARED_WITH_YOU, WAITING, waitingCount } from "./copy";
import { showsDot } from "./marks";
import "./shared.css";

export interface SharedRow {
  id: string;
  title: string;
  owner: string;
  open: number;
  pending?: boolean;
  removed?: boolean;
}

export interface RestoreItem {
  document_id: string;
  title: string;
}

export function MentionDot() {
  return <span className="mention-dot" role="img" title={WAITING} aria-label={WAITING} />;
}

export function MentionCount({ n }: { n: number }) {
  if (!showsDot(n)) return null;
  const label = waitingCount(n);
  return (
    <span className="mention-count" role="img" title={label} aria-label={label}>
      {n}
    </span>
  );
}

function RowCopy({ title, owner }: { title: string; owner: string }) {
  return (
    <span className="shared-copy">
      <span className="shared-title">{title}</span>
      {owner ? <span className="shared-owner">{owner}</span> : null}
    </span>
  );
}

export function SharedWithYou({
  rows,
  restore,
  count,
  onOpen,
  onAnswer,
  onLeave,
  onRestore,
}: {
  rows: readonly SharedRow[];
  restore: readonly RestoreItem[];
  count: number;
  onOpen: (id: string) => void;
  onAnswer: (id: string, accept: boolean) => void;
  onLeave: (id: string) => void;
  onRestore: (documentId: string) => void;
}) {
  return (
    <>
      {restore.length > 0 ? (
        <SidebarSection title={RESTORE_CONFIRM}>
          <div className="flex flex-col gap-px">
            {restore.map((row) => (
              <div key={row.document_id} className="shared-row">
                <span className="shared-copy">
                  <span className="shared-title">{row.title}</span>
                </span>
                <button
                  type="button"
                  className="shared-action"
                  onClick={() => onRestore(row.document_id)}
                >
                  {RESTORE_CONFIRM}
                </button>
              </div>
            ))}
          </div>
        </SidebarSection>
      ) : null}
      <SidebarSection title={SHARED_WITH_YOU} aside={<MentionCount n={count} />}>
        {rows.length === 0 ? (
          <p className="shared-empty">
            {SHARED_EMPTY}
            <span className="shared-empty-next">{SHARED_EMPTY_NEXT}</span>
          </p>
        ) : (
          <div className="flex flex-col gap-px">
            {rows.map((row) =>
              row.removed ? (
                <div key={row.id} className="shared-row">
                  <span className="shared-copy">
                    <span className="shared-title">{row.title}</span>
                    <span className="shared-owner">{TOMBSTONE_REMOVED_BY_OWNER}</span>
                  </span>
                  <button type="button" className="shared-action" onClick={() => onLeave(row.id)}>
                    {SHARED_REMOVE}
                  </button>
                </div>
              ) : row.pending ? (
                <div key={row.id} className="shared-row">
                  <RowCopy title={row.title} owner={row.owner} />
                  <span className="shared-actions">
                    <button
                      type="button"
                      className="shared-action"
                      onClick={() => onAnswer(row.id, true)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="shared-action"
                      onClick={() => onAnswer(row.id, false)}
                    >
                      Decline
                    </button>
                  </span>
                </div>
              ) : (
                <div key={row.id} className="shared-row">
                  <button type="button" className="shared-open" onClick={() => onOpen(row.id)}>
                    <RowCopy title={row.title} owner={row.owner} />
                    {showsDot(row.open) ? <MentionDot /> : null}
                  </button>
                  <button type="button" className="shared-action" onClick={() => onLeave(row.id)}>
                    {SHARED_REMOVE}
                  </button>
                </div>
              ),
            )}
          </div>
        )}
      </SidebarSection>
    </>
  );
}
