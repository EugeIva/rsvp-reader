#!/usr/bin/env bash
#
# Run every check the project has: type check, lint, frontend tests, then
# Rust formatting, lints and tests. Exits non-zero on the first failure.
#
# Usage: ./scripts/ci.sh   (or: npm run ci)
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CARGO_MANIFEST=src-tauri/Cargo.toml

npm run check
npm run lint
npm test
# Compiling the Tauri crate embeds build/, so it must exist first.
npm run build
cargo fmt --manifest-path "$CARGO_MANIFEST" --check
cargo clippy --manifest-path "$CARGO_MANIFEST" --all-targets -- -D warnings
cargo test --manifest-path "$CARGO_MANIFEST"
