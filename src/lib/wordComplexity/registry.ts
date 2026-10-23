import type { LanguageScorer } from "./types";

const scorers = new Map<string, LanguageScorer>();

export function register(scorer: LanguageScorer): void {
    scorers.set(scorer.language, scorer);
}

export function getScorer(lang: string): LanguageScorer | undefined {
    return scorers.get(lang);
}

export function getAllScorers(): LanguageScorer[] {
    return Array.from(scorers.values());
}

export function isReady(lang: string): boolean {
    return scorers.get(lang)?.ready() ?? false;
}