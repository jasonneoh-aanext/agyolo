pub mod models;
pub mod prechecks;
pub mod pty_manager;
pub mod sessions;
pub mod turn_state;

use models::{
    AskAnswerInput, AskQuestionSubmission, ConversationResponse, PickDirectoryResponse,
    PrechecksReport, SessionsListResponse, TurnExitResult, WorkspacesResponse,
};
use pty_manager::{emit_turn_event, start_agy_turn_blocking, AppState, TurnController};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, RunEvent, State};

/// Ensure macOS GUI launches from Finder/Dock inherit the user's shell PATH
/// (`~/.local/bin`, `/opt/homebrew/bin`, `~/.cargo/bin`, etc.) so `agy`, `gh`, `gcloud`, and `node` resolve.
pub fn hydrate_macos_path() {
    let home = env::var("HOME").unwrap_or_else(|_| "/Users/jason".to_string());
    let current_path = env::var("PATH").unwrap_or_default();

    let login_shell_path = Command::new("/bin/zsh")
        .args(["-ilc", "printf \"%s\" \"$PATH\""])
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                String::from_utf8(out.stdout).ok()
            } else {
                None
            }
        })
        .unwrap_or_default();

    let extra_dirs = [
        format!("{}/.local/bin", home),
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{}/.cargo/bin", home),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];

    let mut seen = HashSet::new();
    let mut parts = Vec::new();

    for segment in extra_dirs
        .iter()
        .map(|s| s.as_str())
        .chain(login_shell_path.split(':'))
        .chain(current_path.split(':'))
    {
        let trimmed = segment.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
            parts.push(trimmed.to_string());
        }
    }

    if !parts.is_empty() {
        env::set_var("PATH", parts.join(":"));
    }
}

#[tauri::command]
async fn get_workspaces(state: State<'_, Arc<AppState>>) -> Result<WorkspacesResponse, String> {
    let app_state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || sessions::list_workspaces(&app_state))
        .await
        .map_err(|e| format!("Workspace discovery task failed: {}", e))
}

#[tauri::command]
async fn pick_directory(initial_path: Option<String>) -> Result<PickDirectoryResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sessions::pick_directory_dialog(initial_path.as_deref())
    })
    .await
    .map_err(|e| format!("Directory picker task failed: {}", e))?
}

#[tauri::command]
async fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<SessionsListResponse, String> {
    let app_state = Arc::clone(&state);
    let sessions = tauri::async_runtime::spawn_blocking(move || sessions::list_sessions(&app_state))
        .await
        .map_err(|e| format!("Session listing task failed: {}", e))?;
    Ok(SessionsListResponse { sessions })
}

#[tauri::command]
async fn get_session(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<ConversationResponse, String> {
    let app_state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut data = sessions::read_conversation(&session_id, &app_state);
        if data.transcript_path.is_none() && app_state.get_controller(&session_id).is_none() {
            data.error = Some(format!("Session \"{}\" not found", session_id));
        }
        data
    })
    .await
    .map_err(|e| format!("Failed to read session: {}", e))
}

#[tauri::command]
async fn attach_session_stream(
    session_id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let Some(controller) = state.get_controller(&session_id) else {
        return Ok(json!({
            "ok": false,
            "attached": false,
            "error": format!("No active turn running for session \"{}\"", session_id)
        }));
    };

    let meta = controller.get_snapshot_meta();
    emit_turn_event(
        Some(&app),
        &controller.turn_id,
        Some(&session_id),
        "status",
        serde_json::to_value(&meta).unwrap_or(Value::Null),
    );

    let (items, step_count, pending_q) = if let Ok(st) = controller.state.lock() {
        (
            st.items.clone(),
            st.step_count,
            st.pending_ask_question.clone(),
        )
    } else {
        (Vec::new(), 0, None)
    };

    if !items.is_empty() {
        emit_turn_event(
            Some(&app),
            &controller.turn_id,
            Some(&session_id),
            "transcript",
            json!({
                "sessionId": session_id,
                "items": items,
                "stepCount": step_count,
                "progressLabel": meta.progress_label
            }),
        );
    }

    if let Some(q) = pending_q {
        emit_turn_event(
            Some(&app),
            &controller.turn_id,
            Some(&session_id),
            "ask_question",
            serde_json::to_value(q).unwrap_or(Value::Null),
        );
    }

    Ok(json!({
        "ok": true,
        "attached": true,
        "turnId": controller.turn_id
    }))
}

#[tauri::command]
async fn submit_ask_question(
    session_id: Option<String>,
    turn_id: Option<String>,
    action: Option<String>,
    answers: Option<Vec<AskAnswerInput>>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let mut controller: Option<Arc<TurnController>> = None;

    if let Some(ref sid) = session_id {
        if !sid.is_empty() {
            controller = state.get_controller(sid);
        }
    }
    if controller.is_none() {
        if let Some(ref tid) = turn_id {
            if !tid.is_empty() {
                controller = state.get_controller(tid);
            }
        }
    }
    if controller.is_none() && session_id.is_none() && turn_id.is_none() {
        if let Ok(by_turn) = state.active_turns_by_turn_id.lock() {
            if by_turn.len() == 1 {
                controller = by_turn.values().next().cloned();
            }
        }
    }

    let has_pending_q = controller
        .as_ref()
        .and_then(|c| c.state.lock().ok().map(|st| st.pending_ask_question.is_some()))
        .unwrap_or(false);

    let Some(ctrl) = controller.filter(|_| has_pending_q) else {
        return Ok(json!({
            "ok": false,
            "canResumeAsPrompt": true,
            "error": "No active PTY turn for this session is currently waiting on ask_question"
        }));
    };

    let submission = AskQuestionSubmission {
        action: action.unwrap_or_else(|| "submit".to_string()),
        answers: answers.unwrap_or_default(),
    };

    tauri::async_runtime::spawn_blocking(move || ctrl.submit_ask_question(submission, Some(&app)))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn start_chat_turn(
    prompt: String,
    session_id: Option<String>,
    conversation_id: Option<String>,
    client_turn_id: Option<String>,
    cwd: Option<String>,
    approval_input: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<TurnExitResult, String> {
    if prompt.trim().is_empty() {
        return Err("`prompt` is required".to_string());
    }

    let target_session_id = session_id
        .or(conversation_id)
        .filter(|s| !s.trim().is_empty());

    if let Some(ref sid) = target_session_id {
        if let Ok(by_sess) = state.active_turns.lock() {
            if by_sess.contains_key(sid) {
                return Err(format!("Session \"{}\" already has a turn in progress.", sid));
            }
        }
    }

    if let Some(ref tid) = client_turn_id {
        if !tid.trim().is_empty() {
            if let Ok(by_turn) = state.active_turns_by_turn_id.lock() {
                if by_turn.contains_key(tid) {
                    return Err(format!("Turn \"{}\" is already in progress.", tid));
                }
            }
        }
    }

    let app_state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        start_agy_turn_blocking(
            app_state,
            Some(app),
            prompt,
            target_session_id,
            client_turn_id,
            cwd,
            approval_input,
        )
    })
    .await
    .map_err(|e| format!("PTY worker thread panicked: {}", e))?
}

#[tauri::command]
async fn run_prechecks(check: Option<String>) -> Result<PrechecksReport, String> {
    tauri::async_runtime::spawn_blocking(move || prechecks::run_prechecks(check.as_deref()))
        .await
        .map_err(|e| format!("Prechecks task failed: {}", e))?
}

pub fn run() {
    hydrate_macos_path();
    let shared_state = Arc::new(AppState::new());
    let cleanup_state = Arc::clone(&shared_state);

    let app = tauri::Builder::default()
        .manage(shared_state)
        .invoke_handler(tauri::generate_handler![
            get_workspaces,
            pick_directory,
            list_sessions,
            get_session,
            attach_session_stream,
            submit_ask_question,
            start_chat_turn,
            run_prechecks,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Antigravity Console Tauri application");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            cleanup_state.kill_all_active_turns();
        }
    });
}
