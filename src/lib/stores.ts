import { writable, derived, get } from "svelte/store";
import type { RsvpConfig } from "$lib/utils/rsvp";
import { DEFAULT_RSVP_CONFIG } from "$lib/utils/rsvp";

export interface BookState {
    // Content id; saved state is keyed by it rather than by filePath.
    id: string;
    title: string;
    author: string;
    spineCount: number;
    filePath: string;
}

export interface ReaderMetrics {
    pageW: number;
    pageH: number;
    fontSizeRem: number;
}

/** A position in the book that doesn't depend on layout: word `word` of chapter `chapter`. */
export interface WordAnchor {
    chapter: number;
    word: number;
}

/** Per-chapter page counts for the whole book, measured at one layout (`key`). */
export interface PageCountCache {
    key: string;
    counts: number[];
}

export const book = writable<BookState | null>(null);
export const currentPage = writable(0);
// One entry per chapter; "" until that chapter's HTML has been fetched.
export const chapterHtmls = writable<string[]>([]);
// True once every chapter's HTML is in chapterHtmls.
export const chapterHtmlsLoaded = writable(false);
export const chapterPageCounts = writable<number[]>([]);
export const fontSize = writable(1.2);

export const readerTotalPages = derived(chapterPageCounts, ($counts) =>
    $counts.length ? $counts.reduce((a, b) => a + b, 0) : 0
);

// First word of the page currently shown (page or RSVP mode); null until a
// page has been laid out. Saved as the reading position, together with
// rsvpWordOffset.
export const pageStart = writable<WordAnchor | null>(null);
// Position to bring on screen once its chapter has been laid out (restoring a
// saved position, or keeping the place across a relayout).
export const pendingWordAnchor = writable<WordAnchor | null>(null);
// Saved position from before anchors existed: a global page number, applied
// once every chapter's page count is known.
export const legacyPage = writable<number | null>(null);
export const pageCountCache = writable<PageCountCache | null>(null);

export const rsvpActive = writable(false);
export const rsvpWordOffset = writable(0);
export const rsvpConfig = writable<RsvpConfig>({ ...DEFAULT_RSVP_CONFIG });

// Column-based word snippets per column of the chapter where RSVP entered,
// plus which chapter those belong to. Used by RSVPReader as its source of
// token text (keeps RSVP aligned with the page-mode columns).
export const rsvpColumnTexts = writable<string[]>([]);
export const rsvpColumnChapter = writable(-1);

// Snapshot of reader metrics so RSVP can measure other chapters' columns
// offscreen while page mode is unmounted.
export const readerMetrics = writable<ReaderMetrics>({ pageW: 0, pageH: 0, fontSizeRem: 1.2 });

/** Global page number of the first page of `chapter`. */
export function chapterStartPage(counts: number[], chapter: number): number {
    let page = 0;
    for (let ci = 0; ci < chapter && ci < counts.length; ci++) page += counts[ci];
    return page;
}

/** Chapter and column (page within the chapter) of a global page number. */
export function locatePage(counts: number[], page: number): { chapter: number; column: number } {
    let acc = 0;
    for (let ci = 0; ci < counts.length; ci++) {
        if (page < acc + counts[ci]) return { chapter: ci, column: page - acc };
        acc += counts[ci];
    }
    const last = counts.length - 1;
    return { chapter: Math.max(0, last), column: Math.max(0, (counts[last] ?? 1) - 1) };
}

/**
 * Change page counts while staying on the same chapter and column. The
 * global page number shifts whenever an earlier chapter's count changes
 * (for example as background measuring replaces estimates), so every count
 * update goes through here instead of setting chapterPageCounts directly.
 */
export function updatePageCounts(fn: (counts: number[]) => number[]): void {
    const before = get(chapterPageCounts);
    const after = fn(before);
    if (after === before) return;
    const loc = before.length ? locatePage(before, get(currentPage)) : null;
    chapterPageCounts.set(after);
    if (loc && after.length) {
        const chapter = Math.min(loc.chapter, after.length - 1);
        const page = chapterStartPage(after, chapter) + Math.min(loc.column, after[chapter] - 1);
        if (page !== get(currentPage)) currentPage.set(page);
    }
}

/** Resolves once every chapter's HTML has been fetched. */
export function whenChapterHtmlsLoaded(): Promise<void> {
    return new Promise((resolve) => {
        const unsubscribe = chapterHtmlsLoaded.subscribe((loaded) => {
            if (!loaded) return;
            queueMicrotask(() => unsubscribe());
            resolve();
        });
    });
}
