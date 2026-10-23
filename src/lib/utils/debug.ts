import { invoke } from "@tauri-apps/api/core";

const DEBUG_KEY = "rsvp-reader:debug";

/**
 * Verbose logging is on in dev builds, or in a release build after running
 * `localStorage.setItem("rsvp-reader:debug", "1")` in the webview console.
 */
function debugEnabled(): boolean {
    if (import.meta.env.DEV) return true;
    try {
        return localStorage.getItem(DEBUG_KEY) === "1";
    } catch {
        return false;
    }
}

const enabled = debugEnabled();
let seq = 0;

async function write(msg: string, data?: unknown): Promise<void> {
    const tag = `[${String(++seq).padStart(3, "0")}] ${msg}${data !== undefined ? " " + JSON.stringify(data).slice(0, 200) : ""}`;
    console.log(tag);
    try {
        await invoke("log_debug", { msg: tag });
    } catch {
        /* log file write is best-effort */
    }
}

/** Debug trace to the console and debug.log; only when debug logging is on. */
export async function dbg(msg: string, data?: unknown): Promise<void> {
    if (enabled) await write(msg, data);
}

/** Unexpected errors: always logged, also in release builds. */
export async function logError(msg: string, data?: unknown): Promise<void> {
    await write(msg, data);
}
