use crate::models::{
    AskQuestionDef, AskQuestionSubmission, LiveSessionMeta, PendingAskQuestion, PermissionRecord,
    TurnEventEnvelope, TurnExitResult, TurnState, UiItem,
};
use crate::sessions::{brain_dirs, get_transcript_path, now_iso_string, read_conversation};
use crate::turn_state::parse_transcript_lines;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[repr(C)]
struct WinSize {
    ws_row: u16,
    ws_col: u16,
    ws_xpixel: u16,
    ws_ypixel: u16,
}

const TIOCSCTTY: u64 = 0x20007461;

extern "C" {
    fn openpty(
        amaster: *mut i32,
        aslave: *mut i32,
        name: *mut i8,
        termp: *const std::ffi::c_void,
        winp: *const WinSize,
    ) -> i32;
    fn setsid() -> i32;
    fn ioctl(fd: i32, request: u64, ...) -> i32;
    fn dup(fd: i32) -> i32;
}

#[derive(Default)]
pub struct AppState {
    pub active_turns: Mutex<HashMap<String, Arc<TurnController>>>,
    pub active_turns_by_turn_id: Mutex<HashMap<String, Arc<TurnController>>>,
    pub session_permissions: Mutex<HashMap<String, Vec<PermissionRecord>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_controller(&self, session_or_turn_id: &str) -> Option<Arc<TurnController>> {
        if session_or_turn_id.is_empty() {
            return None;
        }
        if let Ok(by_sess) = self.active_turns.lock() {
            if let Some(c) = by_sess.get(session_or_turn_id) {
                return Some(Arc::clone(c));
            }
        }
        if let Ok(by_turn) = self.active_turns_by_turn_id.lock() {
            if let Some(c) = by_turn.get(session_or_turn_id) {
                return Some(Arc::clone(c));
            }
        }
        None
    }

    pub fn get_live_session_meta(&self, session_id: &str) -> LiveSessionMeta {
        if let Some(controller) = self.get_controller(session_id) {
            controller.get_snapshot_meta()
        } else {
            LiveSessionMeta::default()
        }
    }

    pub fn attach_permissions_to_session(&self, session_id: &str, perms: &[PermissionRecord]) {
        if session_id.is_empty() {
            return;
        }
        if let Ok(mut map) = self.session_permissions.lock() {
            let list = map.entry(session_id.to_string()).or_default();
            for perm in perms {
                let mut p = perm.clone();
                p.session_id = Some(session_id.to_string());
                if let Some(existing) = list.iter_mut().find(|e| e.id == p.id) {
                    *existing = p;
                } else {
                    list.push(p);
                }
            }
        }
    }

    pub fn get_session_permissions(&self, session_id: &str) -> Vec<PermissionRecord> {
        if let Ok(map) = self.session_permissions.lock() {
            if let Some(list) = map.get(session_id) {
                return list.clone();
            }
        }
        if let Some(c) = self.get_controller(session_id) {
            if let Ok(st) = c.state.lock() {
                return st.permissions.clone();
            }
        }
        Vec::new()
    }

    pub fn kill_all_active_turns(&self) {
        if let Ok(by_turn) = self.active_turns_by_turn_id.lock() {
            for controller in by_turn.values() {
                controller.kill_process();
            }
        }
    }
}

pub struct TurnRuntimeState {
    pub session_id: Option<String>,
    pub updated_at: String,
    pub step_count: usize,
    pub latest_step_index: Option<usize>,
    pub latest_step_type: String,
    pub items: Vec<UiItem>,
    pub permissions: Vec<PermissionRecord>,
    pub pending_ask_question: Option<PendingAskQuestion>,
    pub current_state: String,
    pub current_status_message: String,
    pub latest_turn_state: TurnState,
    pub is_exiting: bool,
    pub rolling_clean: String,
    pub bound_tool_item_ids: HashSet<String>,
}

pub struct TurnController {
    pub turn_id: String,
    pub initial_prompt: String,
    pub cwd: String,
    pub child_pid: u32,
    pub pty_writer: Mutex<fs::File>,
    pub state: Mutex<TurnRuntimeState>,
}

impl TurnController {
    pub fn get_progress_label(st: &TurnRuntimeState) -> String {
        if let Some(ref q) = st.pending_ask_question {
            return format!("? Waiting for answer: {}", q.summary);
        }
        if st.permissions.iter().any(|p| p.status != "approved") {
            return "↵ Auto-approving permission...".to_string();
        }
        if let Some(ref bg_sum) = st.latest_turn_state.pending_background_summary {
            return bg_sum.clone();
        }
        if !st.latest_turn_state.latest_activity_label.is_empty() {
            return st.latest_turn_state.latest_activity_label.clone();
        }
        st.current_status_message.clone()
    }

    pub fn get_snapshot_meta(&self) -> LiveSessionMeta {
        if let Ok(st) = self.state.lock() {
            LiveSessionMeta {
                is_running: st.current_state != "idle",
                turn_id: Some(self.turn_id.clone()),
                state: st.current_state.clone(),
                message: st.current_status_message.clone(),
                status_message: st.current_status_message.clone(),
                progress_label: Self::get_progress_label(&st),
                has_pending_question: st.pending_ask_question.is_some(),
                pending_background_count: st.latest_turn_state.pending_background_count,
            }
        } else {
            LiveSessionMeta::default()
        }
    }

    pub fn kill_process(&self) {
        let pid = self.child_pid as i32;
        if pid > 0 {
            unsafe {
                // Send SIGTERM to process group and process
                libc::kill(-pid, libc::SIGTERM);
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }

    pub fn submit_ask_question(
        &self,
        submission: AskQuestionSubmission,
        app_handle: Option<&AppHandle>,
    ) -> Result<(), String> {
        let current_q = {
            let mut st = self.state.lock().map_err(|_| "State lock poisoned")?;
            let q = st
                .pending_ask_question
                .take()
                .ok_or_else(|| "No pending ask_question in active PTY turn".to_string())?;
            st.rolling_clean.clear();
            st.current_state = "answering_question".to_string();
            st.current_status_message = "Submitting answer to AGY TUI...".to_string();
            st.updated_at = now_iso_string();
            q
        };

        emit_turn_event(
            app_handle,
            &self.turn_id,
            current_q.session_id.as_deref(),
            "status",
            json!({
                "state": "answering_question",
                "message": "Submitting answer to AGY TUI...",
                "progressLabel": "Submitting answer to AGY TUI..."
            }),
        );

        send_ask_question_keystrokes(&self.pty_writer, &current_q.questions, &submission);

        emit_turn_event(
            app_handle,
            &self.turn_id,
            current_q.session_id.as_deref(),
            "ask_question_submitted",
            json!({
                "stepIndex": current_q.step_index,
                "submission": submission
            }),
        );

        Ok(())
    }
}

pub fn emit_turn_event(
    app_handle: Option<&AppHandle>,
    turn_id: &str,
    session_id: Option<&str>,
    event: &str,
    mut payload: Value,
) {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("turnId".to_string(), json!(turn_id));
        if matches!(obj.get("sessionId"), None | Some(Value::Null)) {
            obj.insert("sessionId".to_string(), json!(session_id));
        }
    }
    if let Some(app) = app_handle {
        let _ = app.emit(
            "agy-turn-event",
            TurnEventEnvelope {
                event: event.to_string(),
                data: payload,
            },
        );
    }
}

pub fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            if i >= bytes.len() {
                break;
            }
            match bytes[i] {
                b'[' => {
                    i += 1;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += 1;
                }
                b']' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => {
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn handle_terminal_queries(writer: &Mutex<fs::File>, raw: &str) {
    if let Ok(mut w) = writer.lock() {
        let mut wrote = false;
        if raw.contains("\x1b[6n") {
            let _ = w.write_all(b"\x1b[1;1R");
            wrote = true;
        }
        if raw.contains("\x1b]11;?") {
            let _ = w.write_all(b"\x1b]11;rgb:0000/0000/0000\x07");
            wrote = true;
        }
        if raw.contains("\x1b]10;?") {
            let _ = w.write_all(b"\x1b]10;rgb:ffff/ffff/ffff\x07");
            wrote = true;
        }
        if raw.contains("\x1b[c") || raw.contains("\x1b[>c") || raw.contains("\x1b[>q") {
            let _ = w.write_all(b"\x1b[?1;2c");
            wrote = true;
        }
        if wrote {
            let _ = w.flush();
        }
    }
}

#[derive(Debug, Clone)]
pub struct DetectedPrompt {
    pub title: String,
    pub target: String,
    pub reason: String,
    pub question: String,
    pub options: Vec<String>,
    pub snippet: String,
}

fn question_screen_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(Write-in\.\.\.|esc\s+Skip|Question\s+\d+/\d+:)").unwrap()
    })
}

fn menu_opt1_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)>\s*1\.\s*Yes\b").unwrap())
}

fn title_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(File access|Terminal command|Run command|Tool permission|Workspace trust)")
            .unwrap()
    })
}

fn target_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(Read|Write|Edit|Execute|Command|Path):").unwrap())
}

fn option_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^>?\s*[1234]\.\s+").unwrap())
}

fn box_rule_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"─+").unwrap())
}

pub fn detect_permission_prompt(rolling_clean: &str) -> Option<DetectedPrompt> {
    if question_screen_regex().is_match(rolling_clean) {
        return None;
    }

    let lower = rolling_clean.to_lowercase();
    let has_menu_opt1 = menu_opt1_regex().is_match(rolling_clean);
    let has_always_allow = lower.contains("yes, and always allow");
    let has_trust_folder = lower.contains("yes, i trust this folder");
    let has_nav_hint = lower.contains("navigate") && lower.contains("1. yes");

    if !has_menu_opt1 && !has_always_allow && !has_trust_folder && !has_nav_hint {
        return None;
    }

    let clean_lines: Vec<String> = rolling_clean
        .lines()
        .map(|l| box_rule_regex().replace_all(l, "───").trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("esc to cancel"))
        .collect();

    let snippet_start = clean_lines.len().saturating_sub(12);
    let snippet = clean_lines[snippet_start..].join("\n");

    let mut title = "Permission Request".to_string();
    let mut target = String::new();
    let mut reason = String::new();
    let mut question = String::new();
    let mut options = Vec::new();

    let scan_start = clean_lines.len().saturating_sub(14);
    for line in &clean_lines[scan_start..] {
        if title_line_regex().is_match(line) {
            title = line.clone();
        } else if target_line_regex().is_match(line) {
            target = line.clone();
        } else if line.to_lowercase().starts_with("reason:") {
            reason = line.clone();
        } else if line.ends_with('?') {
            question = line.clone();
        } else if option_line_regex().is_match(line) {
            let cleaned_opt = line.trim_start_matches('>').trim().to_string();
            options.push(cleaned_opt);
        }
    }

    if question.is_empty() {
        question = "Allow this operation to proceed?".to_string();
    }
    if options.is_empty() {
        options = vec![
            "1. Yes, allow access".to_string(),
            "2. Yes, and always allow".to_string(),
            "3. No, deny access".to_string(),
        ];
    }

    Some(DetectedPrompt {
        title,
        target,
        reason,
        question,
        options,
        snippet,
    })
}

fn write_pty_bytes(pty_writer: &Mutex<fs::File>, bytes: &[u8]) {
    if let Ok(mut w) = pty_writer.lock() {
        let _ = w.write_all(bytes);
        let _ = w.flush();
    }
}

pub fn send_ask_question_keystrokes(
    pty_writer: &Mutex<fs::File>,
    questions: &[AskQuestionDef],
    submission: &AskQuestionSubmission,
) {
    let fallback_q = vec![AskQuestionDef::default()];
    let q_list = if questions.is_empty() {
        &fallback_q
    } else {
        questions
    };

    if submission.action == "skip" {
        for q_idx in 0..q_list.len() {
            write_pty_bytes(pty_writer, b"\x1b");
            if q_idx + 1 < q_list.len() {
                thread::sleep(Duration::from_millis(200));
            }
        }
        return;
    }

    for (q_idx, q) in q_list.iter().enumerate() {
        let n = q.options.as_ref().map(|o| o.len()).unwrap_or(0);
        let ans = submission.answers.get(q_idx).cloned().unwrap_or_default();
        let write_in = ans.write_in.trim();
        let selected = &ans.selected_indices;
        let is_multi = q.is_multi_select.unwrap_or(false);

        if !is_multi {
            if !write_in.is_empty() {
                if n > 0 {
                    let down = "\x1b[B".repeat(n);
                    write_pty_bytes(pty_writer, down.as_bytes());
                    thread::sleep(Duration::from_millis(80));
                }
                write_pty_bytes(pty_writer, b"\r");
                thread::sleep(Duration::from_millis(220));
                let text = format!("{}\r", write_in);
                write_pty_bytes(pty_writer, text.as_bytes());
            } else {
                let choice_idx = if !selected.is_empty() && n > 0 {
                    selected[0].min(n.saturating_sub(1))
                } else {
                    0
                };
                if choice_idx > 0 {
                    let down = "\x1b[B".repeat(choice_idx);
                    write_pty_bytes(pty_writer, down.as_bytes());
                    thread::sleep(Duration::from_millis(80));
                }
                write_pty_bytes(pty_writer, b"\r");
            }
        } else {
            let max_option_to_visit = if !write_in.is_empty() {
                n
            } else if let Some(&max_sel) = selected.iter().max() {
                max_sel.min(n.saturating_sub(1))
            } else {
                0
            };

            for i in 0..n {
                if selected.contains(&i) {
                    write_pty_bytes(pty_writer, b" ");
                    thread::sleep(Duration::from_millis(70));
                }
                if i < max_option_to_visit {
                    write_pty_bytes(pty_writer, b"\x1b[B");
                    thread::sleep(Duration::from_millis(70));
                }
            }

            if !write_in.is_empty() {
                write_pty_bytes(pty_writer, b"\r");
                thread::sleep(Duration::from_millis(220));
                let text = format!("{}\r", write_in);
                write_pty_bytes(pty_writer, text.as_bytes());
            } else {
                write_pty_bytes(pty_writer, b"\r");
            }
        }

        if q_idx + 1 < q_list.len() {
            thread::sleep(Duration::from_millis(260));
        }
    }
}

fn find_matching_tool_item(
    items: &[UiItem],
    bound_ids: &HashSet<String>,
    target: &str,
    snippet: &str,
    baseline_step_count: usize,
    min_step_index: usize,
) -> Option<(String, usize)> {
    let effective_min = baseline_step_count.max(min_step_index);
    let turn_tools: Vec<&UiItem> = items
        .iter()
        .filter(|it| it.role == "tool_call" && it.step_index >= effective_min)
        .collect();
    if turn_tools.is_empty() {
        return None;
    }

    let unbound: Vec<&UiItem> = turn_tools
        .iter()
        .copied()
        .filter(|t| !bound_ids.contains(&t.id))
        .collect();
    let pool = if !unbound.is_empty() {
        unbound
    } else {
        turn_tools.clone()
    };
    let running: Vec<&UiItem> = pool
        .iter()
        .copied()
        .filter(|t| t.status.as_deref() == Some("running"))
        .collect();
    let candidates = if !running.is_empty() { running } else { pool };

    let target_lower = target.trim().to_lowercase();
    let haystack = format!("{}\n{}", target, snippet).to_lowercase();
    if !target_lower.is_empty() || !haystack.trim().is_empty() {
        if let Some(matched) = candidates.iter().find(|t| {
            let detail = t.detail.as_deref().unwrap_or("").trim().to_lowercase();
            let args_str = t
                .args
                .as_ref()
                .map(|a| a.to_string().to_lowercase())
                .unwrap_or_default();
            if !target_lower.is_empty()
                && (detail.contains(&target_lower) || args_str.contains(&target_lower))
            {
                return true;
            }
            !detail.is_empty() && haystack.contains(&detail)
        }) {
            return Some((matched.id.clone(), matched.step_index));
        }
    }

    if let Some(by_bypass) = candidates
        .iter()
        .find(|t| t.bypass_sandbox.unwrap_or(false))
    {
        return Some((by_bypass.id.clone(), by_bypass.step_index));
    }

    candidates
        .first()
        .or_else(|| turn_tools.last())
        .map(|t| (t.id.clone(), t.step_index))
}

fn resolve_session_id_from_log(log_path: &Path) -> Option<String> {
    let content = fs::read_to_string(log_path).ok()?;
    for marker in ["Created conversation ", "Streaming conversation "] {
        if let Some(idx) = content.find(marker) {
            let rest = &content[idx + marker.len()..];
            if rest.len() >= 36 {
                let candidate = &rest[..36];
                if candidate
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() || c == '-')
                {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    None
}

fn resume_banner_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)agy --conversation=([0-9a-f-]{36})").unwrap())
}

pub fn get_agy_bin() -> String {
    let configured = env::var("AGY_BIN")
        .ok()
        .filter(|val| !val.trim().is_empty())
        .unwrap_or_else(|| {
            crate::sessions::home_dir()
                .join(".local/bin/agy")
                .to_string_lossy()
                .into_owned()
        });
    let path_env = env::var("PATH").unwrap_or_default();
    crate::prechecks::resolve_agy_binary_path(&configured, &path_env).unwrap_or(configured)
}

pub fn get_gcp_project() -> String {
    env::var("GOOGLE_CLOUD_PROJECT").unwrap_or_else(|_| "next-gemini-ent-prd".to_string())
}

pub fn start_agy_turn_blocking(
    app_state: Arc<AppState>,
    app_handle: Option<AppHandle>,
    prompt: String,
    conversation_id: Option<String>,
    client_turn_id: Option<String>,
    cwd: Option<String>,
    approval_input: Option<String>,
) -> Result<TurnExitResult, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let turn_id = client_turn_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("turn-{}-{}", ts, (ts % 100000)));

    let home = crate::sessions::home_dir();
    let fallback_cwd = {
        let p = home.join("projects");
        if p.exists() {
            p.to_string_lossy().into_owned()
        } else {
            home.to_string_lossy().into_owned()
        }
    };
    let valid_cwd = cwd
        .filter(|c| !c.trim().is_empty() && Path::new(c).exists())
        .unwrap_or(fallback_cwd);

    let approval_key = approval_input.unwrap_or_else(|| "\r".to_string());
    let tmp_log_file = env::temp_dir().join(format!("agy-tauri-{}.log", turn_id));

    let mut baseline_step_count = 0usize;
    if let Some(ref cid) = conversation_id {
        if let Some(existing_path) = get_transcript_path(cid) {
            if let Ok(content) = fs::read_to_string(existing_path) {
                baseline_step_count = content.lines().filter(|l| !l.trim().is_empty()).count();
            }
        }
    }

    let agy_bin = get_agy_bin();
    if Path::new(&agy_bin).is_absolute() && !Path::new(&agy_bin).exists() {
        return Err(format!(
            "AGY binary not found at {}. Ensure agy CLI is installed.",
            agy_bin
        ));
    }

    let mut args = vec!["--dangerously-skip-permissions".to_string()];
    if let Some(ref cid) = conversation_id {
        if !cid.trim().is_empty() {
            args.push(format!("--conversation={}", cid));
        }
    }
    args.push("--log-file".to_string());
    args.push(tmp_log_file.to_string_lossy().into_owned());
    args.push("--prompt-interactive".to_string());
    args.push(prompt.clone());

    let mut master_fd: i32 = -1;
    let mut slave_fd: i32 = -1;
    let winsize = WinSize {
        ws_row: 40,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let rc = unsafe {
        openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null(),
            &winsize,
        )
    };
    if rc != 0 {
        return Err("openpty failed to allocate pseudo-terminal".to_string());
    }

    let slave_in = unsafe { fs::File::from_raw_fd(slave_fd) };
    let slave_out = unsafe { fs::File::from_raw_fd(dup(slave_fd)) };
    let slave_err = unsafe { fs::File::from_raw_fd(dup(slave_fd)) };

    let gcp_project = get_gcp_project();
    let mut cmd = Command::new(&agy_bin);
    cmd.args(&args)
        .current_dir(&valid_cwd)
        .env("GOOGLE_CLOUD_PROJECT", &gcp_project)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .stdin(Stdio::from(slave_in))
        .stdout(Stdio::from(slave_out))
        .stderr(Stdio::from(slave_err));

    unsafe {
        cmd.pre_exec(move || {
            setsid();
            ioctl(0, TIOCSCTTY, 0);
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| {
        unsafe {
            libc::close(master_fd);
        }
        format!("Failed to spawn agy binary at {}: {}", agy_bin, e)
    })?;
    // Drop `cmd` immediately so the parent process closes its copies of the slave PTY descriptors.
    drop(cmd);

    let child_pid = child.id();
    let writer_fd = unsafe { dup(master_fd) };
    let mut pty_reader = unsafe { fs::File::from_raw_fd(master_fd) };
    let pty_writer = unsafe { fs::File::from_raw_fd(writer_fd) };

    let initial_status = if conversation_id.is_some() {
        "Resuming session in PTY...".to_string()
    } else {
        "Spawning new AGY PTY session...".to_string()
    };

    let controller = Arc::new(TurnController {
        turn_id: turn_id.clone(),
        initial_prompt: prompt.clone(),
        cwd: valid_cwd.clone(),
        child_pid,
        pty_writer: Mutex::new(pty_writer),
        state: Mutex::new(TurnRuntimeState {
            session_id: conversation_id.clone(),
            updated_at: now_iso_string(),
            step_count: baseline_step_count,
            latest_step_index: None,
            latest_step_type: String::new(),
            items: Vec::new(),
            permissions: Vec::new(),
            pending_ask_question: None,
            current_state: "spawning".to_string(),
            current_status_message: initial_status,
            latest_turn_state: TurnState::default(),
            is_exiting: false,
            rolling_clean: String::new(),
            bound_tool_item_ids: HashSet::new(),
        }),
    });

    if let Ok(mut by_turn) = app_state.active_turns_by_turn_id.lock() {
        by_turn.insert(turn_id.clone(), Arc::clone(&controller));
    }
    if let Some(ref cid) = conversation_id {
        if let Ok(mut by_sess) = app_state.active_turns.lock() {
            by_sess.insert(cid.clone(), Arc::clone(&controller));
        }
    }

    emit_turn_event(
        app_handle.as_ref(),
        &turn_id,
        conversation_id.as_deref(),
        "spawn",
        json!({
            "command": agy_bin,
            "args": args,
            "cwd": valid_cwd,
            "env": { "GOOGLE_CLOUD_PROJECT": gcp_project }
        }),
    );

    let last_emitted_line_count = Arc::new(Mutex::new(baseline_step_count));
    let transcript_final_done = Arc::new(Mutex::new(false));
    let has_started_generating = Arc::new(Mutex::new(false));
    let pending_enter_active = Arc::new(Mutex::new(false));
    let b_dirs = brain_dirs();

    // Shared sync_transcript helper closure
    let sync_transcript = {
        let controller = Arc::clone(&controller);
        let app_state = Arc::clone(&app_state);
        let app_handle = app_handle.clone();
        let tmp_log_file = tmp_log_file.clone();
        let last_emitted_line_count = Arc::clone(&last_emitted_line_count);
        let transcript_final_done = Arc::clone(&transcript_final_done);
        let has_started_generating = Arc::clone(&has_started_generating);
        let pending_enter_active = Arc::clone(&pending_enter_active);
        let b_dirs = b_dirs.clone();

        Arc::new(move |force: bool| -> Option<String> {
            // 1. Resolve session ID from log file if not yet resolved
            let mut resolved_sid = {
                let st = controller.state.lock().ok()?;
                st.session_id.clone()
            };

            if resolved_sid.is_none() {
                if let Some(sid) = resolve_session_id_from_log(&tmp_log_file) {
                    let perms_to_attach = {
                        let mut st = controller.state.lock().ok()?;
                        st.session_id = Some(sid.clone());
                        st.updated_at = now_iso_string();
                        for p in &mut st.permissions {
                            p.session_id = Some(sid.clone());
                        }
                        st.permissions.clone()
                    };
                    if let Ok(mut by_sess) = app_state.active_turns.lock() {
                        by_sess.insert(sid.clone(), Arc::clone(&controller));
                    }
                    app_state.attach_permissions_to_session(&sid, &perms_to_attach);
                    emit_turn_event(
                        app_handle.as_ref(),
                        &controller.turn_id,
                        Some(&sid),
                        "session",
                        json!({ "sessionId": sid, "source": "log-file" }),
                    );
                    resolved_sid = Some(sid);
                }
            }

            let active_sid = resolved_sid?;
            let t_path = get_transcript_path(&active_sid)?;
            let content = fs::read_to_string(&t_path).ok()?;
            let raw_lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
            let line_count = raw_lines.len();

            let mut prev_count = last_emitted_line_count.lock().ok()?;
            let has_new_lines = line_count > *prev_count;
            if !has_new_lines && !force {
                return None;
            }

            let parsed = parse_transcript_lines(&raw_lines, baseline_step_count, &b_dirs);

            // Bind any unbound permission prompts to matching tool_call items
            let mut newly_bound_perms = Vec::new();
            let mut ask_to_emit: Option<PendingAskQuestion> = None;
            let mut status_to_emit: Option<(String, String, String)> = None;
            let mut exit_reason: Option<String> = None;
            let progress_label: String;

            {
                let mut st = controller.state.lock().ok()?;
                let bound_clone = st.bound_tool_item_ids.clone();
                let mut newly_bound_ids = Vec::new();
                for perm in &mut st.permissions {
                    if perm.after_item_id.is_none() && !perm.is_workspace_trust {
                        if let Some((matched_id, matched_step)) = find_matching_tool_item(
                            &parsed.items,
                            &bound_clone,
                            &perm.target,
                            &perm.snippet,
                            baseline_step_count,
                            perm.min_tool_step_index,
                        ) {
                            perm.after_item_id = Some(matched_id.clone());
                            perm.after_step_index = Some(matched_step);
                            newly_bound_ids.push(matched_id);
                            newly_bound_perms.push(perm.clone());
                        }
                    }
                }
                for id in newly_bound_ids {
                    st.bound_tool_item_ids.insert(id);
                }

                st.step_count = parsed.raw_steps.len();
                st.items = parsed.items.clone();
                st.latest_turn_state = parsed.turn_state.clone();
                st.updated_at = now_iso_string();

                if has_new_lines {
                    *prev_count = line_count;

                    if let Some(latest_step) = parsed.raw_steps.last() {
                        let step_idx = latest_step
                            .get("step_index")
                            .and_then(|v| v.as_u64())
                            .map(|n| n as usize)
                            .unwrap_or(0);
                        let step_type = latest_step
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        st.latest_step_index = Some(step_idx);
                        st.latest_step_type = step_type.to_string();

                        let ask_call = if step_idx >= baseline_step_count
                            && step_type == "PLANNER_RESPONSE"
                        {
                            latest_step
                                .get("tool_calls")
                                .and_then(|v| v.as_array())
                                .and_then(|arr| {
                                    arr.iter().find(|tc| {
                                        tc.get("name").and_then(|n| n.as_str())
                                            == Some("ask_question")
                                    })
                                })
                        } else {
                            None
                        };

                        if let Some(tc) = ask_call {
                            let args_val = match tc.get("args") {
                                Some(Value::String(s)) => serde_json::from_str::<Value>(s)
                                    .unwrap_or(Value::Object(Default::default())),
                                Some(v) => v.clone(),
                                None => Value::Object(Default::default()),
                            };
                            let is_new_q = st
                                .pending_ask_question
                                .as_ref()
                                .map(|q| q.step_index != step_idx)
                                .unwrap_or(true);
                            if is_new_q {
                                let questions: Vec<AskQuestionDef> = args_val
                                    .get("questions")
                                    .and_then(|q| serde_json::from_value(q.clone()).ok())
                                    .unwrap_or_default();
                                let summary = args_val
                                    .get("toolAction")
                                    .or_else(|| args_val.get("toolSummary"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Question from Antigravity")
                                    .to_string();
                                let pending_q = PendingAskQuestion {
                                    session_id: Some(active_sid.clone()),
                                    step_index: step_idx,
                                    questions,
                                    summary,
                                };
                                st.pending_ask_question = Some(pending_q.clone());
                                st.current_state = "waiting_for_question".to_string();
                                st.current_status_message =
                                    "Waiting for your answer in AskQuestion...".to_string();
                                ask_to_emit = Some(pending_q);
                                status_to_emit = Some((
                                    "waiting_for_question".to_string(),
                                    st.current_status_message.clone(),
                                    TurnController::get_progress_label(&st),
                                ));
                            }
                        } else if step_type == "GENERIC" {
                            st.pending_ask_question = None;
                        }

                        if parsed.turn_state.is_turn_complete {
                            if let Ok(mut done) = transcript_final_done.lock() {
                                *done = true;
                            }
                            let enter_busy = pending_enter_active
                                .lock()
                                .map(|g| *g)
                                .unwrap_or(false);
                            if !st.is_exiting && !enter_busy && st.pending_ask_question.is_none() {
                                exit_reason = Some(
                                    "Turn complete (final PLANNER_RESPONSE DONE and no pending background work); exiting PTY via Ctrl+D x2"
                                        .to_string(),
                                );
                            }
                        } else {
                            if let Ok(mut done) = transcript_final_done.lock() {
                                *done = false;
                            }
                            if parsed.turn_state.is_latest_step_final_planner_response
                                && parsed.turn_state.has_pending_background_work
                                && st.pending_ask_question.is_none()
                            {
                                let msg = parsed
                                    .turn_state
                                    .pending_background_summary
                                    .clone()
                                    .unwrap_or_else(|| {
                                        "Waiting for background tasks to finish...".to_string()
                                    });
                                st.current_state = "waiting_for_background".to_string();
                                st.current_status_message = msg.clone();
                                status_to_emit = Some((
                                    "waiting_for_background".to_string(),
                                    msg,
                                    TurnController::get_progress_label(&st),
                                ));
                            } else if st.pending_ask_question.is_none()
                                && has_started_generating.lock().map(|g| *g).unwrap_or(false)
                            {
                                let msg = if parsed.turn_state.latest_activity_label.is_empty() {
                                    "AGY is thinking & executing...".to_string()
                                } else {
                                    parsed.turn_state.latest_activity_label.clone()
                                };
                                st.current_state = "generating".to_string();
                                st.current_status_message = msg.clone();
                                status_to_emit = Some((
                                    "generating".to_string(),
                                    msg,
                                    TurnController::get_progress_label(&st),
                                ));
                            }
                        }
                    }
                }

                progress_label = TurnController::get_progress_label(&st);
            }

            if !newly_bound_perms.is_empty() {
                app_state.attach_permissions_to_session(&active_sid, &newly_bound_perms);
                for perm in newly_bound_perms {
                    let evt = if perm.status == "approved" {
                        "enter_simulated"
                    } else {
                        "permission_prompt"
                    };
                    emit_turn_event(
                        app_handle.as_ref(),
                        &controller.turn_id,
                        Some(&active_sid),
                        evt,
                        serde_json::to_value(perm).unwrap_or(Value::Null),
                    );
                }
            }

            if has_new_lines {
                emit_turn_event(
                    app_handle.as_ref(),
                    &controller.turn_id,
                    Some(&active_sid),
                    "transcript",
                    json!({
                        "sessionId": active_sid,
                        "items": parsed.items,
                        "stepCount": parsed.raw_steps.len(),
                        "turnState": parsed.turn_state,
                        "progressLabel": progress_label
                    }),
                );
            }

            if let Some(q) = ask_to_emit {
                emit_turn_event(
                    app_handle.as_ref(),
                    &controller.turn_id,
                    Some(&active_sid),
                    "ask_question",
                    serde_json::to_value(q).unwrap_or(Value::Null),
                );
            }

            if let Some((st_name, st_msg, st_prog)) = status_to_emit {
                emit_turn_event(
                    app_handle.as_ref(),
                    &controller.turn_id,
                    Some(&active_sid),
                    "status",
                    json!({
                        "state": st_name,
                        "message": st_msg,
                        "progressLabel": st_prog
                    }),
                );
            }

            exit_reason
        })
    };

    // Graceful exit helper closure (sends Ctrl+D x2 then kills if still alive)
    let trigger_graceful_exit = {
        let controller = Arc::clone(&controller);
        let app_handle = app_handle.clone();
        Arc::new(move |reason: String| {
            let sid = {
                let mut st = match controller.state.lock() {
                    Ok(s) => s,
                    Err(_) => return,
                };
                if st.is_exiting {
                    return;
                }
                st.is_exiting = true;
                st.current_state = "completing".to_string();
                st.current_status_message = reason.clone();
                st.updated_at = now_iso_string();
                st.session_id.clone()
            };

            emit_turn_event(
                app_handle.as_ref(),
                &controller.turn_id,
                sid.as_deref(),
                "status",
                json!({
                    "state": "completing",
                    "message": reason,
                    "progressLabel": "Completing turn..."
                }),
            );

            let c_clone = Arc::clone(&controller);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(250));
                write_pty_bytes(&c_clone.pty_writer, b"\x04");
                thread::sleep(Duration::from_millis(150));
                write_pty_bytes(&c_clone.pty_writer, b"\x04");
                thread::sleep(Duration::from_millis(2000));
                c_clone.kill_process();
            });
        })
    };

    // Spawn PTY reader thread
    let reader_handle = {
        let controller = Arc::clone(&controller);
        let app_state = Arc::clone(&app_state);
        let app_handle = app_handle.clone();
        let sync_transcript = Arc::clone(&sync_transcript);
        let trigger_graceful_exit = Arc::clone(&trigger_graceful_exit);
        let has_started_generating = Arc::clone(&has_started_generating);
        let pending_enter_active = Arc::clone(&pending_enter_active);
        let transcript_final_done = Arc::clone(&transcript_final_done);
        let approval_key = approval_key.clone();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut last_approve = Instant::now() - Duration::from_secs(10);

            loop {
                match pty_reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let raw = String::from_utf8_lossy(&buf[..n]);
                        handle_terminal_queries(&controller.pty_writer, &raw);

                        let clean = strip_ansi(&raw);
                        let (
                            rolling_snapshot,
                            is_exiting,
                            has_pending_q,
                            active_sid,
                        ) = {
                            let mut st = match controller.state.lock() {
                                Ok(s) => s,
                                Err(_) => break,
                            };
                            st.rolling_clean.push_str(&clean);
                            if st.rolling_clean.len() > 4000 {
                                let drain_to = st.rolling_clean.len() - 4000;
                                let valid_idx = st
                                    .rolling_clean
                                    .char_indices()
                                    .map(|(i, _)| i)
                                    .find(|&i| i >= drain_to)
                                    .unwrap_or(0);
                                st.rolling_clean.drain(..valid_idx);
                            }
                            (
                                st.rolling_clean.clone(),
                                st.is_exiting,
                                st.pending_ask_question.is_some(),
                                st.session_id.clone(),
                            )
                        };

                        // 1. Detect turn generation start
                        let started = has_started_generating.lock().map(|g| *g).unwrap_or(false);
                        if !started
                            && (rolling_snapshot.contains("esc to cancel")
                                || rolling_snapshot.contains("Generating"))
                        {
                            if let Ok(mut g) = has_started_generating.lock() {
                                *g = true;
                            }
                            if let Ok(mut st) = controller.state.lock() {
                                st.current_state = "generating".to_string();
                                st.current_status_message =
                                    "AGY is thinking & executing...".to_string();
                            }
                            emit_turn_event(
                                app_handle.as_ref(),
                                &controller.turn_id,
                                active_sid.as_deref(),
                                "status",
                                json!({
                                    "state": "generating",
                                    "message": "AGY is thinking & executing...",
                                    "progressLabel": "AGY is thinking & executing..."
                                }),
                            );
                        }

                        // 2. Detect TUI permission prompt and simulate Enter (\r)
                        let enter_busy = pending_enter_active.lock().map(|g| *g).unwrap_or(false);
                        if !is_exiting
                            && !has_pending_q
                            && !enter_busy
                            && last_approve.elapsed() > Duration::from_millis(1000)
                        {
                            if let Some(check) = detect_permission_prompt(&rolling_snapshot) {
                                last_approve = Instant::now();
                                if let Ok(mut st) = controller.state.lock() {
                                    st.rolling_clean.clear();
                                }

                                let _ = sync_transcript(true);

                                let is_workspace_trust = {
                                    let hay = format!("{} {}", check.title, check.snippet)
                                        .to_lowercase();
                                    hay.contains("workspace trust")
                                        || hay.contains("trust this folder")
                                };

                                let (prompt_record, sid_after) = {
                                    let mut st = controller
                                        .state
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner());
                                    let latest_step_idx = st
                                        .latest_step_index
                                        .unwrap_or(baseline_step_count);
                                    let min_tool_step_index = match st.latest_step_index {
                                        None => baseline_step_count,
                                        Some(idx) if st.latest_step_type == "PLANNER_RESPONSE" => {
                                            idx
                                        }
                                        Some(idx) => idx + 1,
                                    };
                                    let matched_tool = if is_workspace_trust {
                                        None
                                    } else {
                                        find_matching_tool_item(
                                            &st.items,
                                            &st.bound_tool_item_ids,
                                            &check.target,
                                            &check.snippet,
                                            baseline_step_count,
                                            min_tool_step_index,
                                        )
                                    };
                                    if let Some((ref m_id, _)) = matched_tool {
                                        st.bound_tool_item_ids.insert(m_id.clone());
                                    }

                                    let perm_ms = SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis();
                                    let perm_id =
                                        format!("perm-{}-{}", perm_ms, st.permissions.len());
                                    let rec = PermissionRecord {
                                        id: perm_id,
                                        session_id: st.session_id.clone(),
                                        after_item_id: matched_tool.as_ref().map(|m| m.0.clone()),
                                        after_step_index: Some(
                                            matched_tool
                                                .as_ref()
                                                .map(|m| m.1)
                                                .unwrap_or(latest_step_idx),
                                        ),
                                        min_tool_step_index,
                                        turn_start_step_index: baseline_step_count,
                                        is_workspace_trust,
                                        title: check.title.clone(),
                                        target: check.target.clone(),
                                        reason: check.reason.clone(),
                                        question: check.question.clone(),
                                        options: check.options.clone(),
                                        snippet: check.snippet.clone(),
                                        status: "pending".to_string(),
                                        detected_at: now_iso_string(),
                                        approved_at: None,
                                        key_sent: approval_key.clone(),
                                    };
                                    st.permissions.push(rec.clone());
                                    st.current_state = "permission_prompt".to_string();
                                    st.current_status_message =
                                        format!("Auto-approving: {}...", check.title);
                                    (rec, st.session_id.clone())
                                };

                                if let Some(ref sid) = sid_after {
                                    app_state.attach_permissions_to_session(
                                        sid,
                                        std::slice::from_ref(&prompt_record),
                                    );
                                }

                                emit_turn_event(
                                    app_handle.as_ref(),
                                    &controller.turn_id,
                                    sid_after.as_deref(),
                                    "permission_prompt",
                                    serde_json::to_value(&prompt_record).unwrap_or(Value::Null),
                                );
                                emit_turn_event(
                                    app_handle.as_ref(),
                                    &controller.turn_id,
                                    sid_after.as_deref(),
                                    "status",
                                    json!({
                                        "state": "permission_prompt",
                                        "message": format!("Auto-approving: {}...", check.title),
                                        "progressLabel": "↵ Auto-approving permission..."
                                    }),
                                );

                                if let Ok(mut b) = pending_enter_active.lock() {
                                    *b = true;
                                }

                                let c_for_enter = Arc::clone(&controller);
                                let app_state_for_enter = Arc::clone(&app_state);
                                let app_handle_for_enter = app_handle.clone();
                                let sync_for_enter = Arc::clone(&sync_transcript);
                                let exit_for_enter = Arc::clone(&trigger_graceful_exit);
                                let enter_flag = Arc::clone(&pending_enter_active);
                                let key_to_send = approval_key.clone();
                                let perm_id = prompt_record.id.clone();

                                thread::spawn(move || {
                                    thread::sleep(Duration::from_millis(350));
                                    write_pty_bytes(&c_for_enter.pty_writer, key_to_send.as_bytes());
                                    let approved_at = now_iso_string();
                                    let mut updated_perm: Option<PermissionRecord> = None;
                                    let mut sid_opt: Option<String> = None;

                                    if let Ok(mut st) = c_for_enter.state.lock() {
                                        sid_opt = st.session_id.clone();
                                        if let Some(p) =
                                            st.permissions.iter_mut().find(|p| p.id == perm_id)
                                        {
                                            p.status = "approved".to_string();
                                            p.approved_at = Some(approved_at);
                                            updated_perm = Some(p.clone());
                                        }
                                        st.current_state = "generating".to_string();
                                        st.current_status_message =
                                            "Simulated Enter (\\r) sent · Resuming execution..."
                                                .to_string();
                                    }

                                    if let Ok(mut b) = enter_flag.lock() {
                                        *b = false;
                                    }

                                    if let (Some(ref sid), Some(ref up)) = (&sid_opt, &updated_perm)
                                    {
                                        app_state_for_enter.attach_permissions_to_session(
                                            sid,
                                            std::slice::from_ref(up),
                                        );
                                    }

                                    if let Some(up) = updated_perm {
                                        emit_turn_event(
                                            app_handle_for_enter.as_ref(),
                                            &c_for_enter.turn_id,
                                            sid_opt.as_deref(),
                                            "enter_simulated",
                                            serde_json::to_value(up).unwrap_or(Value::Null),
                                        );
                                    }
                                    emit_turn_event(
                                        app_handle_for_enter.as_ref(),
                                        &c_for_enter.turn_id,
                                        sid_opt.as_deref(),
                                        "status",
                                        json!({
                                            "state": "generating",
                                            "message": "Simulated Enter (\\r) sent · Resuming execution...",
                                            "progressLabel": "Resuming execution..."
                                        }),
                                    );

                                    if let Some(reason) = sync_for_enter(true) {
                                        exit_for_enter(reason);
                                    }
                                });
                            }
                        }

                        // 3. Detect turn completion when TUI returns to `? for shortcuts`
                        let started_now =
                            has_started_generating.lock().map(|g| *g).unwrap_or(false);
                        let enter_now = pending_enter_active.lock().map(|g| *g).unwrap_or(false);
                        let done_now = transcript_final_done.lock().map(|g| *g).unwrap_or(false);

                        if started_now
                            && !is_exiting
                            && !enter_now
                            && !has_pending_q
                            && (clean.contains("? for shortcuts") || done_now)
                        {
                            if let Some(reason) = sync_transcript(true) {
                                trigger_graceful_exit(reason);
                            } else if transcript_final_done.lock().map(|g| *g).unwrap_or(false) {
                                trigger_graceful_exit(
                                    "Turn idle (\"? for shortcuts\" detected); exiting PTY via Ctrl+D x2"
                                        .to_string(),
                                );
                            }
                        }

                        // 4. Backup conversation ID capture from exit banner
                        if active_sid.is_none() {
                            if let Some(cap) = resume_banner_regex().captures(&rolling_snapshot) {
                                if let Some(m) = cap.get(1) {
                                    let sid = m.as_str().to_string();
                                    if let Ok(mut st) = controller.state.lock() {
                                        st.session_id = Some(sid.clone());
                                    }
                                    if let Ok(mut by_sess) = app_state.active_turns.lock() {
                                        by_sess.insert(sid.clone(), Arc::clone(&controller));
                                    }
                                    emit_turn_event(
                                        app_handle.as_ref(),
                                        &controller.turn_id,
                                        Some(&sid),
                                        "session",
                                        json!({ "sessionId": sid, "source": "exit-banner" }),
                                    );
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        })
    };

    // Main poll loop on this turn's blocking worker thread (150ms interval, 300s safety timeout)
    let start_instant = Instant::now();
    let timeout = Duration::from_secs(300);
    let mut exit_code = 0i32;

    loop {
        if let Ok(Some(status)) = child.try_wait() {
            exit_code = status.code().unwrap_or(0);
            break;
        }

        if start_instant.elapsed() >= timeout {
            trigger_graceful_exit("Turn timeout reached; sending Ctrl+D x2".to_string());
            break;
        }

        if let Some(reason) = sync_transcript(false) {
            trigger_graceful_exit(reason);
        }

        thread::sleep(Duration::from_millis(150));
    }

    controller.kill_process();
    let _ = child.kill();
    if let Ok(status) = child.wait() {
        exit_code = status.code().unwrap_or(exit_code);
    }

    // Run final transcript sync before capturing final_sid and permissions
    let _ = sync_transcript(true);
    let _ = fs::remove_file(&tmp_log_file);

    // Mark controller exiting and remove from active registries
    let (final_sid, turn_perms) = {
        let mut st = controller
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        st.is_exiting = true;
        st.current_state = "idle".to_string();
        (st.session_id.clone(), st.permissions.clone())
    };

    if let Ok(mut by_turn) = app_state.active_turns_by_turn_id.lock() {
        by_turn.remove(&turn_id);
    }
    if let Some(ref sid) = final_sid {
        app_state.attach_permissions_to_session(sid, &turn_perms);
        if let Ok(mut by_sess) = app_state.active_turns.lock() {
            if by_sess
                .get(sid)
                .map(|c| c.turn_id == turn_id)
                .unwrap_or(false)
            {
                by_sess.remove(sid);
            }
        }
    }

    let _ = reader_handle;

    let auto_approvals: Vec<PermissionRecord> = turn_perms
        .iter()
        .filter(|p| p.status == "approved")
        .cloned()
        .collect();

    let (final_items, final_permissions) = if let Some(ref sid) = final_sid {
        let conv = read_conversation(sid, &app_state);
        (conv.items, conv.permissions)
    } else {
        (Vec::new(), turn_perms)
    };

    let result = TurnExitResult {
        turn_id: turn_id.clone(),
        session_id: final_sid.clone(),
        exit_code,
        signal: None,
        auto_approvals_count: auto_approvals.len(),
        auto_approvals,
        items: final_items,
        permissions: final_permissions,
    };

    emit_turn_event(
        app_handle.as_ref(),
        &turn_id,
        final_sid.as_deref(),
        "exit",
        serde_json::to_value(&result).unwrap_or(Value::Null),
    );

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi_and_detect_permission_prompt() {
        let raw = "\x1b[38;5;244m────────────────────────\x1b[0m\r\n\
                   Terminal command\r\n\
                   Command: echo \"hello from pty\"\r\n\
                   Reason: Run echo command\r\n\
                   Do you want to proceed?\r\n\
                   > 1. Yes, allow access\r\n\
                     2. Yes, and always allow\r\n\
                     3. No, deny access\r\n\
                   esc to cancel · ↑↓ to navigate\r\n";
        let clean = strip_ansi(raw);
        let detected = detect_permission_prompt(&clean).expect("should detect permission prompt");
        assert_eq!(detected.title, "Terminal command");
        assert_eq!(detected.target, "Command: echo \"hello from pty\"");
        assert_eq!(detected.question, "Do you want to proceed?");
        assert_eq!(detected.options.len(), 3);
    }

    #[test]
    fn test_open_native_pty_roundtrip() {
        let mut master_fd: i32 = -1;
        let mut slave_fd: i32 = -1;
        let winsize = WinSize {
            ws_row: 40,
            ws_col: 120,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let rc = unsafe {
            openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null(),
                &winsize,
            )
        };
        assert_eq!(rc, 0, "openpty should succeed");

        let slave_in = unsafe { fs::File::from_raw_fd(slave_fd) };
        let slave_out = unsafe { fs::File::from_raw_fd(dup(slave_fd)) };
        let slave_err = unsafe { fs::File::from_raw_fd(dup(slave_fd)) };
        let mut reader = unsafe { fs::File::from_raw_fd(master_fd) };

        let mut cmd = Command::new("/bin/echo");
        cmd.arg("pty-roundtrip-ok")
            .stdin(Stdio::from(slave_in))
            .stdout(Stdio::from(slave_out))
            .stderr(Stdio::from(slave_err));
        let mut child = cmd.spawn().expect("spawn echo on pty");
        drop(cmd);

        let mut output = String::new();
        let mut buf = [0u8; 256];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => output.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
        }
        let _ = child.wait();
        assert!(output.contains("pty-roundtrip-ok"));
    }
}

