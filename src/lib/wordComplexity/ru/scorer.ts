import type { WordScore } from "../types";
import { SCORE_WEIGHTS } from "../types";
import { normalizeFrequency } from "../en/loader";
import { bigramRarity } from "./bigrams";

const RU_VOWELS = new Set(["а", "е", "ё", "и", "о", "у", "ы", "э", "ю", "я"]);
const MAX_LENGTH = 30;
const MAX_SYLLABLES = 12;

export function makeRuScorer(freqMap: Map<string, number>, top5000: Set<string>, bigramStats: Map<string, number>) {
    // Normalized by the loaded list's size (a fixed total of 200000 against a
    // 1.4M-word list produced values up to ~7). Missing words score 1, the hardest.
    function getFrequency(word: string): number {
        const rank = freqMap.get(word.toLowerCase());
        return rank !== undefined ? normalizeFrequency(rank, freqMap.size) : 1;
    }

    function countSyllables(word: string): number {
        const lower = word.toLowerCase();
        let count = 0;
        for (const ch of lower) {
            if (RU_VOWELS.has(ch)) count++;
        }
        return Math.max(1, count);
    }

    function getClusters(word: string): number {
        const matches = word.match(/[^аеёиоуыэюя]{2,}/gi);
        if (!matches) return 0;
        const totalLen = matches.reduce((s, m) => s + m.length, 0);
        return word.length > 0 ? totalLen / word.length : 0;
    }

    function getEntropy(word: string): number {
        const lower = word.toLowerCase();
        const freq = new Map<string, number>();
        for (const ch of lower) {
            freq.set(ch, (freq.get(ch) ?? 0) + 1);
        }
        let entropy = 0;
        for (const count of freq.values()) {
            const p = count / lower.length;
            entropy -= p * Math.log2(p);
        }
        const maxEntropy = Math.log2(Math.min(lower.length, 33));
        return maxEntropy > 0 ? entropy / maxEntropy : 0;
    }

    function isProperNoun(word: string): number {
        return /^[А-ЯЁ][а-яё]/.test(word) ? 1 : 0;
    }

    function isFamiliar(word: string): number {
        return top5000.has(word.toLowerCase()) ? 0 : 1;
    }

    return {
        score(word: string): WordScore {
            const lower = word.toLowerCase();
            const length = word.length;
            const factors = {
                frequency: getFrequency(lower),
                syllable: Math.min(countSyllables(lower) / MAX_SYLLABLES, 1),
                length: Math.min(length / MAX_LENGTH, 1),
                clusters: getClusters(word),
                entropy: getEntropy(word),
                properNoun: isProperNoun(word),
                familiar: isFamiliar(word),
                bigramRarity: bigramRarity(word, bigramStats),
            };
            const score =
                factors.frequency * SCORE_WEIGHTS.frequency +
                factors.syllable * SCORE_WEIGHTS.syllable +
                factors.length * SCORE_WEIGHTS.length +
                factors.clusters * SCORE_WEIGHTS.clusters +
                factors.entropy * SCORE_WEIGHTS.entropy +
                factors.properNoun * SCORE_WEIGHTS.properNoun +
                factors.familiar * SCORE_WEIGHTS.familiar +
                factors.bigramRarity * SCORE_WEIGHTS.bigramRarity;
            return { word, score, factors };
        },
    };
}
