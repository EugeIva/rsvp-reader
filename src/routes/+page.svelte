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
        rsvpConfig,
        pageStart,
        pageCountCache,
    } from "$lib/stores";
    import { saveState } from "$lib/utils/persistence";
    import { invoke } from "@tauri-apps/api/core";
    import { getCurrentWindow } from "@tauri-apps/api/window";
    import { tick } from "svelte";
    import { dbg, logError } from "$lib/utils/debug";

    dbg("boot: +page module loaded");

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
            getCurrentWindow().setTitle(b.title || "rsvp-reader");
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
        $rsvpConfig;
        $pageStart;
        $pageCountCache;
        windowSizeTick;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            await tick();
            // Nothing to save until the book's first page has been laid out;
            // saving earlier would overwrite the saved position.
            const start = $pageStart;
            if (!$book || !start) return;
            const c = $rsvpConfig;
            await saveState($book.id, {
                page: $currentPage,
                rsvpWordOffset: $rsvpWordOffset,
                fontSize: $fontSize,
                windowWidth: window.innerWidth,
                windowHeight: window.innerHeight,
                wpm: c.wpm,
                longWordDelay: c.longWordDelay,
                longWordMultiplier: c.longWordMultiplier,
                punctuationPause: c.punctuationPause,
                punctuationDelayMs: c.punctuationDelayMs,
                complexityWeight: c.complexityWeight,
                timerMinutes: c.timerMinutes,
                timerSeconds: c.timerSeconds,
                anchor: { chapter: start.chapter, word: start.word + $rsvpWordOffset },
                pageCounts: $pageCountCache ?? undefined,
            });
        }, 300);
    });
</script>

{#if !$book}
    <Library />
{:else if $rsvpActive}
    <RSVPReader />
{:else}
    <Reader />
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
</style>
