<script lang="ts">
    import Library from "$lib/components/Library.svelte";
    import Reader from "$lib/components/Reader.svelte";
    import RSVPReader from "$lib/components/RSVPReader.svelte";
    import { book, rsvpActive, currentPage, rsvpWordOffset, fontSize, rsvpConfig, pageStart, pageCountCache } from "$lib/stores";
    import { saveState } from "$lib/utils/persistence";
    import { invoke } from "@tauri-apps/api/core";
    import { getCurrentWindow } from "@tauri-apps/api/window";
    import { tick } from "svelte";
    import { dbg } from "$lib/utils/debug";

    dbg("boot: +page module loaded");

    $effect(() => {
        const flushErrors = async () => {
            const errs = (window as any).__rsvpErrors;
            if (!errs || !errs.length) return;
            (window as any).__rsvpErrors = [];
            for (const m of errs) {
                try { dbg("page-error: " + m); } catch {}
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
    let windowSizeTick = $state(0);

    $effect(() => {
        const onResize = () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            console.log("win:resize", w + "x" + h);
            invoke("save_window_size", { w, h }).catch(() => {});
            windowSizeTick++;
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
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
            await saveState($book.filePath, {
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
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
            Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
        font-size: 16px;
        line-height: 1.5;
        color: #e0e0e0;
        background: #000;
        -webkit-font-smoothing: antialiased;
    }
</style>