import { useEditorStore } from "@/stores/editor-store";

/** Whether the file has a frontmatter block, so its properties panel shows.
 *  A boolean selector: edits to the block don't re-render the caller. */
export function useHasFrontmatter(filePath: string) {
  return useEditorStore((s) => s.openFiles.get(filePath)?.frontmatter != null);
}

export function useFrontmatter(filePath: string | null) {
  const frontmatter = useEditorStore(
    (s) => (filePath ? s.openFiles.get(filePath)?.frontmatter : undefined) ?? null,
  );
  const updateFrontmatter = useEditorStore((s) => s.updateFrontmatter);

  return {
    frontmatter: frontmatter ?? "",
    hasFrontmatter: frontmatter !== null,
    updateFrontmatter: (value: string) => {
      if (!filePath) return;
      updateFrontmatter(filePath, value);
    },
    removeFrontmatter: () => {
      if (!filePath) return;
      updateFrontmatter(filePath, null);
    },
  };
}
