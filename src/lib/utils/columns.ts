import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getImageSizes } from "$lib/commands";
import type { ReaderMetrics } from "$lib/stores";
import "$lib/epubFlow.css";

// Part of every saved page-count cache key; bump it when a change to layout
// or measuring could change page counts, so stale caches are ignored.
const LAYOUT_VERSION = 4;

// Shown instead of a chapter that fails to process; raw EPUB HTML is never
// rendered unsanitized.
const FAILED_CHAPTER_HTML = "<p>This chapter could not be displayed.</p>";

// 1x1 transparent GIF: stands in for a book image of known size when only the
// layout matters (offscreen page counting), so nothing is downloaded.
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// DOMPurify's allowlist already drops scripts, iframes, objects, embeds and
// on* handlers. EPUB stylesheets would fight the column layout, and forms or
// <base>/<meta> could navigate the webview, so drop those too.
const SANITIZE_CONFIG = {
    FORBID_TAGS: ["style", "link", "meta", "base", "form", "input", "button", "textarea", "select"],
    // SVG <image> isn't on DOMPurify's allowlist; EPUB covers commonly use it.
    // Remote sources on it are still removed by the hook below.
    ADD_TAGS: ["image"],
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

/** Cache key for page counts measured at these metrics. */
export function layoutKey(metrics: ReaderMetrics): string {
    return `${LAYOUT_VERSION}|${metrics.pageW}x${metrics.pageH}|${metrics.fontSizeRem}`;
}

// Image sizes by the src used in the chapter HTML (the open book only).
const imageSizes = new Map<string, [number, number] | null>();

/** Forget image sizes from the previous book. */
export function clearImageSizeCache(): void {
    imageSizes.clear();
}

async function lookupImageSizes(srcs: string[]): Promise<void> {
    const missing = srcs.filter((s) => !imageSizes.has(s));
    if (!missing.length) return;
    try {
        const sizes = await getImageSizes(missing);
        missing.forEach((s, i) => imageSizes.set(s, sizes[i] ?? null));
    } catch {
        missing.forEach((s) => imageSizes.set(s, null));
    }
}

function setColumnStyle(el: HTMLElement, prop: string, value: string) {
    el.style.setProperty(prop, value);
    const webkit = prop.replace(/^column/, "-webkit-column");
    if (webkit !== prop) el.style.setProperty(webkit, value);
}

/**
 * Body markup of a chapter. EPUB chapters are XHTML, so they're parsed as
 * XML: parsed as HTML, an XHTML-only construct such as an empty `<title/>`
 * swallows the rest of the document into the title and leaves the body
 * empty. Chapters that aren't well-formed XML fall back to the HTML parser.
 */
function chapterBody(raw: string): string {
    const xml = new DOMParser().parseFromString(raw, "application/xhtml+xml");
    if (!xml.querySelector("parsererror") && xml.body) return xml.body.innerHTML;
    return new DOMParser().parseFromString(raw, "text/html").body.innerHTML;
}

/**
 * Parse and sanitize chapter HTML with DOMPurify (remote resources blocked),
 * then point the book's images at the book:// scheme. Images whose size is
 * known get an explicit width and aspect ratio, so the page layout is final
 * before they load. With `forMeasure`, those images use a blank placeholder
 * instead, so measuring downloads nothing. Returns the body innerHTML, or a
 * placeholder message if processing fails.
 */
export async function processHtmlDoc(
    raw: string,
    opts: { forMeasure?: boolean } = {},
): Promise<{ html: string; error: boolean }> {
    try {
        const frag = DOMPurify.sanitize(chapterBody(raw), { ...SANITIZE_CONFIG, RETURN_DOM_FRAGMENT: true });

        // Remote sources were removed by the sanitizer; data: URIs stay as they are.
        const isBookImage = (src: string | null): src is string => !!src && !src.startsWith("data:");
        const imgs = [...frag.querySelectorAll("img")];
        await lookupImageSizes([...new Set(imgs.map((i) => i.getAttribute("src")).filter(isBookImage))]);
        for (const img of imgs) {
            const src = img.getAttribute("src");
            if (!isBookImage(src)) continue;
            const size = imageSizes.get(src);
            if (size) {
                img.style.width = `${size[0]}px`;
                img.style.setProperty("aspect-ratio", `${size[0]} / ${size[1]}`);
            }
            img.setAttribute("src", opts.forMeasure && size ? BLANK_IMAGE : convertFileSrc(src, "book"));
        }
        // SVG <image> (typical for covers): its size comes from the SVG, so
        // measuring never needs the picture itself.
        for (const image of frag.querySelectorAll("image")) {
            const href = image.getAttribute("href") ?? image.getAttribute("xlink:href");
            if (!isBookImage(href)) continue;
            image.removeAttribute("xlink:href");
            image.setAttribute("href", opts.forMeasure ? BLANK_IMAGE : convertFileSrc(href, "book"));
        }

        for (const link of frag.querySelectorAll("a")) {
            const href = link.getAttribute("href");
            if (href?.startsWith("http://") || href?.startsWith("https://")) {
                link.setAttribute("rel", "noopener noreferrer");
            }
        }

        const holder = document.createElement("div");
        holder.appendChild(frag);
        return { html: holder.innerHTML, error: false };
    } catch {
        return { html: FAILED_CHAPTER_HTML, error: true };
    }
}

const IMAGE_WRAPPER_CSS =
    "display:inline-block;width:100%;break-inside:avoid!important;page-break-inside:avoid!important;overflow:hidden;vertical-align:top;";

/**
 * Wrap every `<img>` in a flow inside a `div` with `break-inside:avoid` and
 * `display:inline-block` — the only reliable way to prevent image
 * fragmentation in Safari / WKWebView multicol. Must run before measuring,
 * on the visible page and on offscreen flows alike, since it changes layout.
 * Returns the number of images wrapped.
 */
export function wrapImages(flow: HTMLElement): number {
    let wrapped = 0;
    for (const img of flow.querySelectorAll("img")) {
        if (img.parentElement?.style.cssText.includes("inline-block")) continue;
        const container = img.closest("div, figure, p") ?? img.parentElement ?? flow;
        const nextBlock = container?.nextElementSibling;
        const isCaption =
            nextBlock &&
            nextBlock.tagName.toLowerCase() === "p" &&
            ((nextBlock.textContent?.length ?? 0) < 120 ||
                /^(Рис\.|Fig\.|Figure|Таблица|Table)/.test(nextBlock.textContent?.trim() ?? ""));

        const w = document.createElement("div");
        w.style.cssText = IMAGE_WRAPPER_CSS;
        if (isCaption) {
            container.parentNode?.insertBefore(w, container);
            w.appendChild(container);
            w.appendChild(nextBlock);
        } else {
            let target: Element = img;
            const p = img.parentElement;
            if (p && ["div", "figure", "p", "td", "li"].includes(p.tagName.toLowerCase())) {
                target = p;
            } else if (p) {
                target = p.closest("div, figure, p, body") ?? img;
            }
            target.parentNode?.insertBefore(w, target);
            w.appendChild(target);
        }
        wrapped++;
    }
    return wrapped;
}

/** Images whose size wasn't known up front; layout changes when they load. */
export function unsizedImages(flow: HTMLElement): HTMLImageElement[] {
    return [...flow.querySelectorAll("img")].filter((i) => !i.style.width && !i.complete);
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
 * Split a columnized element's text into per-column word arrays. Each word goes
 * to the column its first character is laid out in, so every column starts
 * with the first word visible on that page. A text node that fits in one
 * column is assigned whole; only nodes that cross a page break (usually one
 * paragraph per page) are measured word by word. This single function is the
 * source of truth for both page-mode word counts and RSVP token text, so the
 * two modes always agree.
 */
export function extractColumnWords(el: HTMLElement, pageW: number, pageCount: number): string[][] {
    const cols: string[][] = Array.from({ length: pageCount }, () => []);
    if (pageW <= 0 || pageCount <= 0) return cols;
    const origin = flowLeftOf(el);
    // The 1px tolerance keeps a word that starts exactly on a column edge
    // from being rounded into the previous column.
    const columnAt = (x: number) => Math.max(0, Math.min(pageCount - 1, Math.floor((x - origin + 1) / pageW)));

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const raw = node.textContent ?? "";
        const words = [...raw.matchAll(/\S+/g)];
        if (!words.length) continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (!rects.length) continue;

        const firstCol = columnAt(rects[0].left);
        if (firstCol === columnAt(rects[rects.length - 1].left)) {
            for (const w of words) cols[firstCol].push(w[0]);
            continue;
        }

        // The node crosses a page break: place each word by its first character.
        let col = firstCol;
        for (const w of words) {
            range.setStart(node, w.index!);
            range.setEnd(node, w.index! + 1);
            const rect = range.getClientRects()[0];
            if (rect) col = columnAt(rect.left);
            cols[col].push(w[0]);
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

/**
 * Lay out a chapter in an offscreen flow that matches the visible page
 * (same class, styles, font size and image wrapping), call `measure` on it,
 * then remove it. Images of unknown size are given up to 3 s to load first.
 */
async function withOffscreenFlow<T>(
    rawHtml: string,
    metrics: ReaderMetrics,
    measure: (flow: HTMLElement) => T,
): Promise<T> {
    const { html } = await processHtmlDoc(rawHtml, { forMeasure: true });

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
    const flow = document.createElement("div");
    flow.className = "epub-flow";
    flow.style.fontSize = `${metrics.fontSizeRem}rem`;
    flow.style.lineHeight = "1.5";
    flow.style.setProperty("--page-h", `${metrics.pageH}px`);
    flow.innerHTML = html;
    host.appendChild(flow);
    document.body.appendChild(host);

    try {
        wrapImages(flow);
        const pending = unsizedImages(flow);
        if (pending.length) {
            await Promise.race([
                Promise.all(pending.map((i) => i.decode().catch(() => {}))),
                new Promise((r) => setTimeout(r, 3000)),
            ]);
        }
        return measure(flow);
    } finally {
        document.body.removeChild(host);
    }
}

/**
 * Columnize a chapter offscreen (same layout as the reader) and return the
 * per-column text snippets plus page count. Used by RSVP to advance into
 * chapters that were never rendered in page mode.
 */
export async function columnizeOffscreen(
    rawHtml: string,
    metrics: ReaderMetrics,
): Promise<{ texts: string[]; pageCount: number }> {
    const { pageW, pageH } = metrics;
    if (pageW <= 0 || pageH <= 0) return { texts: [], pageCount: 1 };
    return withOffscreenFlow(rawHtml, metrics, (flow) => {
        const pageCount = paginateFlow(flow, pageW, pageH);
        return { texts: extractColumnTexts(flow, pageW, pageCount), pageCount };
    });
}

/**
 * Columnize a chapter offscreen and return ONLY its page count. Cheaper than
 * `columnizeOffscreen` (no per-column text extraction) and used to measure
 * every chapter in the background so the book-wide page total is accurate.
 */
export async function measureOffscreenPages(rawHtml: string, metrics: ReaderMetrics): Promise<number> {
    const { pageW, pageH } = metrics;
    if (pageW <= 0 || pageH <= 0) return 1;
    return withOffscreenFlow(rawHtml, metrics, (flow) => paginateFlow(flow, pageW, pageH));
}
