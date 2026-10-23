import { invoke } from "@tauri-apps/api/core";

export interface SavedState {
    page: number;
    rsvpWordOffset: number;
    fontSize: number;
    windowWidth: number;
    windowHeight: number;
    wpm: number;
    longWordDelay: boolean;
    longWordMultiplier: number;
    punctuationPause: boolean;
    punctuationDelayMs: number;
    complexityWeight: number;
    timerMinutes: number;
    timerSeconds: number;
}

export async function saveState(bookPath: string, state: SavedState): Promise<void> {
    try {
        console.log("persist:saveState", {
            path: bookPath.slice(-20),
            page: state.page,
            offset: state.rsvpWordOffset,
            font: state.fontSize,
            win: [state.windowWidth, state.windowHeight],
        });
        await invoke("save_state", { bookPath, data: state });
        console.log("persist:saveState ok");
    } catch (e) {
        console.error("persist:saveState failed", e);
    }
}

export async function loadState(bookPath: string): Promise<SavedState | null> {
    try {
        console.log("persist:loadState", { path: bookPath.slice(-20) });
        const raw = (await invoke("load_state", { bookPath })) as Record<string, unknown> | null;
        if (!raw) {
            console.log("persist:loadState not found");
            return null;
        }
        console.log("persist:loadState data", raw);
        const state: SavedState = {
            page: (raw.page ?? 0) as number,
            rsvpWordOffset: (raw.rsvpWordOffset ?? raw.rsvp_word_offset ?? 0) as number,
            fontSize: (raw.fontSize ?? raw.font_size ?? 1.2) as number,
            windowWidth: (raw.windowWidth ?? raw.window_width ?? 0) as number,
            windowHeight: (raw.windowHeight ?? raw.window_height ?? 0) as number,
            wpm: (raw.wpm ?? 300) as number,
            longWordDelay: (raw.longWordDelay ?? raw.long_word_delay ?? true) as boolean,
            longWordMultiplier: (raw.longWordMultiplier ?? 0.5) as number,
            punctuationPause: (raw.punctuationPause ?? raw.punctuation_pause ?? true) as boolean,
            punctuationDelayMs: (raw.punctuationDelayMs ?? 200) as number,
            complexityWeight: (raw.complexityWeight ?? raw.complexity_weight ?? 0.5) as number,
            timerMinutes: (raw.timerMinutes ?? 0) as number,
            timerSeconds: (raw.timerSeconds ?? 0) as number,
        };
        console.log("persist:loadState parsed", state);
        return state;
    } catch (e) {
        console.error("persist:loadState failed", e);
        return null;
    }
}

export async function getWindowSize(): Promise<{ w: number; h: number } | null> {
    try {
        const raw = (await invoke("get_window_size")) as Record<string, unknown> | null;
        if (!raw) return null;
        const w = raw.w as number;
        const h = raw.h as number;
        if (w > 0 && h > 0) return { w, h };
        return null;
    } catch { return null; }
}