import { useRef, useCallback, useEffect } from "react";
import { EditorView } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { captureDocSession, startNextDocSession } from "./editor-doc-session";
import {
  filePathChange,
  pathChangeKind,
  planEditorSwap,
  reloadEditorChange,
  swapSelectionChange,
} from "./editor-reload";
import { history } from "@codemirror/commands";
import { closeEditorSearch } from "./editor-search-store";
import { findOuterScroller, scrollPosToSafeTop } from "./editor-scroll";
import { createEditorExtensions } from "./editor-extensions";
import { findHeadingBySlug } from "./link-navigation";
import { advanceViewportParse } from "./viewport-parse";
import { clampSelectionToHeadings } from "./heading-decorations";
import * as editorApi from "@/hooks/editor-api";
import { useReloadVersion } from "@/hooks/use-tabs";
import { getFileName } from "@/lib/paths";
import { consumePendingAnchor } from "@/lib/pending-anchor";
import { logTimeline, mark } from "@/lib/startup-metrics";
import { showEditorNotice } from "./editor-notice-store";

function resolveScrollContainer(root: HTMLElement, getScrollContainer?: () => HTMLElement | null) {
  return getScrollContainer?.() ?? findOuterScroller(root);
}

function restoreCursorPosition(view: EditorView, cursorPos: number) {
  // Always dispatch a selection — even a no-op anchor: 0 — so the
  // `headingSelectionGuard` transactionFilter sees the initial selection and
  // clamps it out of any no-go zone (e.g., a doc that starts with a heading
  // would otherwise render the caret at lineFrom, which is the start of the
  // hash chars). `EditorState.create`'s default selection is at position 0
  // and isn't a transaction, so the filter never fires for it.
  let pos: number;
  if (cursorPos > 0) {
    pos = Math.min(cursorPos, view.state.doc.length);
  } else if (view.state.doc.toString() === "# ") {
    // New-file template from create_file_impl is "# "; land caret after it so the user can type the title immediately.
    pos = 2;
  } else {
    pos = 0;
  }
  view.dispatch({ selection: { anchor: pos } });
}

/** Bring a document that just started showing in `view` into position: its
 *  pending heading anchor (a cross-document link), or its saved scroll.
 *
 *  Everything happens in the next frame, after `isCurrent` confirms the view
 *  still shows this document. The anchor is consumed there too, not here: a
 *  view thrown away before its frame (React StrictMode mounts the ref twice,
 *  or the tab moved on) must leave the anchor for the view that replaces it. */
export function restoreDocumentViewport(
  view: EditorView,
  scrollContainer: HTMLElement,
  path: string,
  scrollPos: number,
  isCurrent: () => boolean,
) {
  requestAnimationFrame(() => {
    if (!isCurrent()) return;
    const pendingAnchor = consumePendingAnchor(path);
    if (pendingAnchor === undefined) {
      // Always apply the saved scroll so a new file can reset a reused
      // container back to the top.
      scrollContainer.scrollTo(0, Math.max(0, scrollPos));
      return;
    }
    const heading = findHeadingBySlug(view.state.doc.toString(), pendingAnchor);
    if (heading) {
      scrollPosToSafeTop(view, scrollContainer, heading.pos, "auto");
    } else {
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      showEditorNotice(`Heading "#${pendingAnchor}" not found in ${getFileName(path)}`);
    }
  });
}

export function useProsemarkEditor(
  filePath: string,
  getScrollContainer?: () => HTMLElement | null,
  autoFocus = false,
  onViewChange?: (view: EditorView | null) => void,
) {
  const viewRef = useRef<EditorView | null>(null);
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const filePathRef = useRef(filePath);
  // getScrollContainer is captured into a ref only to resolve a DOM scroll container, not invoked as a callback from an effect.
  // eslint-disable-next-line react-doctor/no-event-handler
  const getScrollContainerRef = useRef(getScrollContainer);
  const autoFocusRef = useRef(autoFocus);
  const onViewChangeRef = useRef(onViewChange);
  const prevPathRef = useRef<string | null>(null);
  const prevReloadVersionRef = useRef<number>(0);
  const historyCompartmentRef = useRef<Compartment | null>(null);
  if (!historyCompartmentRef.current) historyCompartmentRef.current = new Compartment();

  const reloadVersion = useReloadVersion(filePath);

  // Keep refs in sync for use by closures and the swap effect.
  filePathRef.current = filePath;
  getScrollContainerRef.current = getScrollContainer;
  autoFocusRef.current = autoFocus;
  onViewChangeRef.current = onViewChange;

  // Stable ref callback — only handles mount/unmount.
  const mountRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      disposedRef.current = true;
      scrollCleanupRef.current?.();
      scrollCleanupRef.current = null;
      const view = viewRef.current;
      if (view) {
        closeEditorSearch({ view });
        view.destroy();
      }
      viewRef.current = null;
      onViewChangeRef.current?.(null);
      return;
    }

    if (viewRef.current) return;

    disposedRef.current = false;

    const currentPath = filePathRef.current;
    const file = editorApi.getOpenFile(currentPath);
    const initialContent = file?.content ?? "";

    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: initialContent,
        extensions: createEditorExtensions(
          () => filePathRef.current,
          () => disposedRef.current,
          historyCompartmentRef.current!,
        ),
      }),
    });

    viewRef.current = view;
    prevPathRef.current = currentPath;
    prevReloadVersionRef.current = file?.reloadVersion ?? 0;
    onViewChangeRef.current?.(view);

    mark("editor-ready");
    logTimeline();

    // Deferred work for this view stops once it is no longer the hook's view.
    // `disposedRef` alone isn't enough: StrictMode mounts the ref twice, and
    // the remount resets it while the first view's frames are still queued.
    const isGone = () => disposedRef.current || viewRef.current !== view;

    advanceViewportParse(view, isGone);

    restoreCursorPosition(view, file?.cursorPos ?? 0);
    clampSelectionToHeadings(view);

    const scrollContainer = resolveScrollContainer(el, getScrollContainerRef.current);
    if (scrollContainer) {
      // A cross-document link to a file that wasn't loaded yet lands here
      // (the pane shows a spinner, then mounts a fresh view), so the pending
      // anchor is consumed on mount as well as on swap.
      restoreDocumentViewport(
        view,
        scrollContainer,
        currentPath,
        file?.scrollPos ?? 0,
        captureDocSession(view, isGone),
      );

      const handleScroll = () => {
        editorApi.updateScrollPos(filePathRef.current, scrollContainer.scrollTop);
      };
      scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
      scrollCleanupRef.current = () => scrollContainer.removeEventListener("scroll", handleScroll);
    }

    if (autoFocusRef.current) view.focus();
  }, []);

  // Detect path or reload-version changes and swap the document in place.
  // Syncs the external CodeMirror EditorView to filePath/reloadVersion changes (tab switch / external reload); there is no DOM handler to host it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || disposedRef.current) return;

    // eslint-disable-next-line react-doctor/no-event-handler
    const pathChanged = filePath !== prevPathRef.current;
    const reloaded = !pathChanged && reloadVersion !== prevReloadVersionRef.current;

    if (!pathChanged && !reloaded) return;

    const file = editorApi.getOpenFile(filePath);
    const content = file?.content ?? "";
    const live = view.state.doc.toString();
    const liveHead = view.state.selection.main.head;
    const previousPath = prevPathRef.current;
    const previousStillOpen = previousPath != null && editorApi.getOpenFile(previousPath) != null;
    const plan = planEditorSwap({
      pathChanged,
      previousStillOpen,
      live,
      liveHead,
      incoming: content,
      incomingCursorPos: file?.cursorPos ?? 0,
    });
    // Margin notes belong to a file, so a path change says which file this view left and
    // whether the buffer is still that file under a new name (`docs/editor.md`).
    const pathChange = pathChanged
      ? {
          from: previousPath,
          to: filePath,
          kind: pathChangeKind({
            previousStillOpen,
            replace: plan.kind === "load" && plan.replace,
            live,
            incoming: content,
          }),
        }
      : undefined;

    prevPathRef.current = filePath;
    prevReloadVersionRef.current = reloadVersion;

    // A rename of this buffer (or a reload that is already identical) keeps
    // the editor and its history. Only a rename can differ here: keystrokes
    // typed while it moved the store entry extend the moved text, and the new
    // path takes them.
    if (plan.kind === "adopt") {
      if (content !== live) {
        editorApi.updateContent(filePath, live);
        editorApi.updateCursorPos(filePath, liveHead);
      }
      // Nothing else is dispatched for a rename, so the notes are told on their own.
      if (pathChange) view.dispatch({ annotations: filePathChange.of(pathChange) });
      return;
    }

    if (plan.resetHistory) {
      // Reset undo history per file. Removing the history compartment discards
      // its state field; re-adding initializes it fresh. Only history is in the
      // compartment, so the language state and every decoration field survive
      // and the swap doesn't flash raw markdown the way a full view.setState
      // would.
      const historyCompartment = historyCompartmentRef.current!;
      view.dispatch({ effects: historyCompartment.reconfigure([]) });
      view.dispatch({ effects: historyCompartment.reconfigure(history()) });
    }

    // A different document gets a new session even when its text equals the
    // live text, so deferred work for the old one drops itself.
    const load = plan.replace
      ? reloadEditorChange(
          view.state.doc.length,
          plan.cursorPos,
          content,
          pathChanged ? "writer.swap" : "writer.reload",
          pathChange,
        )
      : swapSelectionChange(plan.cursorPos, view.state.doc.length, pathChange);
    view.dispatch({ ...load, effects: plan.newDocument ? startNextDocSession() : [] });

    if (pathChanged) {
      const scrollContainer = resolveScrollContainer(
        view.dom.parentElement!,
        getScrollContainerRef.current,
      );
      if (scrollContainer) {
        restoreDocumentViewport(
          view,
          scrollContainer,
          filePath,
          file?.scrollPos ?? 0,
          captureDocSession(view, () => disposedRef.current || viewRef.current !== view),
        );
      }
    }

    advanceViewportParse(view, () => disposedRef.current);
    clampSelectionToHeadings(view);
  }, [filePath, reloadVersion]);

  return mountRef;
}
