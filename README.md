# Antigravity Console (`agy-test`)

A self-running macOS desktop application (**Tauri v2 + Rust**) that wraps the Antigravity CLI (`agy`) using managed pseudo-terminals (PTY), real-time JSONL transcript streaming, automatic permission prompt approval, and interactive `AskQuestion` UI cards.

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [How Frontend & Backend Communicate](#2-how-frontend--backend-communicate)
3. [Native Rust PTY Manager & Multi-CPU Concurrency](#3-native-rust-pty-manager--multi-cpu-concurrency)
4. [Turn Lifecycle & Transcript State Machine](#4-turn-lifecycle--transcript-state-machine)
5. [Session & Workspace Discovery (Native SQLite FFI)](#5-session--workspace-discovery-native-sqlite-ffi)
6. [Project Structure](#6-project-structure)
7. [Development, Testing & Packaging](#7-development-testing--packaging)

---

## 1. Architecture Overview

Antigravity Console runs as a native macOS desktop application built with **Tauri v2** (`src-tauri/`) and a vanilla HTML/CSS/JS frontend (`public/`):

- Embeds `public/index.html`, `public/styles.css`, `public/precheckModal.js`, and `public/app.js` directly into the compiled binary.
- Communicates exclusively over **Tauri IPC** (`invoke` + `listen`) with **zero localhost ports** and **no Node.js runtime dependency**.
- Links only against standard macOS system libraries (`WebKit.framework`, `AppKit.framework`, `/usr/lib/libsqlite3.dylib`, `/usr/lib/libSystem.B.dylib`).
- Hydrates the user's login-shell `PATH` on startup (`/bin/zsh -ilc`) so launching `Antigravity Console.app` from Finder or Spotlight finds `~/.local/bin/agy`, `gh`, and `gcloud`.

---

## 2. How Frontend & Backend Communicate

`public/app.js` and `public/precheckModal.js` communicate directly with the Rust backend via `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen('agy-turn-event')`:

| Operation | Tauri IPC Command / Event |
| :--- | :--- |
| **Startup Prechecks** | `invoke('run_prechecks', { check })` |
| **List Workspaces** | `invoke('get_workspaces')` |
| **Native Folder Picker** | `invoke('pick_directory', { initialPath })` |
| **List Sessions** | `invoke('list_sessions')` |
| **Load Session History** | `invoke('get_session', { sessionId })` |
| **Attach Live Turn Stream** | `invoke('attach_session_stream', { sessionId })` |
| **Start / Resume Turn** | `invoke('start_chat_turn', { prompt, sessionId, conversationId, clientTurnId, cwd, approvalInput })` |
| **Answer `AskQuestion`** | `invoke('submit_ask_question', { sessionId, turnId, action, answers })` |
| **Real-Time Events** | `event.listen('agy-turn-event', handler)` |

### Event Stream Envelope (`agy-turn-event`)
Every real-time event emitted by the Rust backend carries `{ event, turnId, sessionId, data }` so the UI can demultiplex concurrent sessions:
- `status`: `{ state, message, progressLabel, turnId, sessionId }`
- `session`: `{ sessionId, turnId, source }` (emitted as soon as a new session UUID is discovered)
- `transcript`: `{ sessionId, turnId, items, stepCount, turnState, progressLabel }`
- `permission_prompt`: `PermissionRecord` (`status: "pending"`)
- `enter_simulated`: `PermissionRecord` (`status: "approved"`)
- `ask_question`: `{ sessionId, turnId, stepIndex, questions, summary }`
- `exit`: `TurnExitResult` (`exitCode`, `autoApprovalsCount`, final `items` and `permissions`)

---

## 3. Native Rust PTY Manager & Multi-CPU Concurrency

### Native macOS `openpty` (`src-tauri/src/pty_manager.rs`)
Because `agy --prompt-interactive "<prompt>"` requires an interactive TTY for TUI rendering, permission prompts, and `ask_question` modals, each turn allocates a native macOS pseudo-terminal:
1. Calls `libc::openpty(&mut master_fd, &mut slave_fd, ...)` with a `120x40` `winsize`.
2. Spawns `agy` with `stdin`/`stdout`/`stderr` bound to `slave_fd`, calling `libc::setsid()` and `libc::ioctl(0, TIOCSCTTY, 0)` in `pre_exec` so the child process has its own controlling terminal and process group.
3. Drops `std::process::Command` immediately after `.spawn()` in the parent process so the parent holds zero open `slave_fd` descriptors (ensuring `master_fd` receives `EOF` cleanly when `agy` exits).
4. Duplicates `master_fd` (`libc::dup`) into an independent `pty_reader` (`File`) and `pty_writer` (`Mutex<File>`), allowing concurrent reading and keystroke writing without lock contention.

### Multi-Session & Multi-CPU Execution
- **Concurrent Sessions:** `AppState` maintains `active_turns: Mutex<HashMap<String, Arc<TurnController>>>` (keyed by `sessionId`) and `active_turns_by_turn_id` (keyed by provisional `turnId`). Multiple sessions can run simultaneously across different workspaces.
- **Multi-Core Threading:**
  - Each turn is launched via `tauri::async_runtime::spawn_blocking`, giving its 150ms JSONL transcript watcher its own OS worker thread.
  - Each turn spawns a dedicated OS thread (`std::thread::spawn`) for blocking `pty_reader.read()` and ANSI/TUI parsing.
  - Each `agy` child process runs as an independent OS process scheduled across Apple Silicon CPU cores by the macOS kernel.

### Automated TUI Interactions
1. **Terminal Handshakes:** Automatically responds to terminal queries emitted by `agy` (`\x1b[6n` cursor position, `\x1b]11;?` / `\x1b]10;?` OSC colors, `\x1b[c` device attributes) so the TUI initializes without stalling.
2. **Permission Auto-Approval (`\r`):**
   - Strips ANSI escape sequences (`strip_ansi`) into a rolling 4 KB buffer and scans for permission boxes (`> 1. Yes`, `Yes, and always allow`, `Yes, I trust this folder`).
   - Matches the prompt against the latest tool call in the transcript (`find_matching_tool_item`), emits a `permission_prompt` event, waits 350ms for TUI input readiness, writes `\r` (or custom approval key) to `pty_writer`, and emits `enter_simulated`.
3. **Interactive `AskQuestion` Keystroke Simulation (`send_ask_question_keystrokes`):**
   - When `transcript.jsonl` records a `PLANNER_RESPONSE` containing an `ask_question` tool call, auto-Enter is paused and the Web UI renders an interactive question card.
   - When the user clicks **Submit** or **Skip**, Rust translates the selections/write-in text into exact TUI keystrokes (`\x1b[B` Down arrow, ` ` Spacebar for multi-select, write-in characters, `\r` Enter, or `\x1b` Esc to skip) and writes them directly to the waiting PTY.

---

## 4. Turn Lifecycle & Transcript State Machine

Located in `src-tauri/src/turn_state.rs`:

- **Session Discovery:** For new sessions, `agy` is passed `--log-file /tmp/agy-tauri-<turnId>.log`. The watcher extracts `Created conversation <uuid>` from the log file to locate `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` (and `transcript_full.jsonl` when `truncated_fields` is present).
- **Completion Detection (`is_turn_complete`):**
  - A turn is only considered complete when the latest step after `turn_start_step_index` is a `PLANNER_RESPONSE` with `status == "DONE"`, **no** `tool_calls` are present on that final step, **and** there is no pending background work.
  - Tracks background commands (`run_command` returning `taskId`, `manage_task`), subagents (`invoke_subagent`, `send_message`, `manage_subagents`), and timers/cron jobs (`schedule`, `TimerCondition` early cancellation) across steps, waiting for wakeup `USER_INPUT` / system notifications before sending `Ctrl+D x2` (`\x04`, `\x04`) to exit `agy` cleanly.

---

## 5. Session & Workspace Discovery (Native SQLite FFI)

Located in `src-tauri/src/sessions.rs`:
- **SQLite Summaries (`libsqlite3` FFI):** Queries `~/.gemini/antigravity-cli/conversation_summaries.db` (`summaries` table) in `SQLITE_OPEN_READONLY` mode using macOS's built-in `/usr/lib/libsqlite3.dylib` to retrieve session titles and base64-decoded workspace paths without requiring external SQLite binaries or crates.
- **Brain Directory Scanner:** Scans `~/.gemini/antigravity-cli/brain/` (and `~/.gemini/antigravity/brain/`), reading the tail of `transcript.jsonl` to compute step counts, fallback titles/workspaces, and active running states.

---

## 6. Project Structure

```text
.
├── AGENTS.md                      # Concise agent instructions
├── GEMINI.md                      # Concise Gemini/Antigravity context
├── README.md                      # Detailed architecture & developer guide
├── scripts/
│   └── bundle-macos-app.sh        # Builds Rust binary & packages dist/Antigravity Console.app
├── public/                        # Frontend assets (embedded by Tauri)
│   ├── index.html
│   ├── styles.css
│   ├── precheckModal.js           # Startup prechecks UI modal
│   └── app.js                     # Tauri IPC frontend controller
└── src-tauri/                     # Tauri v2 Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/
    └── src/
        ├── main.rs                # Binary entrypoint
        ├── lib.rs                 # Tauri setup, PATH hydration & command handlers
        ├── models.rs              # Serde camelCase structs
        ├── prechecks.rs           # Native startup prechecks (AGY CLI & Auth)
        ├── pty_manager.rs         # Native openpty manager & turn lifecycle
        ├── sessions.rs            # Native libsqlite3 FFI, directory picker & brain scanner
        └── turn_state.rs          # Transcript JSONL parser & background task tracker
```

---

## 7. Development, Testing & Packaging

### Prerequisites
- macOS 11.0+ (Apple Silicon or Intel)
- Rust toolchain (`cargo`, `rustc`)
- `agy` CLI installed (`~/.local/bin/agy` or custom `$AGY_BIN`) and authenticated

### Commands

```bash
# 1. Run Rust unit tests (turn state machine, native openpty roundtrip, permission detection, prechecks, sessions)
cargo test --offline --manifest-path src-tauri/Cargo.toml

# 2. Build and package the macOS application bundle (dist/Antigravity Console.app)
./scripts/bundle-macos-app.sh

# 3. Build an optimized release macOS application bundle
./scripts/bundle-macos-app.sh --release

# 4. Launch the packaged macOS app
open "dist/Antigravity Console.app"

# 5. Run the Tauri desktop app directly from cargo
cargo run --offline --manifest-path src-tauri/Cargo.toml
```
