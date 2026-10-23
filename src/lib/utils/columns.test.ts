// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("$lib/commands", () => ({
    getChapterResource: vi.fn(async (path: string) => {
        if (path === "images/pic.png") return "UElDREFUQQ==";
        throw new Error(`no resource ${path}`);
    }),
}));

import { processHtmlDoc } from "./columns";

function chapter(body: string): string {
    return `<html><head><title>T</title></head><body>${body}</body></html>`;
}

async function sanitized(body: string): Promise<HTMLElement> {
    const { html, error } = await processHtmlDoc(chapter(body));
    expect(error).toBe(false);
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
}

describe("processHtmlDoc", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps ordinary chapter content", async () => {
        const el = await sanitized('<h1 id="c1">Chapter</h1><p class="x"><em>Hello</em> world</p>');
        expect(el.querySelector("h1#c1")?.textContent).toBe("Chapter");
        expect(el.querySelector("p.x em")?.textContent).toBe("Hello");
    });

    it("removes scripts, including inside SVG", async () => {
        const el = await sanitized('<p>a</p><script>alert(1)</script><svg><script>alert(2)</script></svg>');
        expect(el.querySelector("script")).toBeNull();
        expect(el.innerHTML).not.toContain("alert");
    });

    it("removes event handler attributes", async () => {
        const el = await sanitized('<p onclick="x()">a</p><img src="data:image/png;base64,AA==" onerror="y()">');
        expect(el.innerHTML).not.toMatch(/onclick|onerror/);
    });

    it("removes javascript: links but keeps normal and footnote links", async () => {
        const el = await sanitized(
            '<a id="bad" href="javascript:alert(1)">x</a>' +
            '<a id="web" href="https://example.com/">w</a>' +
            '<a id="note" href="notes.xhtml#fn1">n</a>'
        );
        expect(el.querySelector("#bad")?.getAttribute("href")).toBeNull();
        expect(el.querySelector("#web")?.getAttribute("href")).toBe("https://example.com/");
        expect(el.querySelector("#web")?.getAttribute("rel")).toBe("noopener noreferrer");
        expect(el.querySelector("#note")?.getAttribute("href")).toBe("notes.xhtml#fn1");
    });

    it("removes embedded documents, forms, stylesheets and navigation tags", async () => {
        const el = await sanitized(
            '<iframe src="x.html"></iframe><object data="x"></object><embed src="x">' +
            '<form action="https://evil.example/"><input name="q"><button>go</button></form>' +
            '<style>p{color:red}</style><link rel="stylesheet" href="s.css">' +
            '<meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/">' +
            "<p>text</p>"
        );
        for (const tag of ["iframe", "object", "embed", "form", "input", "button", "style", "link", "meta", "base"]) {
            expect(el.querySelector(tag), tag).toBeNull();
        }
        expect(el.textContent).toContain("text");
    });

    it("inlines EPUB images as data URIs and drops unresolved local images", async () => {
        const el = await sanitized('<img id="ok" src="images/pic.png"><img id="missing" src="images/none.png">');
        expect(el.querySelector("#ok")?.getAttribute("src")).toBe("data:image/*;base64,UElDREFUQQ==");
        expect(el.querySelector("#missing")?.getAttribute("src")).toBeNull();
    });

    it("blocks remote resources", async () => {
        const el = await sanitized(
            '<img id="http" src="http://tracker.example/p.gif">' +
            '<img id="https" src="https://tracker.example/p.gif">' +
            '<img id="proto" src="//tracker.example/p.gif">' +
            '<img id="srcset" srcset="a.png 1x, https://tracker.example/p.gif 2x">' +
            '<video id="video" poster="https://tracker.example/p.jpg"></video>' +
            '<svg><image id="svgimg" href="https://tracker.example/p.svg"></image></svg>' +
            '<p id="bg" style="background:url(https://tracker.example/p.gif)">a</p>' +
            '<p id="plain" style="color: red">b</p>'
        );
        expect(el.querySelector("#http")?.getAttribute("src")).toBeNull();
        expect(el.querySelector("#https")?.getAttribute("src")).toBeNull();
        expect(el.querySelector("#proto")?.getAttribute("src")).toBeNull();
        expect(el.querySelector("#srcset")?.getAttribute("srcset")).toBeNull();
        expect(el.querySelector("#video")?.getAttribute("poster")).toBeNull();
        expect(el.querySelector("#svgimg")?.getAttribute("href") ?? null).toBeNull();
        expect(el.querySelector("#bg")?.getAttribute("style")).toBeNull();
        expect(el.querySelector("#plain")?.getAttribute("style")).toBe("color: red");
        expect(el.innerHTML).not.toContain("tracker.example");
    });

    it("never falls back to the raw HTML when processing fails", async () => {
        vi.stubGlobal(
            "DOMParser",
            class {
                parseFromString(): Document {
                    throw new Error("parse failed");
                }
            }
        );
        const raw = chapter('<script>alert(1)</script><p>secret</p>');
        const { html, error } = await processHtmlDoc(raw);
        expect(error).toBe(true);
        expect(html).not.toContain("<script");
        expect(html).not.toContain("secret");
    });
});
