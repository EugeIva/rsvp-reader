import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    tokenize,
    getORP,
    calculateDelay,
    DEFAULT_RSVP_CONFIG,
    RsvpEngine,
    tokenIndexOfWord,
    wordIndexOfToken,
} from "./rsvp";
import type { RsvpToken, RsvpConfig } from "./rsvp";

function words(tokens: RsvpToken[]): string[] {
    return tokens.filter((t) => t.isWord).map((t) => t.text);
}

function allText(tokens: RsvpToken[]): string {
    return tokens.map((t) => t.text + t.punctSuffix).join("");
}

describe("tokenize", () => {
    it("basic English sentence", () => {
        const tokens = tokenize("Hello, world!");
        expect(words(tokens)).toEqual(["Hello", "world"]);
        expect(allText(tokens)).toBe("Hello,world!");
    });

    it("punctuation attached as suffix to preceding word", () => {
        const tokens = tokenize("Hello, world!");
        const hello = tokens[0];
        expect(hello.text).toBe("Hello");
        expect(hello.punctSuffix).toBe(",");
        expect(hello.isWord).toBe(true);
        const world = tokens[1];
        expect(world.text).toBe("world");
        expect(world.punctSuffix).toBe("!");
    });

    it("empty string", () => {
        expect(tokenize("")).toEqual([]);
    });

    it("single word", () => {
        const tokens = tokenize("Hello");
        expect(words(tokens)).toEqual(["Hello"]);
        expect(tokens[0].orpIndex).toBe(1);
    });

    it("multiple spaces collapsed", () => {
        const tokens = tokenize("hello    world");
        expect(words(tokens)).toEqual(["hello", "world"]);
    });

    it("words with umlauts (ä, ö, ü)", () => {
        const tokens = tokenize("München Köln Düsseldorf");
        const w = words(tokens);
        expect(w).toEqual(["München", "Köln", "Düsseldorf"]);
    });

    it("words with acute accents (é, á, ó, ú)", () => {
        const tokens = tokenize("café déjà vu áo mùa xuân");
        const w = words(tokens);
        expect(w).toEqual(["café", "déjà", "vu", "áo", "mùa", "xuân"]);
    });

    it("words with circumflex (ê, î, ô, û)", () => {
        const tokens = tokenize("hôpital forêt île coût");
        expect(words(tokens)).toEqual(["hôpital", "forêt", "île", "coût"]);
    });

    it("words with tilde (ñ, ã, õ)", () => {
        const tokens = tokenize("mañana jalapeño São Paulo");
        expect(words(tokens)).toEqual(["mañana", "jalapeño", "São", "Paulo"]);
    });

    it("words with cedilla (ç)", () => {
        const tokens = tokenize("garçon français ça va");
        expect(words(tokens)).toEqual(["garçon", "français", "ça", "va"]);
    });

    it("German: mixed umlauts and punctuation", () => {
        const tokens = tokenize("Ärger, Öl, Übermut!");
        expect(words(tokens)).toEqual(["Ärger", "Öl", "Übermut"]);
    });

    it("Scandinavian: ø, æ, å", () => {
        const tokens = tokenize("København ærlig ål");
        expect(words(tokens)).toEqual(["København", "ærlig", "ål"]);
    });

    it("Icelandic: þ, ð", () => {
        const tokens = tokenize("Þingvellir ðing");
        expect(words(tokens)).toEqual(["Þingvellir", "ðing"]);
    });

    it("Polish: ł, ń, ś, ć, ź, ż", () => {
        const tokens = tokenize("Łódź ścieżka całość");
        expect(words(tokens)).toEqual(["Łódź", "ścieżka", "całość"]);
    });

    it("Czech/Slovak: ů, ř, ž, š, č, ď, ň, ť", () => {
        const tokens = tokenize("řeka žlutý černý skříň");
        expect(words(tokens)).toEqual(["řeka", "žlutý", "černý", "skříň"]);
    });

    it("Romanian: ă, â, î, ș, ț", () => {
        const tokens = tokenize("țară românesc adânc");
        expect(words(tokens)).toEqual(["țară", "românesc", "adânc"]);
    });

    it("Hungarian: ő, ű", () => {
        const tokens = tokenize("őrült hűvös");
        expect(words(tokens)).toEqual(["őrült", "hűvös"]);
    });

    it("mixed ASCII and accented text", () => {
        const tokens = tokenize("The café on Müllerstraße is great!");
        expect(words(tokens)).toEqual(["The", "café", "on", "Müllerstraße", "is", "great"]);
    });

    it("capital accented letters", () => {
        const tokens = tokenize("ÉMILE ZOLA ÑOÑO");
        expect(words(tokens)).toEqual(["ÉMILE", "ZOLA", "ÑOÑO"]);
    });

    it("words with diaeresis (ë, ï, ö)", () => {
        const tokens = tokenize("naïve Brontë coöperation");
        expect(words(tokens)).toEqual(["naïve", "Brontë", "coöperation"]);
    });

    it("quotes around accented words", () => {
        const tokens = tokenize("«München» is great");
        expect(words(tokens)).toEqual(["München", "is", "great"]);
    });
});

describe("getORP", () => {
    it("returns 0 for single-character words", () => {
        expect(getORP("a")).toBe(0);
        expect(getORP("é")).toBe(0);
    });

    it("returns floor(length / 3) for multi-character words", () => {
        expect(getORP("hello")).toBe(1); // Math.floor(5/3) = 1
        expect(getORP("München")).toBe(2); // Math.floor(7/3) = 2
        expect(getORP("café")).toBe(1); // Math.floor(4/3) = 1
    });
});

describe("calculateDelay", () => {
    const config: RsvpConfig = { ...DEFAULT_RSVP_CONFIG, complexityWeight: 0 };

    it("returns 0 for punctuation tokens", () => {
        const tok: RsvpToken = {
            text: ".",
            isWord: false,
            orpIndex: -1,
            isPunctuation: true,
            punctSuffix: "",
            quotePrefix: "",
        };
        expect(calculateDelay(tok, config)).toBe(200);
    });

    it("returns base delay for short word with variable delay off", () => {
        const cfg = { ...config, longWordMultiplier: 0, punctuationDelayMs: 0 };
        const tok: RsvpToken = {
            text: "cat",
            isWord: true,
            orpIndex: 0,
            isPunctuation: false,
            punctSuffix: "",
            quotePrefix: "",
        };
        expect(calculateDelay(tok, cfg)).toBe(200);
    });

    it("returns delay based on word length with variable delay on", () => {
        const cfg = { ...config, longWordThreshold: 7, longWordMultiplier: 0.5 };
        const tok: RsvpToken = {
            text: "incomprehensibilities",
            isWord: true,
            orpIndex: 6,
            isPunctuation: false,
            punctSuffix: "",
            quotePrefix: "",
        };
        const delay = calculateDelay(tok, cfg);
        expect(delay).toBeGreaterThan(200);
    });

    it("includes punctuation pause when suffix present", () => {
        const cfg = { ...config, punctuationDelayMs: 200 };
        const tok: RsvpToken = {
            text: "hello",
            isWord: true,
            orpIndex: 1,
            isPunctuation: false,
            punctSuffix: ",",
            quotePrefix: "",
        };
        const delay = calculateDelay(tok, cfg);
        expect(delay).toBeGreaterThanOrEqual(400);
    });
});

describe("tokenize — edge cases", () => {
    it("hyphenated words", () => {
        const tokens = tokenize("well-known state-of-the-art");
        expect(words(tokens)).toEqual(["well-known", "state-of-the-art"]);
    });

    it("possessives", () => {
        const tokens = tokenize("John's cat");
        expect(words(tokens)).toEqual(["John's", "cat"]);
    });

    it("numbers", () => {
        const tokens = tokenize("42 is the answer");
        expect(words(tokens)).toEqual(["42", "is", "the", "answer"]);
    });

    it("only punctuation", () => {
        const tokens = tokenize("?!.");
        expect(tokens.every((t) => t.isPunctuation)).toBe(true);
    });

    it("em-dash", () => {
        const tokens = tokenize("hello—world");
        expect(words(tokens)).toEqual(["hello", "world"]);
    });

    it("ellipsis", () => {
        const tokens = tokenize("wait...");
        expect(tokens.length).toBe(1);
        expect(tokens[0].text).toBe("wait");
        expect(tokens[0].isWord).toBe(true);
        expect(tokens[0].punctSuffix).toBe("...");
    });

    it("glues comma with space before to preceding word", () => {
        const tokens = tokenize("hello , world");
        expect(words(tokens)).toEqual(["hello", "world"]);
        expect(tokens[0].punctSuffix).toBe(",");
    });

    it("glues consecutive punctuation to preceding word", () => {
        const tokens = tokenize("hello?! world");
        expect(words(tokens)).toEqual(["hello", "world"]);
        expect(tokens[0].punctSuffix).toBe("?!");
    });

    it("glues leading punctuation to following word", () => {
        const tokens = tokenize("!hello");
        expect(words(tokens)).toEqual(["hello"]);
        expect(tokens[0].quotePrefix).toBe("!");
    });
});
describe("RsvpEngine", () => {
    // 300 WPM with every modifier off: each word is shown for exactly 200 ms.
    const config: RsvpConfig = {
        ...DEFAULT_RSVP_CONFIG,
        wpm: 300,
        longWordMultiplier: 0,
        punctuationDelayMs: 0,
        complexityWeight: 0,
    };

    let shown: string[];
    let ended: number;

    function makeEngine(text: string) {
        shown = [];
        ended = 0;
        return new RsvpEngine(
            tokenize(text),
            config,
            (tok) => shown.push(tok.text),
            () => ended++,
        );
    }

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("shows each word for its full delay", () => {
        const eng = makeEngine("one two three");
        eng.start();
        expect(shown).toEqual(["one"]);
        vi.advanceTimersByTime(199);
        expect(shown).toEqual(["one"]);
        vi.advanceTimersByTime(1);
        expect(shown).toEqual(["one", "two"]);
        vi.advanceTimersByTime(200);
        expect(shown).toEqual(["one", "two", "three"]);
    });

    it("fires onEnd only after the last word's delay has elapsed", () => {
        const eng = makeEngine("one two");
        eng.start();
        vi.advanceTimersByTime(200);
        expect(shown).toEqual(["one", "two"]);
        expect(ended).toBe(0);
        vi.advanceTimersByTime(199);
        expect(ended).toBe(0);
        vi.advanceTimersByTime(1);
        expect(ended).toBe(1);
        expect(eng.isPlaying).toBe(false);
    });

    it("fires onEnd once, even if resumed after finishing", () => {
        const eng = makeEngine("one");
        eng.start();
        vi.advanceTimersByTime(200);
        expect(ended).toBe(1);
        eng.resume();
        vi.advanceTimersByTime(1000);
        expect(ended).toBe(1);
        expect(shown).toEqual(["one"]);
    });

    it("still fires onEnd when paused and resumed during the last word", () => {
        const eng = makeEngine("one two");
        eng.start();
        vi.advanceTimersByTime(250); // "two" is on screen
        eng.pause();
        vi.advanceTimersByTime(1000);
        expect(ended).toBe(0);
        eng.resume();
        vi.advanceTimersByTime(200);
        expect(ended).toBe(1);
        expect(shown).toEqual(["one", "two"]);
    });

    it("pause and resume neither skip nor repeat words", () => {
        const eng = makeEngine("one two three");
        eng.start();
        eng.pause();
        vi.advanceTimersByTime(1000);
        expect(shown).toEqual(["one"]);
        eng.resume();
        vi.advanceTimersByTime(200);
        expect(shown).toEqual(["one", "two"]);
        vi.advanceTimersByTime(200);
        expect(shown).toEqual(["one", "two", "three"]);
    });

    it("updateConfig while playing keeps the current word and applies to later words", () => {
        const eng = makeEngine("one two three");
        eng.start();
        vi.advanceTimersByTime(100);
        eng.updateConfig({ wpm: 600 }); // 100 ms per word from now on
        expect(shown).toEqual(["one"]);
        vi.advanceTimersByTime(99);
        expect(shown).toEqual(["one"]); // "one" keeps its original 200 ms
        vi.advanceTimersByTime(1);
        expect(shown).toEqual(["one", "two"]);
        vi.advanceTimersByTime(100);
        expect(shown).toEqual(["one", "two", "three"]); // "two" used the new 100 ms
        expect(eng.isPlaying).toBe(true);
    });

    it("repeated updateConfig calls (slider drag) do not advance words", () => {
        const eng = makeEngine("one two three");
        eng.start();
        for (let wpm = 300; wpm <= 400; wpm += 10) eng.updateConfig({ wpm });
        expect(shown).toEqual(["one"]);
    });

    it("start after seek begins at the sought word", () => {
        const eng = makeEngine("one two three");
        eng.seek(2);
        eng.start();
        expect(shown).toEqual(["three"]);
        vi.advanceTimersByTime(200);
        expect(ended).toBe(1);
    });
});

// Cases ported from the former scripts/test-rsvp.ts (run by hand with tsx;
// its console.assert checks never failed a run).
describe("tokenize — word shapes", () => {
    it("splits a sentence into words with attached punctuation", () => {
        const tokens = tokenize("Hello, world! How are you?");
        expect(tokens.map((t) => t.text)).toEqual(["Hello", "world", "How", "are", "you"]);
        expect(tokens[0].punctSuffix).toBe(",");
        expect(tokens[1].punctSuffix).toBe("!");
        expect(tokens[0].orpIndex).toBe(1);
    });

    it("keeps times, abbreviations, hyphenated words and contractions whole", () => {
        expect(words(tokenize("at 7:30 pm"))).toContain("7:30");
        expect(tokenize("at A.M. it").some((t) => t.text === "A.M")).toBe(true);
        expect(words(tokenize("my mother-in-law is"))).toContain("mother-in-law");
        expect(words(tokenize("don't stop"))).toContain("don't");
    });

    it("attaches quotes to the quoted words", () => {
        const tin = tokenize('he said "tin" to her').find((t) => t.text === "tin");
        expect(tin?.quotePrefix).toBe('"');
        expect(tin?.punctSuffix).toBe('"');

        const [first, second] = tokenize('"this day" gone');
        expect(first.quotePrefix + first.text).toBe('"this');
        expect(second.text + second.punctSuffix).toBe('day"');
    });
});

describe("getORP and calculateDelay — more cases", () => {
    const base: RsvpConfig = { ...DEFAULT_RSVP_CONFIG, complexityWeight: 0 };
    const word = (text: string, punctSuffix = ""): RsvpToken => ({
        text,
        isWord: true,
        orpIndex: getORP(text),
        isPunctuation: false,
        punctSuffix,
        quotePrefix: "",
    });
    const comma: RsvpToken = {
        text: ",",
        isWord: false,
        orpIndex: -1,
        isPunctuation: true,
        punctSuffix: "",
        quotePrefix: "",
    };

    it("puts the ORP a third of the way in", () => {
        expect(getORP("he")).toBe(0);
        expect(getORP("hel")).toBe(1);
        expect(getORP("incomprehensibilities")).toBe(7);
    });

    it("derives the base delay from WPM", () => {
        expect(calculateDelay(word("hello"), { ...base, wpm: 300 })).toBe(200);
        expect(calculateDelay(word("hello"), { ...base, wpm: 600 })).toBe(100);
    });

    it("adds the punctuation pause, and drops it at 0 ms", () => {
        expect(calculateDelay(word("hello", ","), { ...base, wpm: 300 })).toBe(400);
        expect(calculateDelay(comma, { ...base, punctuationDelayMs: 0 })).toBe(0);
    });
});

describe("word <-> token mapping (clicking a word in page mode)", () => {
    it("records where each token's text starts", () => {
        const text = '«Hello», he said — "tin" ok.';
        for (const tok of tokenize(text)) {
            expect(text.slice(tok.offset, tok.offset! + tok.text.length)).toBe(tok.text);
        }
    });

    it("maps words to tokens when they line up one-to-one", () => {
        const words = ["one", "two", "three"];
        expect([0, 1, 2].map((k) => tokenIndexOfWord(words, k))).toEqual([0, 1, 2]);
        expect([0, 1, 2].map((t) => wordIndexOfToken(words, t))).toEqual([0, 1, 2]);
    });

    it("maps a punctuation-only word to the token it is glued to", () => {
        // "—" becomes part of "said"'s suffix, so tokens are said, then.
        const words = ["he", "said", "—", "then", "left."];
        expect(tokenize(words.join(" ")).map((t) => t.text)).toEqual(["he", "said", "then", "left"]);
        expect(tokenIndexOfWord(words, 2)).toBe(1);
        expect(tokenIndexOfWord(words, 3)).toBe(2);
        expect(wordIndexOfToken(words, 2)).toBe(3);
    });

    it("maps quoted words to their token, and back to the word itself", () => {
        const words = ["he", "said", '"tin"', "to", "her"];
        expect(tokenIndexOfWord(words, 2)).toBe(2);
        expect(wordIndexOfToken(words, 2)).toBe(2);
    });

    it("round-trips every word of a page that starts a token", () => {
        const words = "Он сказал: «Не надо» — и ушёл, не оглядываясь… Потом вернулся.".split(" ");
        const tokens = tokenize(words.join(" "));
        for (let t = 0; t < tokens.length; t++) {
            expect(tokenIndexOfWord(words, wordIndexOfToken(words, t))).toBe(t);
        }
    });

    it("clamps out-of-range token indexes", () => {
        expect(wordIndexOfToken(["a", "b"], 99)).toBe(1);
        expect(wordIndexOfToken([], 0)).toBe(0);
    });
});
