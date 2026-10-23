import type { LanguageScorer } from "./types";

const scorers = new Map<string, LanguageScorer>();

export function register(scorer: LanguageScorer): void {
    scorers.set(scorer.language, scorer);
}

export function getScorer(lang: string): LanguageScorer | undefined {
    return scorers.get(lang);
}