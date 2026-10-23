import { invoke } from "@tauri-apps/api/core";
import { rsvpConfig } from "$lib/stores";
import type { RsvpConfig } from "$lib/utils/rsvp";
import { parseRsvpSettings } from "$lib/utils/persistence";
import { logError } from "$lib/utils/debug";

// RSVP settings are global (settings.json in the app data folder), shared by
// all books.

let loaded: Promise<void> | null = null;
// Whether settings.json existed, or settings were adopted from a book.
let found = false;

/** Load settings.json into rsvpConfig, once. Resolves when done, also on failure. */
export function loadSettings(): Promise<void> {
    loaded ??= (async () => {
        try {
            const raw = await invoke("load_settings");
            if (raw && typeof raw === "object") {
                rsvpConfig.set(parseRsvpSettings(raw as Record<string, unknown>));
                found = true;
            }
        } catch (e) {
            logError("settings: load failed", String(e));
        }
    })();
    return loaded;
}

/**
 * Seed the global settings from RSVP settings an older version saved with a
 * book, if there were no global settings yet. Call after loadSettings().
 */
export function adoptLegacySettings(cfg: RsvpConfig | undefined): void {
    if (found || !cfg) return;
    found = true;
    rsvpConfig.set(cfg);
}

/**
 * Save rsvpConfig to settings.json whenever it changes (debounced), starting
 * once the saved settings are loaded. Returns a function that stops syncing.
 */
export function syncSettings(): () => void {
    let stopped = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    loadSettings().then(() => {
        if (stopped) return;
        let first = true;
        unsubscribe = rsvpConfig.subscribe((cfg) => {
            // The subscription reports the current value first; nothing changed yet.
            if (first) {
                first = false;
                return;
            }
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                invoke("save_settings", { data: cfg }).catch((e) => logError("settings: save failed", String(e)));
            }, 300);
        });
    });
    return () => {
        stopped = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
    };
}
