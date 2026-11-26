# Editor Notes

Patterns and gotchas for the CodeMirror editor in `apps/desktop/src/components/editor-area/`. Each rule earned its place by costing real time. Apply them when extending or reviewing editor code.

## Use the layout model, not the rendered DOM, for positions

Prefer:

- `view.lineBlockAt(pos)` → `BlockInfo` with `top`/`bottom`/`height` in document coordinates.
- `view.documentTop` → screen y of the first line.

Over:

- `view.coordsAtPos(pos)` → can return `null` for positions outside the rendered viewport. CodeMirror only measures lines that are currently virtualized into the DOM; matches further down the document have no `Rect` until they scroll into view.
- `view.contentDOM.getBoundingClientRect()` → affected by virtualization padding and async layout.

Match screen position, valid for any document position:

```ts
const block = view.lineBlockAt(pos);
const matchScreenY = view.documentTop + block.top;
```

`coordsAtPos` returning `null` is a silent failure: a `scrollHandler` that returns `false` falls back to CodeMirror's default scroll, which doesn't know about app-level fades, masks, or other ancestor overlays. If you only test in-viewport cases, the bug ships.

## Choose the right scroll API for who owns the scroll container

CodeMirror's built-in scroll APIs assume the editor owns its scroll container (`view.scrollDOM`, by default `.cm-scroller`):

- `search()` config's `scrollToMatch` — customize the scroll effect for findNext/findPrevious.
- `EditorView.scrollMargins` facet — declare top/bottom/left/right regions of the scroll container that should be treated as off-screen (e.g. for a fixed gutter or fade).

These are correct when `view.scrollDOM` is the actual scrolling element.

In Writer's editor, `.cm-scroller` has `overflow: visible !important` (see `prosemark-theme.css`) and the surrounding `EditorScrollContainer` is the real scroller. CodeMirror's default scroll walks up to scroll ancestors generically, but `scrollMargins` only applies to `view.scrollDOM`'s computation — so the match can still land under the outer container's fade.

When the scrollable element is an ancestor:

- Use `EditorView.scrollHandler.of(...)` to take over scrolling.
- Find the ancestor scroller by walking `view.dom.parentElement` for the first element with `overflowY: auto | scroll`.
- Scroll it yourself with `scroller.scrollTo({ top, behavior: "auto" })`. `behavior: "smooth"` is async and gets interrupted by rapid keystrokes (e.g. Cmd+G held down).
- Account for `clientTop` if the ancestor has a border (Writer's container has a 12px transparent border-top to give the mask gradient room).

Reference: `EditorView.scrollHandler.of((view, range) => …)` in `apps/desktop/src/components/editor-area/use-prosemark-editor.ts`.

The draft column is `.cm-editor > .cm-scroller > .cm-content`: left-aligned, `--writer-column-pad-left` (75px) on the left, wrapping at `75ch`. Body text defaults to 14px, light ink `#2A2723`. The default window is 1440×900. The scroller `clip-path` cuts the empty pad on the right and stays open on the left so heading hashes and list dashes can hang. CodeMirror's base theme is an adopted stylesheet, so a tied `.cm-editor .cm-content` rule loses `margin` and `padding` to `margin: 0` and `padding: 4px 0`, and `.cm-line` gets its `6px` back. The clip then cuts the first glyph and the bullet, and the line runs through the right gutter. The child combinator is what keeps the content box and the clip on one rectangle. `.cm-scroller` uses the editor face and size so `ch` in the clip matches the draft. Duospace stays on `.cm-content` only.

## Block widgets: pick the decoration shape

Common shapes for widgets that own a block region:

- **Replace-only.** Always `Decoration.replace`. Use when the widget doesn't need to expose source for editing and interaction lives inside the widget itself. Canonical example: `mermaid-decorations.ts` — the fence is always replaced by the canvas, and editing happens in the canvas's nested editor, which writes the whole fence back via `writeFenceText`. The nested editor writes through on every change (deferred to a microtask, never a timer), so a widget destroyed by a tab close, a pane remount or a scroll can't drop typing; only the diagram redraw is debounced. An outer change to the fence is adopted by the nested editor (`FenceSourceSync` tells it apart from the echo of its own write). Anything a widget button reads later (Expand's source and label) lives on the per-wrapper entry that `updateDOM` refreshes, not in a closure from the first `toDOM`. An unclosed fence gets no widget: it runs to the end of the document, and replacing it would hide everything below.
- **Conditional replace ↔ widget.** `Decoration.replace` over `[node.from, node.to]` when the selection doesn't overlap the node; `Decoration.widget(...).range(node.to)` (anchored at the end) when it does, so the source becomes editable next to the rendered widget. Canonical example: `fold/image.ts`. Driven by `selectionTouchesRange`, the third arg passed to `foldableSyntaxFacet`'s `buildDecorations`.
- **Conditional replace ↔ source-line styling.** `Decoration.replace` when the selection is outside the block; line decorations when selection touches the block and the source should stay editable in the main editor. Canonical example: `table-decorations.ts`, which renders a folded table preview with safe inline markdown inside cells, then unfolds a touched table into codeblock-styled markdown source lines rather than a nested editor.

Don't invent a parallel "edit mode" flag that isn't wired through `selectionTouchesRange`. The fold extension already manages that state — duplicating it produces drift between the two sources of truth.

The redline gutter notes are a `scrollDOM` overlay (`redlineGutter` ViewPlugin), not block widgets and not extra children of `contentDOM`. Extra nodes inside `contentDOM` that aren't widgets break `posAtDOM`. Insert widgets for proposed text stay as inline decorations in the paper. Pending insert/replace put Accept / Reject / Edit ask on the gutter note as quiet buttons (`mousedown.preventDefault()` like other in-widget buttons) — not an inline locus pill on the span. Every margin button looks like the composer's: uppercase `--editor-font` at 11px with 0.15em tracking, set on `.cm-redline-btn` itself (WKWebView lets the row's tracking reach a button that does not set its own). The card's main action (Ask Alkuin, Accept, Sign in, Try again, Share changes) adds `cm-redline-btn-primary`, ink with a drawn underline; `cm-redline-btn-aside` sends Cancel and Edit ask to the far end of the line. No separators: Accept, Reject and Edit ask fit one line of the 198px column at the 1em gap, and a longer row wraps with 12px between lines so hit boxes never overlap. A caution line under that suggestion has no buttons of its own. Drag-selection skips `.cm-redline-note`. When notes exist, `.cm-scroller` clip-path keeps the left heading-hash relax and sets the **right inset to 0** so the ink gutter cannot sit in the clipped band; `.cm-selectionLayer` keeps an asymmetric right inset of `gutter-width` so `drawSelection` does not paint through the ink. Live selection wash is native `::selection` ash (`#9a948c` at ~0.16, twice where the live selection and an open note stack) so each wrap fragment hugs its glyphs. On the dark page that wash is a 46% cream mix, and `.cm-selectionBackground` uses it too. In light mode those rects stay transparent because CM’s `toOpen`/`between` path paints past short rows. Saved notes use the same ash CSS fill on `cm-redline-open` / `del` / `ins` with `box-decoration-break: clone` and no side pad. With notes open the draft and a 268px rail are one centered unit. The draft grows up to `--writer-editor-max-width` (75ch, so the text-size setting moves the cap) and then stops. Spare width splits outside that unit. A pane too narrow to center keeps the 75px step and the 95px gap, and the line shrinks so it does not run under the rail. `layoutFrame` only sets the overlay's top and height. The horizontal box is CSS (`right` and `width`). Without notes the draft stays left-aligned at 75px. The editor context menu snapshots the selection on right-click `mousedown` (button 2, or Ctrl-click) before WKWebView can collapse it. `ContextMenuRanges` in `editor-body-menu.ts` owns that snapshot: the menu it opens consumes it, any other press drops it, and the open menu's range is mapped through edits, so a keyboard-opened menu never acts on an earlier right-click's range. A non-empty selection also shows a B1 compact bubble (`selection-bubble.ts` ViewPlugin on `view.dom`, not a CM tooltip) with B / I / Link / List / Note and More for the rest of the Format / Paragraph / Insert command IDs. Bubble buttons `mousedown.preventDefault()` so the range holds. **Note** and **Add redline note** use that captured range and do **not** call `view.focus()` first: `EditorView.focus()` writes the current CM selection to the DOM (often a caret after the native menu) and focuses `contentDOM`, so the compose textarea never keeps focus. `beginAskOnNote` focuses the field. Compose buttons are Submit (`handlers.ask`) and Cancel (`handlers.reject` / `removeRedlineNote`; Escape already the same). Submit without `@agent` is an own note; `@agent` calls `redline_propose`. A saved `intent: none` note reuses `cm-redline-open` (no strike, no insert widget) and shows **Edit** / **Delete** / **Reply** / **Done** under the scribble, still without Accept / Reject. The reply field stays closed until Reply. Done removes the note. On a mention thread, Done, a reply and a suggested wording go to the server first and change the card once it has them; a failed send leaves the card as it was and the reply text in its field. The thread id sent as `note_id` is `threadKey(anchor, note)` from `note-mention/thread.ts`, so the author's card and the reader's card name the same thread; the card id is local. An accepted suggestion leaves the margin; it does not leave a Saved row. Overlapping a washed span still adds a second note. Wash marks live on `.cm-content` only. A suggestion written without search keeps Accept / Reject / Edit ask and paints as a normal insert or replace, even when the ask is cite-shaped. Under it, the margin adds the caution line with no buttons of its own. A held answer that is only that caution sentence (`none` + the sentence + pending + instruction) still shows Accept / Reject and does not search. `requestRewrite` reads that sentence once and sets `hold`; nothing else compares it. What a card is comes from `noteState(note)` in `redline-spike/model.ts`, the one reading of the fields. A failed ask's kind is `errorCode` (sign-in, calm, cancelled, failed), read from Rust's line once in `setAskError`; the gutter never compares copy. While Ask Alkuin is thinking the card shows **Cancel**: it reopens the field with the ask, and the late answer is dropped by its ask id. A shared Accept, Reject or Dismiss is `deciding` (`isDeciding`) until the server answers: its buttons are disabled and a pull cannot remove the card. Accept first checks the words under a replacement; if they already changed it says "This no longer matches." and the server hears nothing. After the save it writes at the position mapped through edits made meanwhile, but only if the replacement's words, or an insertion's line and column, are still what the person saw. If not, nothing is written over the edit. The server has the Accept and has no undo, so the card becomes `notApplied`: it says "Accepted, but the text changed before Alkuin could add it.", keeps the suggestion, has only Dismiss, and is never sent again. An Ask that comes back as a plain note (intent `none`, not the caution hold) offers Dismiss, which clears it the way Reject clears a suggestion. There is no Writer right sidebar for the note — the “right panel” is this overlay. A compose note's hairline mark is a 6px ink dot centered on the first line of `.cm-redline-instruction` (other notes still use the last glyph); the field bullet is hidden. The note is inset 28px from the hairline and 42px from the window, and the compose rule spans that content box. Long explanations are a nested scrollport on `.cm-redline-note-body` (`max-height: 40vh; overflow-y: auto`). Wheel/touch `stopPropagation` while that body can still scroll; leftover wheel is not cancelled, so `EditorScrollContainer` can move once the note is at its end.

## Selection bubble

B1 compact overlay lives on `view.dom` (`selection-bubble.ts`), not `contentDOM` and not a CodeMirror tooltip (wiki-link already parents tooltips to `document.body`). Buttons `mousedown.preventDefault()` so the range holds. Place **snug above** the span with `coordsAtPos`, falling back to `lineBlockAt` + `documentTop` for Y; flip below against the **outer scroller** visible top (`findOuterScroller`), not `.cm-editor` origin. Chrome is an opaque paper pill (`--paper-elevated`: `#FAF8F5` light, `#1E1E1C` dark) with a hairline and a shadow, so the page does not show through the bar or the `···` menu. Menu rows do not wrap. **Note** is the word alone. Click-away collapses only the **active** pane (`[data-pane]` without `.invisible`) and treats `view.dom` plus `[data-search-overlay]` as not-away. Find open hides the bubble and owns Escape. A drag selection hides it too, read from the drag gate's `dragFrozenSelectionField` (one source, so the gate's blur end covers a lost pointerup). `applySide` is the only writer of `data-side`: it starts from the side `sync` placed the bubble on and flips below while More would be clipped above, so a later sync can't undo the flip.

## Type altitude (T1)

Document H1 (`.cm-heading-line-1`) uses the editor face (Paper Mono), 17px, weight 700, tracking `0`, ink `#141312` on the light desk. Dark keeps the theme ink. Inline italic and bold inside a heading render styled (`.cm-emphasis` / `.cm-strong`); the `*` markers hide when the caret is off the token. The sidebar, tab, and window title strip those marks from the first `#` line. H2 and H3 are 13px bold on that same face. H4–H6 and body stay the editor size. A blank draft (empty buffer, or the new-file `# ` stub) shows `.cm-blank-promise` — 15.5px Paper Mono, not italic, centered in `[data-pane]`, outside `contentDOM`. The line is `Write in the center. Help in the margin.` The hash mark uses the heading's font size and line height (H1 17px / 1.25, H2 and H3 13px) in lighter grey `#A8A39A`, including when the caret is off the line. It stays absolutely positioned, so the size is on the mark and not on the line. An earlier change put the mark back at body size and the heading looked like a small grey superscript. The margin hand, the note label, and the desk-p15 bubble are not this altitude. Draft text does not set `font-feature-settings`, `font-kerning`, `text-rendering`, or `font-variant-ligatures`. ss02 and ss03 made macOS paint a different advance than the caret measured.

## Enter edit mode by range-selecting the fence, not by placing a caret

`selectionTouchesRange` from `@prosemark/core` is overlap-based with inclusive bounds (`a.from <= b.to && b.from <= a.to`, see `node_modules/@prosemark/core/dist/main.js:30`). A range selection covering the whole fence reliably flips it true regardless of where the head lands.

```ts
view.dispatch({
  selection: EditorSelection.single(fenceTo, fenceFrom), // reverse-anchor convention
  effects: view.scrollSnapshot(),
});
```

Caret-placement at a single point inside the fence is fragile: empty fences, boundary positions, multi-line content, and stale offsets all break it. Mirror what `selectAllDecorationsOnSelectExtension` (`@prosemark/core`) does — it's the canonical pattern.

## Don't store document positions on widget instances

Widget identity is its visual state — `source`, `editMode`, etc. — never positions. Positions are derived state owned by the syntax tree.

- Don't capture `node.from`/`node.to` on the widget at construction. Above-fence edits shift them and the widget lives across rebuilds.
- Don't try to keep them current via an `eq()` side-effect (mutating the kept instance from `other`). It looks like it works in isolation and silently fails across multi-fence diffs and decoration-shape transitions.
- Look up positions live at click time:

```ts
const pos = view.posAtDOM(host);
const tree = syntaxTree(view.state);
let node = tree.resolveInner(pos, side);
while (node.name !== "FencedCode" && node.parent) node = node.parent;
```

`eq()` should compare only the visual identity. Let CM rebuild when that changes; don't mutate kept instances to compensate.

## `posAtDOM` boundaries: try `resolveInner` with both sides

A `Decoration.widget(...).range(node.to)` returns `posAtDOM(host) === node.to`. `resolveInner(node.to, 1)` resolves to the node _starting_ at `node.to` — the next sibling, not the FencedCode that ends there. The walk up never finds the fence.

For widgets anchored at boundary positions, try `side = -1` first (prefers the node ending at the boundary), fall back to `side = 1`:

```ts
for (const side of [-1, 1] as const) {
  let node = tree.resolveInner(pos, side);
  while (node.name !== target && node.parent) node = node.parent;
  if (node.name === target) return node;
}
return null;
```

## Buttons inside widgets: `mousedown.preventDefault()`

A button inside the widget that dispatches a transaction will race the editor's focus state. Default browser behavior on mousedown:

1. Browser focuses the button → editor blurs.
2. Click handler runs → `view.dispatch(...)`.
3. Decoration rebuilds → button DOM destroyed → focus reverts to body.
4. Our `view.contentDOM.focus({preventScroll: true})` runs.

Steps 1–4 race with CM's own focus tracking; the visible result is the caret landing at click coordinates instead of the dispatched selection, or focus landing nowhere useful.

Add to every in-widget button:

```ts
b.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep the editor focused
  e.stopPropagation(); // keep CM's pointerdown handlers from competing
});
```

Combine with `ignoreEvent: true` on the widget so CM skips its own pointer/click handling for events inside the widget DOM.

**Gotcha: `mousedown.stopPropagation` does not stop `pointerdown`.** They're separate event types — the browser dispatches both for a click, and stopping one doesn't filter the other. If you wire an editor-level handler on `pointerdown` (e.g., a drag-selection gate that listens on `view.contentDOM`), the in-widget button's `mousedown` stop won't suppress it. Filter inside the editor-level handler instead — typically `event.target instanceof Element && event.target.closest('.cm-your-widget')`. See `mermaid-decorations.ts`'s `shouldStartDragGate` for the canonical filter.

## Heightmap-shifting transitions: include `view.scrollSnapshot()`

Any decoration switch that changes block heights (replace ↔ widget, fold/unfold, widget appearing/disappearing) shifts the heightmap. Without compensation the viewport jumps.

```ts
view.dispatch({
  selection: ...,
  effects: view.scrollSnapshot(),
});
```

`scrollSnapshot` captures the viewport-top doc anchor and its screen offset; CM applies the resulting `StateEffect` after the heightmap rebuild and re-scrolls so the same anchor lands at the same screen Y. Don't roll your own `coordsAtPos`-delta scroll math — it depends on layout being flushed and is brittle.

**Caveat: `scrollSnapshot` only affects `view.scrollDOM`, not ancestor scrollers** (per CM's own doc comment; both capture and apply use `scrollDOM.scrollTop`). In Writer, `.cm-scroller` doesn't scroll — the outer `EditorScrollContainer` does — so the snapshot is close to a no-op here. What actually keeps the viewport stable across height changes is CM's measure-loop scroll anchoring, which does adjust the discovered ancestor scroller — but only while the editor has focus or a wheel/touch event happened in the last 100ms. Corollary: widgets whose DOM changes height after insertion (async image decode, deferred renders) must keep `estimatedHeight` truthful and call `view.requestMeasure()` when their height settles, so the anchoring runs while the user is still interacting. `fold/image.ts` does this with a module-level measured-height cache keyed by image URL, reserving the cached height on the `<img>` until it (re)loads.

## Tree-derived StateFields go stale in unparsed regions

`syntaxTree(state)` returns a frozen snapshot committed at the last `LanguageState` flip — not the live parse context. `ensureSyntaxTree` advances the live context and returns the fresh tree, but `syntaxTree(state)` keeps returning the old one until some later transaction commits a new `LanguageState` (`forceParsing` = `ensureSyntaxTree` + that dispatch). Lezer's background worker fills the tree in `requestIdleCallback` slices, which starve during continuous scrolling and are budget-capped on long documents.

Consequence: any `StateField` that builds decorations by iterating `syntaxTree(state)` (list geometry, hide, fold) renders nothing for regions the committed tree hasn't reached — scrolled-into list items lose their hanging indent, markers show raw, etc. The fields' `syntaxTree(startState) !== syntaxTree(state)` rebuild guards only fire once a parse-commit transaction lands.

`viewportParsePlugin` in `use-prosemark-editor.ts` closes the gap: on `viewportChanged` into a region where `syntaxTreeAvailable` is false, it defers a `forceParsing(view, viewport.to + overshoot)` (dispatching inside an update cycle is illegal, hence the `setTimeout`). Mount and tab-swap paths call `advanceViewportParse` for the same reason. Don't add per-field force-parses.

The parse-commit transaction that `forceParsing` dispatches changes neither the doc nor the viewport. So every tree-derived decoration source, StateField **and** ViewPlugin, must rebuild on the tree itself changing. Use `treeChanged(update)` from `prosemark-core/utils.ts`:

```ts
update(update: ViewUpdate) {
  if (update.docChanged || update.viewportChanged || treeChanged(update)) rebuild();
}
```

The StateFields (`hideExtension`, `foldExtension`, `listDecorationsField`) and the ViewPlugins (`headingPlugin`, `codeBlockDecorationsExtension`, `blockQuoteExtension`, `wikiLinkDecorations`) all carry it. Without it a region jumped into (Cmd+G, section rail, anchor) keeps stale decorations until the next scroll. Don't add a "tree sync" plugin that re-dispatches a selection to nudge a rebuild; that was the old workaround and it tripled the rebuild cost per parse commit.

## Deferred work checks the document session

One `EditorView` shows every document of a tab: navigating swaps the text in place (`use-prosemark-editor.ts`), it does not remount. So `isDisposed()` is not enough for work that lands later (a rAF scroll, an image paste, a menu paste, a link or wiki-link resolve): the view can be alive and showing a different document. `editor-doc-session.ts` owns a `docSessionField` generation that the swap transaction bumps (`startNextDocSession`) whenever a different document takes over the view, even one whose text equals the live text. A rename or a disk reload of the same document keeps it.

Capture before the await, check before landing:

```ts
const isCurrent = captureDocSession(view, isDisposed);
const result = await somethingAsync();
if (!isCurrent()) return;
view.dispatch(...);
```

A swap to a different document always resets undo history and consumes that path's pending heading anchor, including the identical-text case (`planEditorSwap` in `editor-reload.ts`). A disk reload of the same path replaces the editor unless the text is already identical, even when the incoming text is a prefix of the live one (an accepted copy that dropped the last paragraph): the store's `if-clean` policy is what keeps a stale save echo out. Only a rename adopts a live text that extends the moved snapshot. A fresh mount consumes the pending anchor too: a link to a file that wasn't loaded mounts a new view after the loading spinner. The anchor is consumed inside the deferred frame, after the session check, so a view thrown away before its frame (React StrictMode mounts the ref twice) leaves it for the view that replaces it. Mount-time deferred work treats a view as gone once it is no longer the hook's view, since the remount resets `disposedRef`.

## Synchronous render in `toDOM` beats IntersectionObserver-deferred

If your renderer is sync and cache-backed (or cheap to call), paint in `toDOM`. The async-deferred path adds a "Loading…" gap users see, can re-fire after a toggle (producing a visible flash), and has no real benefit when the cache makes repeat renders O(map lookup). CM only calls `toDOM` for widgets in its viewport buffer anyway.

Reference: `mermaid-decorations.ts` mounts the canvas synchronously in `toDOM`; the SVG cache is bounded LRU and the output is sanitised before reaching `innerHTML`.

## Test the dispatch path, not just the helpers

Pure-helper tests (`computeToggleSelection`-style) catch math bugs but not focus races, `posAtDOM` boundary errors, or cross-widget interference. The actual contract is "click does the right thing in CM," which only an integration test can verify.

When a widget has a click → dispatch → mode-change cycle, mount a real `EditorView` with two instances and simulate clicks. Assert against `view.state.selection.main` and `view.state.field(foldExtension)`, not against helper outputs.

## State that belongs to a file must outlive the view

One `EditorView` shows the files of a tab one at a time, and it is destroyed while the next file is still loading. A StateField that holds something of the file's (margin notes) loses it on either. Two rules:

- **Ask the hook which file, not the path getter.** The path getter the extensions hold already answers with the next file while the swap is dispatched. `use-prosemark-editor.ts` annotates the load transaction with `filePathChange` (`{ from, to, kind }`), and for a rename it keeps (`planEditorSwap` → `adopt`) it dispatches that annotation alone. `kind` comes from `pathChangeKind` in `editor-reload.ts`: `rename` is this buffer under a new name, `swap` is another file. A field or plugin that keeps per-file state reads that annotation.
- **Park it outside the view.** `features/redline-spike/parked-notes.ts` keeps the writer's own notes per path while their file is not shown. The field only reads the map; the view plugin writes it (`noteParker` in `extension.ts`), once per transaction and on destroy. A view with nothing to park leaves another view's entry. A rename on disk moves the entry (`moveParkedNotes`, called from `renameHoldingSaves`, the one rename path). A reload of the same file keeps own notes whose passage still reads the same, mapped through the one change between the old and new text; there is no search for the same words elsewhere.

## File map

- `mermaid-decorations.ts` — canonical replace-only block widget with in-widget editing. Reference for live position lookup (`findEnclosingFencedCode`) and writing the fence back from a nested editor.
- `fold/image.ts` — canonical conditional replace ↔ widget, plus the measured-height cache for async-loading content.
- `table-decorations.ts` — canonical conditional replace ↔ source-line styling; uses `selectAllDecorationsOnSelectExtension` for click-to-select.
- `prosemark-core/links.ts` — `linkUrlAt` / `rawUrlAt`, the one place that resolves a link destination from a document position.
- `prosemark-core/imageSrc.ts` — `imageSrcResolverFacet` / `resolveImageSrc`; widgets resolve `<img src>` in `toDOM` (Writer provides the facet from `image-src-resolver.ts`), so no DOM observer rewrites images after insertion.
- `editor-scroll.ts` — `findOuterScroller` / `scrollPosToSafeTop`, the one place that scrolls the ancestor container to a document position.
- `editor-extensions.ts` — `createEditorExtensions`, the one place the extension list is assembled. Pieces: `editor-search-extensions.ts` (hidden search panel, `EditorView.scrollHandler` for the ancestor-scroller case, Mod-f / Mod-g / Escape), `link-navigation.ts` (click-to-follow, `followLink`), `editor-clipboard.ts` (image + frontmatter paste), `editor-body-menu.ts` (right-click menu), `selection-bubble.ts` (B1 compact format/note pill), `viewport-parse.ts`. `use-prosemark-editor.ts` only mounts, swaps, and disposes the view.
- `node_modules/@prosemark/core/dist/main.js:30` — `selectionTouchesRange` semantics.
