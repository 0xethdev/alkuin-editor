import { useCallback, useState } from "react";
import { useFrontmatter } from "@/hooks/use-frontmatter";
import {
  addFrontmatterRow,
  blurFrontmatterRow,
  blurFrontmatterText,
  deleteFrontmatterRow,
  editFrontmatterRow,
  editFrontmatterText,
  frontmatterPanelFromStore,
  type FrontmatterPanelState,
  type FrontmatterStep,
} from "./frontmatter-panel-state";

// The transitions live in `frontmatter-panel-state.ts`. This hook keeps the
// panel in sync with the store and applies the writes the transitions return.

function focusActiveEditor() {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>("[data-pane]:not(.invisible) .cm-content")?.focus();
  });
}

interface SyncedPanel {
  // The file and stored frontmatter this panel state was derived from or
  // last wrote. The pane (and so this hook) is reused when the tab navigates
  // to another file, so the path is part of the identity.
  path: string;
  source: string | null;
  panel: FrontmatterPanelState;
}

export function useFrontmatterEntries(filePath: string) {
  const { frontmatter, hasFrontmatter, updateFrontmatter, removeFrontmatter } =
    useFrontmatter(filePath);
  // `useFrontmatter` normalizes `null` → `""` for rendering convenience, so we
  // recover the null-vs-empty distinction here.
  const stored = hasFrontmatter ? frontmatter : null;

  const [synced, setSynced] = useState<SyncedPanel>(() => ({
    path: filePath,
    source: stored,
    panel: frontmatterPanelFromStore(stored),
  }));

  // Re-derive when another file shows here, or the stored YAML changes from
  // outside (disk reload, paste, the `---` shortcut). Our own writes record
  // the exact string they pushed as `source`, so they never come back here.
  let current = synced;
  if (synced.path !== filePath || synced.source !== stored) {
    current = { path: filePath, source: stored, panel: frontmatterPanelFromStore(stored) };
    setSynced(current);
  }
  const { panel, source } = current;

  // Local-only transitions (blur, add). Bail out when nothing changed so a
  // blur on a keyed row doesn't re-render the panel.
  const show = useCallback(
    (next: FrontmatterPanelState) => {
      if (next !== panel) setSynced({ path: filePath, source, panel: next });
    },
    [filePath, panel, source],
  );

  const apply = useCallback(
    ({ panel: next, write }: FrontmatterStep) => {
      switch (write.kind) {
        case "none":
          show(next);
          return;
        case "set":
          setSynced({ path: filePath, source: write.yaml, panel: next });
          updateFrontmatter(write.yaml);
          return;
        case "remove":
          setSynced({ path: filePath, source: null, panel: next });
          removeFrontmatter();
          focusActiveEditor();
          return;
      }
    },
    [filePath, show, updateFrontmatter, removeFrontmatter],
  );

  const updateEntry = useCallback(
    (index: number, field: "key" | "value", value: string) => {
      apply(editFrontmatterRow(panel, index, field, value));
    },
    [panel, apply],
  );

  const removeEntry = useCallback(
    (index: number) => {
      apply(deleteFrontmatterRow(panel, index));
    },
    [panel, apply],
  );

  const addEntry = useCallback(() => {
    show(addFrontmatterRow(panel));
  }, [panel, show]);

  // The caller filters out blurs that stay within the same row (e.g., Tab
  // from key to value) — see `FrontmatterPanel`.
  const blurEntry = useCallback(
    (index: number) => {
      show(blurFrontmatterRow(panel, index));
    },
    [panel, show],
  );

  const updateText = useCallback(
    (text: string) => {
      apply(editFrontmatterText(panel, text));
    },
    [panel, apply],
  );

  const blurText = useCallback(() => {
    show(blurFrontmatterText(panel));
  }, [panel, show]);

  return {
    panel,
    updateEntry,
    removeEntry,
    addEntry,
    blurEntry,
    updateText,
    blurText,
  };
}
