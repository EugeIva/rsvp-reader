<script context="module">
    // Module-scope guard: survives component unmount/remount (page<->RSVP
    // switching) so we don't reset to page 1 or re-fetch the book. Holds the
    // book object (not its path), so reopening the same file still rebuilds.
    let lastLoadedBook: unknown = null;
</script>

<script lang="ts">
    import { open } from "@tauri-apps/plugin-dialog";
    import { getChapterHtml, resolveChapterLink } from "$lib/commands";
    import {
        book, currentPage, chapterHtmls, chapterHtmlsLoaded, chapterPageCounts, readerTotalPages,
        fontSize, rsvpActive, rsvpWordOffset,
        rsvpColumnTexts, rsvpColumnChapter, readerMetrics,
        pageStart, pendingWordAnchor, legacyPage, pageCountCache,
        chapterStartPage, updatePageCounts, whenChapterHtmlsLoaded,
    } from "$lib/stores";
    import type { BookState, ReaderMetrics } from "$lib/stores";
    import { dbg } from "$lib/utils/debug";
    import {
        processHtmlDoc, paginateFlow, extractColumnWords, measureOffscreenPages,
        wrapImages, unsizedImages, layoutKey,
    } from "$lib/utils/columns";
    import { openBook } from "$lib/utils/openBook";
    import { tick } from "svelte";
    import { openUrl } from "@tauri-apps/plugin-opener";

    // After the chapter being read, the rest are fetched this many at a time.
    const HTML_BATCH = 4;
    const CHAPTER_LOAD_FAILED = "<p>This chapter could not be loaded.</p>";

    let processedHtml = $state("");
    let processedChapter = $state(-1);
    let pendingAnchor = $state<string | null>(null);
    let pageWordCount = $state(0);
    let containerEl = $state<HTMLElement>();
    let containerWidth = $state(0);
    let effectiveHeight = $state(0);
    let lineHeight = $state(1.5);
    let columnTextsByChapter = $state<Map<number, string[]>>(new Map());
    let columnWordsCache = $state<string[][]>([]);
    // Chapter that columnWordsCache was measured for (-1 before the first measure).
    let measuredChapter = -1;
    // True while every chapter's page count is known for the current layout.
    let premeasureDone = $state(false);
    let premeasureStarted = false;
    // Layout key of the running or finished background measure.
    let premeasureKey = "";
    // Incremented to cancel a running background measure.
    let premeasureGen = 0;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    let rebuildRunning = false;
    let premeasureTimer: ReturnType<typeof setTimeout> | null = null;

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

    function metricsNow(): ReaderMetrics {
        return { pageW: containerWidth, pageH: effectiveHeight, fontSizeRem: $fontSize };
    }

    /** Number of words on the columns before `col`. */
    function wordsBefore(cols: string[][], col: number): number {
        let n = 0;
        for (let c = 0; c < col && c < cols.length; c++) n += cols[c].length;
        return n;
    }

    /** Column that word number `word` of the chapter is on. */
    function columnOfWord(cols: string[][], word: number): number {
        let n = 0;
        for (let c = 0; c < cols.length; c++) {
            n += cols[c].length;
            if (word < n) return c;
        }
        return Math.max(0, cols.length - 1);
    }

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
        scheduleRelayout();
    });

    // Stop background work when page mode unmounts (switching to RSVP).
    $effect(() => () => {
        premeasureGen++;
        if (premeasureTimer) clearTimeout(premeasureTimer);
        if (rebuildTimer) clearTimeout(rebuildTimer);
    });

    let bootLogged = false;

    $effect(() => {
        const b = $book;
        if (!b) return;
        if (!bootLogged) { bootLogged = true; dbg("Reader: mounted, book=" + b.title); }
        // Rebuild only when a book was (re)opened. The guard lives in module
        // scope so switching page<->RSVP (which unmounts/remounts this
        // component) does NOT reset the position or re-fetch the book.
        if (lastLoadedBook === b) return;
        lastLoadedBook = b;
        rebuildBook(b);
    });

    /** Saved page counts, if they were measured at the current layout. */
    function cachedCounts(n: number): number[] | null {
        const cache = $pageCountCache;
        if (!cache || cache.counts.length !== n || containerWidth <= 0 || effectiveHeight <= 0) return null;
        return cache.key === layoutKey(metricsNow()) ? cache.counts : null;
    }

    async function rebuildBook(b: BookState) {
        const n = b.spineCount;
        processedChapter = -1;
        processedHtml = "";
        measuredChapter = -1;
        columnTextsByChapter = new Map();
        columnWordsCache = [];
        premeasureGen++;
        premeasureStarted = false;
        premeasureKey = "";
        const cached = cachedCounts(n);
        premeasureDone = cached !== null;
        chapterPageCounts.set(cached ? [...cached] : Array(n).fill(1));
        chapterHtmls.set(Array(n).fill(""));
        chapterHtmlsLoaded.set(false);

        // Start on the saved chapter; the exact page is found once it's laid out.
        const anchor = $pendingWordAnchor;
        const first = anchor && anchor.chapter < n ? anchor.chapter : 0;
        currentPage.set(chapterStartPage($chapterPageCounts, first));
        if (cached) applyLegacyPage();
        await loadChapterHtmls(b, first);
    }

    /** Fetch chapter `first` (the one shown), then the rest in parallel batches. */
    async function loadChapterHtmls(b: BookState, first: number) {
        const fetchHtml = (ci: number) => getChapterHtml(ci).catch((e) => {
            dbg(`chapter ${ci}: load failed`, String(e));
            return CHAPTER_LOAD_FAILED;
        });
        const put = (indices: number[], htmls: string[]): boolean => {
            if (lastLoadedBook !== b) return false; // another book was opened meanwhile
            chapterHtmls.update((hs) => {
                const next = [...hs];
                indices.forEach((ci, k) => (next[ci] = htmls[k]));
                return next;
            });
            return true;
        };
        if (!put([first], [await fetchHtml(first)])) return;
        const rest = [...Array(b.spineCount).keys()].filter((ci) => ci !== first);
        for (let i = 0; i < rest.length; i += HTML_BATCH) {
            const batch = rest.slice(i, i + HTML_BATCH);
            if (!put(batch, await Promise.all(batch.map(fetchHtml)))) return;
        }
        chapterHtmlsLoaded.set(true);
    }

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
            for (const img of unsizedImages(el)) img.addEventListener("load", () => scheduleRelayout(), { once: true });
            columnizeCurrent();
        });
    });

    $effect(() => {
        $currentPage;
        $chapterPageCounts;
        if (processedChapter !== currentChapter) return;
        tick().then(() => positionCurrent());
    });

    function scheduleRelayout() {
        if (rebuildTimer) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
            if (rebuildRunning) { scheduleRelayout(); return; }
            rebuildRunning = true;
            rebuildTimer = null;
            relayout().finally(() => { rebuildRunning = false; });
        }, 150);
    }

    async function relayout() {
        if (!$book || currentChapter < 0) return;
        // If the current chapter hasn't been processed yet, let the
        // process/measure effects handle it; nothing to re-flow here.
        if (processedChapter !== currentChapter) return;
        const el = flowEl();
        if (!el) return;
        if (el.scrollHeight <= 0) return;
        const ci = currentChapter;
        // Page boundaries move on a reflow; keep the word being read on screen.
        if (measuredChapter === ci && !$pendingWordAnchor) {
            pendingWordAnchor.set({ chapter: ci, word: wordsBefore(columnWordsCache, colIndexInChapter) + $rsvpWordOffset });
        }
        const prevCount = $chapterPageCounts[ci] || 1;
        const count = paginateFlow(el, containerWidth, effectiveHeight);

        // Scale the other chapters as an estimate until they are re-measured.
        const ratio = count / prevCount;
        updatePageCounts((cs) => cs.map((c, i) => (i === ci ? count : Math.max(1, Math.round(c * ratio)))));
        afterMeasure(el, ci, count);
        // After a resize/font change, re-measure every chapter (debounced) so
        // the global total stays accurate instead of only the current chapter.
        if (layoutKey(metricsNow()) !== premeasureKey) {
            premeasureDone = false;
            schedulePremesure(1000);
        }
    }

    function columnizeCurrent() {
        const el = flowEl();
        const ci = currentChapter;
        if (ci < 0 || !el || containerWidth <= 0 || effectiveHeight <= 0) return;
        if (el.scrollHeight <= 0) return;
        const count = paginateFlow(el, containerWidth, effectiveHeight);
        updatePageCounts((cs) => (cs[ci] === count ? cs : cs.map((c, i) => (i === ci ? count : c))));
        afterMeasure(el, ci, count);
    }

    function afterMeasure(el: HTMLElement, ci: number, count: number) {
        // Single source of truth for page-mode word counts AND RSVP column
        // text, so both modes report the same per-page word count.
        columnWordsCache = extractColumnWords(el, containerWidth, count);
        measuredChapter = ci;
        dbg(`measure: ch${ci} pages=${count} total=${$readerTotalPages}`);
        columnTextsByChapter = new Map(columnTextsByChapter).set(
            ci,
            columnWordsCache.map((a) => a.join(" "))
        );
        readerMetrics.set(metricsNow());

        // Bring a saved (or pre-reflow) position on screen now that the
        // chapter's page boundaries are known.
        const anchor = $pendingWordAnchor;
        if (anchor && anchor.chapter === ci) {
            pendingWordAnchor.set(null);
            const col = columnOfWord(columnWordsCache, anchor.word);
            currentPage.set(chapterStartPage($chapterPageCounts, ci) + col);
            rsvpWordOffset.set(Math.max(0, anchor.word - wordsBefore(columnWordsCache, col)));
        }
        const total = $readerTotalPages;
        if ($currentPage >= total) currentPage.set(Math.max(0, total - 1));
        // Keep the saved counts in step if this chapter measured differently.
        if (premeasureDone) saveCountsCache(premeasureKey || layoutKey(metricsNow()));
        positionCurrent();
        // Once the UI is laid out (we have real dimensions), start measuring
        // the other chapters in the background (or take saved counts).
        if (!premeasureStarted) {
            premeasureStarted = true;
            schedulePremesure(0);
        }
    }

    function schedulePremesure(delay: number) {
        if (premeasureTimer) clearTimeout(premeasureTimer);
        premeasureTimer = setTimeout(() => { premeasureAll(); }, delay);
    }

    function saveCountsCache(key: string) {
        pageCountCache.set({ key, counts: [...$chapterPageCounts] });
    }

    /** Apply a saved position from an older version (a global page number). */
    function applyLegacyPage() {
        const page = $legacyPage;
        if (page === null) return;
        legacyPage.set(null);
        currentPage.set(Math.min(page, Math.max(0, $readerTotalPages - 1)));
    }

    function finishPremeasure(key: string) {
        premeasureDone = true;
        saveCountsCache(key);
        applyLegacyPage();
    }

    /**
     * Measure every chapter's page count offscreen. Takes the saved counts
     * instead when they were measured at this layout. Starts with the
     * chapters nearest the one being read, yields between chapters, and is
     * cancelled by a newer run (resize, font change) or by unmounting.
     */
    async function premeasureAll() {
        const gen = ++premeasureGen;
        const b = $book;
        if (containerWidth <= 0 || effectiveHeight <= 0 || !b) return;
        const metrics = metricsNow();
        const key = layoutKey(metrics);
        premeasureKey = key;

        const cache = $pageCountCache;
        if (cache && cache.key === key && cache.counts.length === b.spineCount) {
            const onScreen = measuredChapter;
            updatePageCounts((cs) => cache.counts.map((c, i) => (i === onScreen ? cs[i] : c)));
            finishPremeasure(key);
            dbg(`premeasure: cached total=${$readerTotalPages}`);
            return;
        }

        premeasureDone = false;
        try {
            await whenChapterHtmlsLoaded();
            const center = currentChapter;
            const order = [...Array(b.spineCount).keys()]
                .sort((x, y) => Math.abs(x - center) - Math.abs(y - center));
            for (const ci of order) {
                // Yield between chapters so input and rendering stay responsive.
                await new Promise((r) => setTimeout(r, 0));
                if (gen !== premeasureGen) return;
                // The chapter on screen is measured there.
                if (ci === measuredChapter) continue;
                const raw = $chapterHtmls[ci];
                if (!raw) continue;
                const pages = await measureOffscreenPages(raw, metrics);
                if (gen !== premeasureGen) return;
                updatePageCounts((cs) => (cs[ci] === pages ? cs : cs.map((c, i) => (i === ci ? pages : c))));
            }
            finishPremeasure(key);
            dbg(`premeasure: done total=${$readerTotalPages}`);
        } catch (e) {
            dbg("premeasure: error", String(e));
        }
    }

    function positionCurrent() {
        const el = flowEl();
        if (!el || containerWidth <= 0) return;
        const viewport = containerEl;

        // When navigating to a footnote / cross-chapter anchor, pendingAnchor
        // is set.  We compute the anchor's column from its position *in the
        // flow* (unaffected by viewport scroll), then scroll and update the
        // page counter — this prevents scrollIntoView from misleading the
        // calculation.
        if (pendingAnchor) {
            const anchorEl = el.querySelector("#" + CSS.escape(pendingAnchor));
            if (anchorEl) {
                const flowRect = el.getBoundingClientRect();
                const anchorRect = anchorEl.getBoundingClientRect();
                const relLeft = anchorRect.left - flowRect.left;
                const pCount = $chapterPageCounts[currentChapter] || 1;
                const col = Math.max(0, Math.min(pCount - 1, Math.floor(relLeft / containerWidth)));

                let targetPage = 0;
                for (let ci = 0; ci < currentChapter; ci++)
                    targetPage += $chapterPageCounts[ci] || 1;
                targetPage += col;

                anchorEl.scrollIntoView({ block: "start" });
                if (targetPage !== $currentPage) currentPage.set(targetPage);
                pageWordCount = columnWordsCache[col]?.length ?? 0;
            }
            pendingAnchor = null;
            return;
        }

        if (viewport) {
            viewport.scrollLeft = colIndexInChapter * containerWidth;
            viewport.scrollTop = 0;
        }
        pageWordCount = columnWordsCache[colIndexInChapter]?.length ?? 0;
        if (measuredChapter === currentChapter) {
            pageStart.set({ chapter: currentChapter, word: wordsBefore(columnWordsCache, colIndexInChapter) });
        }
    }

    function goPrev() {
        if ($currentPage > 0) { currentPage.set($currentPage - 1); rsvpWordOffset.set(0); }
    }

    function goNext() {
        if ($currentPage < $readerTotalPages - 1) { currentPage.set($currentPage + 1); rsvpWordOffset.set(0); }
    }

    function changeFont(delta: number) {
        const next = Math.round(($fontSize + delta) * 10) / 10;
        if (next >= 0.6 && next <= 3.0) fontSize.set(next);
    }

    function enterRsvp() {
        if (currentChapter < 0) return;
        const texts = columnTextsByChapter.get(currentChapter);
        if (texts && texts.length) {
            rsvpColumnTexts.set(texts);
            rsvpColumnChapter.set(currentChapter);
        }
        rsvpActive.set(true);
    }

    function clickWord(e: Event) {
        const link = (e.target as HTMLElement).closest("a");
        if (link) {
            e.preventDefault();
            const href = link.getAttribute("href");
            if (!href) return;
            if (href.startsWith("http://") || href.startsWith("https://")) {
                openUrl(href);
            } else if (href.startsWith("#")) {
                const id = href.slice(1);
                const targetEl = containerEl?.querySelector("#" + CSS.escape(id));
                if (targetEl) {
                    const flowRect = flowEl()?.getBoundingClientRect();
                    if (flowRect && containerWidth > 0) {
                        const targetRect = targetEl.getBoundingClientRect();
                        const relLeft = targetRect.left - flowRect.left;
                        const pCount = $chapterPageCounts[currentChapter] || 1;
                        const col = Math.max(0, Math.min(pCount - 1, Math.floor(relLeft / containerWidth)));
                        let targetPage = 0;
                        for (let ci = 0; ci < currentChapter; ci++)
                            targetPage += $chapterPageCounts[ci] || 1;
                        targetPage += col;
                        if (targetPage !== $currentPage) currentPage.set(targetPage);
                    }
                    targetEl.scrollIntoView({ block: "start" });
                }
            } else {
                resolveChapterLink(href).then((resolved) => {
                    let offset = 0;
                    for (let ci = 0; ci < resolved.chapter_index; ci++) offset += $chapterPageCounts[ci] || 1;
                    pendingAnchor = resolved.anchor;
                    currentPage.set(offset);
                    rsvpWordOffset.set(0);
                }).catch(() => {});
            }
            return;
        }
        enterRsvp();
    }

    function onKeyDown(e: KeyboardEvent) {
        if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
        if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
        if (e.key === "9") { e.preventDefault(); changeFont(0.1); }
        if (e.key === "0") { e.preventDefault(); changeFont(-0.1); }
        if (e.key === "a" || e.key === "A") { e.preventDefault(); enterRsvp(); }
    }

    async function handleOpen() {
        const selected = await open({
            multiple: false,
            filters: [{ name: "EPUB", extensions: ["epub"] }],
        });
        if (!selected) return;
        try {
            await openBook(selected);
        } catch (e) { dbg("open failed", String(e)); }
    }
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="reader">
    <div class="toolbar">
        <span class="title">{$book?.title ?? "rsvp-reader"}</span>
        <div class="spacer"></div>
        <button class="rsvp-btn" onclick={enterRsvp}>RSVP (A)</button>
        <button class="open-btn" onclick={handleOpen}>Open</button>
    </div>

    <div class="page-area">
        <div
            class="epub-viewport"
            bind:this={containerEl}
            style="--page-h: {effectiveHeight}px;"
        >
            <div
                class="epub-flow"
                style="font-size: {$fontSize}rem; line-height: {lineHeight};"
                role="button"
                tabindex="0"
                onclick={clickWord}
                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); clickWord(e); } }}
            >
                {#if processedHtml}
                    {@html processedHtml}
                {:else}
                    <p class="loading-text">Loading…</p>
                {/if}
            </div>
        </div>
    </div>

    <div class="bottom-bar">
        <span class="word-count">{pageWordCount} words</span>
        <span class="page-num">
            {$readerTotalPages > 0
                ? (!premeasureDone
                    ? `Page ${$currentPage + 1} of …`
                    : `Page ${$currentPage + 1} of ${$readerTotalPages}`)
                : ""}
            &ensp;|&ensp;font {$fontSize}rem
        </span>
        <div class="page-nav">
            <button class="nav-btn" onclick={goPrev} disabled={$currentPage <= 0}>
                &larr; Prev
            </button>
            <button class="nav-btn" onclick={goNext} disabled={$currentPage >= $readerTotalPages - 1}>
                Next &rarr;
            </button>
        </div>
    </div>
</div>

<style>
    .reader { display:flex; flex-direction:column; height:100vh; background:#000; color:#e0e0e0; }
    .toolbar { display:flex; align-items:center; gap:1rem; padding:0.5rem 1rem; background:#111; border-bottom:1px solid #222; flex-shrink:0; }
    .title { font-weight:600; font-size:0.95rem; }
    .spacer { flex:1; }
    .rsvp-btn { padding:0.3rem 0.8rem; border:1px solid #6a9cf5; border-radius:6px; background:#1a2a40; color:#6a9cf5; cursor:pointer; font-size:0.85rem; }
    .rsvp-btn:hover { background:#1a3050; }
    .open-btn { padding:0.3rem 0.8rem; border:1px solid #444; border-radius:6px; background:transparent; color:#e0e0e0; cursor:pointer; font-size:0.85rem; }
    .open-btn:hover { border-color:#6a9cf5; color:#6a9cf5; }
    .page-area { flex:1; position:relative; overflow:hidden; }
    .epub-viewport { position:absolute; inset:0; margin:1.5rem 2rem; overflow-y:hidden; overflow-x:auto; box-sizing:border-box; scrollbar-width:none; }
    .epub-viewport::-webkit-scrollbar { display:none; }
    .loading-text { color:#666; font-size:1rem; }
    .bottom-bar { display:flex; align-items:center; justify-content:space-between; padding:0.5rem 1rem; background:#111; border-top:1px solid #222; flex-shrink:0; }
    .word-count { font-size:0.8rem; color:#666; }
    .page-num { font-size:0.85rem; color:#888; }
    .page-nav { display:flex; gap:0.5rem; }
    .nav-btn { padding:0.3rem 0.8rem; border:1px solid #444; border-radius:6px; background:#1a1a1a; color:#e0e0e0; cursor:pointer; font-size:0.85rem; }
    .nav-btn:hover:not(:disabled) { border-color:#6a9cf5; color:#6a9cf5; }
    .nav-btn:disabled { opacity:0.3; cursor:not-allowed; }
</style>