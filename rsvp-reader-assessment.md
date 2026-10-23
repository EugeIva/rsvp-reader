# rsvp-reader: code and architecture assessment

Project: `/Users/eugene/deepseek-test/rsvp-reader`. I only read files: nothing was changed, built, installed or run, so the tests were not executed. Line references are relative to the project root.

## 1. What it is

It's a desktop EPUB reader with two modes. **Page mode** shows the book's HTML split into pages using CSS columns. **RSVP mode** shows one word at a time with an ORP (optimal recognition point) highlight. Word timing changes with word length, punctuation and a "word complexity" score for English or Russian.

- **Stack:** Tauri 2 (Rust, with `rbook` 0.7 for EPUB parsing) plus a SvelteKit 2 / Svelte 5 single-page app (adapter-static, no SSR), TypeScript 6, Vite 8 and Vitest 5. The npm packages `syllable` and `dale-chall` feed the English complexity score.
- **Size:** about 2.9k lines of first-party TypeScript/Svelte and about 470 lines of Rust. Most of the frontend logic sits in two components: `Reader.svelte` (587 lines) and `RSVPReader.svelte` (473 lines).
- **Not a git repository.** There's no version history, and `README.md` is still the unedited Tauri template.

## 2. Architecture

**The layering is reasonable at the top level:**
- `src-tauri/src/epub.rs` handles EPUB access.
- `src-tauri/src/state.rs` handles persistence.
- `src/lib/commands.ts` is a thin typed IPC layer.
- `src/lib/stores.ts` holds the global stores.
- `src/lib/utils/` holds pure-ish logic (`rsvp.ts` for tokenizer and engine, `columns.ts` for pagination).
- `src/lib/wordComplexity/` is a pluggable per-language scorer registry.

`AGENTS.md` is a good architecture map, and much better than the README.

**In practice the boundaries are weak:**

- **God components.** `Reader.svelte` does several unrelated jobs:
  - book loading (`rebuildBook`, line 106)
  - HTML processing
  - pagination and relayout scheduling
  - background premeasuring
  - DOM surgery on images (`wrapImagesInDom`, line 317)
  - link routing
  - keyboard handling
  - a full second copy of open-file and restore-state (lines 425–481)

  `RSVPReader.svelte` also mixes page location, column text sourcing, engine lifecycle, a countdown timer and timer input parsing.
- **Three parallel word models.** Nothing reconciles them:
  1. Rust `chapter_word_counts`, computed by stripping tags in `epub.rs:42-52`. The frontend only uses its *length* (`Reader.svelte:130`).
  2. Rust `get_chapter_text` → `allWords` / `globalPageBoundaries` / `totalPages`, built by measuring every word in the DOM (`pagination.ts`). These stores are **written and never read**: the "legacy word model" in `AGENTS.md`.
  3. DOM column extraction (`columns.ts:150`). This is the real source of truth for page mode and RSVP.

  Model 2 is pure overhead: an extra IPC call per chapter, plus per-word `getBoundingClientRect` across the whole book on every load.
- **Position is stored as a layout-dependent number.** `currentPage` is a global column index (`stores.ts:21`), so its meaning changes with window size and font size. The saved state stores that raw index (`+page.svelte:66`), not a content anchor such as chapter + word offset or a CFI. `relayout()` scales the page counts of chapters that aren't on screen by a ratio heuristic (`Reader.svelte:193-196`), so page numbers are approximate until premeasuring finishes.
- **Loading the whole book up front.** Opening a book costs:
  1. A **synchronous** Rust command that reads and strips every chapter (`epub.rs:43`). Synchronous Tauri commands run on the main thread, so the UI freezes on large books.
  2. Two IPC calls per chapter, run one after another (`Reader.svelte:114-121`). `get_chapter_text` re-reads the HTML just to strip it.
  3. `premeasureAll` (`Reader.svelte:242`), which runs `processHtmlDoc` on every chapter. That fetches **every image in the book as base64 over IPC** (`columns.ts:36`), with no cache, and fetches them again whenever a chapter is displayed.
- **The complexity data loads at startup on the UI thread.** `initWordComplexity()` (`+page.svelte:16`) fetches and parses `ru_full.txt`: **29 MB and 1.42M lines**. It also computes bigram statistics over every one of those words, whatever language the book is in. The file is also copied into `build/`, so it ships inside the binary.
- **The RSVP engine is decently isolated.** `RsvpEngine` (`rsvp.ts:247`) is a small timer-driven class with an `onToken` callback. That's the right shape. Its integration with the page/column model in `RSVPReader.svelte` is where most of the RSVP bugs are.

## 3. Code quality

- **Readability and naming.** The naming is mostly fine, and the comments explain the intent of the tricky DOM code well (`columns.ts`). The tokenizer (`rsvp.ts:72-211`) is a hand-written state machine with overlapping sets: `'` is in both `PUNCTUATION` and `OPENING_QUOTES`, and the *closing* quote U+2019 is listed as an opening quote (line 50). It's hard to reason about. One indentation slip: `columns.ts:47`.
- **Duplication. This is the biggest code smell:**
  - The open-book and `restoreState` code is copied verbatim in `Library.svelte:85-115` / `44-83` and `Reader.svelte:425-481`.
  - Both copies of `restoreState` immediately write the state they just loaded back to disk, which does nothing useful.
  - The `SavedState` fields are listed by hand in four places: `persistence.ts:3`, `persistence.ts:44`, `+page.svelte:66`, and both `restoreState` copies.
  - `startTimer` and `resumeTimer` are nearly identical (`RSVPReader.svelte:162-200`). So are `timerMinDisplay` and `timerSecDisplay`, and `setTimerMin` and `setTimerSec`.
  - `columnizeOffscreen` and `measureOffscreenPages` share their setup line for line (`columns.ts:229-288`).
  - The anchor-to-page calculation is written twice (`Reader.svelte:283-299` and `387-400`).
  - `en/bigrams.ts` and `ru/bigrams.ts` are byte-identical. Both scorers duplicate entropy, clusters and the weighted sum.
- **Dead code:**
  - Stores never read or never meaningfully set: `allWords`, `globalPageBoundaries`, `totalPages`, `isLoading` (only ever set to `false`) and `error` (written, never read).
  - Unused functions: `computeTotalPages` (imported but unused, `stores.ts:2`), `countColumnWords`, `timerDisplay`, `wordHtml` (`RSVPReader.svelte:278`, which would also be an XSS sink if ever used), `detectAndScore`, `isComplexityReady`, `getAllScorers`, `isReady`, `getWindowSize`.
  - Unused Rust commands: `get_last_book_path` and `get_window_size`. The last-opened book is tracked in both `localStorage` and `last_book.txt`, and only the former is read.
  - Unused interface members and variables: `LanguageScorer.init`, `FrequencyMap`, `normalizeFrequency`'s purpose, and `wasPlaying` in `RsvpEngine.seek` (`rsvp.ts:301`).
  - Empty stray file: `src-tauri/main.rs`.
- **Error handling.** Errors are mostly swallowed: empty `catch {}` blocks, and `.catch(() => {})` on link resolution (`Reader.svelte:410`) and window saves.
  - `read_state_json` turns corrupt JSON into `Ok(None)` without saying anything (`state.rs:61`).
  - `loadState` casts untrusted JSON with `as number` / `as boolean` and never validates it (`persistence.ts:44-58`).
  - The legacy snake_case fallbacks there look like leftovers from an earlier format.
- **Typing.** `strict` is on, and the IPC types are hand-written to match the Rust structs, with no code generation. The rest is loose: there are `(window as any)` casts, `RsvpConfig` mixes engine settings with UI timer settings, and the module script in `Reader.svelte:1` uses the deprecated `context="module"` with a TypeScript annotation but no `lang="ts"`.
- **Logging noise.**
  - About 21 `console.log`/`dbg` calls in the frontend, including one per resize event.
  - `println!` in every Rust state command.
  - `log_debug` appends to `debug.log` forever, with no rotation (`state.rs:142`).

## 4. Tests and tooling

- **Vitest:** `src/lib/utils/rsvp.test.ts` has 36 tests on `tokenize`, `getORP` and `calculateDelay`. About 20 of the 36 are near-duplicate diacritics checks. Gaps:
  - `RsvpEngine` (scheduling, pause/resume, seek, updateConfig) has **no** tests, even though that's where the bugs are.
  - No Cyrillic or Russian tokenization tests, although Russian is a first-class language here.
  - Nothing tests `columns.ts`, the complexity scorers or persistence.
  - One test is mislabeled: "returns 0 for punctuation tokens" expects 200 (`rsvp.test.ts:149-151`).
  - `jsdom` is installed but no test uses it, because `vitest.config.ts` sets no environment.
- **Rust:** 6 tests in `state.rs`, covering the hash and JSON round-trip. Nothing tests `epub.rs`'s `strip_html_tags` or `resolve_chapter_link`, which are the most bug-prone Rust code.
- **`scripts/test-*.ts`:** ad-hoc scripts that use `console.assert`, which never makes the process fail. They need `tsx`, which isn't installed. `test-persistence.ts` tests a *copy* of `loadState`'s logic rather than the real function, so it can't catch a regression.
- **Missing tooling:** no ESLint, Prettier, rustfmt/clippy config, CI or git. `npm run check` (svelte-check) exists.
- **Config:**
  - `tauri.conf.json` has `"csp": null`.
  - `Cargo.toml` still has template metadata (`authors = ["you"]`).
  - `app.html`'s `<title>` is still the template's.
  - `launch.sh` is clean and well documented.
  - The dependency set is small and appropriate.

## 5. Notable bugs, risks and smells

The confirmed bugs are traced through the code; none were reproduced at runtime.

1. **The last word of every page is effectively skipped in continuous RSVP.** `onToken` calls `advanceToNextPage()` the moment the last token is *emitted* (`RSVPReader.svelte:103-105`). That fires the `$currentPage` effect. Once the next page's column text is already cached, the effect rebuilds and starts a new engine on the next microtask, so the last word flashes for about 0 ms and its delay is never honored. When the next chapter still has to be laid out offscreen, the last word stays up only until that finishes.
2. **Changing any setting while playing skips ahead.** `updateConfig` does `pause()` then `start()` (`rsvp.ts:306-311`). `start()` immediately emits `tokens[idx]`, which is the *next* token, cutting the current word's delay short. Every `input` event while dragging a slider in `Controls.svelte` does this, so dragging the WPM slider fast-forwards through the text.
3. **The Russian frequency score is out of range.** `ru/loader.ts:19` sets `FREQ_TOTAL = 200000`, but the file has 1,423,050 entries, so `rank / FREQ_TOTAL` reaches about 7.1 (`ru/scorer.ts:17`).
   - Rare-but-listed words get up to 7× the frequency factor, which works out to roughly +2.1 on the score: about 2× the delay at the default weight of 0.5.
   - Words *missing* from the list get 1, so they're treated as easier than rare listed words.
   - The English side happens to be consistent (50k lines, `FREQ_TOTAL = 50000`).
4. **Unsanitized HTML on the error path.** If `processHtmlDoc` throws, it returns the *raw* chapter HTML (`columns.ts:73-74`), which then goes into `{@html}` (`Reader.svelte:509`). With `csp: null` and the Tauri IPC reachable from the page, a crafted EPUB could run script. The normal path also relies on a denylist sanitizer (`columns.ts:63-68`):
   - Remote `http(s)` images and `style` attributes are kept, so opening a book can make network requests (tracking beacons).
   - `<form>`, `<meta>` and `<link>` aren't removed.
5. **`strip_html_tags` can swallow text.** A bare `&`, as in "R & D", enters entity mode and drops every character until the next `;` (`epub.rs:147-157`). It also doesn't decode hex entities (`&#x2014;`), and it counts text inside `<head>`/`<title>`/`<style>`. That makes `chapter_word_counts` and `get_chapter_text` wrong, although (per section 2) the frontend barely uses either.
6. **A wrong chapter can match a link.** `resolve_chapter_link` matches with `ends_with` in both directions (`epub.rs:117`), so `1.xhtml` matches `ch11.xhtml`. It also doesn't percent-decode or resolve `../` paths. Image `src` values likewise go to `read_resource_bytes` without being resolved against the chapter's path (`columns.ts:38`). Whether `rbook` normalizes these isn't verified.
7. **Page counts are stale after images are wrapped.** `columnizeCurrent()` measures first, then `wrapImagesInDom()` changes the layout (`Reader.svelte:159-160`). The page count and per-column word lists stay out of date until the next relayout. Wrapping also mutates DOM that Svelte owns, through `{@html}`.
8. **The saved page can be lost on reopen (likely).** `restoreState` sets `currentPage` to the saved value. Meanwhile `Reader`'s effect sets it back to 0 and `rebuildBook` resets `chapterPageCounts` to all 1s (`Reader.svelte:101,130`). `afterMeasure` then clamps `currentPage` to `total-1` (line 227) before premeasuring has found the real counts. This depends on async ordering, so it's inferred from the code, not observed.
9. **Saving during playback is starved and noisy.** Every token sets `rsvpWordOffset` (`RSVPReader.svelte:102`), which restarts the 300 ms save debounce (`+page.svelte:61`). At 300 WPM (200 ms per word) it only saves when a single word's delay exceeds 300 ms, mostly at punctuation. When it does save, it writes pretty-printed JSON plus `last_book.txt`. `save_window_size` writes a file on *every* resize event, with no debounce (`+page.svelte:46`).
10. **Fragile per-book state key.** The key is a 64-bit polynomial hash of the file path (`state.rs:43`), so moving or renaming a book loses its progress. Writes aren't atomic (`fs::write`), so a crash mid-write corrupts the file, which is then dropped without notice (item in section 3).
11. **Global keyboard handlers don't check focus.**
    - Typing `a` in the RSVP timer inputs exits RSVP, and Space toggles play while typing (`RSVPReader.svelte:257-267`).
    - The whole book body is `role="button"`, and a click on any text enters RSVP.
12. **Complexity init isn't guarded.** `initWordComplexity` has no in-flight promise, so concurrent calls load twice. `rsvp.ts:13-23` lazily `import()`s the same module, which `+page.svelte` already imports eagerly. Until the 29 MB list has parsed, `calculateDelay` uses a complexity score of 0, so timing changes partway through the first session. The scorer is also rebuilt on every word (`wordComplexity/index.ts:28,38`).
13. **Minor:**
    - Images are tagged with the invalid MIME type `data:image/*` (`columns.ts:50`).
    - Non-word, non-punctuation tokens get a 0 ms delay (`rsvp.ts:224`).
    - The leading-punctuation pass uses `splice` in a loop, which is O(n²) (`rsvp.ts:202-208`).
    - The countdown timer uses `setInterval`, which drifts.
    - `columnizeOffscreen` takes `fontSizeRem` both in `metrics` and as a separate argument.

## 6. Prioritized improvements

1. ✅ **Done in `719edfc`.** **Fix the RSVP engine semantics, and test them** (items 1, 2):
   - Advance to the next page only *after* the last token's delay has elapsed. For example, have the engine fire an `onEnd` after the final delay.
   - Make `updateConfig` keep the current word, either by only changing future delays or by rescheduling the remaining time.
   - Add Vitest tests for `RsvpEngine` using fake timers.
2. ✅ **Done in `5705099`.** **Harden the HTML path** (item 4):
   - Never fall back to raw HTML.
   - Switch to an allowlist sanitizer such as DOMPurify.
   - Set a real CSP in `tauri.conf.json`.
   - Block remote resources.
3. ✅ **Done, together with the English `daleChall.has` bug found later.** **Fix the complexity data** (items 3, 12):
   - Derive `FREQ_TOTAL` from the loaded map and clamp to [0, 1].
   - Treat unknown words as the hardest.
   - Trim `ru_full.txt` to a sensible top-N, or precompute it into a compact format.
   - Load only the book's language, off the startup path (or in a worker), with an init promise.
   - Build each scorer once.
4. ✅ **Done.** **Delete the legacy word model and other dead code** (section 2, word model 2; section 3, dead code). This removes `pagination.ts`, `allWords`, `globalPageBoundaries`, `totalPages`, `get_chapter_text`, the unused Rust commands and the unused functions, and halves the IPC done on book load.
5. ✅ **Done.** **Keep accurate page numbers without blocking.** The owner blocks on loading every chapter on purpose, to get an accurate page total. The current blocking doesn't actually buy that accuracy:
   - The Rust word count in `open_epub` (`epub.rs:42-52`) never reaches the page total. The frontend only uses the length of `chapter_word_counts` (`Reader.svelte:130`).
   - The accurate total comes from `premeasureAll` (`Reader.svelte:242`), which lays out every chapter offscreen. It already runs in the background, and the UI already shows `Page X of …` until it finishes (`Reader.svelte:521-523`).

   Same accuracy, without the freeze:
   - [ ] **Remove the blocking work that doesn't affect page numbers.** Drop the word-count loop from `open_epub`, or at least make it `async` / `spawn_blocking` so it runs off the main thread. Drop the `get_chapter_text` calls in `rebuildBook` (they only feed the unused word model).
   - [ ] **Show the current chapter first.** Fetch and render the chapter being read, then fetch the rest of the HTML in the background for `premeasureAll`. Fetch it in parallel batches, not one IPC call at a time.
   - [ ] **Don't fetch images just to measure.** During premeasure, swap each `<img>` for a placeholder box of the same size instead of pulling base64 data over IPC. A small Rust command can return image dimensions from the EPUB (just the header). Pagination stays exact, because `max-width` / `max-height` / `object-fit` size images only from their dimensions.
   - [ ] **Cache page counts.** Store the per-chapter page counts in the book's state file, keyed by `(pageW, pageH, fontSize)`. Reopening at the same window and font size then shows an accurate total immediately; premeasure only reruns when the layout changes.
   - [ ] **Keep the UI responsive while premeasuring.** Yield between chapters (`await new Promise(r => setTimeout(r))` or `requestIdleCallback`), measure the chapters closest to the reader first, and cancel a stale run when a resize or font change starts a new one.
   - [ ] **Make the reading position independent of the total.** Save position as chapter + word/column offset (item 6). The current page number then comes from the chapter's own page count, so it's exact as soon as that chapter has been laid out, and the global total can fill in later without moving the reader.
   - [ ] **Serve resources through a custom URI scheme.** Use a Tauri custom protocol (e.g. `epub://res/<path>`) instead of base64-over-IPC. Displayed images then load lazily and the browser caches them.
6. ✅ **Done** (anchor and openBook in item 5). **Persist a content anchor** (chapter index + word or column offset), not a layout-dependent global page.
   - Extract one `openBook(path)` service used by both `Library` and `Reader`.
   - Validate `SavedState` in one place.
   - Debounce the window-size save.
   - Write files atomically.
   - Key state by a hash of the book's identifier or content rather than its path.
7. ✅ **Done.** **Split the god components.** For example: a `bookLoader` module, a `pagination` controller (measure, relayout, premeasure), a `useRsvpPlayback` that owns the engine and page advance, and a `CountdownTimer`.
8. ✅ **Done** (text helpers were deleted in item 5; links and image paths fixed). **Fix the Rust text helpers** (items 5, 6):
   - End entity mode on a non-entity character and decode hex entities.
   - Skip `<head>`, `<style>` and `<script>` text.
   - Resolve links and image paths against the chapter path, with exact matches.
   - Add unit tests.
9. ✅ **Done.** **Tooling hygiene:**
   - `git init`.
   - ESLint + Prettier, plus `cargo clippy`/`fmt`.
   - A CI script running `check`, `test` and `cargo test`.
   - Delete or convert the `scripts/test-*.ts` files into Vitest.
   - Replace the template README and metadata.
   - Gate debug logging behind a flag and cap the size of `debug.log`.
10. ✅ **Done in item 7** (the module script moved into bookLoader.ts). **Fix the parse error Vite reports for `Reader.svelte` on every dev start.**
    - `npm run tauri dev` logs `[PARSE_ERROR] Expected a semicolon … Reader.svelte?id=0:4:27` during Vite's dependency scan.
    - Cause: the module-level script (`Reader.svelte:1-5`) is `<script context="module">` without `lang="ts"`, but it contains a TypeScript annotation (`let lastLoadedBookPath: string | null = null;`). The scanner parses that block as plain JavaScript.
    - The app still runs, because the Svelte compiler treats the whole component as TypeScript. `npm run check` also warns that `context="module"` is deprecated.
    - Fix: change the tag to `<script module lang="ts">`.

## 7. Overall verdict

This is a **working prototype with a sensible core idea and uneven execution**.

**The good parts:**
- The column-based pagination (`columns.ts`) is thoughtful, and the comments explain the hard parts.
- The tokenizer is reasonably tested.
- `AGENTS.md` shows real architectural awareness.

**The weak parts:**
- It has the typical signs of iterative, AI-driven patching: copy-pasted flows, a legacy model kept "for back-compat" that nothing reads, empty `catch` blocks, and fixes logged in `known-issues.md` rather than locked in by tests.
- The parts users notice most are where the defects cluster: RSVP timing at page boundaries and on settings changes, a scaling bug in the Russian complexity data, startup cost from a 29 MB word list, and a permissive HTML/CSP setup.

**Rough grade:** about **C+**. It's fine as a personal tool, not ready to ship as-is. The fixes in section 6, items 1–4, are small and would raise quality the most.

## 8. Feature to-do list (requested by the owner)

- [x] **Make RSVP settings global, not per book.**
  - Today `rsvpConfig` is saved inside each book's state file (`+page.svelte:72-79`) and overwritten on every book open by `restoreState` (`Library.svelte:56`, `Reader.svelte:454`).
  - Move it to one `settings.json` in the app data dir, with its own `save_settings` / `load_settings` commands in `state.rs`. Load it once at startup and debounce saves when it changes.
  - Per-book state keeps only position and font size, if font size should stay per book.
  - Migration: if `settings.json` doesn't exist yet, seed it from the last opened book's saved config.
- [x] **Remove the "Punctuation pause" ON/OFF button.**
  - Remove it from `Controls.svelte:59-61`, along with the slider's `disabled` binding (line 62). The slider already goes down to 0 ms, which means off.
  - Drop `punctuationPause` from `RsvpConfig` (`rsvp.ts:28`), `calculateDelay` (`rsvp.ts:221,231`), `SavedState` and the tests (`rsvp.test.ts:155,168`).
- [x] **Remove the "Word length delay" ON/OFF button.**
  - Remove it from `Controls.svelte:68-70` and the slider's `disabled` binding (line 71). The multiplier slider already goes down to 0, which means off.
  - Drop `longWordDelay` from `RsvpConfig` and `calculateDelay` (`rsvp.ts:227`), the persisted fields, and the tests (`rsvp.test.ts:155,161`).
- [x] **Add an enable/disable checkbox for the countdown.**
  - Add `timerEnabled: boolean` to the global settings and a checkbox next to the timer inputs (`RSVPReader.svelte:324-326`).
  - When it's unchecked, disable the minute and second inputs, skip `startTimer` / `resumeTimer`, and hide the remaining-time display. The minutes and seconds values stay saved, so turning it back on restores them.
  - Today the countdown can only be turned off by setting it to 00:00 (`RSVPReader.svelte:164`).
- [x] **Clicking a word in page mode sets the RSVP position without switching modes.**
  - Today any click on non-link text calls `enterRsvp()` (`Reader.svelte:414`). Remove that call and keep the RSVP button and the mode-switch key (physical `A`, see the next item) as the only ways in.
  - On click, find the clicked text node and character offset with `document.caretPositionFromPoint` (fall back to `caretRangeFromPoint` in WebKit).
  - Find the word's index within its column by walking the column's text nodes in the same order as `extractColumnWords` (`columns.ts:150`).
  - Convert that whitespace-word index to an RSVP **token** index. `tokenize()` merges and splits differently from whitespace splitting ("hello—world", standalone punctuation), so build a word→token map when tokenizing, or store the source word index on each token.
  - Set `currentPage` to the clicked column's page and `rsvpWordOffset` to the token index. `loadColumn` already starts from `rsvpWordOffset` (`RSVPReader.svelte:87`).
  - **Highlight the selected word** in page mode so it's clear where RSVP will start:
    - Use the CSS Custom Highlight API (`CSS.highlights.set("rsvp-word", new Highlight(range))` plus a `::highlight(rsvp-word)` style). It doesn't modify the DOM, so it can't change pagination or column word counts, which wrapping the word in a `<span>` could.
    - Keep the `Range` (text node + start/end offsets) in component state. Re-apply it after `columnizeCurrent` / `relayout` and when coming back from RSVP. Clear it when `rsvpWordOffset` resets to 0 or the chapter changes.
    - On return from RSVP, highlight the word RSVP stopped on, by mapping the token index back to its word (the reverse of the word→token map). The highlight then shows the current RSVP position both ways.
    - Fallback if `CSS.highlights` isn't available in the WebView: an absolutely positioned overlay `div` placed from `range.getBoundingClientRect()`.
  - Keep link clicks working as they do now (`Reader.svelte:378-413`).
  - Keep the current behavior where turning the page resets the RSVP position: `goPrev` / `goNext` set `rsvpWordOffset` to 0 (`Reader.svelte:355,359`). Turning the page therefore also clears the highlight.
- [x] **Keyboard behavior (required spec):**
  - **Page mode:**
    - `A` switches to RSVP mode.
    - Space goes to the next page, the same as the right arrow (`goNext()`). On the last page it does nothing.
  - **RSVP mode:**
    - `A` stops playback and switches to page mode.
    - Space starts and stops playback.
  - RSVP mode already matches this spec (`RSVPReader.svelte:257-267`). Page mode needs a Space handler (`Reader.svelte:417-423`):
    - Add `if (e.code === "Space") { e.preventDefault(); if (!e.repeat) goNext(); }`.
    - `preventDefault()` is required. Without it, Space also presses whichever toolbar button has focus after a mouse click (Prev, Next, Open, RSVP). With Prev focused, that would cancel out the page turn; with Open focused, it would open the file dialog.
    - Like RSVP's Space, ignore auto-repeat (`e.repeat`), so holding Space doesn't race through pages. Leave it out if holding Space should keep turning pages, as holding the arrow keys does now.
    - `goNext()` resets the RSVP position to the start of the page, the same as the arrow keys.
- [x] **Keep `A` as the mode-switch key, but match the physical key so it works with any keyboard layout.**
  - Today `e.key === "a" || "A"` (`Reader.svelte:422`, `RSVPReader.svelte:258`) never matches on Cyrillic and other non-Latin layouts, where the key produces `ф`.
  - Match on the physical key instead: `e.code === "KeyA"`. `e.code` names the key's position on a US QWERTY keyboard whatever the active layout, so it fires for `ф` on Russian too.
    - On AZERTY, `KeyA` is the key labelled `Q`. That's an accepted side effect of matching by position.
  - Ignore the key when a modifier is held (`e.metaKey || e.ctrlKey || e.altKey`), so `Cmd+A` (select all) doesn't switch modes.
  - Ignore the key when focus is in a text field (`e.target` is `input` / `textarea` / contenteditable). The same guard fixes Space toggling play while typing in the RSVP timer fields.
  - The button labels "RSVP (A)" (`Reader.svelte:490`) and "Page mode (A)" (`RSVPReader.svelte:294`) stay as they are.
  - Leave the font-size keys `9` / `0` (`Reader.svelte:420-421`) as they are.
- [x] **Open an EPUB by dragging it onto the window. Do nothing if the file isn't an EPUB.**
  - Tauri 2 handles file drops natively, and they're on by default for the window built in `lib.rs:18`. Listen with `getCurrentWebview().onDragDropEvent(...)` in `+page.svelte`.
  - On a `drop` event, take the first path that ends in `.epub` (case-insensitive). If none does, ignore the drop. Optionally, also ignore a file that `open_epub` fails to parse, without showing an error.
  - Route the path through the shared `openBook(path)` service (section 6, item 6), so it works the same from the Library screen and during reading, and stops a running RSVP engine first.
  - Optionally, show a drop-zone overlay on `enter` / `over` and remove it on `leave`.
  - Related: register `.epub` in `bundle.fileAssociations` in `tauri.conf.json`, so double-clicking an EPUB or using "Open With" in Finder also works. That arrives as an `Opened` run event on macOS.
- [ ] **Build a macOS app bundle.**
  - `bundle.targets` is `"all"` in `tauri.conf.json`. `npm run tauri build -- --bundles app` (or `dmg`) produces `src-tauri/target/release/bundle/macos/rsvp-reader.app`, and `custom-protocol` is enabled automatically.
  - Add a `./launch.sh --app` mode, or a `package` npm script, that builds it and optionally copies it to `/Applications`.
  - Set `productName` (e.g. "RSVP Reader"), `bundle.category` (`"public.app-category.education"` or `"productivity"`), `bundle.copyright` and `bundle.macOS.minimumSystemVersion`. Also fill in the `Cargo.toml` template metadata (`authors = ["you"]`).
  - For anyone else to run it: sign and notarize (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`). An unsigned build is fine for personal use, but Gatekeeper will ask for confirmation the first time.
- [ ] **Add an app icon.**
  - `src-tauri/icons/` has a full set (512×512 `icon.png`, `.icns`, `.ico`), most likely the Tauri template icons.
  - Design a 1024×1024 PNG source, then run `npm run tauri icon path/to/icon.png` to generate every size, including `icon.icns`. `bundle.icon` already points at these files.
  - Also replace `static/favicon.png` (the `<title>` in `app.html` was set to "RSVP Reader" in item 9).
- [ ] **Add a way back to the reading page after following a footnote.**
  - Today a footnote link moves the reader to the note (same chapter: `Reader.clickWord`, `href="#id"`; another chapter: `resolveChapterLink` + `pager.pendingAnchor`), and the only way back is the note's own backlink, if the book has one, or paging back by hand.
  - Before following an internal link, remember the reading position as a word anchor (`pageStart` + `rsvpWordOffset`, the same thing `+page.svelte` saves). Keep a stack, so a note that links to another note still leads back step by step.
  - While the stack isn't empty, show a "← Back to page N" button in the reader's toolbar or bottom bar. Clicking it pops the stack and restores the position the same way a saved position is restored: set `pendingWordAnchor`, move `currentPage` to the start of that chapter, and let `Pagination.afterMeasure` pick the exact page.
  - Add a keyboard shortcut for it as well, matching the physical key like the `A` key item (for example Backspace, ignored while typing in a field).
  - Clear the stack when another book is opened. Decide whether ordinary page turns should clear it too; keeping it until it's used is simpler and matches browser "back".
  - Web links (`http(s)://`) open in the system browser and don't touch the stack.
