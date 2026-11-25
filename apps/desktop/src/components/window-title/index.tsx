import { useActiveFilePath, useActiveTab, useFileIsDirty, useFileTitle } from "@/hooks/use-tabs";
import { pageKind } from "@/components/editor-area/page-kinds";
import { APP_NAME } from "@/lib/app-name";
import { getFileName } from "@/lib/paths";
import { useWindowTitle } from "./use-window-title";

export function WindowTitle() {
  const activeTab = useActiveTab();
  const activeFilePath = useActiveFilePath();
  const fileTitle = useFileTitle(activeFilePath);
  const isDirty = useFileIsDirty(activeFilePath);

  const title = (() => {
    if (!activeTab) return APP_NAME;
    if (!activeFilePath) {
      const label = pageKind(activeTab.location).title(activeTab.location);
      return `${label} - ${APP_NAME}`;
    }
    const name = fileTitle.trim() || getFileName(activeFilePath);
    return isDirty ? `${name} (unsaved) - ${APP_NAME}` : `${name} - ${APP_NAME}`;
  })();

  useWindowTitle(title);

  return null;
}
