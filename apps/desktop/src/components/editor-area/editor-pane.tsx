import type { EditorView } from "@codemirror/view";
import { ProseMarkEditor } from "./prosemark-editor";
import { FrontmatterPanel } from "./frontmatter-panel";
import { EditorScrollContainer } from "./editor-scroll-container";
import { EditorSearchOverview } from "./editor-search-overview";
import { SectionRail } from "./section-rail";
import { useCloseEditorSearchWhenInactive } from "./use-close-editor-search-when-inactive";
import { useAgentProposals } from "@/features/agent-proposal/desk";
import { useShareLive } from "@/features/document-share/live";
import { useHasFrontmatter } from "@/hooks/use-frontmatter";
import { useIsFileReady } from "@/hooks/use-tabs";
import { memo, useCallback, useEffect, useRef, useState } from "react";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function AsciiSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <span>{SPINNER_FRAMES[frame]}</span>;
}

interface EditorPaneProps {
  path: string;
  isActive: boolean;
}

export const EditorPane = memo(function EditorPane({ path, isActive }: EditorPaneProps) {
  const isReady = useIsFileReady(path);
  const hasFrontmatter = useHasFrontmatter(path);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  useCloseEditorSearchWhenInactive(isActive);
  useShareLive(path, isActive ? editorView : null);
  useAgentProposals(path, isActive ? editorView : null);

  const getScrollContainer = useCallback(() => scrollContainerRef.current, []);

  if (!isReady) {
    return (
      <div
        className={
          isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none"
        }
      >
        <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">
          <AsciiSpinner />
        </div>
      </div>
    );
  }

  return (
    <div
      data-pane
      // The top gap sits above the properties when there are any (prosemark-theme.css).
      data-has-frontmatter={hasFrontmatter || undefined}
      className={
        isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none"
      }
    >
      <EditorScrollContainer ref={scrollContainerRef}>
        {/* The draft's column. Its pads come from prosemark-theme.css and, with notes
            showing, redline-spike.css. */}
        <div data-properties-column>
          <FrontmatterPanel filePath={path} />
        </div>
        <ProseMarkEditor
          filePath={path}
          getScrollContainer={getScrollContainer}
          autoFocus={isActive}
          onViewChange={setEditorView}
        />
      </EditorScrollContainer>
      <SectionRail filePath={path} view={editorView} scrollContainerRef={scrollContainerRef} />
      {isActive && <EditorSearchOverview scrollContainerRef={scrollContainerRef} />}
    </div>
  );
});
