export type Language = "en" | "ru";

export interface WordScore {
    word: string;
    score: number;
    factors: {
        frequency: number;
        syllable: number;
        length: number;
        clusters: number;
        entropy: number;
        properNoun: number;
        familiar: number;
        bigramRarity: number;
    };
}

export interface LanguageScorer {
    name: string;
    label: string;
    init: () => Promise<void>;
    ready: () => boolean;
    score: (word: string) => WordScore;
    language: Language;
}

export interface FrequencyMap {
    word: string;
    count: number;
    rank: number;
}

export const SCORE_WEIGHTS = {
    frequency: 0.30,
    syllable: 0.15,
    length: 0.15,
    clusters: 0.10,
    entropy: 0.05,
    properNoun: 0.10,
    familiar: 0.10,
    bigramRarity: 0.05,
};