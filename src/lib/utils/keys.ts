// Keyboard helpers shared by page mode and RSVP mode.

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"]);

/** True if the key event comes from a field the user types into. */
export function inTextField(e: KeyboardEvent): boolean {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return false;
    if (t.isContentEditable || t instanceof HTMLTextAreaElement) return true;
    return t instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(t.type);
}

/**
 * The page/RSVP mode-switch key: the physical A key, whatever the keyboard
 * layout (it types "ф" on Russian), without Cmd/Ctrl/Alt (Cmd+A selects all).
 */
export function isModeSwitchKey(e: KeyboardEvent): boolean {
    return e.code === "KeyA" && !e.metaKey && !e.ctrlKey && !e.altKey && !inTextField(e);
}

/** Backspace, outside text fields: go back after following a link. */
export function isBackKey(e: KeyboardEvent): boolean {
    return e.code === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !inTextField(e);
}

/** Space, outside text fields. */
export function isSpaceKey(e: KeyboardEvent): boolean {
    return e.code === "Space" && !inTextField(e);
}
