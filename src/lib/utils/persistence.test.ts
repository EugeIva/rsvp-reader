import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { loadState, parseSavedState, parseRsvpSettings } from "./persistence";
import { DEFAULT_RSVP_CONFIG } from "./rsvp";

describe("loadState", () => {
    beforeEach(() => {
        invoke.mockReset();
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("reads the position anchor and page-count cache", async () => {
        invoke.mockResolvedValue({
            page: 7,
            anchor: { chapter: 3, word: 120 },
            pageCounts: { key: "2|600x700|1.2", counts: [4, 10, 2] },
        });
        const s = await loadState("abc123", "/book.epub");
        expect(s?.anchor).toEqual({ chapter: 3, word: 120 });
        expect(s?.pageCounts).toEqual({ key: "2|600x700|1.2", counts: [4, 10, 2] });
    });

    it("leaves them out for states saved by older versions", async () => {
        invoke.mockResolvedValue({ page: 7 });
        const s = await loadState("abc123", "/book.epub");
        expect(s?.page).toBe(7);
        expect(s?.anchor).toBeUndefined();
        expect(s?.pageCounts).toBeUndefined();
    });

    it("ignores malformed values", async () => {
        invoke.mockResolvedValue({
            anchor: { chapter: -1, word: "x" },
            pageCounts: { key: "k", counts: [3, 0] },
        });
        const s = await loadState("abc123", "/book.epub");
        expect(s?.anchor).toBeUndefined();
        expect(s?.pageCounts).toBeUndefined();
    });

    it("looks the state up by book id, passing the path for the legacy fallback", async () => {
        invoke.mockResolvedValue(null);
        expect(await loadState("abc123", "/book.epub")).toBeNull();
        expect(invoke).toHaveBeenCalledWith("load_state", { bookId: "abc123", bookPath: "/book.epub" });
    });
});

describe("parseSavedState", () => {
    it("clamps out-of-range values to what the UI allows", () => {
        const s = parseSavedState({ fontSize: 40, page: -3 });
        expect(s.fontSize).toBe(3);
        expect(s.page).toBe(0);
    });

    it("falls back to defaults for missing or wrongly typed values", () => {
        const s = parseSavedState({ fontSize: "big", rsvpWordOffset: "x" });
        expect(s.fontSize).toBe(1.2);
        expect(s.rsvpWordOffset).toBe(0);
    });

    it("reads the oldest snake_case keys", () => {
        const s = parseSavedState({ font_size: 1.5, rsvp_word_offset: 7, window_width: 800 });
        expect(s.fontSize).toBe(1.5);
        expect(s.rsvpWordOffset).toBe(7);
        expect(s.windowWidth).toBe(800);
    });

    it("keeps the per-book RSVP settings of older versions, to seed the global ones", () => {
        expect(parseSavedState({ fontSize: 1.2 }).rsvp).toBeUndefined();
        expect(parseSavedState({ wpm: 450, punctuationDelayMs: 150 }).rsvp).toMatchObject({
            wpm: 450,
            punctuationDelayMs: 150,
        });
    });
});

describe("parseRsvpSettings", () => {
    it("clamps out-of-range values to what the UI allows", () => {
        const s = parseRsvpSettings({
            wpm: 5,
            punctuationDelayMs: 9000,
            complexityWeight: -1,
            longWordMultiplier: 7,
            timerMinutes: 500,
            timerSeconds: 75,
        });
        expect(s.wpm).toBe(100);
        expect(s.punctuationDelayMs).toBe(500);
        expect(s.complexityWeight).toBe(0);
        expect(s.longWordMultiplier).toBe(3);
        expect(s.timerMinutes).toBe(99);
        expect(s.timerSeconds).toBe(59);
    });

    it("falls back to defaults for missing or wrongly typed values", () => {
        const s = parseRsvpSettings({ wpm: null, complexityWeight: Number.NaN, timerEnabled: "yes" });
        expect(s).toEqual(DEFAULT_RSVP_CONFIG);
    });

    it("turns the old OFF switches into 0 values, which mean off now", () => {
        const off = parseRsvpSettings({
            longWordDelay: false,
            punctuationPause: false,
            longWordMultiplier: 1.5,
            punctuationDelayMs: 300,
        });
        expect(off.longWordMultiplier).toBe(0);
        expect(off.punctuationDelayMs).toBe(0);
        const on = parseRsvpSettings({
            longWordDelay: true,
            punctuation_pause: true,
            longWordMultiplier: 1.5,
            punctuationDelayMs: 300,
        });
        expect(on.longWordMultiplier).toBe(1.5);
        expect(on.punctuationDelayMs).toBe(300);
    });

    it("turns the countdown on for older settings that had a time set", () => {
        expect(parseRsvpSettings({ timerMinutes: 5 }).timerEnabled).toBe(true);
        expect(parseRsvpSettings({ timerMinutes: 0, timerSeconds: 0 }).timerEnabled).toBe(false);
        expect(parseRsvpSettings({ timerMinutes: 5, timerEnabled: false }).timerEnabled).toBe(false);
    });
});
