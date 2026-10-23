import { openEpub } from "$lib/commands";
import {
    book,
    currentPage,
    fontSize,
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

/** The first path that names an EPUB file (case-insensitive extension), or null. */
export function firstEpubPath(paths: string[]): string | null {
    return paths.find((p) => p.toLowerCase().endsWith(".epub")) ?? null;
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
 * can't be opened as an EPUB.
 */
export async function openBook(path: string): Promise<void> {
    const meta = await openEpub(path);
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
    if (saved) fontSize.set(saved.fontSize);
    // RSVP settings are global; a book saved by an older version may carry
    // its own, which seed the global settings if there are none yet.
    adoptLegacySettings(saved?.rsvp);

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
