// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { firstBookPath } from "./openBook";

describe("firstBookPath (dropped files)", () => {
    it("picks the first book, whatever the extension's case", () => {
        expect(firstBookPath(["/a/notes.md", "/b/Book.EPUB", "/c/other.epub"])).toBe("/b/Book.EPUB");
    });

    it("accepts Kindle books", () => {
        expect(firstBookPath(["/a/notes.md", "/b/Книга.AZW3"])).toBe("/b/Книга.AZW3");
        expect(firstBookPath(["/a/book.mobi"])).toBe("/a/book.mobi");
        expect(firstBookPath(["/a/book.prc"])).toBe("/a/book.prc");
    });

    it("accepts plain text", () => {
        expect(firstBookPath(["/a/cover.jpg", "/b/Рассказ.TXT"])).toBe("/b/Рассказ.TXT");
    });

    it("accepts FB2 and zipped FB2", () => {
        expect(firstBookPath(["/a/cover.jpg", "/b/Книга.FB2"])).toBe("/b/Книга.FB2");
        expect(firstBookPath(["/b/книга.fb2.zip"])).toBe("/b/книга.fb2.zip");
    });

    it("ignores drops without a book", () => {
        expect(firstBookPath(["/a/cover.jpg", "/b/book.epub.zip", "/c/epub", "/d/archive.zip"])).toBeNull();
        expect(firstBookPath([])).toBeNull();
    });
});
