import { get } from "svelte/store";
import {
    currentPage,
    chapterPageCounts,
    readerTotalPages,
    chapterHtmls,
    chapterHtmlsLoaded,
    rsvpActive,
    rsvpWordOffset,
    rsvpConfig,
    rsvpColumnTexts,
    rsvpColumnChapter,
    readerMetrics,
    pageStart,
    wordHighlight,
    updatePageCounts,
    whenChapterHtmlsLoaded,
} from "$lib/stores";
import { tokenize, RsvpEngine } from "$lib/utils/rsvp";
import type { RsvpConfig, RsvpToken } from "$lib/utils/rsvp";
import { columnizeOffscreen } from "$lib/utils/columns";
import { loadLanguage } from "$lib/wordComplexity";
import { detectLanguage } from "$lib/wordComplexity/language";
import { Countdown } from "./countdown.svelte";

/**
 * RSVP playback: loads the current page's text, runs an RsvpEngine over it,
 * advances to the next page at the end, and drives the reading countdown.
 */
export class RsvpPlayback {
    tokens = $state<RsvpToken[]>([]);
    currentToken = $state<RsvpToken | null>(null);
    currentIdx = $state(0);
    playing = $state(false);
    started = $state(false);
    loadingColumn = $state(false);
    readonly countdown: Countdown;
    private engine: RsvpEngine | null = null;

    constructor() {
        this.countdown = new Countdown(
            () => {
                const c = get(rsvpConfig);
                return c.timerEnabled ? c.timerMinutes * 60 + c.timerSeconds : 0;
            },
            () => {
                if (this.engine) this.engine.pause();
                this.playing = false;
            },
        );
    }

    // chapter + column for the current global page
    private locatePage(page: number) {
        const counts = get(chapterPageCounts);
        if (!counts.length) return { chapter: 0, column: 0 };
        let acc = 0;
        for (let ci = 0; ci < counts.length; ci++) {
            if (page < acc + counts[ci]) return { chapter: ci, column: page - acc };
            acc += counts[ci];
        }
        return { chapter: counts.length - 1, column: (counts[counts.length - 1] || 1) - 1 };
    }

    private async getColumnText(chapter: number, column: number): Promise<string> {
        if (get(rsvpColumnChapter) === chapter && column < get(rsvpColumnTexts).length) {
            return get(rsvpColumnTexts)[column] ?? "";
        }
        this.loadingColumn = true;
        try {
            // Chapters are still being fetched right after a book opens.
            if (!get(chapterHtmls)[chapter] && !get(chapterHtmlsLoaded)) await whenChapterHtmlsLoaded();
            const raw = get(chapterHtmls)[chapter];
            if (!raw) return "";
            const { texts, pageCount } = await columnizeOffscreen(raw, get(readerMetrics));
            rsvpColumnTexts.set(texts);
            rsvpColumnChapter.set(chapter);
            updatePageCounts((cs) =>
                cs[chapter] === pageCount ? cs : cs.map((c, i) => (i === chapter ? pageCount : c)),
            );
            return texts[column] ?? "";
        } finally {
            this.loadingColumn = false;
        }
    }

    /** Show page `page`; keep playing if `wasPlaying`. */
    async loadColumn(page: number, wasPlaying: boolean) {
        const { chapter, column } = this.locatePage(page);
        const text = await this.getColumnText(chapter, column);
        if (!get(rsvpActive)) return;

        // Blank page (e.g. section separator) — skip to the next column.
        if (!text.trim()) {
            if (page < get(readerTotalPages) - 1) {
                currentPage.set(page + 1);
                rsvpWordOffset.set(0);
            } else {
                this.stop();
            }
            return;
        }

        // Saved reading position: first word of this page within the chapter.
        const startWord = get(rsvpColumnTexts)
            .slice(0, column)
            .reduce((n, t) => n + (t ? t.split(" ").length : 0), 0);
        pageStart.set({ chapter, word: startWord });

        // Load the page's word list before playback starts, so the first
        // words already get complexity timing.
        loadLanguage(detectLanguage(text)).catch(() => {});

        const allTokens = tokenize(text);
        const start = Math.min(get(rsvpWordOffset), Math.max(0, allTokens.length - 1));

        this.tokens = allTokens;
        this.currentIdx = start;
        this.currentToken = start < allTokens.length ? allTokens[start] : null;
        this.started = false;

        if (this.engine) {
            this.engine.stop();
            this.engine = null;
        }

        const eng = new RsvpEngine(
            allTokens,
            get(rsvpConfig),
            (tok, idx) => {
                this.currentToken = tok;
                this.currentIdx = idx;
                rsvpWordOffset.set(idx);
            },
            () => this.advanceToNextPage(),
        );
        if (start < allTokens.length) {
            eng.seek(start);
        }
        this.engine = eng;

        // Auto-continue playing if we were playing before page transition
        if (wasPlaying) {
            this.started = true;
            this.playing = true;
            this.engine.start();
        }
    }

    private advanceToNextPage() {
        if (get(currentPage) < get(readerTotalPages) - 1) {
            const nextPage = get(currentPage) + 1;
            currentPage.set(nextPage);
            rsvpWordOffset.set(0);
        } else {
            this.stop();
        }
    }

    togglePlay() {
        if (!this.engine) return;
        if (this.engine.isPlaying) {
            this.engine.pause();
            this.playing = false;
            this.countdown.pause();
        } else if (!this.started) {
            this.started = true;
            this.playing = true;
            this.engine.start();
            this.countdown.start();
        } else {
            this.playing = true;
            this.engine.resume();
            if (this.countdown.remaining <= 0) {
                this.countdown.start();
            } else {
                this.countdown.resume();
            }
        }
    }

    /** Stop playback and leave RSVP mode, keeping the position. */
    stop() {
        if (this.engine) this.engine.stop();
        this.engine = null;
        this.playing = false;
        this.started = false;
        this.countdown.stop();
        rsvpActive.set(false);
        rsvpWordOffset.set(this.currentIdx);
        // Page mode shows where RSVP stopped.
        wordHighlight.set(true);
    }

    /**
     * Stop the engine and countdown without touching the stores. For when
     * the RSVP view goes away for another reason than stop() (for example a
     * book dropped onto the window), so they don't keep running in the
     * background and overwrite the new book's position.
     */
    dispose() {
        if (this.engine) this.engine.stop();
        this.engine = null;
        this.playing = false;
        this.countdown.stop();
    }

    updateConfig(cfg: RsvpConfig) {
        if (this.engine && get(rsvpActive)) {
            this.engine.updateConfig(cfg);
        }
    }
}
