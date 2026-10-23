import { invoke } from "@tauri-apps/api/core";

let seq = 0;

export async function dbg(msg: string, data?: unknown): Promise<void> {
    const tag = `[${String(++seq).padStart(3, "0")}] ${msg}${data !== undefined ? " " + JSON.stringify(data).slice(0, 200) : ""}`;
    console.log(tag);
    try {
        await invoke("log_debug", { msg: tag });
    } catch { /* log file write is best-effort */ }
}