import type { Language, LanguageScorer, WordScore } from "./types";
import { detectLanguage } from "./language";
import { register, getScorer, isReady } from "./registry";
import { makeEnScorer } from "./en/scorer";
import { loadFrequency as loadEnFreq } from "./en/loader";
import { precomputeBigramStats as enBigrams } from "./en/bigrams";
import { makeRuScorer } from "./ru/scorer";
import { loadFrequency as loadRuFreq } from "./ru/loader";
import { precomputeBigramStats as ruBigrams } from "./ru/bigrams";

let ready = false;

export async function initWordComplexity(): Promise<void> {
    if (ready) return;

    const [enData, ruData] = await Promise.all([
        loadEnFreq(),
        loadRuFreq(),
    ]);

    const enStats = enBigrams(enData);
    const enScorer: LanguageScorer = {
        name: "English",
        label: "EN",
        language: "en",
        ready: () => true,
        init: async () => {},
        score: (word) => makeEnScorer(enData, enStats).score(word),
    };

    const ruStats = ruBigrams(ruData.map);
    const ruScorer: LanguageScorer = {
        name: "Russian",
        label: "RU",
        language: "ru",
        ready: () => true,
        init: async () => {},
        score: (word) => makeRuScorer(ruData.map, ruData.top5000, ruStats).score(word),
    };

    register(enScorer);
    register(ruScorer);
    ready = true;
}

export function scoreWord(word: string, lang?: Language): WordScore {
    const detected = lang ?? detectLanguage(word);
    const scorer = getScorer(detected);
    if (!scorer || !scorer.ready()) {
        return {
            word,
            score: 0,
            factors: {
                frequency: 0, syllable: 0, length: 0, clusters: 0,
                entropy: 0, properNoun: 0, familiar: 0, bigramRarity: 0,
            },
        };
    }
    return scorer.score(word);
}

export function detectAndScore(text: string): number {
    const lang = detectLanguage(text);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return 0;
    let total = 0;
    for (const w of words) {
        total += scoreWord(w, lang).score;
    }
    return total / words.length;
}

export function isComplexityReady(): boolean {
    return ready;
}