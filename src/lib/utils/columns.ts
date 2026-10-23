import DOMPurify from "dompurify";
import { getChapterResource } from "$lib/commands";
import type { ReaderMetrics } from "$lib/stores";

const FONT_STACK = 'Georgia, "Times New Roman", serif';

// Shown instead of a chapter that fails to process; raw EPUB HTML is never
// rendered unsanitized.
const FAILED_CHAPTER_HTML = "<p>This chapter could not be displayed.</p>";

// DOMPurify's allowlist already drops scripts, iframes, objects, embeds and
// on* handlers. EPUB stylesheets would fight the column layout, and forms or
// <base>/<meta> could navigate the webview, so drop those too.
const SANITIZE_CONFIG = {
    FORBID_TAGS: ["style", "link", "meta", "base", "form", "input", "button", "textarea", "select"],
};

// http(s)://, protocol-relative // and any other scheme://. Relative paths and
// data: URIs don't match.
const REMOTE_URL = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const RESOURCE_ATTRS = new Set(["src", "srcset", "poster", "background", "href", "xlink:href"]);

// Block anything that would make the webview fetch from the network. Links
// (<a href>) stay, since clicks on them are routed to the system browser.
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    const value = data.attrValue ?? "";
    if (data.attrName === "style") {
        if (/url\s*\(/i.test(value)) data.keepAttr = false;
        return;
    }
    if (!RESOURCE_ATTRS.has(data.attrName)) return;
    if (node.nodeName.toLowerCase() === "a" && data.attrName === "href") return;
    if (data.attrName === "srcset" ? value.split(",").some((c) => REMOTE_URL.test(c)) : REMOTE_URL.test(value)) {
        data.keepAttr = false;
    }
});

function setColumnStyle(el: HTMLElement, prop: string, value: string) {
    el.style.setProperty(prop, value);
    const webkit = prop.replace(/^column/, "-webkit-column");
    if (webkit !== prop) el.style.setProperty(webkit, value);
}

/**
 * Parse and sanitize chapter HTML: inline base64 images from the EPUB, then
 * run it through DOMPurify with remote resources blocked. Returns the body
 * innerHTML for rendering, or a placeholder message if processing fails.
 */
export async function processHtmlDoc(raw: string): Promise<{ html: string; error: boolean }> {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(raw, "text/html");

        const imgs = [...doc.querySelectorAll("img")];
        const uniqueSrcs = [
            ...new Set(
                imgs
                    .map((i) => i.getAttribute("src"))
                    .filter(
                        (s): s is string =>
                            !!s &&
                            !s.startsWith("data:") &&
                            !s.startsWith("http://") &&
                            !s.startsWith("https://")
                    )
            ),
        ];

        const results = await Promise.allSettled(
            uniqueSrcs.map(async (src) => {
                const b64 = await getChapterResource(src);
                return { src, b64 };
            })
        );
        const resolved = new Map<string, string>();
        for (const r of results) {
            if (r.status === "fulfilled") resolved.set(r.value.src, r.value.b64);
        }

for (const img of imgs) {
            const src = img.getAttribute("src");
            if (src && resolved.has(src)) {
                img.setAttribute("src", `data:image/*;base64,${resolved.get(src)!}`);
            } else if (src && !src.startsWith("data:") && !src.startsWith("http")) {
                img.removeAttribute("src");
            }
        }

        for (const link of doc.querySelectorAll("a")) {
            const href = link.getAttribute("href");
            if (href?.startsWith("http://") || href?.startsWith("https://")) {
                link.setAttribute("rel", "noopener noreferrer");
            }
        }

        const html = DOMPurify.sanitize(doc.body.innerHTML, SANITIZE_CONFIG);
        return { html, error: false };
    } catch {
        return { html: FAILED_CHAPTER_HTML, error: true };
    }
}

/**
 * Apply the horizontal multi-column "pages" layout (epub.js / Foliate
 * technique). Temporarily gives the element a very wide width so all columns
 * flow in a single horizontal run and can be measured.
 */
export function applyColumnLayout(el: HTMLElement, pageW: number, pageH: number) {
    const wide = Math.max(pageW * 128, 1_000_000);
    el.style.height = `${pageH}px`;
    el.style.width = `${wide}px`;
    el.style.boxSizing = "border-box";
    el.style.overflow = "hidden";
    el.style.margin = "0";
    setColumnStyle(el, "column-width", `${pageW}px`);
    setColumnStyle(el, "column-gap", "0");
    setColumnStyle(el, "column-fill", "auto");
    el.style.setProperty("-webkit-line-box-contain", "block glyphs replaced");
}

/**
 * Measure the number of columns (= pages) the rendered content occupies.
 * Uses the bounding box of the element's content (Foliate's technique) rather
 * than `scrollWidth`, which would return the element's own (deliberately huge)
 * width and over-count pages.
 */
export function measurePageCount(el: HTMLElement, pageW: number): number {
    if (pageW <= 0) return 1;
    try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rect = range.getBoundingClientRect();
        if (!rect || rect.width <= 0) return 1; // empty content → single page
        const rootRect = el.getBoundingClientRect();
        const start = Math.max(0, rect.left - rootRect.left);
        const size = start + rect.width;
        return Math.max(1, Math.ceil(size / pageW - 1e-6));
    } catch {
        const sw = el.scrollWidth;
        if (sw <= pageW) return 1;
        return Math.max(1, Math.ceil(sw / pageW - 1e-6));
    }
}

/** Set the flow width to exactly fit the measured page count (one row of columns). */
export function finalizeFlowWidth(el: HTMLElement, pageCount: number, pageW: number) {
    el.style.width = `${pageCount * pageW}px`;
}

/** Lay out, measure and resize a flow element; returns the page count. */
export function paginateFlow(el: HTMLElement, pageW: number, pageH: number): number {
    applyColumnLayout(el, pageW, pageH);
    let count = measurePageCount(el, pageW);
    for (let i = 0; i < 3; i++) {
        finalizeFlowWidth(el, count, pageW);
        const re = measurePageCount(el, pageW);
        if (re <= count) break;
        count = re;
    }
    return count;
}

function flowLeftOf(el: HTMLElement): number {
    return el.getBoundingClientRect().left;
}

/**
 * Split a columnized element's text into per-column word arrays. Words of a
 * text node are distributed across the columns it spans proportionally to the
 * node's width overlap with each column, so every column gets exactly the
 * words that a page-mode count would attribute to it. This single function is
 * the source of truth for both page-mode word counts and RSVP token text, so
 * the two modes always agree.
 */
export function extractColumnWords(
    el: HTMLElement,
    pageW: number,
    pageCount: number
): string[][] {
    const cols: string[][] = Array.from({ length: pageCount }, () => []);
    if (pageW <= 0 || pageCount <= 0) return cols;
    const origin = flowLeftOf(el);

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const raw = node.textContent ?? "";
        const words = raw.trim().split(/\s+/).filter((w) => w.length > 0);
        if (!words.length) continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (!rects.length) continue;

        const totals = Array(pageCount).fill(0);
        let totalW = 0;
        for (const r of rects) {
            totalW += r.width;
            for (let c = 0; c < pageCount; c++) {
                const lo = Math.max(r.left, origin + c * pageW);
                const hi = Math.min(r.right, origin + (c + 1) * pageW);
                if (hi > lo) totals[c] += hi - lo;
            }
        }
        if (totalW <= 0) continue;

        // Distribute words across the touched columns proportionally, keeping
        // the per-column counts summing exactly to the node's word count.
        let acc = 0;
        let from = 0;
        let lastTouched = -1;
        for (let c = 0; c < pageCount; c++) {
            if (totals[c] <= 0) continue;
            lastTouched = c;
            acc += words.length * (totals[c] / totalW);
            const to = Math.min(words.length, Math.round(acc));
            if (to > from) cols[c].push(...words.slice(from, to));
            from = to;
        }
        // Guard against cumulative rounding dropping trailing words.
        if (from < words.length && lastTouched >= 0) {
            cols[lastTouched].push(...words.slice(from));
        }
    }
    return cols;
}

/**
 * Split a columnized element's text into per-column snippets. See
 * `extractColumnWords` — this joins each column's words for tokenization.
 */
export function extractColumnTexts(el: HTMLElement, pageW: number, pageCount: number): string[] {
    return extractColumnWords(el, pageW, pageCount).map((a) => a.join(" "));
}

/** Count words assigned to the given column (matches the RSVP text exactly). */
export function countColumnWords(
    el: HTMLElement,
    pageW: number,
    colIndex: number,
    pageCount: number
): number {
    if (pageW <= 0 || pageCount <= 0) return 0;
    const cols = extractColumnWords(el, pageW, pageCount);
    return cols[colIndex]?.length ?? 0;
}

/**
 * Columnize a chapter offscreen (same metrics/font as the reader) and return
 * the per-column text snippets plus page count. Used by RSVP to advance into
 * chapters that were never rendered in page mode.
 */
export async function columnizeOffscreen(
    rawHtml: string,
    metrics: ReaderMetrics,
    fontSizeRem: number
): Promise<{ texts: string[]; pageCount: number }> {
    const { pageW, pageH } = metrics;
    if (pageW <= 0 || pageH <= 0) return { texts: [], pageCount: 1 };
    const { html } = await processHtmlDoc(rawHtml);

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
    const flow = document.createElement("div");
    flow.style.fontFamily = FONT_STACK;
    flow.style.fontSize = `${fontSizeRem}rem`;
    flow.style.lineHeight = "1.5";
    flow.style.color = "#e0e0e0";
    flow.innerHTML = html;
    host.appendChild(flow);
    document.body.appendChild(host);

    try {
        const pageCount = paginateFlow(flow, pageW, pageH);
        const texts = extractColumnTexts(flow, pageW, pageCount);
        return { texts, pageCount };
    } finally {
        document.body.removeChild(host);
    }
}

/**
 * Columnize a chapter offscreen and return ONLY its page count. Cheaper than
 * `columnizeOffscreen` (no per-column text extraction) and used to eagerly
 * measure every chapter so the book-wide page total is accurate up front.
 */
export async function measureOffscreenPages(
    rawHtml: string,
    metrics: ReaderMetrics,
    fontSizeRem: number
): Promise<number> {
    const { pageW, pageH } = metrics;
    if (pageW <= 0 || pageH <= 0) return 1;
    const { html } = await processHtmlDoc(rawHtml);

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
    const flow = document.createElement("div");
    flow.style.fontFamily = FONT_STACK;
    flow.style.fontSize = `${fontSizeRem}rem`;
    flow.style.lineHeight = "1.5";
    flow.style.color = "#e0e0e0";
    flow.innerHTML = html;
    host.appendChild(flow);
    document.body.appendChild(host);

    try {
        return paginateFlow(flow, pageW, pageH);
    } finally {
        document.body.removeChild(host);
    }
}