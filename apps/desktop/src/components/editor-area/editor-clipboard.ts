import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import * as editorApi from "@/hooks/editor-api";
import { parseDocument, parseFrontmatter } from "@/lib/frontmatter";
import { formatMarkdownDestination } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import { captureDocSession } from "./editor-doc-session";
import { showEditorNotice } from "./editor-notice-store";
import { focusNewFrontmatter } from "./frontmatter-panel";

const MAX_IMAGE_SIZE_MB = 5;
const MAX_IMAGE_SIZE = MAX_IMAGE_SIZE_MB * 1024 * 1024;

// `isCurrent` is captured at paste time (`captureDocSession`): the view may
// have moved on to another document of the tab while the image was read or
// saved, and the link must not land there.
async function handleImagePaste(
  file: File,
  view: EditorView,
  filePath: string,
  isCurrent: () => boolean,
) {
  const buffer = await file.arrayBuffer();
  if (!isCurrent()) return;
  if (buffer.byteLength > MAX_IMAGE_SIZE) {
    const sizeMb = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    showEditorNotice(`Image not pasted: ${sizeMb} MB is over the ${MAX_IMAGE_SIZE_MB} MB limit`);
    return;
  }

  const imageData = Array.from(new Uint8Array(buffer));
  const format = file.type.split("/")[1] || "png";
  const result = await tauri.saveClipboardImage(filePath, imageData, format);
  if (!isCurrent()) {
    console.warn(
      `[editor] Pasted image saved to ${result.relative_path}, but not linked: the document changed`,
    );
    return;
  }
  const imageMarkdown = `![${file.name}](${formatMarkdownDestination(result.relative_path)})`;
  const cursor = view.state.selection.main.head;
  view.dispatch({ changes: { from: cursor, insert: imageMarkdown } });
}

// Pasting a whole document (frontmatter + body) into a file without
// frontmatter adopts the frontmatter into the panel and inserts only the body.
function handleFrontmatterPaste(event: ClipboardEvent, view: EditorView, filePath: string) {
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return false;

  const parsedFrontmatter = parseFrontmatter(text);
  if (parsedFrontmatter.frontmatter === null) return false;

  const parsedDocument = parseDocument(text);

  const file = editorApi.getOpenFile(filePath);
  if (!file || file.frontmatter !== null) return false;

  event.preventDefault();
  editorApi.updateFrontmatter(filePath, parsedFrontmatter.frontmatter);
  if (parsedDocument.body) {
    view.dispatch(view.state.replaceSelection(parsedDocument.body));
  }
  return true;
}

// Typing `---` on the first line of a file without frontmatter opens an empty
// frontmatter panel instead of leaving a horizontal rule in the body.
function handleFrontmatterStart(event: KeyboardEvent, view: EditorView, filePath: string) {
  if (event.key !== "-") return false;

  const { doc, selection } = view.state;
  const pos = selection.main.head;
  const firstLine = doc.line(1);

  if (pos !== firstLine.from + 2) return false;
  if (firstLine.text !== "--") return false;

  const file = editorApi.getOpenFile(filePath);
  if (!file || file.frontmatter !== null) return false;

  editorApi.updateFrontmatter(filePath, "");
  view.dispatch({
    changes: { from: firstLine.from, to: firstLine.from + 2 },
  });
  event.preventDefault();
  // The new block's placeholder row doesn't focus itself (a block that is
  // already there on mount must not steal focus), so this action does.
  focusNewFrontmatter(view);
  return true;
}

/** Paste and keyboard handling that touches files: image paste to disk,
 *  frontmatter adoption on paste, and the `---` frontmatter shortcut. */
export function editorClipboardExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (handleFrontmatterPaste(event, view, getFilePath())) return true;

      const items = event.clipboardData?.items;
      if (!items) return false;

      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const imageFile = item.getAsFile();
        if (!imageFile) continue;

        event.preventDefault();
        const isCurrent = captureDocSession(view, isDisposed);
        void handleImagePaste(imageFile, view, getFilePath(), isCurrent).catch((error) => {
          console.error("[editor] Failed to paste image:", error);
        });
        return true;
      }

      return false;
    },
    keydown(event, view) {
      return handleFrontmatterStart(event, view, getFilePath());
    },
  });
}
