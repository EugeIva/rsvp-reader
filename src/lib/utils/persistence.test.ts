import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { loadState } from "./persistence";

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
        const s = await loadState("/book.epub");
        expect(s?.anchor).toEqual({ chapter: 3, word: 120 });
        expect(s?.pageCounts).toEqual({ key: "2|600x700|1.2", counts: [4, 10, 2] });
    });

    it("leaves them out for states saved by older versions", async () => {
        invoke.mockResolvedValue({ page: 7 });
        const s = await loadState("/book.epub");
        expect(s?.page).toBe(7);
        expect(s?.anchor).toBeUndefined();
        expect(s?.pageCounts).toBeUndefined();
    });

    it("ignores malformed values", async () => {
        invoke.mockResolvedValue({
            anchor: { chapter: -1, word: "x" },
            pageCounts: { key: "k", counts: [3, 0] },
        });
        const s = await loadState("/book.epub");
        expect(s?.anchor).toBeUndefined();
        expect(s?.pageCounts).toBeUndefined();
    });
});
