export interface RsvpToken {
    text: string;
    isWord: boolean;
    orpIndex: number;
    isPunctuation: boolean;
    punctSuffix: string;
    quotePrefix: string;
}

let _scoreWord: ((word: string) => { score: number }) | null = null;
let _complexityLoaded = false;

async function ensureComplexity(): Promise<void> {
    if (_complexityLoaded) return;
    _complexityLoaded = true;
    try {
        const mod = await import("$lib/wordComplexity");
        _scoreWord = (word: string) => mod.scoreWord(word);
    } catch {
        _scoreWord = () => ({ score: 0 });
    }
}
ensureComplexity();

export interface RsvpConfig {
    wpm: number;
    longWordDelay: boolean;
    punctuationPause: boolean;
    longWordThreshold: number;
    longWordMultiplier: number;
    punctuationDelayMs: number;
    complexityWeight: number;
    timerMinutes: number;
    timerSeconds: number;
}

export const DEFAULT_RSVP_CONFIG: RsvpConfig = {
    wpm: 300,
    longWordDelay: true,
    punctuationPause: true,
    longWordThreshold: 7,
    longWordMultiplier: 0.5,
    punctuationDelayMs: 200,
    complexityWeight: 0.5,
    timerMinutes: 0,
    timerSeconds: 0,
};

const PUNCTUATION = new Set([".", "!", "?", ";", ":", ",", "—", "…", '"', "'", "”", "’", "»", "`"]);
const OPENING_QUOTES = new Set(['"', "'", "«", "„", "“", "‘", "`", "\u2019"]);

function quoteFamily(ch: string): string {
    if (ch === '"' || ch === '\u201c' || ch === '\u201d' || ch === '\u00ab' || ch === '\u201e') return 'dbl';
    if (ch === "'" || ch === '\u2018' || ch === '\u2019' || ch === '\u201a') return 'sng';
    if (ch === '`') return 'btk';
    if (ch === '\u00bb') return 'dbl';
    return ch;
}

function isCompatibleQuote(a: string, b: string): boolean {
    return quoteFamily(a) === quoteFamily(b);
}

interface RawToken {
    text: string;
    isWord: boolean;
    orpIndex: number;
    isPunctuation: boolean;
    spaceBefore: boolean;
}

export function tokenize(text: string): RsvpToken[] {
    const raw: RawToken[] = [];
    const re = /([\p{L}\p{N}]+(?:['\u2019:.\-/][\p{L}\p{N}]+)*|\S)/gu;
    let match: RegExpExecArray | null;
    let prevEnd = 0;

    while ((match = re.exec(text)) !== null) {
        const raw_text = match[1];
        const spaceBefore = match.index > prevEnd;
        prevEnd = match.index + match[0].length;
        const isWord = /^[\p{L}\p{N}]+(?:['\u2019:.\-/][\p{L}\p{N}]+)*$/u.test(raw_text);
        raw.push({
            text: raw_text,
            isWord,
            orpIndex: isWord ? getORP(raw_text) : -1,
            isPunctuation: !isWord && PUNCTUATION.has(raw_text),
            spaceBefore,
        });
    }

    const tokens: RsvpToken[] = [];
    const openQuotes = new Set<string>();
    let i = 0;

    function hasQuoteOpen(close: string): boolean {
        for (const open of openQuotes) {
            if (isCompatibleQuote(open, close)) return true;
        }
        return false;
    }

    function removeQuote(close: string): void {
        for (const open of openQuotes) {
            if (isCompatibleQuote(open, close)) {
                openQuotes.delete(open);
                return;
            }
        }
    }

    while (i < raw.length) {
        const tok = raw[i];

        // Case A: opening quote (not currently open) followed by a word → quote as prefix,
        // with optional immediately-following closing punctuation as suffix
        if (!tok.isWord && OPENING_QUOTES.has(tok.text) && !hasQuoteOpen(tok.text)
            && i + 1 < raw.length && raw[i + 1].isWord) {
            openQuotes.add(tok.text);
            const wordTok = raw[i + 1];
            let punctSuffix = "";
            let consumed = 2;
            if (i + 2 < raw.length && raw[i + 2].isPunctuation) {
                punctSuffix = raw[i + 2].text;
                if (OPENING_QUOTES.has(raw[i + 2].text)) {
                    removeQuote(raw[i + 2].text);
                }
                consumed = 3;
            }
            tokens.push({
                text: wordTok.text,
                isWord: true,
                orpIndex: wordTok.orpIndex,
                isPunctuation: false,
                punctSuffix,
                quotePrefix: tok.text,
            });
            i += consumed;
            continue;
        }

        // Case B: word followed by directly-attached punctuation
        if (tok.isWord) {
            let punctSuffix = "";
            let consumed = 1;
            if (i + 1 < raw.length && raw[i + 1].isPunctuation && !raw[i + 1].spaceBefore) {
                const nextTok = raw[i + 1];
                if (OPENING_QUOTES.has(nextTok.text) && hasQuoteOpen(nextTok.text)) {
                    // closing quote → suffix, mark closed
                    removeQuote(nextTok.text);
                    punctSuffix = nextTok.text;
                    consumed = 2;
                } else if (!OPENING_QUOTES.has(nextTok.text)) {
                    punctSuffix = nextTok.text;
                    consumed = 2;
                }
            }
            tokens.push({
                text: tok.text,
                isWord: true,
                orpIndex: tok.orpIndex,
                isPunctuation: false,
                punctSuffix,
                quotePrefix: "",
            });
            i += consumed;
            continue;
        }

        // Case C: closing quote with no attached word → append to last word token
        if (!tok.isWord && OPENING_QUOTES.has(tok.text) && hasQuoteOpen(tok.text)) {
            removeQuote(tok.text);
            const last = tokens[tokens.length - 1];
            if (last && last.isWord && !last.punctSuffix) {
                last.punctSuffix = tok.text;
            } else {
                tokens.push({ text: tok.text, isWord: false, orpIndex: -1, isPunctuation: true, punctSuffix: "", quotePrefix: "" });
            }
            i++;
            continue;
        }

        // Fallthrough: standalone raw token (usually punctuation)
        // Glue to preceding word's suffix when possible
        const last = tokens[tokens.length - 1];
        if (last && last.isWord) {
            last.punctSuffix += tok.text;
        } else {
            tokens.push({
                text: tok.text,
                isWord: false,
                orpIndex: -1,
                isPunctuation: tok.isPunctuation,
                punctSuffix: "",
                quotePrefix: "",
            });
        }
        i++;
    }

    // Post-process: glue leading standalone punctuation to the following word
    for (let j = 0; j < tokens.length - 1; j++) {
        if (!tokens[j].isWord && tokens[j].isPunctuation && tokens[j + 1].isWord) {
            tokens[j + 1].quotePrefix = tokens[j].text + tokens[j + 1].quotePrefix;
            tokens.splice(j, 1);
            j--;
        }
    }

    return tokens;
}

export function getORP(word: string): number {
    if (word.length <= 1) return 0;
    return Math.floor(word.length / 3);
}

export function calculateDelay(token: RsvpToken, config: RsvpConfig): number {
    const baseDelay = 60000 / config.wpm;
    if (!token.isWord) {
        if (token.isPunctuation && config.punctuationPause) {
            return config.punctuationDelayMs;
        }
        return 0;
    }
    let delay = baseDelay;
    if (config.longWordDelay && token.text.length > config.longWordThreshold) {
        const extra = token.text.length / config.longWordThreshold;
        delay = baseDelay * (1 + (extra - 1) * config.longWordMultiplier);
    }
    if (config.punctuationPause && token.punctSuffix !== "") {
        delay += config.punctuationDelayMs;
    }
    if (config.complexityWeight > 0) {
        try {
            const wc = _scoreWord?.(token.text) ?? { score: 0 };
            delay = delay * (1 + wc.score * config.complexityWeight);
        } catch {
            // complexity scoring unavailable
        }
    }
    return Math.round(delay);
}

export type RsvpCallback = (token: RsvpToken, index: number) => void;

export class RsvpEngine {
    private tokens: RsvpToken[];
    private config: RsvpConfig;
    private onToken: RsvpCallback;
    private onEnd: (() => void) | null;
    private idx = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private playing = false;
    private finished = false;
    private currentDelay = 0;

    // onEnd fires once the last token's delay has fully elapsed, so the
    // last word gets the same display time as every other word.
    constructor(tokens: RsvpToken[], config: RsvpConfig, onToken: RsvpCallback, onEnd?: () => void) {
        this.tokens = tokens;
        this.config = { ...config };
        this.onToken = onToken;
        this.onEnd = onEnd ?? null;
    }

    get currentIndex(): number {
        return this.idx;
    }

    get isPlaying(): boolean {
        return this.playing;
    }

    start(): void {
        if (this.playing) return;
        if (this.idx >= this.tokens.length) return;
        this.playing = true;
        this.emitCurrent();
        this.currentDelay = calculateDelay(this.tokens[this.idx], this.config);
        this.idx++;
        this.schedule();
    }

    pause(): void {
        this.playing = false;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    resume(): void {
        if (this.playing || this.finished) return;
        if (this.tokens.length === 0) return;
        // Also reached when paused during the last token's delay: the
        // rescheduled advance() then finishes and fires onEnd.
        this.playing = true;
        this.schedule();
    }

    stop(): void {
        this.pause();
        this.idx = 0;
        this.finished = false;
    }

    seek(index: number): void {
        this.pause();
        this.idx = Math.max(0, Math.min(index, this.tokens.length - 1));
        this.finished = false;
    }

    // Applies to tokens shown after this call; the word on screen keeps its
    // already-scheduled delay instead of being skipped.
    updateConfig(config: Partial<RsvpConfig>): void {
        Object.assign(this.config, config);
    }

    private emitCurrent(): void {
        this.onToken(this.tokens[this.idx], this.idx);
    }

    private advance(): void {
        if (!this.playing) return;
        if (this.idx >= this.tokens.length) {
            this.playing = false;
            this.finished = true;
            this.timer = null;
            this.onEnd?.();
            return;
        }
        this.emitCurrent();
        this.currentDelay = calculateDelay(this.tokens[this.idx], this.config);
        this.idx++;
        this.schedule();
    }

    private schedule(): void {
        const delay = this.currentDelay;
        this.timer = setTimeout(() => this.advance(), delay);
    }
}