import { EditorView } from "@codemirror/view";
import { type Extension, Prec } from "@codemirror/state";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import * as editorApi from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { buildSlugIndex, parseDocumentHeadings } from "@/hooks/use-document-headings";
import type { DocumentHeading } from "@/hooks/use-document-headings";
import { resolveLinkTarget } from "@/lib/paths";
import { setPendingAnchor } from "@/lib/pending-anchor";
import { linkUrlAt, rawUrlAt } from "@/lib/prosemark-core/links";
import * as tauri from "@/lib/tauri";
import { referenceAnchorPos } from "@/features/redline-spike/cite-apply";
import { captureDocSession } from "./editor-doc-session";
import { findOuterScroller, scrollPosToSafeTop } from "./editor-scroll";
import { showEditorNotice } from "./editor-notice-store";

export function findHeadingBySlug(content: string, slug: string): DocumentHeading | undefined {
  return buildSlugIndex(parseDocumentHeadings(content, { maxDepth: 6, slugDepth: 6 })).get(slug);
}

function scrollSameDocAnchor(view: EditorView, filePath: string, anchor: string) {
  const live = view.state.doc.toString();
  const refAt = referenceAnchorPos(live, anchor);
  const file = editorApi.getOpenFile(filePath);
  const content = file?.content ?? live;
  const heading = refAt == null ? findHeadingBySlug(content, anchor) : undefined;
  const pos = refAt ?? heading?.pos;
  if (pos == null) {
    showEditorNotice(`Heading "#${anchor}" not found in this document`);
    return;
  }
  const scroller = findOuterScroller(view.dom);
  if (!scroller) return;
  scrollPosToSafeTop(view, scroller, pos, "smooth");
}

/** Navigate to `href` as written in the document: same-document anchors
 *  scroll, workspace files open in the tab (with a pending anchor), external
 *  URLs and other paths hand off to the OS. The target is resolved for the
 *  document showing at the click; if the view has moved on to another
 *  document (or closed) by the time it resolves, the click is dropped. */
export async function followLink(
  href: string | null,
  view: EditorView,
  filePath: string,
  isDisposed: () => boolean = () => false,
) {
  if (!href) return;
  const isCurrent = captureDocSession(view, isDisposed);

  const target = await resolveLinkTarget(href, filePath, getWorkspaceRoot(), (path) =>
    tauri.fileExists(path),
  );
  if (!target || !isCurrent()) return;

  if (target.kind === "same-doc-anchor") {
    scrollSameDocAnchor(view, filePath, target.anchor);
    return;
  }

  if (target.kind === "internal") {
    if (target.anchor && target.path === filePath) {
      scrollSameDocAnchor(view, filePath, target.anchor);
      return;
    }
    if (target.anchor) setPendingAnchor(target.path, target.anchor);
    await editorApi.navigateToFile(target.path);
    return;
  }

  if (target.kind === "external-url") {
    await openUrl(target.url);
    return;
  }

  await openPath(target.path);
}

/** Link href under a document position, whether rendered or a bare URL. */
export function linkHrefAtPos(view: EditorView, pos: number): string | null {
  return linkUrlAt(view.state, pos) ?? rawUrlAt(view.state, pos) ?? null;
}

/** Resolve the link href under a mouse event, or null if it isn't a link.
 *  Shared by the mousedown (claim the press) and click (navigate) handlers. */
function linkHrefAt(event: MouseEvent, view: EditorView): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;

  const htmlAnchor = target.closest(".cm-html-block-widget a");
  if (htmlAnchor instanceof HTMLAnchorElement) {
    return htmlAnchor.getAttribute("href");
  }

  const renderedLink = target.closest(".cm-rendered-link");
  const isRenderedLink = renderedLink !== null;
  const isRawUrl = target.closest(".cm-url") !== null;
  if (!isRenderedLink && !isRawUrl) return null;

  if (renderedLink instanceof HTMLElement && renderedLink.dataset.href) {
    return renderedLink.dataset.href;
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  return (isRenderedLink ? linkUrlAt(view.state, pos) : rawUrlAt(view.state, pos)) ?? null;
}

export function linkNavigationExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      // Claim the press on mousedown so CodeMirror doesn't move the caret
      // into the link (which would unfold a rendered link), but defer the
      // actual navigation to the click (mouseup) so it follows on release.
      mousedown(event, view) {
        if (linkHrefAt(event, view) === null) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
      click(event, view) {
        const href = linkHrefAt(event, view);
        if (href === null) return false;
        event.preventDefault();
        event.stopPropagation();
        void followLink(href, view, getFilePath(), isDisposed).catch((error) => {
          if (!isDisposed()) console.error("[editor] Failed to open link:", error);
        });
        return true;
      },
    }),
  );
}
