import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Listen for an event Rust sent to one window with `emit_to`.
 *
 * `listen` from `@tauri-apps/api/event` hears every target, the events meant
 * for another window included. With two windows open, a menu item chosen in
 * one ran in both: Export PDF asked each window where to save. Use this for
 * any event the backend addresses to a window (the native menu, a drop or an
 * opened file, a refused invite link). An event sent to the whole app with
 * `emit` still takes the plain `listen`.
 */
export function listenInThisWindow<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<T>(event, handler);
}
