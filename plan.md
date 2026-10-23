# RSVP Reader — Plan

## Tech Stack

| Layer | Choice |
|-------|--------|
| App shell | Tauri 2.0 |
| Backend | Rust (`rbook` for EPUB parsing) |
| Frontend | Svelte + TypeScript |
| Packaging | Tauri builder (macOS .dmg / .app) |

## Architecture

### Rust Backend (`src-tauri/`)
- `open_epub(path)` — parse EPUB, return metadata + chapter listing
- `get_chapter_html(index)` — return raw chapter HTML (styling/images preserved)
- `get_chapter_text(index)` — return plain text for RSVP mode
- EPUB resources served to WebView via `convertFileSrc` or asset embedding

### Svelte Frontend (`src/`)
| Component | Purpose |
|-----------|---------|
| `Library.svelte` | File open dialog, chapter list |
| `Reader.svelte` | Page-by-page mode — renders chapter HTML in iframe |
| `RSVPReader.svelte` | RSVP mode — word-at-a-time with ORP highlighting |
| `Controls.svelte` | Speed slider, variable delay toggle, play/pause, progress |

### RSVP Engine (`src/lib/utils/rsvp.ts`)
- **Tokenizer**: split text into word + punctuation tokens
- **ORP**: Optimal Recognition Point at ~⅓ character of each word, highlighted in color
- **Timing**: base = 60000 / WPM ms per word, scaled by `word.length / 5`, extra +150ms pause after punctuation
- **Controls**: speed (100–1000 WPM), variable delay on/off, play/pause/seek
- Entirely client-side — no IPC overhead per word

### Data Flow
```
[EPUB file] → Rust (rbook parses, extracts chapters) → IPC → Svelte store
                                                              ↓
                                        Reader.svelte ← chapter HTML (iframe)
                                        RSVPReader.svelte ← chapter text (tokenizer + timer)
```

### RSVP Controls
| Control | Range / Values |
|---------|---------------|
| Speed | 100 – 1000 WPM (slider) |
| Variable delay | Toggle ON/OFF |
| Punctuation pause | Enabled with variable delay (implicit) |
| Play/Pause | Toggle |
| Chapter select | Dropdown / list |