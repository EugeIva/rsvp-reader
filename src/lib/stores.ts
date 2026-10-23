import { writable, derived } from "svelte/store";
import type { RsvpConfig } from "$lib/utils/rsvp";
import { DEFAULT_RSVP_CONFIG } from "$lib/utils/rsvp";

export interface BookState {
    title: string;
    author: string;
    spineCount: number;
    filePath: string;
    chapterWordCounts: number[];
}

export interface ReaderMetrics {
    pageW: number;
    pageH: number;
    fontSizeRem: number;
}

export const book = writable<BookState | null>(null);
export const currentPage = writable(0);
export const chapterHtmls = writable<string[]>([]);
export const chapterPageCounts = writable<number[]>([]);
export const fontSize = writable(1.2);

export const readerTotalPages = derived(chapterPageCounts, ($counts) =>
    $counts.length ? $counts.reduce((a, b) => a + b, 0) : 0
);

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