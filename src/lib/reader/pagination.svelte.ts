// columnTextsByChapter is read imperatively (entering RSVP), never rendered,
// so a plain Map is right here.
/* eslint-disable svelte/prefer-svelte-reactivity */
import { get } from "svelte/store";
import {
    book,
    currentPage,
    chapterHtmls,
    chapterPageCounts,
    readerTotalPages,
    fontSize,
    rsvpWordOffset,
    readerMetrics,
    pageStart,
    pendingWordAnchor,
    legacyPage,
    pageCountCache,
    wordHighlight,
    chapterStartPage,
    updatePageCounts,
    whenChapterHtmlsLoaded,
} from "$lib/stores";
import type { ReaderMetrics, WordAnchor } from "$lib/stores";
import { dbg } from "$lib/utils/debug";
import { paginateFlow, extractColumnWords, measureOffscreenPages, layoutKey } from "$lib/utils/columns";
import { tokenIndexOfWord, wordIndexOfToken } from "$lib/utils/rsvp";

// Name of the CSS highlight (styled with ::highlight(rsvp-word) in epubFlow.css).
const HIGHLIGHT = "rsvp-word";

/** The text node and character offset at a viewport point, if it's in text. */
function caretAt(x: number, y: number): { node: Text; offset: number } | null {
    const pos = document.caretPositionFromPoint?.(x, y);
    if (pos) return pos.offsetNode instanceof Text ? { node: pos.offsetNode, offset: pos.offset } : null;
    const range = document.caretRangeFromPoint?.(x, y);
    return range && range.startContainer instanceof Text
        ? { node: range.startContainer, offset: range.startOffset }
        : null;
}

/** What the pagination controller needs from the page-mode view. */
export interface PageView {
    /** The `.epub-flow` element holding the rendered chapter. */
    flow(): HTMLElement | null;
    /** The scrolling element that shows one column (page) at a time. */
    viewport(): HTMLElement | undefined;
    width(): number;
    height(): number;
    /** Chapter of the current page (-1 before page counts exist). */
    currentChapter(): number;
    /** Column (page within the chapter) of the current page. */
    column(): number;
    /** Chapter whose HTML is rendered in the flow (-1 if none). */
    renderedChapter(): number;
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

/**
 * Page-mode layout: measures the rendered chapter into columns (pages),
 * reflows on resize/font changes, measures the other chapters in the
 * background (or takes saved counts), and keeps the right page on screen.
 */
export class Pagination {
    /** Words on the page shown. */
    pageWordCount = $state(0);
    /** True while every chapter's page count is known for the current layout. */
    premeasureDone = $state(false);
    /** Per-column text of each measured chapter; RSVP starts from it. */
    columnTextsByChapter = new Map<number, string[]>();
    /** Element id to bring on screen after a cross-chapter link (footnotes). */
    pendingAnchor: string | null = null;

    private columnWordsCache: string[][] = [];
    // Chapter that columnWordsCache was measured for (-1 before the first measure).
    private measuredChapter = -1;
    private premeasureStarted = false;
    // Layout key of the running or finished background measure.
    private premeasureKey = "";
    // Incremented to cancel a running background measure.
    private premeasureGen = 0;
    private relayoutTimer: ReturnType<typeof setTimeout> | null = null;
    private relayoutRunning = false;
    private premeasureTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private view: PageView) {}

    private metricsNow(): ReaderMetrics {
        return { pageW: this.view.width(), pageH: this.view.height(), fontSizeRem: get(fontSize) };
    }

    /** Forget the previous book's measurements. `countsKnown`: saved counts were applied. */
    reset(countsKnown: boolean) {
        this.measuredChapter = -1;
        this.columnTextsByChapter = new Map();
        this.columnWordsCache = [];
        this.premeasureGen++;
        this.premeasureStarted = false;
        this.premeasureKey = "";
        this.premeasureDone = countsKnown;
        if (countsKnown) this.applyLegacyPage();
    }

    /** Stop background work (page mode is unmounting). */
    destroy() {
        CSS.highlights?.delete(HIGHLIGHT);
        this.premeasureGen++;
        if (this.premeasureTimer) clearTimeout(this.premeasureTimer);
        if (this.relayoutTimer) clearTimeout(this.relayoutTimer);
    }

    scheduleRelayout = () => {
        if (this.relayoutTimer) clearTimeout(this.relayoutTimer);
        this.relayoutTimer = setTimeout(() => {
            if (this.relayoutRunning) {
                this.scheduleRelayout();
                return;
            }
            this.relayoutRunning = true;
            this.relayoutTimer = null;
            this.relayout().finally(() => {
                this.relayoutRunning = false;
            });
        }, 150);
    };

    private async relayout() {
        const ci = this.view.currentChapter();
        if (!get(book) || ci < 0) return;
        // If the current chapter hasn't been processed yet, let the
        // process/measure effects handle it; nothing to re-flow here.
        if (this.view.renderedChapter() !== ci) return;
        const el = this.view.flow();
        if (!el) return;
        if (el.scrollHeight <= 0) return;
        // Page boundaries move on a reflow; keep the word being read on screen.
        if (this.measuredChapter === ci && !get(pendingWordAnchor)) {
            pendingWordAnchor.set({
                chapter: ci,
                word: this.wordAtToken(this.view.column(), get(rsvpWordOffset)),
            });
        }
        const prevCount = get(chapterPageCounts)[ci] || 1;
        const count = paginateFlow(el, this.view.width(), this.view.height());

        // Scale the other chapters as an estimate until they are re-measured.
        const ratio = count / prevCount;
        updatePageCounts((cs) => cs.map((c, i) => (i === ci ? count : Math.max(1, Math.round(c * ratio)))));
        this.afterMeasure(el, ci, count);
        // After a resize/font change, re-measure every chapter (debounced) so
        // the global total stays accurate instead of only the current chapter.
        if (layoutKey(this.metricsNow()) !== this.premeasureKey) {
            this.premeasureDone = false;
            this.schedulePremeasure(1000);
        }
    }

    /** Measure the chapter just rendered in the flow. */
    columnizeCurrent() {
        const el = this.view.flow();
        const ci = this.view.currentChapter();
        if (ci < 0 || !el || this.view.width() <= 0 || this.view.height() <= 0) return;
        if (el.scrollHeight <= 0) return;
        const count = paginateFlow(el, this.view.width(), this.view.height());
        updatePageCounts((cs) => (cs[ci] === count ? cs : cs.map((c, i) => (i === ci ? count : c))));
        this.afterMeasure(el, ci, count);
    }

    private afterMeasure(el: HTMLElement, ci: number, count: number) {
        // Single source of truth for page-mode word counts AND RSVP column
        // text, so both modes report the same per-page word count.
        this.columnWordsCache = extractColumnWords(el, this.view.width(), count);
        this.measuredChapter = ci;
        dbg(`measure: ch${ci} pages=${count} total=${get(readerTotalPages)}`);
        this.columnTextsByChapter = new Map(this.columnTextsByChapter).set(
            ci,
            this.columnWordsCache.map((a) => a.join(" ")),
        );
        readerMetrics.set(this.metricsNow());

        // Bring a saved (or pre-reflow) position on screen now that the
        // chapter's page boundaries are known.
        const anchor = get(pendingWordAnchor);
        if (anchor && anchor.chapter === ci) {
            pendingWordAnchor.set(null);
            const col = columnOfWord(this.columnWordsCache, anchor.word);
            currentPage.set(chapterStartPage(get(chapterPageCounts), ci) + col);
            rsvpWordOffset.set(this.tokenAtWord(col, anchor.word));
        }
        const total = get(readerTotalPages);
        if (get(currentPage) >= total) currentPage.set(Math.max(0, total - 1));
        // Keep the saved counts in step if this chapter measured differently.
        if (this.premeasureDone) this.saveCountsCache(this.premeasureKey || layoutKey(this.metricsNow()));
        this.positionCurrent();
        // Once the UI is laid out (we have real dimensions), start measuring
        // the other chapters in the background (or take saved counts).
        if (!this.premeasureStarted) {
            this.premeasureStarted = true;
            this.schedulePremeasure(0);
        }
    }

    private schedulePremeasure(delay: number) {
        if (this.premeasureTimer) clearTimeout(this.premeasureTimer);
        this.premeasureTimer = setTimeout(() => {
            this.premeasureAll();
        }, delay);
    }

    private saveCountsCache(key: string) {
        pageCountCache.set({ key, counts: [...get(chapterPageCounts)] });
    }

    /** Apply a saved position from an older version (a global page number). */
    private applyLegacyPage() {
        const page = get(legacyPage);
        if (page === null) return;
        legacyPage.set(null);
        currentPage.set(Math.min(page, Math.max(0, get(readerTotalPages) - 1)));
    }

    private finishPremeasure(key: string) {
        this.premeasureDone = true;
        this.saveCountsCache(key);
        this.applyLegacyPage();
    }

    /**
     * Measure every chapter's page count offscreen. Takes the saved counts
     * instead when they were measured at this layout. Starts with the
     * chapters nearest the one being read, yields between chapters, and is
     * cancelled by a newer run (resize, font change) or by unmounting.
     */
    private async premeasureAll() {
        const gen = ++this.premeasureGen;
        const b = get(book);
        if (this.view.width() <= 0 || this.view.height() <= 0 || !b) return;
        const metrics = this.metricsNow();
        const key = layoutKey(metrics);
        this.premeasureKey = key;

        const cache = get(pageCountCache);
        if (cache && cache.key === key && cache.counts.length === b.spineCount) {
            const onScreen = this.measuredChapter;
            updatePageCounts((cs) => cache.counts.map((c, i) => (i === onScreen ? cs[i] : c)));
            this.finishPremeasure(key);
            dbg(`premeasure: cached total=${get(readerTotalPages)}`);
            return;
        }

        this.premeasureDone = false;
        try {
            await whenChapterHtmlsLoaded();
            const center = this.view.currentChapter();
            const order = [...Array(b.spineCount).keys()].sort((x, y) => Math.abs(x - center) - Math.abs(y - center));
            for (const ci of order) {
                // Yield between chapters so input and rendering stay responsive.
                await new Promise((r) => setTimeout(r, 0));
                if (gen !== this.premeasureGen) return;
                // The chapter on screen is measured there.
                if (ci === this.measuredChapter) continue;
                const raw = get(chapterHtmls)[ci];
                if (!raw) continue;
                const pages = await measureOffscreenPages(raw, metrics);
                if (gen !== this.premeasureGen) return;
                updatePageCounts((cs) => (cs[ci] === pages ? cs : cs.map((c, i) => (i === ci ? pages : c))));
            }
            this.finishPremeasure(key);
            dbg(`premeasure: done total=${get(readerTotalPages)}`);
        } catch (e) {
            dbg("premeasure: error", String(e));
        }
    }

    /**
     * Go to a remembered position. In the chapter already laid out the page
     * is known now; otherwise move to that chapter and let afterMeasure()
     * place the page once it's laid out (as when restoring a saved position).
     */
    goToAnchor(anchor: WordAnchor) {
        const counts = get(chapterPageCounts);
        if (anchor.chapter === this.measuredChapter && anchor.chapter === this.view.renderedChapter()) {
            const col = columnOfWord(this.columnWordsCache, anchor.word);
            currentPage.set(chapterStartPage(counts, anchor.chapter) + col);
            rsvpWordOffset.set(this.tokenAtWord(col, anchor.word));
            return;
        }
        pendingWordAnchor.set(anchor);
        currentPage.set(chapterStartPage(counts, anchor.chapter));
    }

    /** Scroll the viewport to the current page and publish its start. */
    positionCurrent() {
        const el = this.view.flow();
        const width = this.view.width();
        if (!el || width <= 0) return;
        const viewport = this.view.viewport();
        const currentChapter = this.view.currentChapter();
        const counts = get(chapterPageCounts);

        // When navigating to a footnote / cross-chapter anchor, pendingAnchor
        // is set.  We compute the anchor's column from its position *in the
        // flow* (unaffected by viewport scroll), then scroll and update the
        // page counter — this prevents scrollIntoView from misleading the
        // calculation.
        if (this.pendingAnchor) {
            const anchorEl = el.querySelector("#" + CSS.escape(this.pendingAnchor));
            if (anchorEl) {
                const flowRect = el.getBoundingClientRect();
                const anchorRect = anchorEl.getBoundingClientRect();
                const relLeft = anchorRect.left - flowRect.left;
                const pCount = counts[currentChapter] || 1;
                const col = Math.max(0, Math.min(pCount - 1, Math.floor(relLeft / width)));

                let targetPage = 0;
                for (let ci = 0; ci < currentChapter; ci++) targetPage += counts[ci] || 1;
                targetPage += col;

                anchorEl.scrollIntoView({ block: "start" });
                if (targetPage !== get(currentPage)) currentPage.set(targetPage);
                this.pageWordCount = this.columnWordsCache[col]?.length ?? 0;
            }
            this.pendingAnchor = null;
            return;
        }

        const column = this.view.column();
        if (viewport) {
            viewport.scrollLeft = column * width;
            viewport.scrollTop = 0;
        }
        this.pageWordCount = this.columnWordsCache[column]?.length ?? 0;
        if (this.measuredChapter === currentChapter) {
            pageStart.set({
                chapter: currentChapter,
                word: wordsBefore(this.columnWordsCache, column),
                words: this.columnWordsCache[column] ?? [],
            });
        }
        this.updateHighlight();
    }

    /** Chapter word index of RSVP token `token` on column `col`. */
    private wordAtToken(col: number, token: number): number {
        const words = this.columnWordsCache[col] ?? [];
        const within = token > 0 && words.length ? wordIndexOfToken(words, token) : 0;
        return wordsBefore(this.columnWordsCache, col) + within;
    }

    /** RSVP token index (on column `col`) of chapter word `word`. */
    private tokenAtWord(col: number, word: number): number {
        const words = this.columnWordsCache[col] ?? [];
        const within = Math.max(0, word - wordsBefore(this.columnWordsCache, col));
        return within > 0 && words.length ? tokenIndexOfWord(words, within) : 0;
    }

    /**
     * The flow's laid-out text nodes, in order, with their words. Counted the
     * same way as extractColumnWords (nodes without boxes are skipped), so
     * word N here is word N of the chapter's column word lists.
     */
    private laidOutWords(): { node: Text; words: RegExpMatchArray[] }[] {
        const el = this.view.flow();
        if (!el) return [];
        const out: { node: Text; words: RegExpMatchArray[] }[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        const range = document.createRange();
        while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const words = [...(node.textContent ?? "").matchAll(/\S+/g)];
            if (!words.length) continue;
            range.selectNodeContents(node);
            if (!Array.from(range.getClientRects()).some((r) => r.width > 0 && r.height > 0)) continue;
            out.push({ node, words });
        }
        return out;
    }

    /**
     * Make the word at viewport point (x, y) the RSVP starting word, and
     * highlight it. Returns false if there's no word there.
     */
    selectWordAt(x: number, y: number): boolean {
        const ci = this.view.currentChapter();
        const hit = caretAt(x, y);
        if (!hit || this.measuredChapter !== ci) return false;
        let before = 0;
        let word = -1;
        for (const { node, words } of this.laidOutWords()) {
            if (node === hit.node) {
                // The word the caret is in or at the end of (clicking the right
                // half of a word's last letter puts the caret after it), else
                // the next word.
                const i = words.findIndex((m) => hit.offset <= m.index! + m[0].length);
                word = before + (i < 0 ? words.length - 1 : i);
                break;
            }
            before += words.length;
        }
        if (word < 0) return false;
        const col = columnOfWord(this.columnWordsCache, word);
        const page = chapterStartPage(get(chapterPageCounts), ci) + col;
        if (page !== get(currentPage)) currentPage.set(page);
        rsvpWordOffset.set(
            tokenIndexOfWord(this.columnWordsCache[col], word - wordsBefore(this.columnWordsCache, col)),
        );
        wordHighlight.set(true);
        this.updateHighlight();
        return true;
    }

    /** Highlight the word at the RSVP position on the current page, or clear the highlight. */
    updateHighlight() {
        const registry = CSS.highlights;
        if (!registry) return;
        const words = this.columnWordsCache[this.view.column()];
        if (!get(wordHighlight) || this.measuredChapter !== this.view.currentChapter() || !words?.length) {
            registry.delete(HIGHLIGHT);
            return;
        }
        const target =
            wordsBefore(this.columnWordsCache, this.view.column()) + wordIndexOfToken(words, get(rsvpWordOffset));
        let before = 0;
        for (const { node, words: nodeWords } of this.laidOutWords()) {
            if (target < before + nodeWords.length) {
                const m = nodeWords[target - before];
                const range = document.createRange();
                range.setStart(node, m.index!);
                range.setEnd(node, m.index! + m[0].length);
                registry.set(HIGHLIGHT, new Highlight(range));
                return;
            }
            before += nodeWords.length;
        }
        registry.delete(HIGHLIGHT);
    }
}
