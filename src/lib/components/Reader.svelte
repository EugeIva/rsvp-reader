<script context="module">
    // Module-scope guard: survives component unmount/remount (page<->RSVP
    // switching) so we don't reset to page 1 or re-fetch the book.
    let lastLoadedBookPath: string | null = null;
</script>

<script lang="ts">
    import { open } from "@tauri-apps/plugin-dialog";
    import { openEpub, getChapterHtml, resolveChapterLink } from "$lib/commands";
    import {
        book, currentPage, chapterHtmls, chapterPageCounts, readerTotalPages,
        fontSize, rsvpActive, rsvpWordOffset, rsvpConfig,
        rsvpColumnTexts, rsvpColumnChapter, readerMetrics,
    } from "$lib/stores";
    import { loadState, saveState } from "$lib/utils/persistence";
    import { dbg } from "$lib/utils/debug";
    import {
        processHtmlDoc, paginateFlow, extractColumnWords,
        measureOffscreenPages,
    } from "$lib/utils/columns";
    import { tick } from "svelte";
    import { openUrl } from "@tauri-apps/plugin-opener";

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
    let premeasuring = $state(false);
    let premeasureDone = $state(false);
    let premeasureStarted = $state(false);
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

    let bootLogged = false;

    $effect(() => {
        const b = $book;
        if (!b) return;
        if (!bootLogged) { bootLogged = true; dbg("Reader: mounted, book=" + b.title); }
        // Rebuild only when a different book was loaded. The guard lives in
        // module scope so switching page<->RSVP (which unmounts/remounts this
        // component) does NOT reset to page 1 or re-fetch the book.
        if (lastLoadedBookPath === b.filePath) return;
        lastLoadedBookPath = b.filePath;
        currentPage.set(0);
        rsvpWordOffset.set(0);
        rebuildBook();
    });

    async function rebuildBook() {
        const b = $book;
        if (!b) return;
        try {
            const htmls: string[] = [];
            for (let ci = 0; ci < b.spineCount; ci++) {
                htmls[ci] = await getChapterHtml(ci);
            }

            chapterHtmls.set(htmls);
            processedChapter = -1;
            processedHtml = "";
            columnTextsByChapter = new Map();
            premeasureStarted = false;
            premeasureDone = false;
            chapterPageCounts.set(b.chapterWordCounts.map(() => 1));
        } catch (e) {
            dbg("rebuild: error", String(e));
        }
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
            if (ci === currentChapter) {
                columnizeCurrent();
                wrapImagesInDom();
            }
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
        const prevCount = $chapterPageCounts[currentChapter] || 1;
        const count = paginateFlow(el, containerWidth, effectiveHeight);

        const ratio = count / prevCount;
        const counts = $chapterPageCounts.map((c, i) =>
            i === currentChapter ? count : Math.max(1, Math.round(c * ratio))
        );
        chapterPageCounts.set(counts);
        afterMeasure(el, count);
        // After a resize/font reflow, re-measure every chapter (debounced) so
        // the global total stays accurate instead of only the current chapter.
        schedulePremesure(1000);
    }

    function columnizeCurrent() {
        const el = flowEl();
        if (currentChapter < 0 || !el || containerWidth <= 0 || effectiveHeight <= 0) return;
        if (el.scrollHeight <= 0) return;
        const count = paginateFlow(el, containerWidth, effectiveHeight);
        const counts = [...$chapterPageCounts];
        counts[currentChapter] = count;
        chapterPageCounts.set(counts);
        afterMeasure(el, count);
    }

    function afterMeasure(el: HTMLElement, count: number) {
        dbg(`measure: ch${currentChapter} pages=${count} total=${$readerTotalPages}`);
        // Single source of truth for page-mode word counts AND RSVP column
        // text, so both modes report the same per-page word count.
        columnWordsCache = extractColumnWords(el, containerWidth, count);
        dbg(`measure: ch${currentChapter} pages=${count} total=${$readerTotalPages} words=${columnWordsCache[colIndexInChapter]?.length ?? 0}`);
        columnTextsByChapter = new Map(columnTextsByChapter).set(
            currentChapter,
            columnWordsCache.map((a) => a.join(" "))
        );
        readerMetrics.set({ pageW: containerWidth, pageH: effectiveHeight, fontSizeRem: $fontSize });
        const total = $readerTotalPages;
        if ($currentPage >= total) currentPage.set(Math.max(0, total - 1));
        positionCurrent();
        // Once the UI is laid out (we have real dimensions), kick off the
        // background premeasure so the global page count reflects every chapter.
        if (!premeasureStarted) {
            premeasureStarted = true;
            schedulePremesure(0);
        }
    }

    function schedulePremesure(delay: number) {
        if (premeasureTimer) clearTimeout(premeasureTimer);
        premeasureTimer = setTimeout(() => { premeasureAll(); }, delay);
    }

    async function premeasureAll() {
        if (premeasuring) return;
        const b = $book;
        if (containerWidth <= 0 || effectiveHeight <= 0 || !b) return;
        const metrics = { pageW: containerWidth, pageH: effectiveHeight, fontSizeRem: $fontSize };
        premeasuring = true;
        premeasureDone = false;
        try {
            for (let ci = 0; ci < b.spineCount; ci++) {
                // The rendered chapter is already measured on-screen.
                if (ci === processedChapter) continue;
                const raw = $chapterHtmls[ci];
                if (!raw) continue;
                const pages = await measureOffscreenPages(raw, metrics, $fontSize);
                chapterPageCounts.update((cs) => {
                    if (cs[ci] === pages) return cs;
                    const n = [...cs];
                    n[ci] = pages;
                    return n;
                });
            }
            premeasureDone = true;
            dbg(`premeasure: done total=${$readerTotalPages}`);
        } catch (e) {
            dbg("premeasure: error", String(e));
        } finally {
            premeasuring = false;
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
    }

    /**
     * Wrap every `<img>` in the rendered flow inside a `div` with
     * `break-inside:avoid` and `display:inline-block` — the only reliable
     * way to prevent image fragmentation in Safari / WKWebView multicol.
     * Runs in the live DOM (after `{@html}` renders), so it always works.
     */
    function wrapImagesInDom() {
        const flow = flowEl();
        if (!flow) return;
        let wrapped = 0;
        for (const img of flow.querySelectorAll("img")) {
            if (img.parentElement?.style.cssText.includes("inline-block")) continue;
            const container = img.closest("div, figure, p") ?? img.parentElement ?? flow;
            const nextBlock = container?.nextElementSibling;
            const isCaption = nextBlock && nextBlock.tagName.toLowerCase() === "p" &&
                ((nextBlock.textContent?.length ?? 0) < 120 ||
                 /^(Рис\.|Fig\.|Figure|Таблица|Table)/.test(nextBlock.textContent?.trim() ?? ""));

            if (isCaption) {
                const w = document.createElement("div");
                w.style.cssText = "display:inline-block;width:100%;break-inside:avoid!important;page-break-inside:avoid!important;overflow:hidden;vertical-align:top;";
                container.parentNode?.insertBefore(w, container);
                w.appendChild(container);
                w.appendChild(nextBlock);
                wrapped++;
            } else {
                let target: Element = img;
                const p = img.parentElement;
                if (p && ["div", "figure", "p", "td", "li"].includes(p.tagName.toLowerCase())) {
                    target = p;
                } else if (p) {
                    target = p.closest("div, figure, p, body") ?? img;
                }
                const w = document.createElement("div");
                w.style.cssText = "display:inline-block;width:100%;break-inside:avoid!important;page-break-inside:avoid!important;overflow:hidden;vertical-align:top;";
                target.parentNode?.insertBefore(w, target);
                w.appendChild(target);
                wrapped++;
            }
        }
        if (wrapped > 0) dbg(`wrapImages: ch${currentChapter} wrapped ${wrapped} images`);
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
            const meta = await openEpub(selected);
            book.set({
                title: meta.title,
                author: meta.author,
                spineCount: meta.spine_count,
                filePath: selected,
                chapterWordCounts: meta.chapter_word_counts,
            });
            currentPage.set(0);
            rsvpWordOffset.set(0);
            try { localStorage.setItem("rsvp-reader:lastPath", selected); } catch {}
            restoreState(selected);
        } catch (e) { dbg("open failed", String(e)); }
    }

    async function restoreState(path: string) {
        try {
            const saved = await loadState(path);
            if (!saved) return;
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
        } catch { /* best-effort */ }
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
                ? (premeasuring && !premeasureDone
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
    .epub-flow { color:#e0e0e0; overflow:hidden; box-sizing:border-box; }
    .epub-flow :global(figure),
    .epub-flow :global(*:has(> img)),
    .epub-flow :global(*:has(> svg)),
    .epub-flow :global(*:has(> video)),
    .epub-flow :global(*:has(> :has(> img))),
    .epub-flow :global(*:has(> img) + p),
    .epub-flow :global(*:has(> :has(> img)) + p),
    .epub-flow :global(figure > figcaption) {
        page-break-inside:avoid;
        break-inside:avoid;
        -webkit-column-break-inside:avoid;
    }
    .epub-flow :global(img), .epub-flow :global(svg), .epub-flow :global(video) {
        display:block;
        margin:0.25rem auto;
        max-width:100%;
        max-height:calc(var(--page-h, 100vh) - 3rem);
        width:auto;
        height:auto;
        object-fit:contain;
        page-break-inside:avoid;
        break-inside:avoid;
        -webkit-column-break-inside:avoid;
    }
    .epub-flow :global(a) { color:#6a9cf5; text-decoration:underline; }
    .epub-flow :global(a:hover) { color:#8ab4ff; }
    .epub-flow :global(p) { margin:0.5em 0; }
    .epub-flow :global(h1), .epub-flow :global(h2), .epub-flow :global(h3),
    .epub-flow :global(h4), .epub-flow :global(h5), .epub-flow :global(h6) { margin:0.8em 0 0.3em; color:#e0e0e0; }
    .loading-text { color:#666; font-size:1rem; }
    .bottom-bar { display:flex; align-items:center; justify-content:space-between; padding:0.5rem 1rem; background:#111; border-top:1px solid #222; flex-shrink:0; }
    .word-count { font-size:0.8rem; color:#666; }
    .page-num { font-size:0.85rem; color:#888; }
    .page-nav { display:flex; gap:0.5rem; }
    .nav-btn { padding:0.3rem 0.8rem; border:1px solid #444; border-radius:6px; background:#1a1a1a; color:#e0e0e0; cursor:pointer; font-size:0.85rem; }
    .nav-btn:hover:not(:disabled) { border-color:#6a9cf5; color:#6a9cf5; }
    .nav-btn:disabled { opacity:0.3; cursor:not-allowed; }
</style>