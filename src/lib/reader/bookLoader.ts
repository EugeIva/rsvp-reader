import { get } from "svelte/store";
import { getChapterHtml } from "$lib/commands";
import {
    currentPage,
    chapterHtmls,
    chapterHtmlsLoaded,
    chapterPageCounts,
    pendingWordAnchor,
    pageCountCache,
    chapterStartPage,
} from "$lib/stores";
import type { BookState, ReaderMetrics } from "$lib/stores";
import { layoutKey } from "$lib/utils/columns";
import { dbg } from "$lib/utils/debug";

// After the chapter being read, the rest are fetched this many at a time.
const HTML_BATCH = 4;
const CHAPTER_LOAD_FAILED = "<p>This chapter could not be loaded.</p>";

// The book whose chapters are loaded. Module scope, so switching page<->RSVP
// (which unmounts/remounts the reader) doesn't reset the position or
// re-fetch the book. It's the book object, not its path, so reopening the
// same file still reloads.
let loadedBook: BookState | null = null;

/** True if `b` was opened since its chapters were last loaded. */
export function needsLoad(b: BookState): boolean {
    return loadedBook !== b;
}

/** Saved page counts, if they were measured at `metrics`. */
function cachedCounts(n: number, metrics: ReaderMetrics): number[] | null {
    const cache = get(pageCountCache);
    if (!cache || cache.counts.length !== n || metrics.pageW <= 0 || metrics.pageH <= 0) return null;
    return cache.key === layoutKey(metrics) ? cache.counts : null;
}

/**
 * Reset the per-book stores for a newly opened book, start on its saved
 * chapter, and fetch its chapters in the background. Returns whether saved
 * page counts for `metrics` were applied (so no estimates are in use).
 */
export function loadBook(b: BookState, metrics: ReaderMetrics): boolean {
    loadedBook = b;
    const n = b.spineCount;
    const cached = cachedCounts(n, metrics);
    chapterPageCounts.set(cached ? [...cached] : Array(n).fill(1));
    chapterHtmls.set(Array(n).fill(""));
    chapterHtmlsLoaded.set(false);

    // Start on the saved chapter; the exact page is found once it's laid out.
    const anchor = get(pendingWordAnchor);
    const first = anchor && anchor.chapter < n ? anchor.chapter : 0;
    currentPage.set(chapterStartPage(get(chapterPageCounts), first));
    void loadChapterHtmls(b, first);
    return cached !== null;
}

/** Fetch chapter `first` (the one shown), then the rest in parallel batches. */
async function loadChapterHtmls(b: BookState, first: number) {
    const fetchHtml = (ci: number) =>
        getChapterHtml(ci).catch((e) => {
            dbg(`chapter ${ci}: load failed`, String(e));
            return CHAPTER_LOAD_FAILED;
        });
    const put = (indices: number[], htmls: string[]): boolean => {
        if (loadedBook !== b) return false; // another book was opened meanwhile
        chapterHtmls.update((hs) => {
            const next = [...hs];
            indices.forEach((ci, k) => (next[ci] = htmls[k]));
            return next;
        });
        return true;
    };
    if (!put([first], [await fetchHtml(first)])) return;
    const rest = [...Array(b.spineCount).keys()].filter((ci) => ci !== first);
    for (let i = 0; i < rest.length; i += HTML_BATCH) {
        const batch = rest.slice(i, i + HTML_BATCH);
        if (!put(batch, await Promise.all(batch.map(fetchHtml)))) return;
    }
    chapterHtmlsLoaded.set(true);
}
