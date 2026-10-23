export async function loadFrequency(): Promise<{ map: Map<string, number>; top5000: Set<string> }> {
    const resp = await fetch("/ru_200k.txt");
    const text = await resp.text();
    const map = new Map<string, number>();
    const top5000 = new Set<string>();
    let rank = 0;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const spaceIdx = trimmed.lastIndexOf(" ");
        const word = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
        map.set(word.toLowerCase(), rank);
        if (rank < 5000) top5000.add(word.toLowerCase());
        rank++;
    }
    return { map, top5000 };
}