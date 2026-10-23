# AGENTS.md — rsvp-reader project guide

EPUB reader (Tauri 2 + SvelteKit 5 SPA) with two reading modes: **page mode** (renders EPUB HTML with the browser's native column pagination) and **RSVP mode** (rapid serial visual presentation, word-at-a-time).

## Quick commands (run from repo root)

| Task | Command |
|---|---|
| Dev (vite + tauri, hot reload) | `npm run tauri dev` |
| Standalone debug binary | `./launch.sh --debug` (auto-builds if missing) |
| Release build + launch | `./launch.sh --build` |
| Frontend build (outputs `build/`) | `npm run build` |
| Frontend typecheck | `npm run check` |
| Tests (vitest) | `npm run test` |
| Rust check | `cargo check --manifest-path src-tauri/Cargo.toml` |

**⚠️ Critical build gotcha:** standalone binaries MUST be compiled with `--features custom-protocol`. Without it, Tauri treats the build as dev mode and embeds **zero** frontend assets, expecting the Vite server → blank white window. See `src-tauri/Cargo.toml` `[features]`. `launch.sh` handles this; bare `cargo build` does not.

## Architecture map

```
src-tauri/                 Rust backend (commands exposed via IPC `invoke`)
├── src/epub.rs            EPUB: open_epub, get_chapter_html, get_chapter_resource (base64), resolve_chapter_link
├── src/state.rs           Persistence: save/load state, window size, debug.log
├── src/lib.rs             Tauri builder, command registration, window creation
└── Cargo.toml             tauri 2 + rbook 0.7 + base64; [features] custom-protocol

src/                        SvelteKit SPA (adapter-static, no SSR)
├── routes/+page.svelte     Root: switches Library / Reader / RSVPReader based on stores; auto-save state
├── app.html                Shell; global error trap buffers to window.__rsvpErrors
└── lib/
    ├── stores.ts           All shared state (writable stores + derived)
    ├── commands.ts         IPC bindings (openEpub, getChapterHtml/Resource, resolveChapterLink)
    ├── types.ts            BookMetadata
    ├── components/
    │   ├── Library.svelte     Welcome + Open dialog + auto-resume last book
    │   ├── Reader.svelte      PAGE MODE: columnized HTML, nav, footnote links, RSVP entry
    │   ├── RSVPReader.svelte  RSVP MODE: tokenizes current column's text via RsvpEngine
    │   └── Controls.svelte    RSVP speed/complexity/timer controls
    └── utils/
        ├── columns.ts         ★ CSS multi-column pagination (epub.js/Foliate technique)
        ├── rsvp.ts            Tokenizer, ORP, delay calc, RsvpEngine (unit-tested)
        ├── rsvp.test.ts       36 tests
        ├── persistence.ts     save/load reading state via IPC
        └── debug.ts           dbg() → console + debug.log (via log_debug IPC)
```

## Data flow

1. `Library.autoOpen()` / `handleOpen()` → `openEpub()` → sets `book` store.
2. `Reader` mounts → module-scope `lastLoadedBookPath` guard → `rebuildBook()` fetches each chapter with `getChapterHtml` (→ `chapterHtmls`).
3. Page mode renders current chapter's sanitized HTML in `.epub-flow`; `paginateFlow()` applies CSS columns (`column-width: pageW`) and measures real page count via a content `Range` (NOT `scrollWidth` — that returns the element's own huge width).
4. Navigation = scroll the `.epub-viewport` by `colIndex * pageW`.
5. RSVP entry: `enterRsvp()` pushes the current chapter's per-column word snippets (`extractColumnTexts`) into `rsvpColumnTexts`; RSVP tokenizes those. Cross-chapter during RSVP uses `columnizeOffscreen()`.

## Key stores (`stores.ts`)

- `book` — BookState (title, spineCount, chapterWordCounts, filePath)
- `currentPage` — global column-based page index (NOT word-based)
- `chapterPageCounts` / derived `readerTotalPages` — per-chapter column counts (page mode)
- `rsvpColumnTexts`, `rsvpColumnChapter`, `readerMetrics` — RSVP column sourcing
- `rsvpActive`, `rsvpWordOffset`, `rsvpConfig`, `fontSize`

## Architecture decisions (read before editing)

- **Columns engine (`columns.ts`)**: content flows into horizontal columns = pages (`column-fill:auto`, fixed height). `measurePageCount` MUST use `Range.selectNodeContents(el).getBoundingClientRect()` width, not `scrollWidth`. Word counts attribute text-node words **proportionally by fragment width overlap** per column (sums exactly to the chapter's true word count).
- **Margins**: `.epub-viewport` is `position:absolute; inset:0; margin:1.5rem 2rem`. NEVER put padding inside the scrollport — it widens the visible window past one page and causes slivers of adjacent pages.
- **Mode-switch persistence**: `Reader` unmounts when entering RSVP. The book-rebuild guard lives in `<script context="module">` (`lastLoadedBookPath`) so remounting does NOT reset to page 1. Keep it module-scoped.
- **Images**: `break-inside:avoid`, `max-width:100%`, `max-height:calc(var(--page-h) - 1rem)`, `object-fit:contain` — scaled to fit, never cropped/split (Foliate behavior).
- **HTML sanitization** in `processHtmlDoc()`: strips `<script>/<iframe>/<style>`, `on*` handlers; inlines images as base64 via `getChapterResource`; external links get `openUrl` handling in `Reader.clickWord`.
- **State `page` semantics**: was word-based, now column-based. Restored values from old sessions may be large; `colIndexInChapter` clamps to `counts-1` so it degrades gracefully.

## Debugging aids

- `dbg()` calls land in `debug.log` at `~/Library/Application Support/com.eugene.rsvp-reader/debug.log` and stdout.
- `Reader.afterMeasure` logs `measure: chN pages=P total=T` (page counts).
- `app.html` traps uncaught errors into `window.__rsvpErrors`; `+page.svelte` flushes them via `dbg("page-error: ...")`.
- To diagnose a blank/white window: verify the binary has embedded assets (`strings <bin> | grep -c "start\."` should be > 0) — i.e. it was built with `custom-protocol`.