# User Scenarios

## Scenario 1 — Open an EPUB

1. User launches the app
2. App shows a dark welcome screen with "Open EPUB" button
3. User clicks the button, native file dialog opens
4. User selects `dune.epub`
5. App immediately opens to page 1 of the book in reader mode
6. Reader shows one page of text at a time on black background

## Scenario 2 — Navigate pages

1. User is on page 1 of `dune.epub`
2. User clicks "Next" button (or presses ArrowRight)
3. Page 2 appears — text fits the container (no scroll, no overflow)
4. User continues pressing Next through the book
5. When reaching the end of a chapter, the next page seamlessly shows content from the next chapter
6. User clicks "Prev" (or presses ArrowLeft) to go back

## Scenario 3 — Keyboard navigation

1. User is reading page 42 of `dune.epub`
2. User presses ArrowRight → advances to next page
3. User presses ArrowLeft → returns to previous page
4. Arrow keys work without clicking any UI element

## Scenario 4 — Adjust font size

1. User is reading page 15
2. User presses `9` key — font size increases by 0.1rem
3. Page text reflows immediately; page content recalculates to fit the new font size
4. User presses `0` key — font size decreases by 0.1rem
5. The page count and word count update to reflect the new layout
6. Font size is displayed in bottom bar (e.g., "font 1.2rem")

## Scenario 5 — Window resize triggers recalculation

1. User is reading on a full-screen window, page 50 of 847
2. User makes the window narrower
3. Page content recalculates — fewer words fit per line
4. Total page count increases from 847 to ~920
5. Word count on the current page decreases
6. Text still fits the container with no scrollbar

## Scenario 6 — Read across chapter boundaries

1. User is on the last page of Chapter 3
2. User clicks "Next"
3. The next page shows the first portion of Chapter 4
4. No visual break or chapter label — content flows continuously

## Scenario 7 — Open a different book mid-reading

1. User is on page 73 of `dune.epub`
2. User clicks "Open" in the toolbar
3. File dialog opens
4. User selects `neuromancer.epub`
5. `dune.epub` state is replaced; `neuromancer.epub` opens at page 1

## Scenario 8 — Handle a corrupted EPUB

1. User opens the app, clicks "Open EPUB"
2. User selects `broken.epub`
3. Rust backend fails to parse the file
4. App shows an error message: "Could not open EPUB"
5. User selects a valid EPUB, loads successfully

## Scenario 9 — Reading experience

1. User opens a book
2. Reader has black background with light text
3. Text is displayed in a serif font (Georgia), comfortably spaced
4. Top toolbar shows book title and "Open" button
5. Bottom bar shows: word count (left), page X of Y + font size (center), Prev/Next buttons (right)
6. No scrollbar — each page is a discrete chunk that fits the viewport
7. Page count adjusts dynamically when window is resized or font is changed

## Scenario 10 — Very short chapter

1. A chapter has only 50 words
2. With a default page fitting ~300 words, the chapter fits on a single page
3. Page count still shows correct totals based on actual words per page

## Scenario 11 — Very long word handling

1. A page contains the word "incomprehensibilities" (21 chars)
2. The word wraps to the next line instead of overflowing
3. `overflow-wrap: break-word` ensures no horizontal scroll