import { invoke } from "@tauri-apps/api/core";
import type { PageCountCache, WordAnchor } from "$lib/stores";
import { DEFAULT_RSVP_CONFIG } from "$lib/utils/rsvp";

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
    // Reading position independent of layout: the word being read (page
    // start + rsvpWordOffset). Absent in states saved by older versions,
    // which only have `page`.
    anchor?: WordAnchor;
    // Page counts for the layout the book was last fully measured at.
    pageCounts?: PageCountCache;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function parseAnchor(v: unknown): WordAnchor | undefined {
    const a = v as Record<string, unknown> | null;
    return a && isCount(a.chapter) && isCount(a.word) ? { chapter: a.chapter, word: a.word } : undefined;
}

function parsePageCounts(v: unknown): PageCountCache | undefined {
    const c = v as Record<string, unknown> | null;
    if (!c || typeof c.key !== "string" || !Array.isArray(c.counts)) return undefined;
    return c.counts.every((n) => isCount(n) && n > 0) ? { key: c.key, counts: c.counts as number[] } : undefined;
}

/** A finite number clamped to [min, max] (rounded if `int`), else `fallback`. */
function num(v: unknown, fallback: number, min: number, max: number, int = false): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    const n = Math.min(max, Math.max(min, v));
    return int ? Math.round(n) : n;
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/**
 * The single place a saved state is validated: every field is checked and
 * clamped to the range the UI allows, falling back to the default, so a
 * hand-edited or corrupt file can't put the reader into an invalid state.
 * Also accepts the snake_case keys of the oldest saved states.
 */
export function parseSavedState(raw: Record<string, unknown>): SavedState {
    const d = DEFAULT_RSVP_CONFIG;
    return {
        page: num(raw.page, 0, 0, Number.MAX_SAFE_INTEGER, true),
        rsvpWordOffset: num(raw.rsvpWordOffset ?? raw.rsvp_word_offset, 0, 0, Number.MAX_SAFE_INTEGER, true),
        fontSize: num(raw.fontSize ?? raw.font_size, 1.2, 0.6, 3.0),
        windowWidth: num(raw.windowWidth ?? raw.window_width, 0, 0, 100_000),
        windowHeight: num(raw.windowHeight ?? raw.window_height, 0, 0, 100_000),
        wpm: num(raw.wpm, d.wpm, 100, 1000, true),
        longWordDelay: bool(raw.longWordDelay ?? raw.long_word_delay, d.longWordDelay),
        longWordMultiplier: num(raw.longWordMultiplier, d.longWordMultiplier, 0, 3),
        punctuationPause: bool(raw.punctuationPause ?? raw.punctuation_pause, d.punctuationPause),
        punctuationDelayMs: num(raw.punctuationDelayMs, d.punctuationDelayMs, 0, 500, true),
        complexityWeight: num(raw.complexityWeight ?? raw.complexity_weight, d.complexityWeight, 0, 1),
        timerMinutes: num(raw.timerMinutes, d.timerMinutes, 0, 99, true),
        timerSeconds: num(raw.timerSeconds, d.timerSeconds, 0, 59, true),
        anchor: parseAnchor(raw.anchor),
        pageCounts: parsePageCounts(raw.pageCounts),
    };
}

export async function saveState(bookId: string, state: SavedState): Promise<void> {
    try {
        console.log("persist:saveState", {
            id: bookId,
            anchor: state.anchor,
            offset: state.rsvpWordOffset,
            font: state.fontSize,
        });
        await invoke("save_state", { bookId, data: state });
        console.log("persist:saveState ok");
    } catch (e) {
        console.error("persist:saveState failed", e);
    }
}

/**
 * Load a book's saved state by its content id. `bookPath` lets the backend
 * fall back to state saved by earlier versions, which was keyed by path.
 */
export async function loadState(bookId: string, bookPath: string): Promise<SavedState | null> {
    try {
        console.log("persist:loadState", { id: bookId });
        const raw = await invoke("load_state", { bookId, bookPath });
        if (!raw || typeof raw !== "object") {
            console.log("persist:loadState not found");
            return null;
        }
        const state = parseSavedState(raw as Record<string, unknown>);
        console.log("persist:loadState parsed", state);
        return state;
    } catch (e) {
        console.error("persist:loadState failed", e);
        return null;
    }
}
