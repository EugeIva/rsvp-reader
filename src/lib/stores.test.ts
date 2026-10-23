import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
    chapterPageCounts,
    currentPage,
    chapterStartPage,
    locatePage,
    updatePageCounts,
    backStack,
    pushBack,
    popBack,
    readingAnchor,
} from "./stores";
import { tokenIndexOfWord } from "./utils/rsvp";

describe("page location helpers", () => {
    it("finds a chapter's first page and a page's chapter and column", () => {
        const counts = [2, 3, 1];
        expect(chapterStartPage(counts, 0)).toBe(0);
        expect(chapterStartPage(counts, 2)).toBe(5);
        expect(locatePage(counts, 0)).toEqual({ chapter: 0, column: 0 });
        expect(locatePage(counts, 4)).toEqual({ chapter: 1, column: 2 });
        expect(locatePage(counts, 99)).toEqual({ chapter: 2, column: 0 });
    });
});

describe("updatePageCounts", () => {
    beforeEach(() => {
        chapterPageCounts.set([1, 1, 1, 1]);
        currentPage.set(0);
    });

    it("keeps the same chapter and column when an earlier chapter's count changes", () => {
        chapterPageCounts.set([1, 1, 5, 1]);
        currentPage.set(4); // chapter 2, column 2
        updatePageCounts((cs) => cs.map((c, i) => (i === 0 ? 40 : c)));
        expect(get(chapterPageCounts)).toEqual([40, 1, 5, 1]);
        expect(get(currentPage)).toBe(43); // still chapter 2, column 2
    });

    it("does not move when a later chapter's count changes", () => {
        currentPage.set(1);
        updatePageCounts((cs) => cs.map((c, i) => (i === 3 ? 9 : c)));
        expect(get(currentPage)).toBe(1);
    });

    it("clamps the column when the current chapter gets fewer pages", () => {
        chapterPageCounts.set([1, 6, 1]);
        currentPage.set(6); // chapter 1, column 5
        updatePageCounts((cs) => cs.map((c, i) => (i === 1 ? 3 : c)));
        expect(get(currentPage)).toBe(3); // chapter 1, last column
    });

    it("leaves everything alone when the updater returns the same array", () => {
        currentPage.set(2);
        const before = get(chapterPageCounts);
        updatePageCounts((cs) => cs);
        expect(get(chapterPageCounts)).toBe(before);
        expect(get(currentPage)).toBe(2);
    });
});

describe("back stack (following footnotes)", () => {
    beforeEach(() => backStack.set([]));

    it("returns positions in reverse order, so chained notes lead back step by step", () => {
        pushBack({ anchor: { chapter: 2, word: 120 }, page: 30 });
        pushBack({ anchor: { chapter: 9, word: 4 }, page: 210 });
        expect(popBack()).toEqual({ anchor: { chapter: 9, word: 4 }, page: 210 });
        expect(popBack()).toEqual({ anchor: { chapter: 2, word: 120 }, page: 30 });
        expect(popBack()).toBeNull();
        expect(get(backStack)).toEqual([]);
    });
});

describe("readingAnchor (saved position from page start + RSVP token offset)", () => {
    // RSVP tokens: he, said, then, left  ("—" is glued to "said").
    const start = { chapter: 4, word: 100, words: ["he", "said", "—", "then", "left."] };

    it("maps the RSVP token to the right page word, not token-for-word", () => {
        expect(readingAnchor(start, 0)).toEqual({ chapter: 4, word: 100 });
        expect(readingAnchor(start, 2)).toEqual({ chapter: 4, word: 103 }); // "then", not "—"
        expect(readingAnchor(start, 3)).toEqual({ chapter: 4, word: 104 });
    });

    it("round-trips back to the same RSVP token", () => {
        for (const token of [0, 1, 2, 3]) {
            const word = readingAnchor(start, token).word - start.word;
            expect(tokenIndexOfWord(start.words, word)).toBe(token);
        }
    });

    it("falls back to the page start when the page's words aren't known", () => {
        expect(readingAnchor({ chapter: 1, word: 7, words: [] }, 5)).toEqual({ chapter: 1, word: 7 });
    });
});
