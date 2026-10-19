# Agent Instructions (`agy-test` / Antigravity Console)

High-level context for coding agents working in this repository. For full architecture and protocol details, see [`README.md`](./README.md).

## Stack Overview
- **Primary Runtime (`main` branch — Rust Backend):** Self-running macOS Tauri v2 desktop app (`dist/Antigravity Console.app`) with a pure Rust backend (`src-tauri/`) and vanilla HTML/CSS/JS frontend (`public/`). The backend architecture has been migrated from Node.js to Rust.
- **Legacy/Dev Fallback Runtime (Tag `node` / Browser Dev):** Node.js + Express + `node-pty` (`server.js`, `lib/turnState.js`, `lib/prechecks.js`) serving the same `public/` frontend over HTTP + SSE for browser development and fallback testing.
- **Zero-Port Desktop IPC:** In Tauri mode, `public/app.js` and `public/precheckModal.js` detect `window.__TAURI__` and communicate directly with Rust via `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen('agy-turn-event')`. No localhost TCP port or Node process is used at runtime.

## Repository Map
- `src-tauri/src/lib.rs` — Tauri entrypoint, macOS login-shell `PATH` hydration, `#[tauri::command]` handlers, exit cleanup.
- `src-tauri/src/pty_manager.rs` — Multi-session native macOS `openpty` manager, ANSI stripping, auto-`Enter` (`\r`) permission approval, `ask_question` TUI keystroke simulation, `Ctrl+D x2` graceful exit.
- `src-tauri/src/turn_state.rs` — Transcript JSONL parser tracking tool calls, subagents, background tasks, timers, and wakeup steps.
- `src-tauri/src/sessions.rs` — Native `libsqlite3` FFI reader for `~/.gemini/antigravity-cli/conversation_summaries.db` and `brain/<sessionId>` transcripts.
- `src-tauri/src/prechecks.rs` — Native Rust startup prechecks verifying `agy` CLI binary and active authentication credentials.
- `src-tauri/src/models.rs` — `camelCase` Serde IPC request/response/event payloads.
- `public/` — Frontend UI (`index.html`, `styles.css`, `precheckModal.js`, `app.js`) supporting both Tauri IPC and HTTP/SSE fallback.
- `server.js`, `lib/turnState.js`, `lib/prechecks.js` — Legacy/fallback Node.js server, transcript parser, and prechecks (backend architecture is now Rust in `src-tauri/`).
- `scripts/bundle-macos-app.sh` — Builds the Rust binary and packages `dist/Antigravity Console.app`.

## Essential Commands
- **Run Rust unit tests:** `npm run tauri:test` (or `cargo test --offline --manifest-path src-tauri/Cargo.toml`)
- **Build macOS `.app` bundle:** `npm run tauri:bundle` (outputs `dist/Antigravity Console.app`; pass `-- --release` for release build)
- **Run Tauri app directly:** `npm run tauri:run`
- **Run Node/Browser fallback tests:** `npm test` (`node test-poc.js`)

## Key Invariants
1. **External `agy` Binary:** Assumes `agy` is installed (`~/.local/bin/agy` or `$AGY_BIN`) and authenticated by the user.
2. **Parity Between Transports:** Any change to IPC command signatures or `agy-turn-event` payloads in `src-tauri/` must remain compatible with `public/app.js`.
3. **PTY Lifecycle Safety:** Always drop `std::process::Command` immediately after `.spawn()` in `pty_manager.rs` so the parent process does not retain open `slave_fd` handles.
