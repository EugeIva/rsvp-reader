<script lang="ts">
    import { open } from "@tauri-apps/plugin-dialog";
    import { openEpub } from "$lib/commands";
    import { book, isLoading, error, currentPage, rsvpWordOffset, fontSize, rsvpConfig } from "$lib/stores";
    import { loadState, saveState } from "$lib/utils/persistence";

    let spinner = $state(false);
    let errMsg = $state<string | null>(null);
    let initDone = $state(false);

    $effect(() => {
        if (initDone) return;
        initDone = true;
        autoOpen();
    });

    async function autoOpen() {
        let lastPath: string | null = null;
        try { lastPath = localStorage.getItem("rsvp-reader:lastPath"); } catch {}
        if (!lastPath) return;
        spinner = true;
        try {
            const meta = await openEpub(lastPath);
            book.set({
                title: meta.title,
                author: meta.author,
                spineCount: meta.spine_count,
                filePath: lastPath,
                chapterWordCounts: meta.chapter_word_counts,
            });
            error.set(null);
            currentPage.set(0);
            rsvpWordOffset.set(0);
            // non-blocking state restore
            restoreState(lastPath);
        } catch {
            // file missing or corrupted — stay on welcome screen
        } finally {
            spinner = false;
            isLoading.set(false);
        }
    }

    async function restoreState(path: string) {
        try {
            const saved = await loadState(path);
            if (!saved) {
                console.log("persist:restoreState no saved state");
                return;
            }
            console.log("persist:restoreState from file", { page: saved.page, font: saved.fontSize });

            currentPage.set(saved.page);
            rsvpWordOffset.set(saved.rsvpWordOffset);
            fontSize.set(saved.fontSize);
            rsvpConfig.set({
                wpm: saved.wpm,
                longWordDelay: saved.longWordDelay,
                longWordMultiplier: saved.longWordMultiplier,
                punctuationPause: saved.punctuationPause,
                punctuationDelayMs: saved.punctuationDelayMs,
                longWordThreshold: 7,
                complexityWeight: saved.complexityWeight,
                timerMinutes: saved.timerMinutes,
                timerSeconds: saved.timerSeconds,
            });
            await saveState(path, {
                page: saved.page,
                rsvpWordOffset: saved.rsvpWordOffset,
                fontSize: saved.fontSize,
                windowWidth: saved.windowWidth,
                windowHeight: saved.windowHeight,
                wpm: saved.wpm,
                longWordDelay: saved.longWordDelay,
                longWordMultiplier: saved.longWordMultiplier,
                punctuationPause: saved.punctuationPause,
                punctuationDelayMs: saved.punctuationDelayMs,
                complexityWeight: saved.complexityWeight,
                timerMinutes: saved.timerMinutes,
                timerSeconds: saved.timerSeconds,
            });
        } catch { /* state restore is best-effort */ }
    }

    async function handleOpen() {
        const selected = await open({
            multiple: false,
            filters: [{ name: "EPUB", extensions: ["epub"] }],
        });
        if (!selected) return;

        spinner = true;
        errMsg = null;
        try {
            const meta = await openEpub(selected);
            book.set({
                title: meta.title,
                author: meta.author,
                spineCount: meta.spine_count,
                filePath: selected,
                chapterWordCounts: meta.chapter_word_counts,
            });
            error.set(null);
            currentPage.set(0);
            rsvpWordOffset.set(0);
            try { localStorage.setItem("rsvp-reader:lastPath", selected); } catch {}
            restoreState(selected);
        } catch (e) {
            errMsg = String(e);
            error.set(errMsg);
        } finally {
            spinner = false;
            isLoading.set(false);
        }
    }
</script>

<div class="welcome">
    <h1>rsvp-reader</h1>
    <p class="tagline">Open an EPUB file to start reading</p>
    <button class="open-btn" onclick={handleOpen} disabled={spinner}>
        {spinner ? "Loading..." : "Open EPUB"}
    </button>
    {#if errMsg}
        <p class="error">{errMsg}</p>
    {/if}
</div>

<style>
    .welcome {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100vh;
        text-align: center;
    }

    h1 {
        font-size: 2.5rem;
        margin-bottom: 0.5rem;
    }

    .tagline {
        color: #888;
        margin-bottom: 2rem;
    }

    .open-btn {
        font-size: 1.1rem;
        padding: 0.8rem 2rem;
        border-radius: 8px;
        border: 1px solid #396cd8;
        background: #396cd8;
        color: #fff;
        cursor: pointer;
    }

    .open-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .open-btn:hover:not(:disabled) {
        background: #2a56b3;
    }

    .error {
        color: #c00;
        margin-top: 1rem;
        padding: 0.5rem;
        background: #fee;
        border-radius: 6px;
    }

    @media (prefers-color-scheme: dark) {
        .error {
            background: #3a1a1a;
            color: #f66;
        }
    }
</style>