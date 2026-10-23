import { openEpub } from "$lib/commands";
import {
    book,
    currentPage,
    fontSize,
    rsvpConfig,
    rsvpWordOffset,
    rsvpActive,
    pageStart,
    pendingWordAnchor,
    legacyPage,
    pageCountCache,
} from "$lib/stores";
import { DEFAULT_RSVP_CONFIG } from "$lib/utils/rsvp";
import { loadState } from "$lib/utils/persistence";
import { clearImageSizeCache } from "$lib/utils/columns";

const LAST_PATH_KEY = "rsvp-reader:lastPath";

/** Path of the last book opened, or null. */
export function lastOpenedPath(): string | null {
    try {
        return localStorage.getItem(LAST_PATH_KEY);
    } catch {
        return null;
    }
}

/**
 * Open a book and restore its saved state. The state is applied before the
 * book store is set, so the reader lays out the right chapter at the right
 * font size from the start instead of racing the restore. Throws if the file
 * can't be opened as an EPUB.
 */
export async function openBook(path: string): Promise<void> {
    const meta = await openEpub(path);
    const saved = await loadState(meta.id, path);

    clearImageSizeCache();
    rsvpActive.set(false);
    currentPage.set(0);
    rsvpWordOffset.set(0);
    pageStart.set(null);
    pendingWordAnchor.set(saved?.anchor ?? null);
    legacyPage.set(saved && !saved.anchor && saved.page > 0 ? saved.page : null);
    pageCountCache.set(saved?.pageCounts ?? null);
    if (saved) {
        fontSize.set(saved.fontSize);
        rsvpConfig.set({
            ...DEFAULT_RSVP_CONFIG,
            wpm: saved.wpm,
            longWordDelay: saved.longWordDelay,
            longWordMultiplier: saved.longWordMultiplier,
            punctuationPause: saved.punctuationPause,
            punctuationDelayMs: saved.punctuationDelayMs,
            complexityWeight: saved.complexityWeight,
            timerMinutes: saved.timerMinutes,
            timerSeconds: saved.timerSeconds,
        });
    }

    try {
        localStorage.setItem(LAST_PATH_KEY, path);
    } catch {
        /* best-effort */
    }
    book.set({
        id: meta.id,
        title: meta.title,
        author: meta.author,
        spineCount: meta.spine_count,
        filePath: path,
    });
}
