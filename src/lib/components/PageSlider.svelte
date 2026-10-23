<script lang="ts">
    import { currentPage, readerTotalPages, rsvpWordOffset, wordHighlight } from "$lib/stores";

    // Slider under the page for jumping anywhere in the book. While dragging
    // it shows the target page; the jump happens on release, so dragging
    // doesn't lay out every chapter it passes over.
    let dragging = $state<number | null>(null);
    let value = $derived(dragging ?? $currentPage + 1);

    function onInput(e: Event) {
        dragging = Number((e.target as HTMLInputElement).value);
    }

    function onChange(e: Event) {
        const page = Number((e.target as HTMLInputElement).value) - 1;
        dragging = null;
        if (page === $currentPage) return;
        currentPage.set(page);
        rsvpWordOffset.set(0);
        wordHighlight.set(false);
    }

    function onKeyDown(e: KeyboardEvent) {
        // The focused slider moves one page per arrow key itself; don't let
        // the reader's own arrow-key handler turn a second page.
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
    }
</script>

{#if $readerTotalPages > 1}
    <div class="page-slider">
        <input
            type="range"
            min="1"
            max={$readerTotalPages}
            step="1"
            {value}
            oninput={onInput}
            onchange={onChange}
            onkeydown={onKeyDown}
            aria-label="Page"
        />
        {#if dragging !== null}
            <span class="target">Page {dragging} of {$readerTotalPages}</span>
        {/if}
    </div>
{/if}

<style>
    .page-slider {
        position: relative;
        padding: 0.35rem 1rem;
        background: #111;
        border-top: 1px solid #222;
        flex-shrink: 0;
    }

    input[type="range"] {
        display: block;
        width: 100%;
        margin: 0;
        accent-color: #6a9cf5;
        cursor: pointer;
    }

    .target {
        position: absolute;
        right: 1rem;
        bottom: calc(100% + 0.4rem);
        padding: 0.2rem 0.6rem;
        border-radius: 6px;
        background: #1a2a40;
        color: #6a9cf5;
        font-size: 0.85rem;
        pointer-events: none;
    }
</style>
