import { invoke } from "@tauri-apps/api/core";
import { derived } from "svelte/store";
import { rsvpConfig, fontSize } from "$lib/stores";
import type { RsvpConfig } from "$lib/utils/rsvp";
import { parseRsvpSettings, parseFontSize } from "$lib/utils/persistence";
import { logError } from "$lib/utils/debug";

// RSVP settings and the font size are global (settings.json in the app data
// folder), shared by all books.

let loaded: Promise<void> | null = null;
// Whether settings.json had RSVP settings / a font size, or they were
// adopted from a book.
let found = false;
let fontFound = false;

/** Load settings.json into rsvpConfig and fontSize, once. Resolves when done, also on failure. */
export function loadSettings(): Promise<void> {
    loaded ??= (async () => {
        try {
            const raw = await invoke("load_settings");
            if (raw && typeof raw === "object") {
                rsvpConfig.set(parseRsvpSettings(raw as Record<string, unknown>));
                found = true;
                const size = parseFontSize(raw as Record<string, unknown>);
                if (size !== undefined) {
                    fontSize.set(size);
                    fontFound = true;
                }
            }
        } catch (e) {
            logError("settings: load failed", String(e));
        }
    })();
    return loaded;
}

/**
 * Seed the global settings from the RSVP settings and font size an older
 * version saved with a book, for whichever has no global value yet. Call
 * after loadSettings().
 */
export function adoptLegacySettings(saved: { rsvp?: RsvpConfig; fontSize?: number } | null): void {
    if (!found && saved?.rsvp) {
        found = true;
        rsvpConfig.set(saved.rsvp);
    }
    if (!fontFound && saved?.fontSize !== undefined) {
        fontFound = true;
        fontSize.set(saved.fontSize);
    }
}

/**
 * Save rsvpConfig and fontSize to settings.json whenever they change
 * (debounced), starting once the saved settings are loaded. Returns a
 * function that stops syncing.
 */
export function syncSettings(): () => void {
    let stopped = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    loadSettings().then(() => {
        if (stopped) return;
        let first = true;
        const settings = derived([rsvpConfig, fontSize], ([cfg, size]) => ({ ...cfg, fontSize: size }));
        unsubscribe = settings.subscribe((data) => {
            // The subscription reports the current value first; nothing changed yet.
            if (first) {
                first = false;
                return;
            }
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                invoke("save_settings", { data }).catch((e) => logError("settings: save failed", String(e)));
            }, 300);
        });
    });
    return () => {
        stopped = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
    };
}
