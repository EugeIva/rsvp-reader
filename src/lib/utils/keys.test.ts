// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { inTextField, isModeSwitchKey, isSpaceKey, isBackKey } from "./keys";

/** Dispatch a keydown on `target` and return the event as a handler sees it. */
function keydown(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
    let seen: KeyboardEvent | null = null;
    target.addEventListener("keydown", (e) => (seen = e), { once: true });
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    return seen!;
}

function el(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    return host.firstElementChild as HTMLElement;
}

describe("keyboard helpers", () => {
    it("matches the physical A key on any layout", () => {
        const body = document.body;
        expect(isModeSwitchKey(keydown(body, { code: "KeyA", key: "a" }))).toBe(true);
        expect(isModeSwitchKey(keydown(body, { code: "KeyA", key: "ф" }))).toBe(true);
        // On AZERTY the key labelled A is KeyQ.
        expect(isModeSwitchKey(keydown(body, { code: "KeyQ", key: "a" }))).toBe(false);
    });

    it("ignores A with Cmd, Ctrl or Alt", () => {
        const body = document.body;
        expect(isModeSwitchKey(keydown(body, { code: "KeyA", metaKey: true }))).toBe(false);
        expect(isModeSwitchKey(keydown(body, { code: "KeyA", ctrlKey: true }))).toBe(false);
        expect(isModeSwitchKey(keydown(body, { code: "KeyA", altKey: true }))).toBe(false);
    });

    it("ignores A and Space while typing in a text field", () => {
        const input = el('<input type="text">');
        expect(inTextField(keydown(input, { code: "KeyA" }))).toBe(true);
        expect(isModeSwitchKey(keydown(input, { code: "KeyA" }))).toBe(false);
        expect(isSpaceKey(keydown(input, { code: "Space" }))).toBe(false);
        expect(isSpaceKey(keydown(el("<textarea></textarea>"), { code: "Space" }))).toBe(false);
    });

    it("matches Backspace for going back, except while typing or with modifiers", () => {
        expect(isBackKey(keydown(document.body, { code: "Backspace" }))).toBe(true);
        expect(isBackKey(keydown(document.body, { code: "Backspace", metaKey: true }))).toBe(false);
        expect(isBackKey(keydown(el('<input type="text">'), { code: "Backspace" }))).toBe(false);
    });

    it("still handles them on checkboxes, sliders and buttons", () => {
        for (const html of ['<input type="checkbox">', '<input type="range">', "<button>Next</button>"]) {
            const target = el(html);
            expect(isSpaceKey(keydown(target, { code: "Space" }))).toBe(true);
            expect(isModeSwitchKey(keydown(target, { code: "KeyA" }))).toBe(true);
        }
    });
});
