import { openBookFile } from "$lib/commands";
import {
    book,
    currentPage,
    rsvpWordOffset,
    rsvpActive,
    pageStart,
    wordHighlight,
    backStack,
    pendingWordAnchor,
    legacyPage,
    pageCountCache,
} from "$lib/stores";
import { loadState } from "$lib/utils/persistence";
import { loadSettings, adoptLegacySettings } from "$lib/utils/settings";
import { clearImageSizeCache } from "$lib/utils/columns";

const LAST_PATH_KEY = "rsvp-reader:lastPath";

/** Book file extensions the app opens (also in the open dialog and Finder registration). */
export const BOOK_EXTENSIONS = [".epub", ".fb2", ".fb2.zip", ".txt", ".mobi", ".azw3", ".azw", ".prc"];

/** The first path that names a book file (case-insensitive extension), or null. */
export function firstBookPath(paths: string[]): string | null {
    return paths.find((p) => BOOK_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))) ?? null;
}

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
 * can't be opened as an EPUB, FB2, MOBI or TXT book.
 */
export async function openBook(path: string): Promise<void> {
    const meta = await openBookFile(path);
    const saved = await loadState(meta.id, path);
    await loadSettings();

    clearImageSizeCache();
    rsvpActive.set(false);
    currentPage.set(0);
    rsvpWordOffset.set(0);
    pageStart.set(null);
    wordHighlight.set(false);
    backStack.set([]);
    pendingWordAnchor.set(saved?.anchor ?? null);
    legacyPage.set(saved && !saved.anchor && saved.page > 0 ? saved.page : null);
    pageCountCache.set(saved?.pageCounts ?? null);
    // RSVP settings and font size are global; a book saved by an older
    // version may carry its own, which seed the global ones if there are none
    // yet.
    adoptLegacySettings(saved);

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
