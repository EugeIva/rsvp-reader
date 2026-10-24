<script lang="ts">
    import { open } from "@tauri-apps/plugin-dialog";
    import { resolveChapterLink } from "$lib/commands";
    import {
        book,
        currentPage,
        chapterHtmls,
        chapterPageCounts,
        readerTotalPages,
        fontSize,
        rsvpActive,
        rsvpWordOffset,
        rsvpColumnTexts,
        rsvpColumnChapter,
        wordHighlight,
        pageStart,
        backStack,
        pushBack,
        popBack,
        readingAnchor,
    } from "$lib/stores";
    import { dbg } from "$lib/utils/debug";
    import { processHtmlDoc, wrapImages, unsizedImages } from "$lib/utils/columns";
    import { openBook } from "$lib/utils/openBook";
    import { needsLoad, loadBook } from "$lib/reader/bookLoader";
    import { Pagination } from "$lib/reader/pagination.svelte";
    import PageSlider from "./PageSlider.svelte";
    import { tick } from "svelte";
    import { openUrl } from "@tauri-apps/plugin-opener";
    import { isModeSwitchKey, isSpaceKey, isBackKey } from "$lib/utils/keys";

    let processedHtml = $state("");
    let processedChapter = $state(-1);
    let containerEl = $state<HTMLElement>();
    let containerWidth = $state(0);
    let effectiveHeight = $state(0);
    let lineHeight = $state(1.5);

    let currentChapter = $derived.by(() => {
        const cs = $chapterPageCounts;
        const p = $currentPage;
        if (!cs.length) return -1;
        let acc = 0;
        for (let ci = 0; ci < cs.length; ci++) {
            if (p < acc + cs[ci]) return ci;
            acc += cs[ci];
        }
        return cs.length - 1;
    });

    let colIndexInChapter = $derived.by(() => {
        const cs = $chapterPageCounts;
        const ci = currentChapter;
        const p = $currentPage;
        if (ci < 0 || !cs.length) return 0;
        let acc = 0;
        for (let k = 0; k < ci; k++) acc += cs[k] || 1;
        return Math.max(0, Math.min(p - acc, (cs[ci] || 1) - 1));
    });

    function flowEl(): HTMLElement | null {
        return containerEl?.querySelector(".epub-flow") as HTMLElement | null;
    }

    const pager = new Pagination({
        flow: flowEl,
        viewport: () => containerEl,
        width: () => containerWidth,
        height: () => effectiveHeight,
        currentChapter: () => currentChapter,
        column: () => colIndexInChapter,
        renderedChapter: () => processedChapter,
    });

    $effect(() => {
        const node = containerEl;
        if (!node) return;
        // Read the size now instead of waiting for the observer's first
        // callback: on remount (returning from RSVP) the chapter HTML can be
        // ready before that, and columnizeCurrent() would skip it, so the
        // un-paginated chapter start was painted until the debounced relayout.
        const rect = node.getBoundingClientRect();
        containerWidth = Math.round(rect.width);
        effectiveHeight = Math.round(rect.height);
        const ro = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            containerWidth = Math.round(width);
            effectiveHeight = Math.round(height);
        });
        ro.observe(node);
        return () => ro.disconnect();
    });

    $effect(() => {
        $book;
        $fontSize;
        containerWidth;
        effectiveHeight;
        if (!$book || containerWidth <= 0 || effectiveHeight <= 0) return;
        pager.scheduleRelayout();
    });

    // Stop background work when page mode unmounts (switching to RSVP).
    $effect(() => () => pager.destroy());

    let bootLogged = false;

    $effect(() => {
        const b = $book;
        if (!b) return;
        if (!bootLogged) {
            bootLogged = true;
            dbg("Reader: mounted, book=" + b.title);
        }
        // Load only when a book was (re)opened: switching page<->RSVP remounts
        // this component with the same book, which must keep its position.
        if (!needsLoad(b)) return;
        processedChapter = -1;
        processedHtml = "";
        const countsKnown = loadBook(b, { pageW: containerWidth, pageH: effectiveHeight, fontSizeRem: $fontSize });
        pager.reset(countsKnown);
    });

    $effect(() => {
        const ci = currentChapter;
        const rawHtml = $chapterHtmls[ci];
        if (ci < 0 || !rawHtml) return;
        if (processedChapter === ci) return;
        processChapterHtml(ci, rawHtml);
    });

    async function processChapterHtml(ci: number, raw: string) {
        const { html } = await processHtmlDoc(raw);
        processedHtml = html;
        processedChapter = ci;
    }

    $effect(() => {
        const h = processedHtml;
        const ci = processedChapter;
        if (!h || ci < 0) return;
        tick().then(() => {
            if (ci !== currentChapter) return;
            const el = flowEl();
            if (!el) return;
            // Wrap before measuring: wrapping changes the layout.
            const wrapped = wrapImages(el);
            if (wrapped > 0) dbg(`wrapImages: ch${ci} wrapped ${wrapped} images`);
            // Images whose size wasn't known up front reflow the page when they load.
            for (const img of unsizedImages(el))
                img.addEventListener("load", () => pager.scheduleRelayout(), { once: true });
            pager.columnizeCurrent();
        });
    });

    $effect(() => {
        $currentPage;
        $chapterPageCounts;
        if (processedChapter !== currentChapter) return;
        tick().then(() => pager.positionCurrent());
    });

    // Redraw the highlight when the RSVP position changes or it's switched on/off.
    $effect(() => {
        $rsvpWordOffset;
        $wordHighlight;
        tick().then(() => pager.updateHighlight());
    });

    function goPrev() {
        if ($currentPage > 0) {
            currentPage.set($currentPage - 1);
            rsvpWordOffset.set(0);
            wordHighlight.set(false);
        }
    }

    function goNext() {
        if ($currentPage < $readerTotalPages - 1) {
            currentPage.set($currentPage + 1);
            rsvpWordOffset.set(0);
            wordHighlight.set(false);
        }
    }

    function changeFont(delta: number) {
        const next = Math.round(($fontSize + delta) * 10) / 10;
        if (next >= 0.6 && next <= 3.0) fontSize.set(next);
    }

    function enterRsvp() {
        if (currentChapter < 0) return;
        const texts = pager.columnTextsByChapter.get(currentChapter);
        if (texts && texts.length) {
            rsvpColumnTexts.set(texts);
            rsvpColumnChapter.set(currentChapter);
        }
        rsvpActive.set(true);
    }

    /** Remember the reading position before following an internal link. */
    function rememberPosition() {
        const start = $pageStart;
        if (!start) return;
        pushBack({ anchor: readingAnchor(start, $rsvpWordOffset), page: $currentPage + 1 });
    }

    /** Return to where the last internal link was followed from. */
    function goBack() {
        const entry = popBack();
        if (!entry) return;
        wordHighlight.set(false);
        pager.goToAnchor(entry.anchor);
    }

    /** Follow a link, or make the clicked word the RSVP starting word. */
    function clickWord(e: MouseEvent) {
        const link = (e.target as HTMLElement).closest("a");
        if (link) {
            e.preventDefault();
            wordHighlight.set(false);
            const href = link.getAttribute("href");
            if (!href) return;
            if (href.startsWith("http://") || href.startsWith("https://")) {
                openUrl(href);
            } else if (href.startsWith("#")) {
                const id = href.slice(1);
                const targetEl = containerEl?.querySelector("#" + CSS.escape(id));
                if (targetEl) {
                    rememberPosition();
                    const flowRect = flowEl()?.getBoundingClientRect();
                    if (flowRect && containerWidth > 0) {
                        const targetRect = targetEl.getBoundingClientRect();
                        const relLeft = targetRect.left - flowRect.left;
                        const pCount = $chapterPageCounts[currentChapter] || 1;
                        const col = Math.max(0, Math.min(pCount - 1, Math.floor(relLeft / containerWidth)));
                        let targetPage = 0;
                        for (let ci = 0; ci < currentChapter; ci++) targetPage += $chapterPageCounts[ci] || 1;
                        targetPage += col;
                        if (targetPage !== $currentPage) currentPage.set(targetPage);
                    }
                    targetEl.scrollIntoView({ block: "start" });
                }
            } else {
                resolveChapterLink(href, currentChapter)
                    .then((resolved) => {
                        rememberPosition();
                        let offset = 0;
                        for (let ci = 0; ci < resolved.chapter_index; ci++) offset += $chapterPageCounts[ci] || 1;
                        pager.pendingAnchor = resolved.anchor;
                        currentPage.set(offset);
                        rsvpWordOffset.set(0);
                    })
                    .catch(() => {});
            }
            return;
        }
        pager.selectWordAt(e.clientX, e.clientY);
    }

    function onKeyDown(e: KeyboardEvent) {
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            goPrev();
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            goNext();
        }
        if (e.key === "9") {
            e.preventDefault();
            changeFont(0.1);
        }
        if (e.key === "0") {
            e.preventDefault();
            changeFont(-0.1);
        }
        if (isModeSwitchKey(e)) {
            e.preventDefault();
            enterRsvp();
        }
        // Space turns the page. preventDefault stops it also pressing a
        // focused button (Prev, Open...); holding it doesn't race ahead.
        if (isBackKey(e)) {
            e.preventDefault();
            goBack();
        }
        if (isSpaceKey(e)) {
            e.preventDefault();
            if (!e.repeat) goNext();
        }
    }

    async function handleOpen() {
        const selected = await open({
            multiple: false,
            filters: [
                {
                    name: "Books (EPUB, FB2, MOBI, AZW3, TXT)",
                    extensions: ["epub", "fb2", "zip", "mobi", "azw3", "azw", "prc", "txt"],
                },
            ],
        });
        if (!selected) return;
        try {
            await openBook(selected);
        } catch (e) {
            dbg("open failed", String(e));
        }
    }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="reader">
    <div class="toolbar">
        <span class="title">{$book?.title ?? "rsvp-reader"}</span>
        <div class="spacer"></div>
        {#if $backStack.length}
            <button class="back-btn" onclick={goBack} title="Back to where the link was followed (⌫)">
                ← Back to page {$backStack[$backStack.length - 1].page}
            </button>
        {/if}
        <button class="rsvp-btn" onclick={enterRsvp}>RSVP (A)</button>
        <button class="open-btn" onclick={handleOpen}>Open</button>
    </div>

    <div class="page-area">
        <div class="epub-viewport" bind:this={containerEl} style="--page-h: {effectiveHeight}px;">
            <div
                class="epub-flow"
                style="font-size: {$fontSize}rem; line-height: {lineHeight};"
                role="button"
                tabindex="0"
                onclick={clickWord}
                onkeydown={(e) => {
                    // Keyboard access: Enter on a focused link follows it (the
                    // browser turns it into a click); elsewhere it starts RSVP.
                    if (e.key === "Enter" && !(e.target as HTMLElement).closest("a")) {
                        e.preventDefault();
                        enterRsvp();
                    }
                }}
            >
                {#if processedHtml}
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify in processHtmlDoc -->
                    {@html processedHtml}
                {:else}
                    <p class="loading-text">Loading…</p>
                {/if}
            </div>
        </div>
    </div>

    <PageSlider />

    <div class="bottom-bar">
        <span class="word-count">{pager.pageWordCount} words</span>
        <span class="page-num">
            {$readerTotalPages > 0
                ? !pager.premeasureDone
                    ? `Page ${$currentPage + 1} of …`
                    : `Page ${$currentPage + 1} of ${$readerTotalPages}`
                : ""}
            &ensp;|&ensp;font {$fontSize}rem
        </span>
        <div class="page-nav">
            <button class="nav-btn" onclick={goPrev} disabled={$currentPage <= 0}> &larr; Prev </button>
            <button class="nav-btn" onclick={goNext} disabled={$currentPage >= $readerTotalPages - 1}>
                Next &rarr;
            </button>
        </div>
    </div>
</div>

<style>
    .reader {
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
    .rsvp-btn {
        padding: 0.3rem 0.8rem;
        border: 1px solid #6a9cf5;
        border-radius: 6px;
        background: #1a2a40;
        color: #6a9cf5;
        cursor: pointer;
        font-size: 0.85rem;
    }
    .rsvp-btn:hover {
        background: #1a3050;
    }
    .back-btn {
        padding: 0.3rem 0.8rem;
        border: 1px solid #6a9cf5;
        border-radius: 6px;
        background: transparent;
        color: #6a9cf5;
        cursor: pointer;
        font-size: 0.85rem;
    }

    .back-btn:hover {
        background: #1a2a40;
    }

    .open-btn {
        padding: 0.3rem 0.8rem;
        border: 1px solid #444;
        border-radius: 6px;
        background: transparent;
        color: #e0e0e0;
        cursor: pointer;
        font-size: 0.85rem;
    }
    .open-btn:hover {
        border-color: #6a9cf5;
        color: #6a9cf5;
    }
    .page-area {
        flex: 1;
        position: relative;
        overflow: hidden;
    }
    .epub-viewport {
        position: absolute;
        inset: 0;
        margin: 1.5rem 2rem;
        overflow-y: hidden;
        overflow-x: auto;
        box-sizing: border-box;
        scrollbar-width: none;
    }
    .epub-viewport::-webkit-scrollbar {
        display: none;
    }
    .loading-text {
        color: #666;
        font-size: 1rem;
    }
    .bottom-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 1rem;
        background: #111;
        border-top: 1px solid #222;
        flex-shrink: 0;
    }
    .word-count {
        font-size: 0.8rem;
        color: #666;
    }
    .page-num {
        font-size: 0.85rem;
        color: #888;
    }
    .page-nav {
        display: flex;
        gap: 0.5rem;
    }
    .nav-btn {
        padding: 0.3rem 0.8rem;
        border: 1px solid #444;
        border-radius: 6px;
        background: #1a1a1a;
        color: #e0e0e0;
        cursor: pointer;
        font-size: 0.85rem;
    }
    .nav-btn:hover:not(:disabled) {
        border-color: #6a9cf5;
        color: #6a9cf5;
    }
    .nav-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
    }
</style>
