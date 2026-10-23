export function precomputeBigramStats(map: Map<string, number>): Map<string, number> {
    const bigramCount = new Map<string, number>();
    let total = 0;
    for (const word of map.keys()) {
        for (let i = 0; i < word.length - 1; i++) {
            const bg = word.slice(i, i + 2).toLowerCase();
            bigramCount.set(bg, (bigramCount.get(bg) ?? 0) + 1);
            total++;
        }
    }
    const rarity = new Map<string, number>();
    for (const [bg, count] of bigramCount) {
        rarity.set(bg, 1 - count / total);
    }
    return rarity;
}

export function bigramRarity(word: string, stats: Map<string, number>): number {
    const lower = word.toLowerCase();
    let total = 0;
    let sum = 0;
    for (let i = 0; i < lower.length - 1; i++) {
        const bg = lower.slice(i, i + 2);
        sum += stats.get(bg) ?? 1;
        total++;
    }
    return total > 0 ? sum / total : 0;
}
