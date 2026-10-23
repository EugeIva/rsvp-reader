<script lang="ts">
    import { book, currentPage, readerTotalPages, rsvpActive, rsvpConfig } from "$lib/stores";
    import { RsvpPlayback } from "$lib/rsvp/playback.svelte";
    import Controls from "./Controls.svelte";
    import CountdownTimer from "./CountdownTimer.svelte";
    import { untrack } from "svelte";

    const playback = new RsvpPlayback();

    $effect(() => {
        if (!$rsvpActive) return;
        const page = $currentPage;
        untrack(() => {
            const wasPlaying = playback.playing;
            playback.loadColumn(page, wasPlaying);
        });
    });

    function onKeyDown(e: KeyboardEvent) {
        if (e.key === "a" || e.key === "A") {
            e.preventDefault();
            playback.stop();
        }
        if (e.key === " ") {
            e.preventDefault();
            if (e.repeat) return;
            playback.togglePlay();
        }
    }

    $effect(() => {
        const cfg = $rsvpConfig;
        untrack(() => playback.updateConfig(cfg));
    });
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="rsvp-reader">
    <div class="toolbar">
        <span class="title">{$book?.title ?? "rsvp-reader"}</span>
        <div class="spacer"></div>
        <span class="page-num">Page {$currentPage + 1} / {$readerTotalPages}</span>
        <button class="exit-btn" onclick={() => playback.stop()}>Page mode (A)</button>
    </div>

    <div
        class="word-area"
        role="button"
        tabindex="0"
        onclick={() => playback.togglePlay()}
        onkeydown={(e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                playback.togglePlay();
            }
        }}
    >
        {#if playback.currentToken}
            {@const currentToken = playback.currentToken}
            <div class="word-display">
                {#if currentToken.isWord}
                    {#if currentToken.quotePrefix}<span class="quote-prefix">{currentToken.quotePrefix}</span>{/if}
                    <span class="pre">{currentToken.text.slice(0, currentToken.orpIndex)}</span>
                    <span class="orp">{currentToken.text[currentToken.orpIndex]}</span>
                    <span class="post">{currentToken.text.slice(currentToken.orpIndex + 1)}</span>
                    {#if currentToken.punctSuffix}<span class="punct-suffix">{currentToken.punctSuffix}</span>{/if}
                {:else}
                    <span class="punct">{currentToken.text}</span>
                {/if}
            </div>
        {:else}
            <div class="placeholder">No text</div>
        {/if}

        <div class="play-hint">
            {playback.playing ? "Click or Space to pause" : "Click or Space to play"}
        </div>
    </div>

    <div class="bottom-panel">
        <div class="play-bar">
            <button class="play-btn" onclick={() => playback.togglePlay()}>
                {playback.playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <CountdownTimer countdown={playback.countdown} started={playback.started} playing={playback.playing} />
            <span class="progress">{playback.currentIdx + 1} / {playback.tokens.length} words</span>
        </div>
        <Controls />
    </div>
</div>

<style>
    .rsvp-reader {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: #000;
        color: #e0e0e0;
    }

    .toolbar {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.5rem 1rem;
        background: #111;
        border-bottom: 1px solid #222;
        flex-shrink: 0;
    }

    .title {
        font-weight: 600;
        font-size: 0.95rem;
    }

    .spacer {
        flex: 1;
    }

    .page-num {
        font-size: 0.85rem;
        color: #888;
    }

    .exit-btn {
        padding: 0.3rem 0.8rem;
        border: 1px solid #444;
        border-radius: 6px;
        background: transparent;
        color: #e0e0e0;
        cursor: pointer;
        font-size: 0.85rem;
    }

    .exit-btn:hover {
        border-color: #6a9cf5;
        color: #6a9cf5;
    }

    .word-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
    }

    .word-display {
        font-family: Georgia, "Times New Roman", serif;
        font-size: 3rem;
        line-height: 1.3;
    }

    .pre {
        color: #e0e0e0;
    }
    .orp {
        color: #f55;
    }
    .post {
        color: #e0e0e0;
    }
    .punct-suffix {
        color: #e0e0e0;
    }
    .quote-prefix {
        color: #e0e0e0;
    }
    .punct {
        color: #888;
        font-size: 2rem;
    }

    .placeholder {
        font-size: 1.2rem;
        color: #888;
    }

    .play-hint {
        margin-top: 2rem;
        font-size: 0.8rem;
        color: #555;
    }

    .bottom-panel {
        border-top: 1px solid #222;
        background: #111;
        flex-shrink: 0;
    }

    .play-bar {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.5rem 1rem;
        border-bottom: 1px solid #222;
    }

    .play-btn {
        padding: 0.3rem 1rem;
        border: 1px solid #444;
        border-radius: 6px;
        background: #1a1a1a;
        color: #e0e0e0;
        cursor: pointer;
        font-size: 0.85rem;
    }

    .play-btn:hover {
        border-color: #6a9cf5;
        color: #6a9cf5;
    }

    .progress {
        font-size: 0.85rem;
        color: #888;
    }
</style>
