# AGENTS.md — rsvp-reader project guide

EPUB, FB2, MOBI/AZW3 and TXT reader (Tauri 2 + SvelteKit 5 SPA) with two reading modes: **page mode** (renders the book's chapters as HTML with the browser's native column pagination) and **RSVP mode** (rapid serial visual presentation, word-at-a-time).

## Quick commands (run from repo root)

| Task | Command |
|---|---|
| Dev (vite + tauri, hot reload) | `npm run tauri dev` |
| Standalone debug binary | `./launch.sh --debug` (auto-builds if missing) |
| Release build + launch | `./launch.sh --build` |
| Frontend build (outputs `build/`) | `npm run build` |
| All checks (what CI runs) | `npm run ci` (`scripts/ci.sh`) |
| Frontend typecheck | `npm run check` |
| Lint / format | `npm run lint` / `npm run format` |
| Tests (vitest) | `npm test` |
| Rust tests / lints | `cargo test` / `cargo clippy` with `--manifest-path src-tauri/Cargo.toml` |

**⚠️ Critical build gotcha:** standalone binaries MUST be compiled with `--features custom-protocol`. Without it, Tauri treats the build as dev mode and embeds **zero** frontend assets, expecting the Vite server → blank white window. See `src-tauri/Cargo.toml` `[features]`. `launch.sh` handles this; bare `cargo build` does not. Compiling the crate also needs `build/` to exist (`npm run build` first).

## Architecture map

```
src-tauri/                 Rust backend (commands exposed via IPC `invoke`)
├── src/book.rs            Format-neutral BookSource trait; open_book (detects the format by content,
│                          + content id), get_chapter_html, get_image_sizes, resolve_chapter_link,
│                          read_resource for the book:// scheme
├── src/epub.rs            EPUB via rbook (paths in chapters rewritten to absolute)
├── src/fb2.rs             FB2 / .fb2.zip: decoded (windows-1251 etc.) and converted to XHTML chapters
│                          (innermost sections; cover first, notes bodies last; links point at chapters)
├── src/mobi.rs            MOBI/AZW3 (DRM-free): Palm database, PalmDOC and HUFF/CDIC decompression; MOBI7 split
│                          at page breaks with filepos links, KF8 files rebuilt from skeleton/fragment indexes
├── src/txt.rs             TXT: encoding detected (UTF-8 / windows-1251 / KOI8-R / 866), paragraphs from the
│                          file's layout, chapters at headings or ~30k-char chunks (opened by .txt extension)
├── src/state.rs           Persistence: per-book state (book_<id>.json, atomic writes), window size, debug.log
├── src/lib.rs             Tauri builder, book:// URI scheme, Finder opens, command registration, window
└── tauri.conf.json        CSP (img-src allows book:), .epub/.fb2/.mobi/.azw3/.txt file associations (.txt as Alternate)

src/                        SvelteKit SPA (adapter-static, no SSR)
├── routes/+page.svelte     Root: switches Library / Reader / RSVPReader; debounced auto-save of state
├── app.html                Shell; global error trap buffers to window.__rsvpErrors
└── lib/
    ├── stores.ts           Shared state + page helpers (chapterStartPage, locatePage, updatePageCounts)
    ├── commands.ts         IPC bindings
    ├── epubFlow.css        Global styles for laid-out book content (visible page AND offscreen measuring)
    ├── components/
    │   ├── Library.svelte        Welcome + Open dialog + reopen last book
    │   ├── Reader.svelte         PAGE MODE view: renders the chapter, input, links, RSVP entry
    │   ├── RSVPReader.svelte     RSVP MODE view
    │   ├── Controls.svelte       RSVP speed/complexity controls
    │   └── CountdownTimer.svelte Countdown minute/second inputs
    ├── reader/
    │   ├── bookLoader.ts         Per-book reset, chapter HTML fetch (current first, then batches)
    │   └── pagination.svelte.ts  Pagination: measure, relayout, background measuring, cache, positioning
    ├── rsvp/
    │   ├── playback.svelte.ts    RsvpPlayback: page text, RsvpEngine, page advance, play/pause
    │   └── countdown.svelte.ts   Countdown
    ├── wordComplexity/           Per-language word scoring (en, ru), word lists loaded lazily
    └── utils/
        ├── columns.ts      ★ Chapter processing (XHTML parse, DOMPurify, images) + CSS-column pagination
        ├── rsvp.ts         Tokenizer, ORP, delay calc, RsvpEngine
        ├── openBook.ts     Open a book and restore its state (shared by Library and Reader)
        ├── persistence.ts  Save/load state via IPC; parseSavedState validates every field
        └── debug.ts        dbg() (dev builds or debug flag) and logError() (always)
```

## Data flow

1. `openBook(path)` → `open_epub` (metadata + content id) → `loadState` → restores font, RSVP settings, word anchor and page-count cache → sets `book`.
2. `Reader` sees a new book (`bookLoader.needsLoad`) → `loadBook()`: page counts from the cache (if measured at this layout) or 1 per chapter, current page = start of the saved chapter, chapter HTML fetched current-first then in parallel batches.
3. The current chapter's HTML goes through `processHtmlDoc()` and is rendered in `.epub-flow`; images are wrapped, then `paginateFlow()` measures its columns (pages) and `extractColumnWords()` assigns words to pages. The saved word anchor then picks the exact page.
4. `Pagination.premeasureAll()` measures the other chapters offscreen (nearest first, yielding between chapters) unless the cache matches; the result is saved as the page-count cache.
5. Navigation = scroll the `.epub-viewport` by `column * pageW`.
6. RSVP entry: the current chapter's per-column texts go to `rsvpColumnTexts`; `RsvpPlayback` tokenizes the current column and runs `RsvpEngine`. Other chapters are columnized offscreen (`columnizeOffscreen()`).
7. `+page.svelte` saves state (debounced): `anchor` = page start word + `rsvpWordOffset`, settings, `pageCounts`.

## Key stores (`stores.ts`)

- `book` — BookState (id, title, author, spineCount, filePath)
- `currentPage` — global column-based page index; change page counts only via `updatePageCounts()`, which keeps the same chapter and column
- `chapterPageCounts` / derived `readerTotalPages`; `chapterHtmls` (+ `chapterHtmlsLoaded`)
- `pageStart`, `pendingWordAnchor`, `legacyPage`, `pageCountCache` — position and cache restore
- `rsvpColumnTexts`, `rsvpColumnChapter`, `readerMetrics` — RSVP column sourcing
- `rsvpActive`, `rsvpWordOffset`, `rsvpConfig`, `fontSize` (`rsvpConfig` and `fontSize` are global, synced to settings.json by `utils/settings.ts`)

## Architecture decisions (read before editing)

- **Columns engine (`columns.ts`)**: content flows into horizontal columns = pages (`column-fill:auto`, fixed height). `measurePageCount` MUST use `Range.selectNodeContents(el).getBoundingClientRect()` width, not `scrollWidth`. A text node that crosses a page break is assigned to pages word by word (by each word's own position); RSVP starts from the page's word list, so it must match what's on screen.
- **Offscreen = on-screen layout**: page counts are measured offscreen for chapters not on screen, so anything that affects layout must apply to both: styles live in the global `epubFlow.css`, images get explicit sizes before measuring, `wrapImages()` runs before measuring on both paths. Bump `LAYOUT_VERSION` in `columns.ts` whenever a change could alter page counts, or stale caches are reused.
- **Margins**: `.epub-viewport` is `position:absolute; inset:0; margin:1.5rem 2rem`. NEVER put padding inside the scrollport — it widens the visible window past one page and causes slivers of adjacent pages.
- **Mode-switch persistence**: `Reader` unmounts when entering RSVP. The "already loaded" guard lives in module scope in `bookLoader.ts` (holding the book object), so remounting doesn't reset the position or re-fetch the book.
- **Chapter parsing**: chapters are XHTML and parsed as `application/xhtml+xml` (an empty `<title/>` swallows the body under the HTML parser), falling back to HTML when not well-formed.
- **HTML sanitization**: DOMPurify allowlist (plus SVG `<image>`), remote resources removed, never falls back to raw HTML. External links open via `openUrl` in `Reader.clickWord`.
- **Formats**: every format becomes chapters of XHTML in the backend (`BookSource`); the frontend never sees the format. FB2 and TXT output is wrapped in `.fb2` / `.txt`, which scopes their styles in `epubFlow.css`. MOBI7 chapters are HTML (not well-formed XML) and go through the HTML-parser fallback. Test books: `scripts/test.epub`, and `scripts/test.azw3` / `scripts/test.mobi` (from `scripts/create_test_mobi.py`).
- **Images**: served over `book://` (paths made absolute by `get_chapter_html`); sizes come from `get_image_sizes` so the layout is final before they load; offscreen measuring uses a blank placeholder. Styled `max-width:100%`, `max-height:calc(var(--page-h) - 3rem)`, `object-fit:contain`.
- **Saved position**: chapter + word (`anchor`), not a page number; older states with only `page` are applied once all page counts are known.

## Debugging aids

- `dbg()` writes to the console and `debug.log` at `~/Library/Application Support/com.eugene.rsvp-reader/debug.log` (rotated to `debug.log.1` at 1 MiB). On in dev builds; in a release build set `localStorage.setItem("rsvp-reader:debug", "1")` in the webview console and restart. `logError()` always writes.
- `Pagination.afterMeasure` logs `measure: chN pages=P total=T`; background measuring logs `premeasure: done|cached total=T`.
- `app.html` traps uncaught errors into `window.__rsvpErrors`; `+page.svelte` flushes them via `logError("page-error: ...")`.
- To diagnose a blank/white window: verify the binary has embedded assets (`strings <bin> | grep -c "start\."` should be > 0) — i.e. it was built with `custom-protocol`.
