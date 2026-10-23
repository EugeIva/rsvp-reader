// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { firstEpubPath } from "./openBook";

describe("firstEpubPath (dropped files)", () => {
    it("picks the first EPUB, whatever the extension's case", () => {
        expect(firstEpubPath(["/a/notes.txt", "/b/Book.EPUB", "/c/other.epub"])).toBe("/b/Book.EPUB");
    });

    it("ignores drops without an EPUB", () => {
        expect(firstEpubPath(["/a/cover.jpg", "/b/book.epub.zip", "/c/epub"])).toBeNull();
        expect(firstEpubPath([])).toBeNull();
    });
});
