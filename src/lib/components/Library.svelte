<script lang="ts">
    import { open } from "@tauri-apps/plugin-dialog";
    import { openBook, lastOpenedPath } from "$lib/utils/openBook";
    import { takePendingOpen } from "$lib/commands";

    let spinner = $state(false);
    let errMsg = $state<string | null>(null);
    let initDone = $state(false);

    $effect(() => {
        if (initDone) return;
        initDone = true;
        autoOpen();
    });

    async function autoOpen() {
        // A book opened from Finder at launch comes first, else the last one read.
        const pending = await takePendingOpen().catch(() => null);
        const lastPath = pending ?? lastOpenedPath();
        if (!lastPath) return;
        spinner = true;
        try {
            await openBook(lastPath);
        } catch {
            // file missing or corrupted — stay on welcome screen
        } finally {
            spinner = false;
        }
    }

    async function handleOpen() {
        const selected = await open({
            multiple: false,
            filters: [{ name: "Books (EPUB, FB2)", extensions: ["epub", "fb2", "zip"] }],
        });
        if (!selected) return;

        spinner = true;
        errMsg = null;
        try {
            await openBook(selected);
        } catch (e) {
            errMsg = String(e);
        } finally {
            spinner = false;
        }
    }
</script>

<div class="welcome">
    <h1>rsvp-reader</h1>
    <p class="tagline">Open an EPUB or FB2 book to start reading</p>
    <button class="open-btn" onclick={handleOpen} disabled={spinner}>
        {spinner ? "Loading..." : "Open a book"}
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
