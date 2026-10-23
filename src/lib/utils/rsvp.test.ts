import { describe, it, expect } from "vitest";
import { tokenize, getORP, calculateDelay, DEFAULT_RSVP_CONFIG } from "./rsvp";
import type { RsvpToken, RsvpConfig } from "./rsvp";

function words(tokens: RsvpToken[]): string[] {
    return tokens.filter((t) => t.isWord).map((t) => t.text);
}

function allText(tokens: RsvpToken[]): string {
    return tokens.map((t) => t.text + t.punctSuffix).join("");
}

function textAndSuffix(tokens: RsvpToken[]): string[] {
    return tokens.map((t) => t.text + (t.punctSuffix || ""));
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
        expect(getORP("hello")).toBe(1);   // Math.floor(5/3) = 1
        expect(getORP("München")).toBe(2); // Math.floor(7/3) = 2
        expect(getORP("café")).toBe(1);    // Math.floor(4/3) = 1
    });
});

describe("calculateDelay", () => {
    const config: RsvpConfig = { ...DEFAULT_RSVP_CONFIG, complexityWeight: 0 };

    it("returns 0 for punctuation tokens", () => {
        const tok: RsvpToken = { text: ".", isWord: false, orpIndex: -1, isPunctuation: true, punctSuffix: "", quotePrefix: "" };
        expect(calculateDelay(tok, config)).toBe(200);
    });

    it("returns base delay for short word with variable delay off", () => {
        const cfg = { ...config, longWordDelay: false, punctuationPause: false };
        const tok: RsvpToken = { text: "cat", isWord: true, orpIndex: 0, isPunctuation: false, punctSuffix: "", quotePrefix: "" };
        expect(calculateDelay(tok, cfg)).toBe(200);
    });

    it("returns delay based on word length with variable delay on", () => {
        const cfg = { ...config, longWordDelay: true, longWordThreshold: 7, longWordMultiplier: 0.5 };
        const tok: RsvpToken = { text: "incomprehensibilities", isWord: true, orpIndex: 6, isPunctuation: false, punctSuffix: "", quotePrefix: "" };
        const delay = calculateDelay(tok, cfg);
        expect(delay).toBeGreaterThan(200);
    });

    it("includes punctuation pause when suffix present", () => {
        const cfg = { ...config, punctuationPause: true, punctuationDelayMs: 200 };
        const tok: RsvpToken = { text: "hello", isWord: true, orpIndex: 1, isPunctuation: false, punctSuffix: ",", quotePrefix: "" };
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