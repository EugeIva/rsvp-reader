<script lang="ts">
    import Library from "$lib/components/Library.svelte";
    import Reader from "$lib/components/Reader.svelte";
    import RSVPReader from "$lib/components/RSVPReader.svelte";
    import {
        book,
        rsvpActive,
        currentPage,
        rsvpWordOffset,
        fontSize,
        pageStart,
        pageCountCache,
        readingAnchor,
    } from "$lib/stores";
    import { saveState } from "$lib/utils/persistence";
    import { invoke } from "@tauri-apps/api/core";
    import { getCurrentWindow } from "@tauri-apps/api/window";
    import { getCurrentWebview } from "@tauri-apps/api/webview";
    import { listen } from "@tauri-apps/api/event";
    import { takePendingOpen } from "$lib/commands";
    import { tick } from "svelte";
    import { dbg, logError } from "$lib/utils/debug";
    import { syncSettings } from "$lib/utils/settings";
    import { openBook, firstEpubPath } from "$lib/utils/openBook";

    dbg("boot: +page module loaded");

    // Load the global RSVP settings and save them whenever they change.
    $effect(() => syncSettings());

    // A book opened from Finder (double-click, "Open With") while the app
    // is running. At launch, Library takes it instead of reopening the last book.
    $effect(() => {
        let unlisten: (() => void) | null = null;
        let disposed = false;
        listen("open-file-pending", async () => {
            const path = await takePendingOpen();
            if (path) openBook(path).catch((e) => dbg("finder: open failed", String(e)));
        })
            .then((fn) => {
                if (disposed) fn();
                else unlisten = fn;
            })
            .catch((e) => logError("finder: listen failed", String(e)));
        return () => {
            disposed = true;
            unlisten?.();
        };
    });

    // Open an EPUB dropped onto the window; other files are ignored. The
    // overlay shows only while an EPUB is being dragged over the window.
    let draggingEpub = $state(false);
    $effect(() => {
        let unlisten: (() => void) | null = null;
        let disposed = false;
        getCurrentWebview()
            .onDragDropEvent(({ payload }) => {
                if (payload.type === "enter") {
                    draggingEpub = firstEpubPath(payload.paths) !== null;
                } else if (payload.type === "leave") {
                    draggingEpub = false;
                } else if (payload.type === "drop") {
                    draggingEpub = false;
                    const path = firstEpubPath(payload.paths);
                    if (!path) return;
                    // A file that isn't a readable EPUB is ignored too.
                    openBook(path).catch((e) => dbg("drop: open failed", String(e)));
                }
            })
            .then((fn) => {
                if (disposed) fn();
                else unlisten = fn;
            })
            .catch((e) => logError("drop: listen failed", String(e)));
        return () => {
            disposed = true;
            unlisten?.();
        };
    });

    $effect(() => {
        // Errors trapped by app.html before the app started.
        const w = window as Window & { __rsvpErrors?: string[] };
        const flushErrors = async () => {
            const errs = w.__rsvpErrors;
            if (!errs || !errs.length) return;
            w.__rsvpErrors = [];
            for (const m of errs) {
                try {
                    logError("page-error: " + m);
                } catch {
                    /* logging is best-effort */
                }
            }
        };
        flushErrors();
    });

    $effect(() => {
        const b = $book;
        if (b) {
            getCurrentWindow().setTitle(b.title || "RSVP Reader");
        }
    });

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let windowSizeTimer: ReturnType<typeof setTimeout> | null = null;
    let windowSizeTick = $state(0);

    // Save the window size once a resize settles, not on every resize event.
    $effect(() => {
        const onResize = () => {
            if (windowSizeTimer) clearTimeout(windowSizeTimer);
            windowSizeTimer = setTimeout(() => {
                const w = window.innerWidth;
                const h = window.innerHeight;
                dbg("win:resize", w + "x" + h);
                invoke("save_window_size", { w, h }).catch(() => {});
                windowSizeTick++;
            }, 500);
        };
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            if (windowSizeTimer) clearTimeout(windowSizeTimer);
        };
    });

    $effect(() => {
        const b = $book;
        if (!b) return;
        $currentPage;
        $rsvpWordOffset;
        $fontSize;
        $pageStart;
        $pageCountCache;
        windowSizeTick;
        // Throttle, not debounce: a change schedules one save a second later,
        // and later changes ride along instead of pushing it back. (During
        // RSVP playback the position changes with every word, which kept a
        // debounce from ever firing.)
        if (saveTimer) return;
        saveTimer = setTimeout(async () => {
            saveTimer = null;
            await tick();
            // Nothing to save until the book's first page has been laid out;
            // saving earlier would overwrite the saved position.
            const start = $pageStart;
            if (!$book || !start) return;
            await saveState($book.id, {
                page: $currentPage,
                rsvpWordOffset: $rsvpWordOffset,
                fontSize: $fontSize,
                windowWidth: window.innerWidth,
                windowHeight: window.innerHeight,
                anchor: readingAnchor(start, $rsvpWordOffset),
                pageCounts: $pageCountCache ?? undefined,
            });
        }, 1000);
    });
</script>

{#if !$book}
    <Library />
{:else if $rsvpActive}
    <RSVPReader />
{:else}
    <Reader />
{/if}

{#if draggingEpub}
    <div class="drop-overlay"><span>Drop to open</span></div>
{/if}

<style>
    :global(*) {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    :global(body) {
        font-family:
            -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji",
            "Segoe UI Emoji";
        font-size: 16px;
        line-height: 1.5;
        color: #e0e0e0;
        background: #000;
        -webkit-font-smoothing: antialiased;
    }

    .drop-overlay {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.7);
        border: 3px dashed #6a9cf5;
        pointer-events: none;
        z-index: 100;
    }

    .drop-overlay span {
        font-size: 1.5rem;
        color: #6a9cf5;
    }
</style>
