import { HugeiconsIcon } from "@hugeicons/react";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { openPreferences } from "@/hooks/use-menu-events";

export function PreferencesButton() {
  return (
    <button
      type="button"
      onClick={openPreferences}
      aria-label="Preferences"
      title="Preferences ⌘,"
      className="group pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-[var(--fg-base)] transition-colors hover:bg-[var(--surface-subtle)] hover:transition-none"
    >
      <span className="opacity-60 transition-opacity group-hover:opacity-100 group-hover:transition-none">
        <HugeiconsIcon icon={Settings01Icon} size={18} color="currentColor" strokeWidth={2} />
      </span>
    </button>
  );
}
