import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeEnScorer } from "./en/scorer";
import { precomputeBigramStats as enBigrams } from "./en/bigrams";
import { makeRuScorer } from "./ru/scorer";
import { precomputeBigramStats as ruBigrams } from "./ru/bigrams";

function rankMap(words: string[]): Map<string, number> {
    return new Map(words.map((w, i) => [w, i]));
}

describe("English scorer", () => {
    const freq = rankMap(["the", "of", "and", "cat", "house"]);
    const scorer = makeEnScorer(freq, enBigrams(freq));

    it("scores words without throwing (dale-chall lookup)", () => {
        expect(() => scorer.score("the")).not.toThrow();
        expect(() => scorer.score("Incomprehensibilities")).not.toThrow();
    });

    it("marks Dale-Chall words as familiar and others as unfamiliar", () => {
        expect(scorer.score("house").factors.familiar).toBe(0);
        expect(scorer.score("photosynthesis").factors.familiar).toBe(1);
    });

    it("normalizes frequency by the list size and treats missing words as hardest", () => {
        expect(scorer.score("the").factors.frequency).toBe(0);
        expect(scorer.score("house").factors.frequency).toBeCloseTo(4 / 5);
        expect(scorer.score("zyzzyva").factors.frequency).toBe(1);
    });

    it("scores rare words higher than common ones", () => {
        expect(scorer.score("photosynthesis").score).toBeGreaterThan(scorer.score("the").score);
    });
});

describe("Russian scorer", () => {
    // Simulates a list much longer than the old fixed total of 200000.
    const words = Array.from({ length: 300_000 }, (_, i) => `слово${i}`);
    words[0] = "и";
    words[299_999] = "редчайшее";
    const freq = rankMap(words);
    const scorer = makeRuScorer(freq, new Set(["и"]), ruBigrams(new Map([["и", 0], ["редчайшее", 1]])));

    it("keeps the frequency factor within [0, 1] for every rank", () => {
        expect(scorer.score("и").factors.frequency).toBe(0);
        const rare = scorer.score("редчайшее").factors.frequency;
        expect(rare).toBeGreaterThan(0.99);
        expect(rare).toBeLessThan(1);
    });

    it("treats words missing from the list as harder than any listed word", () => {
        expect(scorer.score("отсутствующее").factors.frequency).toBe(1);
        expect(scorer.score("отсутствующее").factors.frequency)
            .toBeGreaterThan(scorer.score("редчайшее").factors.frequency);
    });
});

describe("lazy loading", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        fetchMock = vi.fn(async (url: string) => {
            const body = url.includes("ru") ? "и 100\nдом 50\nкот 10\n" : "the 100\ncat 50\n";
            return { text: async () => body } as Response;
        });
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("loads only the scored word's language, once, then scores with it", async () => {
        const wc = await import("./index");
        expect(wc.scoreWord("кот").score).toBe(0); // not loaded yet
        wc.scoreWord("дом");
        wc.scoreWord("и");
        await wc.loadLanguage("ru");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe("/ru_200k.txt");
        expect(wc.scoreWord("кот").score).toBeGreaterThan(0);
    });

    it("shares one load between concurrent callers", async () => {
        const wc = await import("./index");
        await Promise.all([wc.loadLanguage("en"), wc.loadLanguage("en"), wc.loadLanguage("en")]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(wc.scoreWord("cat", "en").factors.frequency).toBeCloseTo(1 / 2);
    });

    it("does not retry a failed load for every word", async () => {
        fetchMock.mockRejectedValue(new Error("offline"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const wc = await import("./index");
        wc.scoreWord("cat");
        await expect(wc.loadLanguage("en")).rejects.toThrow("offline");
        wc.scoreWord("dog");
        wc.scoreWord("house");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
