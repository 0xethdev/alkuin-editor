# Keyboard Shortcuts

Canonical shortcut reference for Writer.

## Global

These shortcuts are handled by the global `useKeyboardShortcuts` hook and work regardless of editor focus.

| Shortcut        | Action                                                             |
| --------------- | ------------------------------------------------------------------ |
| Cmd+P           | File search (command palette)                                      |
| Cmd+O           | Go to file                                                         |
| Cmd+N           | Create new note                                                    |
| Cmd+T           | New tab                                                            |
| Cmd+W           | Close current tab; hides the window when only the launcher is left |
| Cmd+\\          | Toggle sidebar                                                     |
| Ctrl+Tab        | Next tab                                                           |
| Ctrl+Shift+Tab  | Previous tab                                                       |
| Cmd+1 ... Cmd+9 | Jump to Nth tab                                                    |
| Alt+ArrowLeft   | Navigate back                                                      |
| Alt+ArrowRight  | Navigate forward                                                   |

In compact single-file windows, sidebar and tab-management shortcuts do not
create hidden UI state: Cmd+\\, Cmd+T, Ctrl+Tab, Ctrl+Shift+Tab, and Cmd+1 ...
Cmd+9 are ignored. Cmd+P, Cmd+O, Cmd+N, and history navigation still work.

## Menu Accelerators

These shortcuts are bound to the native app menu (Tauri menu accelerators) rather than the global JS handler.

| Shortcut | Action                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------- |
| Cmd+,    | Open Preferences in the focused window. The gear at the top right does the same.                  |
| Cmd+Q    | Quit Alkuin. Every window saves first; if a document can't be saved, Alkuin asks before quitting. |

Quit Alkuin is a custom menu item (`app.quit`, see `src-tauri/src/quit.rs`), not the system Quit, so that it can save first. Keep its label and Cmd+Q accelerator. On Linux and Windows it has no accelerator, the same as the system item. Quit in the macOS Dock menu, logout and shutdown go straight to macOS and do not run the save round. Only the per-window close save and autosave cover them.

File → Export PDF… writes the open document and opens the PDF. It has no shortcut.

File → Import Word…, Import Google Docs…, Export Word…, and Export Google Docs… have no shortcut. Import Google Docs asks for a link. The document has to be shared so anyone with the link can view it. Export Google Docs writes a Word file and opens Google Drive.

## Editor Formatting

These shortcuts are handled by the `markdownFormatting` CodeMirror extension and only apply when the editor is focused. The same commands are on the B1 selection bubble (compact strip + More) and in the editor context menu under Format, Paragraph, and Insert.

| Shortcut                | Action                                                   |
| ----------------------- | -------------------------------------------------------- |
| Cmd+B                   | Bold                                                     |
| Cmd+I                   | Italic                                                   |
| Cmd+K                   | Insert link                                              |
| Cmd+E                   | Inline code                                              |
| Cmd+Shift+X             | Strikethrough                                            |
| Cmd+Shift+8             | Bullet list                                              |
| Cmd+Shift+7             | Numbered list                                            |
| Cmd+Shift+.             | Blockquote                                               |
| Cmd+Shift+Enter         | Task list                                                |
| Cmd+Alt+1 ... Cmd+Alt+6 | Heading 1-6                                              |
| Cmd+Alt+0               | Paragraph (strip heading)                                |
| Ctrl+Option+M           | Mark the caret diagnostic log (flash on the status line) |

## Editor (inherited from CodeMirror)

Standard editing shortcuts provided by CodeMirror's basic setup.

| Shortcut             | Action                                  |
| -------------------- | --------------------------------------- |
| Cmd+Z                | Undo                                    |
| Cmd+Shift+Z          | Redo                                    |
| Cmd+A                | Select all                              |
| Cmd+D                | Select next occurrence                  |
| Alt+ArrowUp          | Move line up                            |
| Alt+ArrowDown        | Move line down                          |
| Alt+Shift+ArrowUp    | Copy line up                            |
| Alt+Shift+ArrowDown  | Copy line down                          |
| Cmd+Shift+K          | Delete line                             |
| Cmd+Enter            | Insert line below                       |
| Cmd+Shift+Enter      | Insert line above                       |
| Tab                  | Indent / accept completion              |
| Shift+Tab            | Dedent                                  |
| Cmd+]                | Indent more                             |
| Cmd+[                | Indent less                             |
| Cmd+F                | Find                                    |
| Cmd+H                | Find and replace                        |
| Cmd+G                | Find next                               |
| Cmd+Shift+G          | Find previous                           |
| Escape               | Close find if open; else dismiss bubble |
| Alt+Shift+ArrowLeft  | Extend selection by word left           |
| Alt+Shift+ArrowRight | Extend selection by word right          |

When a redline compose field is focused, Enter asks Alkuin (same as Ask Alkuin). Shift+Enter inserts a line. Escape cancels the draft (same as Cancel).
