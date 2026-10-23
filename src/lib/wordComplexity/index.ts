import type { Language, LanguageScorer, WordScore } from "./types";
import { detectLanguage } from "./language";
import { register, getScorer } from "./registry";
import { makeEnScorer } from "./en/scorer";
import { loadFrequency as loadEnFreq } from "./en/loader";
import { precomputeBigramStats as enBigrams } from "./en/bigrams";
import { makeRuScorer } from "./ru/scorer";
import { loadFrequency as loadRuFreq } from "./ru/loader";
import { precomputeBigramStats as ruBigrams } from "./ru/bigrams";

// One load per language; concurrent callers share the promise. A failed load
// is not retried, so a missing word list can't trigger a fetch per word.
const loading = new Map<Language, Promise<void>>();

async function buildScorer(lang: Language): Promise<LanguageScorer> {
    if (lang === "en") {
        const data = await loadEnFreq();
        const scorer = makeEnScorer(data, enBigrams(data));
        return {
            name: "English",
            label: "EN",
            language: "en",
            ready: () => true,
            score: scorer.score,
        };
    }
    const data = await loadRuFreq();
    const scorer = makeRuScorer(data.map, data.top5000, ruBigrams(data.map));
    return {
        name: "Russian",
        label: "RU",
        language: "ru",
        ready: () => true,
        score: scorer.score,
    };
}

/** Load a language's word list and register its scorer (once). */
export function loadLanguage(lang: Language): Promise<void> {
    let p = loading.get(lang);
    if (!p) {
        p = buildScorer(lang).then(register);
        loading.set(lang, p);
    }
    return p;
}

/**
 * Score a word with its language's scorer. A language's word list is loaded
 * the first time one of its words is scored, so only the languages a book
 * actually uses are loaded; until then the word scores 0.
 */
export function scoreWord(word: string, lang?: Language): WordScore {
    const detected = lang ?? detectLanguage(word);
    const scorer = getScorer(detected);
    if (!scorer || !scorer.ready()) {
        if (!loading.has(detected)) {
            loadLanguage(detected).catch((e) => console.warn(`wordComplexity: failed to load "${detected}"`, e));
        }
        return {
            word,
            score: 0,
            factors: {
                frequency: 0,
                syllable: 0,
                length: 0,
                clusters: 0,
                entropy: 0,
                properNoun: 0,
                familiar: 0,
                bigramRarity: 0,
            },
        };
    }
    return scorer.score(word);
}
