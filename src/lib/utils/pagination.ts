export interface PageLocation {
    wordStart: number;
    wordEnd: number;
}

export function computeTotalPages(pagesPerChapter: number[]): number {
    return pagesPerChapter.reduce((sum, p) => sum + p, 0);
}

let _measureEl: HTMLElement | null = null;

function getMeasureEl(fontSizePx: number, lineHeight: number, font: string): HTMLElement {
    if (!_measureEl) {
        _measureEl = document.createElement("span");
        _measureEl.style.cssText = "position:fixed;visibility:hidden;white-space:nowrap;height:auto;top:-999px;left:-999px;pointer-events:none;";
        document.body.appendChild(_measureEl);
    }
    _measureEl.style.font = `${fontSizePx}px/${lineHeight} ${font}`;
    return _measureEl;
}

function measureWord(el: HTMLElement, word: string): number {
    el.textContent = word + " ";
    return el.getBoundingClientRect().width;
}

export function computePageBoundaries(
    words: string[],
    width: number,
    height: number,
    fontSizePx: number,
    lineHeight: number,
    font: string,
): number[] {
    if (width <= 0 || height <= 0 || fontSizePx <= 0 || words.length === 0) {
        return [0];
    }

    try {
        const measureEl = getMeasureEl(fontSizePx, lineHeight, font);

        const maxWidth = width;
        const lineH = fontSizePx * lineHeight;
        const maxLines = Math.max(1, Math.floor(height / lineH) - 1);
        if (maxLines < 1) return [0];

        const pageStarts: number[] = [0];
        let lineWidth = 0;
        let lineCount = 1;

        for (let i = 0; i < words.length; i++) {
            let wordWidth: number;
            try {
                wordWidth = measureWord(measureEl, words[i]);
            } catch {
                wordWidth = words[i].length * fontSizePx * 0.5 + fontSizePx * 0.2;
            }

            if (wordWidth > maxWidth) {
                wordWidth = maxWidth * 0.9;
            }

            if (lineWidth + wordWidth > maxWidth && lineWidth > 0) {
                if (lineCount >= maxLines) {
                    pageStarts.push(i);
                    lineCount = 1;
                    lineWidth = 0;
                } else {
                    lineCount++;
                    lineWidth = 0;
                }
            }
            lineWidth += wordWidth;
        }

        return pageStarts.length > 0 ? pageStarts : [0];
    } catch (e) {
        console.warn("computePageBoundaries: error, using fallback", e);
        return fallbackBoundaries(words.length, width, height, fontSizePx, lineHeight);
    }
}

function fallbackBoundaries(
    wordCount: number,
    width: number,
    height: number,
    fontSizePx: number,
    lineHeight: number,
): number[] {
    const avgCharWidth = fontSizePx * 0.5;
    const charsPerLine = width / avgCharWidth;
    const wordsPerLine = charsPerLine / 5.5;
    const linesPerPage = Math.max(1, Math.floor(height / (fontSizePx * lineHeight)));
    const wpp = Math.max(1, Math.floor(wordsPerLine * linesPerPage * 0.85));
    const pageCount = Math.max(1, Math.ceil(wordCount / wpp));
    const bounds: number[] = [0];
    for (let p = 1; p < pageCount; p++) bounds.push(p * wpp);
    return bounds;
}

export function computeGlobalBoundaries(
    chapterWords: string[][],
    width: number,
    height: number,
    fontSizePx: number,
    lineHeight: number,
    font: string,
): number[] {
    const globalPages: number[] = [0];
    let cumulativeWords = 0;

    for (const words of chapterWords) {
        if (words.length === 0) continue;

        let bounds: number[];
        try {
            bounds = computePageBoundaries(words, width, height, fontSizePx, lineHeight, font);
        } catch {
            const wpp = estimateWpp(width, height, fontSizePx, lineHeight);
            const pages = Math.max(1, Math.ceil(words.length / wpp));
            bounds = [0];
            for (let p = 1; p < pages; p++) bounds.push(p * wpp);
        }

        // Convert per-chapter word indices to global word indices
        for (let p = 1; p < bounds.length; p++) {
            globalPages.push(cumulativeWords + bounds[p]);
        }
        cumulativeWords += words.length;
        // Push chapter boundary so last page of this chapter
        // never merges with first page of next chapter
        globalPages.push(cumulativeWords);
    }

    return globalPages;
}

function estimateWpp(
    width: number,
    height: number,
    fontSizePx: number,
    lineHeight: number,
): number {
    const avgCharWidth = fontSizePx * 0.5;
    const charsPerLine = width / avgCharWidth;
    const wordsPerLine = charsPerLine / 5.5;
    const linesPerPage = Math.max(1, Math.floor(height / (fontSizePx * lineHeight)));
    return Math.max(1, Math.floor(wordsPerLine * linesPerPage * 0.85));
}