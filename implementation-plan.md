# Implementation Plan

Each step leaves the project in a verifiable, testable state.

---

## Step 1 — Scaffold Tauri 2.0 + Svelte project

**What:** Create the base Tauri project with Svelte frontend scaffolding.

**Commands:**
```bash
npm create tauri-app@latest -- --template svelte-ts rsvp-reader
cd rsvp-reader
npm install
```

**Verify:**
- `npm run tauri dev` launches a native window with the Svelte template
- Window shows the default "Welcome to Tauri" text
- No errors in terminal or browser console

---

## Step 2 — Rust EPUB parsing backend

**What:** Add `rbook` crate. Implement Tauri commands: `open_epub`, `get_chapter_html`, `get_chapter_text`.

**Files to create/modify:**
- `src-tauri/Cargo.toml` — add `rbook`, `zip` dependencies
- `src-tauri/src/epub.rs` — EPUB loader module
- `src-tauri/src/lib.rs` — register commands
- `src/lib/commands.ts` — TypeScript bindings for Rust commands

**Verify:**
- Start with a test EPUB (e.g. a public domain book)
- `npm run tauri dev` opens
- `invoke('open_epub', { path: '/path/to/book.epub' })` in browser console returns metadata object with title, author, chapter list
- `invoke('get_chapter_html', { index: 0 })` returns HTML string
- `invoke('get_chapter_text', { index: 0 })` returns plain text string

---

## Step 3 — Library view (file open + chapter list)

**What:** Svelte UI to open an EPUB file and display its chapters.

**Files to create/modify:**
- `src/App.svelte` — root layout, state management
- `src/lib/types.ts` — TypeScript types for book metadata, chapters
- `src/lib/stores.ts` — Svelte writable stores for book state
- `src/lib/components/Library.svelte` — file open dialog trigger + chapter list
- `src-tauri/capabilities/default.json` — allow `dialog:allow-open`

**Verify:**
- App launches, shows "Open EPUB" button
- Clicking triggers native file open dialog
- Selecting an EPUB loads metadata + chapter list in UI
- Clicking a chapter does nothing yet (next step)

---

## Step 4 — Page reader (HTML chapter rendering)

**What:** Read chapter HTML in a scrollable viewport with prev/next chapter navigation.

**Files to create/modify:**
- `src/lib/components/Reader.svelte` — iframe-based chapter HTML renderer
- `App.svelte` — mode switching (library ↔ reader)

**Verify:**
- From chapter list, clicking a chapter opens reader view
- Chapter HTML renders with original formatting, images, styling
- "Previous" / "Next" chapter navigation works
- "Back to library" returns to chapter list

---

## Step 5 — RSVP engine (tokenizer + timing)

**What:** Pure TypeScript RSVP engine with tokenizer, ORP positioning, and timing calculations. No UI yet.

**Files to create/modify:**
- `src/lib/utils/rsvp.ts` — `tokenize()`, `getORP()`, `calculateDelay()`, `RsvpEngine` class

**RSVP logic:**
- **Tokenizer**: split text into tokens (word, punctuation, whitespace)
- **ORP**: `Math.floor(word.length / 3)` — character index to highlight
- **Timing**: `baseDelay = 60000 / wpm`; variable delay = `baseDelay * (word.length / 5)`
- **Punctuation pause**: extra 150ms after `.`, `!`, `?`, `;`, `:`, `,`

**Verify:**
- Import rsvp module in browser console via dev tools
- `tokenize("Hello, world!")` returns correct token array
- `getORP("hello")` returns 1 (index of 'e')
- `calculateDelay("hello", 300, true)` returns correct ms value
- `RsvpEngine` emits tokens at correct intervals via callback

---

## Step 6 — RSVP reader UI

**What:** Full RSVP reading mode with word display, speed control, variable delay toggle, play/pause.

**Files to create/modify:**
- `src/lib/components/RSVPReader.svelte` — word display with ORP highlight, play/pause
- `src/lib/components/Controls.svelte` — speed slider (100–1000), variable delay toggle, progress bar
- `App.svelte` — add RSVP mode alongside library + page reader

**Verify:**
- From chapter list, "Read in RSVP mode" button starts RSVP
- Words display one at a time at configured speed
- ORP character is highlighted (colored)
- Speed slider changes pace in real-time
- Variable delay toggle changes timing behavior
- Play/pause works
- Punctuation pauses are noticeable when variable delay is on
- "Back to library" returns to chapter list

---

## Step 7 — Navigation & polish

**What:** Smooth navigation between modes, error states, keyboard shortcuts, styling.

**Files to modify:**
- All components — error boundaries, loading states
- `App.svelte` — routing between library/reader/rsvp
- `app.css` — theming, typography for reading

**Details:**
- Keyboard: Space = play/pause in RSVP, ← → = prev/next chapter in reader
- Error state when EPUB fails to load
- Loading spinner during chapter content fetch
- Remember last-read position per chapter (basic, in-memory)

**Verify:**
- Full flow: open EPUB → browse chapters → read page-by-page → switch to RSVP mode → control speed → navigate back
- Keyboard shortcuts work
- Error messages shown on invalid files
- No console errors or warnings
- App window title shows book title