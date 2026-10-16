# Gemini / Antigravity Context (`agy-test`)

High-level project guide for Antigravity / Gemini agents. Detailed internals, PTY protocols, and state-machine rules live in [`README.md`](./README.md).

## Architecture at a Glance
- **Desktop App (Tauri v2 + Rust):** `src-tauri/` compiles into a standalone macOS application (`dist/Antigravity Console.app`) that embeds `public/` and links directly against macOS system frameworks (`WebKit`, `AppKit`, `libsqlite3`, `libSystem`).
- **Dual-Transport Web UI (`public/app.js`):**
  - **Tauri Mode:** Uses `window.__TAURI__.core.invoke(...)` for commands and `window.__TAURI__.event.listen('agy-turn-event')` for real-time streaming.
  - **Browser Mode:** Falls back to `fetch('/api/...')` and `EventSource` SSE against `server.js`.
- **Multi-Core Native PTY Execution (`src-tauri/src/pty_manager.rs`):**
  - Each chat turn spawns `agy --prompt-interactive` inside a native macOS pseudo-terminal (`libc::openpty`, `setsid`, `TIOCSCTTY`).
  - Each turn runs on dedicated OS threads (`tauri::async_runtime::spawn_blocking` for 150ms JSONL transcript polling + `std::thread::spawn` for non-blocking PTY stdout reading and keystroke injection).

## Key Files
- `src-tauri/src/lib.rs` — Tauri commands & macOS login-shell `PATH` hydration.
- `src-tauri/src/pty_manager.rs` — Multi-session PTY lifecycle, permission auto-approval (`\r`), and `AskQuestion` TUI keystrokes.
- `src-tauri/src/turn_state.rs` — Transcript JSONL state machine (subagents, background tasks, schedules/timers).
- `src-tauri/src/sessions.rs` — Native SQLite FFI session metadata reader + `brain/` directory scanner.
- `public/app.js` — Multi-session UI state, Tauri IPC / HTTP-SSE transport adapter.
- `scripts/bundle-macos-app.sh` — Packages `dist/Antigravity Console.app`.

## Common Workflows
- **Test Rust backend:** `npm run tauri:test`
- **Package macOS `.app`:** `npm run tauri:bundle`
- **Launch packaged `.app`:** `open "dist/Antigravity Console.app"`
- **Test Node fallback:** `npm test`
