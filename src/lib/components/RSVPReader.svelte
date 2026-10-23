<script lang="ts">
    import {
        book, currentPage, chapterPageCounts, readerTotalPages, chapterHtmls, chapterHtmlsLoaded,
        rsvpActive, rsvpWordOffset, rsvpConfig,
        rsvpColumnTexts, rsvpColumnChapter, readerMetrics, pageStart,
        updatePageCounts, whenChapterHtmlsLoaded,
    } from "$lib/stores";
    import { tokenize, RsvpEngine } from "$lib/utils/rsvp";
    import type { RsvpToken } from "$lib/utils/rsvp";
    import { columnizeOffscreen } from "$lib/utils/columns";
    import { loadLanguage } from "$lib/wordComplexity";
    import { detectLanguage } from "$lib/wordComplexity/language";
    import Controls from "./Controls.svelte";
    import { untrack } from "svelte";

    let tokens = $state<RsvpToken[]>([]);
    let currentToken = $state<RsvpToken | null>(null);
    let currentIdx = $state(0);
    let engine = $state<RsvpEngine | null>(null);
    let playing = $state(false);
    let started = $state(false);
    let timerRemaining = $state(0);
    let timerInterval: ReturnType<typeof setInterval> | null = null;
    let loadingColumn = $state(false);

    // chapter + column for the current global page
    function locatePage(page: number) {
        const counts = $chapterPageCounts;
        if (!counts.length) return { chapter: 0, column: 0 };
        let acc = 0;
        for (let ci = 0; ci < counts.length; ci++) {
            if (page < acc + counts[ci]) return { chapter: ci, column: page - acc };
            acc += counts[ci];
        }
        return { chapter: counts.length - 1, column: (counts[counts.length - 1] || 1) - 1 };
    }

    async function getColumnText(chapter: number, column: number): Promise<string> {
        if ($rsvpColumnChapter === chapter && column < $rsvpColumnTexts.length) {
            return $rsvpColumnTexts[column] ?? "";
        }
        loadingColumn = true;
        try {
            // Chapters are still being fetched right after a book opens.
            if (!$chapterHtmls[chapter] && !$chapterHtmlsLoaded) await whenChapterHtmlsLoaded();
            const raw = $chapterHtmls[chapter];
            if (!raw) return "";
            const { texts, pageCount } = await columnizeOffscreen(raw, $readerMetrics);
            rsvpColumnTexts.set(texts);
            rsvpColumnChapter.set(chapter);
            updatePageCounts((cs) => (cs[chapter] === pageCount ? cs : cs.map((c, i) => (i === chapter ? pageCount : c))));
            return texts[column] ?? "";
        } finally {
            loadingColumn = false;
        }
    }

    $effect(() => {
        if (!$rsvpActive) return;
        const page = $currentPage;
        untrack(() => {
            const wasPlaying = playing;
            loadColumn(page, wasPlaying);
        });
    });

    async function loadColumn(page: number, wasPlaying: boolean) {
        const { chapter, column } = locatePage(page);
        const text = await getColumnText(chapter, column);
        if (!$rsvpActive) return;

        // Blank page (e.g. section separator) — skip to the next column.
        if (!text.trim()) {
            if (page < $readerTotalPages - 1) {
                currentPage.set(page + 1);
                rsvpWordOffset.set(0);
            } else {
                stopRsvp();
            }
            return;
        }

        // Saved reading position: first word of this page within the chapter.
        const startWord = $rsvpColumnTexts
            .slice(0, column)
            .reduce((n, t) => n + (t ? t.split(" ").length : 0), 0);
        pageStart.set({ chapter, word: startWord });

        // Load the page's word list before playback starts, so the first
        // words already get complexity timing.
        loadLanguage(detectLanguage(text)).catch(() => {});

        const allTokens = tokenize(text);
        const start = Math.min($rsvpWordOffset, Math.max(0, allTokens.length - 1));

        tokens = allTokens;
        currentIdx = start;
        currentToken = start < allTokens.length ? allTokens[start] : null;
        started = false;

        if (engine) {
            engine.stop();
            engine = null;
        }

        const eng = new RsvpEngine(
            allTokens,
            $rsvpConfig,
            (tok, idx) => {
                currentToken = tok;
                currentIdx = idx;
                rsvpWordOffset.set(idx);
            },
            advanceToNextPage
        );
        if (start < allTokens.length) {
            eng.seek(start);
        }
        engine = eng;

        // Auto-continue playing if we were playing before page transition
        if (wasPlaying) {
            started = true;
            playing = true;
            engine.start();
        }
    }

    function advanceToNextPage() {
        if ($currentPage < $readerTotalPages - 1) {
            const nextPage = $currentPage + 1;
            currentPage.set(nextPage);
            rsvpWordOffset.set(0);
        } else {
            stopRsvp();
        }
    }

    function togglePlay() {
        if (!engine) return;
        if (engine.isPlaying) {
            engine.pause();
            playing = false;
            pauseTimer();
        } else if (!started) {
            started = true;
            playing = true;
            engine.start();
            startTimer();
        } else {
            playing = true;
            engine.resume();
            if (timerRemaining <= 0) {
                startTimer();
            } else {
                resumeTimer();
            }
        }
    }

    function stopRsvp() {
        if (engine) engine.stop();
        engine = null;
        playing = false;
        started = false;
        stopTimer();
        rsvpActive.set(false);
        rsvpWordOffset.set(currentIdx);
    }

    function startTimer() {
        const total = $rsvpConfig.timerMinutes * 60 + $rsvpConfig.timerSeconds;
        if (total <= 0) return;
        timerRemaining = total;
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            timerRemaining--;
            if (timerRemaining <= 0) {
                timerRemaining = 0;
                clearInterval(timerInterval!);
                timerInterval = null;
                if (engine) engine.pause();
                playing = false;
            }
        }, 1000);
    }

    function pauseTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    }

    function resumeTimer() {
        if ($rsvpConfig.timerMinutes + $rsvpConfig.timerSeconds <= 0) return;
        if (timerRemaining <= 0) return;
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            timerRemaining--;
            if (timerRemaining <= 0) {
                timerRemaining = 0;
                clearInterval(timerInterval!);
                timerInterval = null;
                if (engine) engine.pause();
                playing = false;
            }
        }, 1000);
    }

    function stopTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        timerRemaining = 0;
    }

    function timerMinDisplay(): number {
        const total = $rsvpConfig.timerMinutes * 60 + $rsvpConfig.timerSeconds;
        if (total <= 0) return 0;
        const t = timerRemaining > 0 ? timerRemaining : total;
        return Math.floor(t / 60);
    }

    function timerSecDisplay(): number {
        const total = $rsvpConfig.timerMinutes * 60 + $rsvpConfig.timerSeconds;
        if (total <= 0) return 0;
        const t = timerRemaining > 0 ? timerRemaining : total;
        return t % 60;
    }

    function setTimerMin(e: Event) {
        if (started && timerRemaining > 0) return;
        const raw = (e.target as HTMLInputElement).value.replace(/\D/g, "");
        const v = parseInt(raw);
        if (!isNaN(v)) {
            rsvpConfig.update((c) => ({ ...c, timerMinutes: Math.max(0, Math.min(99, v)) }));
        } else if (raw === "") {
            rsvpConfig.update((c) => ({ ...c, timerMinutes: 0 }));
        }
        (e.target as HTMLInputElement).value = String(Math.max(0, Math.min(99, parseInt(raw) || 0)));
    }

    function setTimerSec(e: Event) {
        if (started && timerRemaining > 0) return;
        const raw = (e.target as HTMLInputElement).value.replace(/\D/g, "");
        const v = parseInt(raw);
        if (!isNaN(v)) {
            rsvpConfig.update((c) => ({ ...c, timerSeconds: Math.max(0, Math.min(59, v)) }));
        } else if (raw === "") {
            rsvpConfig.update((c) => ({ ...c, timerSeconds: 0 }));
        }
        (e.target as HTMLInputElement).value = String(Math.max(0, Math.min(59, parseInt(raw) || 0)));
    }

    function onKeyDown(e: KeyboardEvent) {
        if (e.key === "a" || e.key === "A") {
            e.preventDefault();
            stopRsvp();
        }
        if (e.key === " ") {
            e.preventDefault();
            if (e.repeat) return;
            togglePlay();
        }
    }

    $effect(() => {
        const cfg = $rsvpConfig;
        untrack(() => {
            if (engine && $rsvpActive) {
                engine.updateConfig(cfg);
            }
        });
    });
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="rsvp-reader">
    <div class="toolbar">
        <span class="title">{$book?.title ?? "rsvp-reader"}</span>
        <div class="spacer"></div>
        <span class="page-num">Page {$currentPage + 1} / {$readerTotalPages}</span>
        <button class="exit-btn" onclick={stopRsvp}>Page mode (A)</button>
    </div>

    <div class="word-area" role="button" tabindex="0" onclick={togglePlay} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); togglePlay(); } }}>
        {#if currentToken}
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
            {playing ? "Click or Space to pause" : "Click or Space to play"}
        </div>
    </div>

    <div class="bottom-panel">
        <div class="play-bar">
            <button class="play-btn" onclick={togglePlay}>
                {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <input type="text" inputmode="numeric" maxlength="2" value={timerMinDisplay()} oninput={setTimerMin} class="timer-input timer-min" disabled={started && playing && timerRemaining > 0} />
            <span class="timer-colon">:</span>
            <input type="text" inputmode="numeric" maxlength="2" value={timerSecDisplay()} oninput={setTimerSec} class="timer-input timer-sec" disabled={started && playing && timerRemaining > 0} />
            <span class="progress">{currentIdx + 1} / {tokens.length} words</span>
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

    .spacer { flex: 1; }

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

    .pre { color: #e0e0e0; }
    .orp { color: #f55; }
    .post { color: #e0e0e0; }
    .punct-suffix { color: #e0e0e0; }
    .quote-prefix { color: #e0e0e0; }
    .punct { color: #888; font-size: 2rem; }

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

    .timer-input {
        width: 3rem;
        padding: 0.2rem 0.3rem;
        border: 1px solid #444;
        border-radius: 4px;
        background: #1a1a1a;
        color: #6a9cf5;
        font-size: 1.1rem;
        font-variant-numeric: tabular-nums;
        text-align: center;
    }

    .timer-input:disabled {
        opacity: 1;
        border-color: transparent;
    }

    .timer-input:focus {
        border-color: #6a9cf5;
        outline: none;
    }

    .timer-colon {
        font-size: 1.1rem;
        color: #6a9cf5;
        font-weight: bold;
    }
</style>