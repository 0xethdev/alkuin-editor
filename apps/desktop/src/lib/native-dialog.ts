import { invoke } from "@tauri-apps/api/core";

/**
 * The desktop dialog plugin is 2.7, which registers `message` only.
 * `ask` from plugin-dialog 2.6 calls `plugin:dialog|ask` and throws.
 * A custom button comes back as the label, or as `{ Custom: label }`.
 */
export function dialogAccepted(result: unknown, okLabel: string): boolean {
  if (result === okLabel || result === "Ok" || result === "Yes") return true;
  if (result && typeof result === "object" && "Custom" in result) {
    return (result as { Custom?: unknown }).Custom === okLabel;
  }
  return false;
}

export async function confirmWarning(copy: {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
}): Promise<boolean> {
  const result = await invoke("plugin:dialog|message", {
    message: copy.body,
    title: copy.title,
    kind: "warning",
    buttons: { OkCancelCustom: [copy.confirm, copy.cancel] },
  });
  return dialogAccepted(result, copy.confirm);
}
