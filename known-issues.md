# Known Issues

## 1. Umlauts/accents break word tokenizer [FIXED]

The tokenizer regex at `src/lib/utils/rsvp.ts:74` used `\w` which matches only `[a-zA-Z0-9_]`. Changed to `\p{L}\p{N}` with `u` flag for full Unicode letter/number matching.

**Fix** (applied): Lines 74 and 82 now use `[\p{L}\p{N}]` with the `u` flag, covering all Unicode letters (Latin, Cyrillic, CJK, etc.). All 16 accented/umlaut tests now pass.

## 2. RSVP keeps running when switching to page mode; focus word state lost on return [FIXED]

The `a`/`A` key handler at `RSVPReader.svelte:201` was saving the offset and setting `rsvpActive = false` inline without calling `stopRsvp()`, leaving the `RsvpEngine` timer running in the background. The runaway engine continued advancing `rsvpWordOffset` while in page mode, so switching back showed a different word.

**Fix** (applied): The key handler now calls `stopRsvp()` which stops the engine and saves the current index before deactivating RSVP mode.

## 3. Timer expired → pressing Play doesn't restart the timer [FIXED]

`resumeTimer()` at `RSVPReader.svelte:130` bailed out early with `if (timerRemaining <= 0) return;`. After the timer countdown reached 0, `timerRemaining` stayed at 0, so pressing Play in the `else` branch called `resumeTimer()` which immediately returned.

**Fix** (applied): `togglePlay()` now checks `timerRemaining <= 0` before calling `resumeTimer()` and calls `startTimer()` instead when the timer has expired.

## 4. Changing timer duration then pressing Play doesn't start the timer [FIXED]

Two root causes:
- Timer inputs used `onchange` which fires on blur — typing a value and clicking Play before the input loses focus left the store un-updated.
- When `started` was `true` from a previous session (no timer), the `else` branch routed to `resumeTimer()` which blocked on `timerRemaining <= 0`.

**Fix** (applied): Timer inputs changed from `onchange` to `oninput` (immediate store updates). The `else` branch now calls `startTimer()` directly when `timerRemaining <= 0`.

## 5. Punctuation characters treated as separate tokens [FIXED]

The tokenizer's punctuation-glue logic (`rsvp.ts:142-168` Case B) only attached a punctuation token to a **preceding word** when `spaceBefore` was false. Several cases produced standalone `isPunctuation` tokens.

**Fix** (applied): Fallthrough case at line 183 now appends punctuation to the preceding word's `punctSuffix` instead of creating a separate token. A post-processing pass also glues leading punctuation to the following word's `quotePrefix`. `calculateDelay` uses `punctSuffix !== ""` for the boolean check instead of `.length > 0`.

Fixed cases:
- Ellipsis `...` → glued as `"..."` suffix on preceding word
- Spaced punctuation (`hello , world`) → comma glued to `hello`
- Consecutive punctuation (`?!`) → all chars appended to same suffix
- Leading punctuation (`!hello`) → `!` becomes `quotePrefix`
- Punctuation after closing suffix (`"Hello"?`) → `?` glued via post-processing