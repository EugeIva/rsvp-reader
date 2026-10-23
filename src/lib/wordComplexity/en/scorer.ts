import { syllable } from "syllable";
import { daleChall } from "dale-chall";
import type { WordScore } from "../types";
import { SCORE_WEIGHTS } from "../types";
import { normalizeFrequency } from "./loader";
import { bigramRarity } from "./bigrams";

const MAX_LENGTH = 30;
const MAX_SYLLABLES = 12;

// dale-chall exports a plain array; a Set gives O(1) lookups.
const FAMILIAR_WORDS = new Set(daleChall);

export function makeEnScorer(
    freqMap: Map<string, number>,
    bigramStats: Map<string, number>,
) {
    // Words missing from the list score 1, the hardest.
    function getFrequency(word: string): number {
        const rank = freqMap.get(word.toLowerCase());
        return rank !== undefined ? normalizeFrequency(rank, freqMap.size) : 1;
    }

    function getSyllables(word: string): number {
        try {
            return syllable(word);
        } catch {
            return estimateSyllablesSimple(word);
        }
    }

    function getClusters(word: string): number {
        const matches = word.match(/[^aeiouy]{2,}/gi);
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
        const maxEntropy = Math.log2(Math.min(lower.length, 26));
        return maxEntropy > 0 ? entropy / maxEntropy : 0;
    }

    function isProperNoun(word: string): number {
        return /^[A-Z][a-z]/.test(word) ? 1 : 0;
    }

    function isFamiliar(word: string): number {
        return FAMILIAR_WORDS.has(word.toLowerCase()) ? 0 : 1;
    }

    return {
        score(word: string): WordScore {
            const lower = word.toLowerCase();
            const length = word.length;
            const freq = getFrequency(lower);
            const sylCount = getSyllables(lower);
            const factors = {
                frequency: freq,
                syllable: Math.min(sylCount / MAX_SYLLABLES, 1),
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

function estimateSyllablesSimple(word: string): number {
    const vowels = word.match(/[aeiouy]/gi);
    return vowels ? vowels.length : 1;
}