# rsvp-reader

A desktop EPUB reader for macOS with two reading modes:

- **Page mode** — the book laid out in pages (CSS columns), with footnote and
  chapter links, images and an adjustable font size.
- **RSVP mode** — rapid serial visual presentation: one word at a time with
  the optimal recognition point highlighted. Each word's display time adapts
  to its length, punctuation and a complexity score (English and Russian),
  and an optional countdown limits a reading session.

Built with [Tauri 2](https://tauri.app) (Rust backend, `rbook` for EPUB
parsing) and SvelteKit / Svelte 5 (static SPA).

## Requirements

- Node.js and npm
- Rust (stable) with `clippy` and `rustfmt`
- Xcode command line tools (macOS)

```bash
npm install
```

## Running

| Task | Command |
|---|---|
| Development (hot reload) | `npm run tauri dev` |
| Build a release binary and launch it | `./launch.sh --build` |
| Launch an existing build | `./launch.sh` |

Standalone binaries must be built with the `custom-protocol` feature, or
they show a blank window; `launch.sh` takes care of this (see `AGENTS.md`).

## Keyboard

| Key | Page mode | RSVP mode |
|---|---|---|
| `A` | switch to RSVP | stop and return to page mode |
| `Space` | — | play / pause |
| `←` `→` | previous / next page | — |
| `9` `0` | larger / smaller font | — |

## Checks

| Task | Command |
|---|---|
| Everything below, as CI runs it | `npm run ci` |
| Type check | `npm run check` |
| Lint (Prettier + ESLint) | `npm run lint` |
| Format | `npm run format` |
| Frontend tests (Vitest) | `npm test` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |

## Where data lives

Reading position, page-count cache and RSVP settings are saved per book in
`~/Library/Application Support/com.eugene.rsvp-reader/` (`book_<id>.json`,
keyed by the book file's contents, so moving a book keeps its progress).

Verbose logging goes to `debug.log` in the same folder. It's on in dev
builds; in a release build, run
`localStorage.setItem("rsvp-reader:debug", "1")` in the webview console and
restart. The log rotates at 1 MiB.

## More

- `AGENTS.md` — architecture, data flow and design decisions.
- `rsvp-reader-assessment.md` — code review and to-do list.
