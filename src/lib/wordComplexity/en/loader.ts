export async function loadFrequency(): Promise<Map<string, number>> {
    const resp = await fetch("/en_50k.txt");
    const text = await resp.text();
    const map = new Map<string, number>();
    let rank = 0;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const spaceIdx = trimmed.lastIndexOf(" ");
        const word = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
        map.set(word, rank++);
    }
    return map;
}

// Maps a 0-based rank in a list of `total` words into [0, 1).
export function normalizeFrequency(rank: number, total: number): number {
    return total > 0 ? Math.min(1, rank / total) : 1;
}