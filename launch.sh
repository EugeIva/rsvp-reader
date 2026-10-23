#!/usr/bin/env bash
#
# Launch rsvp-reader.
#
# Note: standalone binaries must be compiled with the `custom-protocol`
# feature so the frontend is embedded (otherwise the app expects the Vite
# dev server and shows a blank window). `--build` and `--debug` both use it.
#
# Usage:
#   ./launch.sh                 Run the existing built binary (release if present, else debug)
#   ./launch.sh --dev           Run in development mode (vite + tauri, hot reload)
#   ./launch.sh --build         Build the release binary, then launch it
#   ./launch.sh --debug         Launch the existing debug binary
#   ./launch.sh --check         Print which target would be launched and exit
#   ./launch.sh --app           Build the macOS app bundle (RSVP Reader.app) and open it
#   ./launch.sh --install       Build the app bundle, copy it to /Applications and open it
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN=rsvp-reader
APP_NAME="RSVP Reader.app"
APP_BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"

usage() {
    # The comment block at the top of this file.
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
    exit 0
}

mode="auto"
case "${1:-}" in
    -h|--help) usage ;;
    --dev)  mode="dev" ;;
    --build) mode="build" ;;
    --debug) mode="debug" ;;
    --check) mode="check" ;;
    --app) mode="app" ;;
    --install) mode="install" ;;
    "") ;;
    *) echo "Unknown option: $1" >&2; usage ;;
esac

if [[ "$mode" == "dev" ]]; then
    cd "$ROOT"
    exec npm run tauri dev
fi

if [[ "$mode" == "app" || "$mode" == "install" ]]; then
    cd "$ROOT"
    # Release build of the frontend and binary, bundled as a .app
    # (custom-protocol is enabled automatically).
    npm run package
    if [[ "$mode" == "install" ]]; then
        rm -rf "/Applications/$APP_NAME"
        cp -R "$APP_BUNDLE" /Applications/
        echo "Installed: /Applications/$APP_NAME"
        exec open "/Applications/$APP_NAME"
    fi
    echo "Built: $APP_BUNDLE"
    exec open "$APP_BUNDLE"
fi

if [[ "$mode" == "build" ]]; then
    cd "$ROOT"
    npm run build
    cargo build --manifest-path "$ROOT/src-tauri/Cargo.toml" --release --features custom-protocol
    exec "$ROOT/src-tauri/target/release/$BIN"
fi

debug_bin="$ROOT/src-tauri/target/debug/$BIN"
release_bin="$ROOT/src-tauri/target/release/$BIN"
target=""

if [[ "$mode" == "debug" ]]; then
    if [[ ! -x "$debug_bin" ]]; then
        echo "Debug binary not found; building with custom-protocol..."
        cargo build --manifest-path "$ROOT/src-tauri/Cargo.toml" --features custom-protocol
    fi
    target="$debug_bin"
elif [[ "$mode" == "auto" || "$mode" == "check" ]]; then
    if [[ -x "$release_bin" ]]; then
        target="$release_bin"
    elif [[ -x "$debug_bin" ]]; then
        target="$debug_bin"
    fi
fi

if [[ -z "$target" || ! -x "$target" ]]; then
    echo "No application binary found. Build it first:" >&2
    echo "    $0 --build" >&2
    echo "or run the dev server with:" >&2
    echo "    $0 --dev" >&2
    exit 1
fi

if [[ "$mode" == "check" ]]; then
    echo "$target"
    exit 0
fi

echo "Launching: $target"
exec "$target"