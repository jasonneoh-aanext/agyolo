use crate::models::{
    ConversationResponse, LiveSessionMeta, PickDirectoryResponse, SessionSummary,
    WorkspacesResponse,
};
use crate::pty_manager::AppState;
use crate::turn_state::parse_transcript_lines;
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_OPEN_READONLY: c_int = 0x00000001;
const SQLITE_OPEN_NOMUTEX: c_int = 0x00008000;

#[link(name = "sqlite3")]
extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        pp_db: *mut *mut c_void,
        flags: c_int,
        z_vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut c_void,
        z_sql: *const c_char,
        n_byte: c_int,
        pp_stmt: *mut *mut c_void,
        pz_tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(p_stmt: *mut c_void) -> c_int;
    fn sqlite3_column_text(p_stmt: *mut c_void, i_col: c_int) -> *const c_char;
    fn sqlite3_column_int64(p_stmt: *mut c_void, i_col: c_int) -> i64;
    fn sqlite3_finalize(p_stmt: *mut c_void) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
}

/// Format a `SystemTime` into an ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SS.sssZ`).
pub fn system_time_to_iso(time: SystemTime) -> String {
    let dur = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() as libc::time_t;
    let millis = dur.subsec_millis();
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::gmtime_r(&secs, &mut tm);
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        millis
    )
}

/// Return the current time as an ISO-8601 UTC string.
pub fn now_iso_string() -> String {
    system_time_to_iso(SystemTime::now())
}

/// Resolve the current user's home directory from `HOME`.
pub fn home_dir() -> PathBuf {
    env::var("HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
}

/// Primary and secondary Antigravity brain directories.
pub fn brain_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    vec![
        home.join(".gemini/antigravity-cli/brain"),
        home.join(".gemini/antigravity/brain"),
    ]
}

fn summaries_db_path() -> PathBuf {
    home_dir().join(".gemini/antigravity-cli/conversation_summaries.db")
}

/// Locate the transcript file (`transcript_full.jsonl` or `transcript.jsonl`) for a session UUID.
pub fn get_transcript_path(session_id: &str) -> Option<PathBuf> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains("..") {
        return None;
    }
    for brain_dir in brain_dirs() {
        let logs_dir = brain_dir
            .join(trimmed)
            .join(".system_generated")
            .join("logs");
        let full_path = logs_dir.join("transcript_full.jsonl");
        if full_path.exists() {
            return Some(full_path);
        }
        let compact_path = logs_dir.join("transcript.jsonl");
        if compact_path.exists() {
            return Some(compact_path);
        }
    }
    None
}

/// Read and parse a conversation's transcript and merge live PTY state if running.
pub fn read_conversation(session_id: &str, app_state: &AppState) -> ConversationResponse {
    let transcript_path = get_transcript_path(session_id);
    let live = app_state.get_live_session_meta(session_id);

    let Some(t_path) = transcript_path else {
        let (items, workspace) = if let Some(controller) = app_state.get_controller(session_id) {
            let items = controller
                .state
                .lock()
                .map(|st| st.items.clone())
                .unwrap_or_default();
            (items, controller.cwd.clone())
        } else {
            (Vec::new(), String::new())
        };

        return ConversationResponse {
            session_id: session_id.to_string(),
            transcript_path: None,
            workspace,
            raw_steps: Vec::new(),
            items,
            turn_state: None,
            permissions: app_state.get_session_permissions(session_id),
            error: None,
            live,
        };
    };

    let t_path_str = t_path.to_string_lossy().into_owned();
    let content = match fs::read_to_string(&t_path) {
        Ok(c) => c,
        Err(err) => {
            return ConversationResponse {
                session_id: session_id.to_string(),
                transcript_path: Some(t_path_str),
                workspace: String::new(),
                raw_steps: Vec::new(),
                items: Vec::new(),
                turn_state: None,
                permissions: app_state.get_session_permissions(session_id),
                error: Some(format!(
                    "Failed to read transcript for session \"{}\": {}",
                    session_id, err
                )),
                live,
            };
        }
    };

    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let b_dirs = brain_dirs();
    let mut parsed = parse_transcript_lines(&lines, 0, &b_dirs);

    if !live.is_running {
        for item in &mut parsed.items {
            if item.role == "tool_call" && item.status.as_deref() == Some("running") {
                item.status = Some("done".to_string());
            }
        }
    }

    ConversationResponse {
        session_id: session_id.to_string(),
        transcript_path: Some(t_path_str),
        workspace: parsed.workspace_cwd,
        raw_steps: parsed.raw_steps,
        items: parsed.items,
        turn_state: Some(parsed.turn_state),
        permissions: app_state.get_session_permissions(session_id),
        error: None,
        live,
    }
}

unsafe fn sqlite_col_string(stmt: *mut c_void, col: c_int) -> String {
    let ptr = sqlite3_column_text(stmt, col);
    if ptr.is_null() {
        String::new()
    } else {
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

fn read_summaries_from_sqlite(db_path: &Path) -> Vec<SessionSummary> {
    let mut results = Vec::new();
    if !db_path.exists() {
        return results;
    }
    let Ok(c_path) = CString::new(db_path.to_string_lossy().as_bytes()) else {
        return results;
    };
    let sql = "SELECT conversation_id, title, preview, step_count, created_time, last_modified_time, workspace_uris \
               FROM conversation_summaries \
               WHERE nesting_depth = 0 \
               ORDER BY last_modified_time DESC \
               LIMIT 50";
    let Ok(c_sql) = CString::new(sql) else {
        return results;
    };

    unsafe {
        let mut db: *mut c_void = ptr::null_mut();
        let rc = sqlite3_open_v2(
            c_path.as_ptr(),
            &mut db,
            SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX,
            ptr::null(),
        );
        if rc != SQLITE_OK || db.is_null() {
            if !db.is_null() {
                sqlite3_close(db);
            }
            return results;
        }

        let mut stmt: *mut c_void = ptr::null_mut();
        let prep_rc = sqlite3_prepare_v2(db, c_sql.as_ptr(), -1, &mut stmt, ptr::null_mut());
        if prep_rc == SQLITE_OK && !stmt.is_null() {
            while sqlite3_step(stmt) == SQLITE_ROW {
                let conv_id = sqlite_col_string(stmt, 0);
                if conv_id.is_empty() {
                    continue;
                }
                let raw_title = sqlite_col_string(stmt, 1);
                let preview = sqlite_col_string(stmt, 2);
                let step_count = sqlite3_column_int64(stmt, 3).max(0) as usize;
                let created_time = sqlite_col_string(stmt, 4);
                let last_modified = sqlite_col_string(stmt, 5);
                let workspace_uris_raw = sqlite_col_string(stmt, 6);

                let workspace = serde_json::from_str::<Vec<String>>(&workspace_uris_raw)
                    .ok()
                    .and_then(|uris| uris.into_iter().next())
                    .map(|u| u.strip_prefix("file://").unwrap_or(&u).to_string())
                    .unwrap_or_default();

                let short_id: String = conv_id.chars().take(8).collect();
                let title = if !raw_title.is_empty() {
                    raw_title
                } else if !preview.is_empty() {
                    preview.clone()
                } else {
                    short_id
                };
                let updated_at = if !last_modified.is_empty() {
                    last_modified
                } else {
                    created_time
                };

                results.push(SessionSummary {
                    id: conv_id,
                    title,
                    preview,
                    step_count,
                    updated_at,
                    workspace,
                    live: LiveSessionMeta::default(),
                });
            }
            sqlite3_finalize(stmt);
        }
        sqlite3_close(db);
    }

    results
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// List historical and active `agy` sessions enriched with live PTY metadata.
pub fn list_sessions(app_state: &AppState) -> Vec<SessionSummary> {
    let mut sessions_map: HashMap<String, SessionSummary> = HashMap::new();

    for row in read_summaries_from_sqlite(&summaries_db_path()) {
        sessions_map.insert(row.id.clone(), row);
    }

    let b_dirs = brain_dirs();
    for brain_dir in &b_dirs {
        let Ok(entries) = fs::read_dir(brain_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let Some(t_path) = get_transcript_path(&id) else {
                continue;
            };
            let Ok(meta) = fs::metadata(&t_path) else {
                continue;
            };
            let Ok(content) = fs::read_to_string(&t_path) else {
                continue;
            };
            let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
            let parsed = parse_transcript_lines(&lines, 0, &b_dirs);
            let first_user_content = parsed
                .items
                .iter()
                .find(|i| i.role == "user")
                .and_then(|i| i.content.as_deref())
                .unwrap_or("");

            let existing = sessions_map.get(&id);
            let short_id: String = id.chars().take(8).collect();

            let title = existing
                .filter(|e| !e.title.is_empty())
                .map(|e| e.title.clone())
                .unwrap_or_else(|| {
                    if !first_user_content.is_empty() {
                        truncate_chars(first_user_content, 60)
                    } else {
                        format!("Session {}", short_id)
                    }
                });

            let preview = existing
                .filter(|e| !e.preview.is_empty())
                .map(|e| e.preview.clone())
                .unwrap_or_else(|| first_user_content.to_string());

            let workspace = existing
                .filter(|e| !e.workspace.is_empty())
                .map(|e| e.workspace.clone())
                .unwrap_or(parsed.workspace_cwd);

            let updated_at = meta
                .modified()
                .map(system_time_to_iso)
                .unwrap_or_else(|_| now_iso_string());

            sessions_map.insert(
                id.clone(),
                SessionSummary {
                    id,
                    title,
                    preview,
                    step_count: lines.len(),
                    updated_at,
                    workspace,
                    live: LiveSessionMeta::default(),
                },
            );
        }
    }

    // Merge in-flight active turns (including brand-new turns that haven't flushed a transcript yet)
    if let Ok(by_turn) = app_state.active_turns_by_turn_id.lock() {
        for controller in by_turn.values() {
            let (sid_opt, step_count, updated_at) = match controller.state.lock() {
                Ok(st) => (
                    st.session_id.clone(),
                    st.step_count,
                    st.updated_at.clone(),
                ),
                Err(_) => continue,
            };
            let sid = sid_opt.unwrap_or_else(|| controller.turn_id.clone());
            if sid.is_empty() {
                continue;
            }
            let existing = sessions_map.get(&sid);
            let short_id: String = sid.chars().take(8).collect();

            let title = existing
                .filter(|e| !e.title.is_empty())
                .map(|e| e.title.clone())
                .unwrap_or_else(|| {
                    if !controller.initial_prompt.is_empty() {
                        truncate_chars(&controller.initial_prompt, 60)
                    } else {
                        format!("Session {}", short_id)
                    }
                });

            let preview = existing
                .filter(|e| !e.preview.is_empty())
                .map(|e| e.preview.clone())
                .unwrap_or_else(|| controller.initial_prompt.clone());

            let merged_steps = existing.map(|e| e.step_count).unwrap_or(0).max(step_count);
            let merged_updated = if !updated_at.is_empty() {
                updated_at
            } else {
                existing
                    .map(|e| e.updated_at.clone())
                    .unwrap_or_else(now_iso_string)
            };
            let workspace = existing
                .filter(|e| !e.workspace.is_empty())
                .map(|e| e.workspace.clone())
                .unwrap_or_else(|| controller.cwd.clone());

            sessions_map.insert(
                sid.clone(),
                SessionSummary {
                    id: sid,
                    title,
                    preview,
                    step_count: merged_steps,
                    updated_at: merged_updated,
                    workspace,
                    live: controller.get_snapshot_meta(),
                },
            );
        }
    }

    let mut result: Vec<SessionSummary> = sessions_map
        .into_values()
        .map(|mut s| {
            s.live = app_state.get_live_session_meta(&s.id);
            s
        })
        .collect();

    result.sort_by(|a, b| {
        if a.live.is_running != b.live.is_running {
            return if a.live.is_running {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        b.updated_at.cmp(&a.updated_at)
    });

    result
}

/// Resolve the default workspace directory and preset workspace list.
pub fn list_workspaces(app_state: &AppState) -> WorkspacesResponse {
    let home = home_dir();
    let projects_dir = home.join("Projects");
    let lower_projects_dir = home.join("projects");

    let default_workspace_path = env::current_dir()
        .ok()
        .and_then(|cwd| {
            // If launched inside `src-tauri`, step up to repo root
            if cwd.file_name().and_then(|n| n.to_str()) == Some("src-tauri") {
                cwd.parent().map(|p| p.to_path_buf())
            } else {
                Some(cwd)
            }
        })
        .filter(|cwd| {
            let s = cwd.to_string_lossy();
            cwd.exists() && s != "/" && !s.contains(".app/Contents")
        })
        .unwrap_or_else(|| {
            if lower_projects_dir.exists() {
                lower_projects_dir.clone()
            } else if projects_dir.exists() {
                projects_dir.clone()
            } else {
                home.clone()
            }
        });

    let default_workspace = default_workspace_path.to_string_lossy().into_owned();
    let mut presets: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut add_preset = |p: &Path| {
        if p.exists() {
            let s = p.to_string_lossy().into_owned();
            if seen.insert(s.clone()) {
                presets.push(s);
            }
        }
    };

    add_preset(&default_workspace_path);
    add_preset(&projects_dir);
    add_preset(&lower_projects_dir);
    add_preset(&home);

    for dir in [&projects_dir, &lower_projects_dir] {
        if let Ok(entries) = fs::read_dir(dir) {
            let mut subdirs: Vec<PathBuf> = entries
                .flatten()
                .filter_map(|e| {
                    let ft = e.file_type().ok()?;
                    let name = e.file_name().to_string_lossy().into_owned();
                    if ft.is_dir() && !name.starts_with('.') {
                        Some(e.path())
                    } else {
                        None
                    }
                })
                .collect();
            subdirs.sort();
            for sub in subdirs {
                add_preset(&sub);
            }
        }
    }

    for s in list_sessions(app_state) {
        if !s.workspace.is_empty() {
            add_preset(Path::new(&s.workspace));
        }
    }

    WorkspacesResponse {
        default_workspace,
        workspaces: presets,
    }
}

/// Normalize a POSIX directory path by stripping trailing slashes (except root `/`).
pub fn normalize_directory_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed == "/" {
        return "/".to_string();
    }
    let stripped = trimmed.trim_end_matches('/');
    if stripped.is_empty() {
        "/".to_string()
    } else {
        stripped.to_string()
    }
}

/// Resolve a valid existing directory to seed the native folder picker dialog.
pub fn resolve_initial_picker_directory(candidate: Option<&str>) -> String {
    if let Some(raw) = candidate {
        let normalized = normalize_directory_path(raw);
        if !normalized.is_empty() {
            let path = Path::new(&normalized);
            if path.is_dir() {
                return normalized;
            }
            if let Some(parent) = path.parent() {
                if parent.is_dir() {
                    return normalize_directory_path(&parent.to_string_lossy());
                }
            }
        }
    }

    let home = home_dir();
    if home.is_dir() {
        return normalize_directory_path(&home.to_string_lossy());
    }
    "/".to_string()
}

/// Open the native macOS folder picker dialog via `/usr/bin/osascript` and return the chosen POSIX path.
pub fn pick_directory_dialog(initial_path: Option<&str>) -> Result<PickDirectoryResponse, String> {
    if let Ok(mock_pick) = env::var("AGY_MOCK_PICK_DIR") {
        let trimmed = mock_pick.trim();
        if !trimmed.is_empty() {
            if trimmed == "__CANCEL__" {
                return Ok(PickDirectoryResponse {
                    cancelled: true,
                    path: None,
                });
            }
            if trimmed == "__ERROR__" {
                return Err("Mock directory picker error".to_string());
            }
            return Ok(PickDirectoryResponse {
                cancelled: false,
                path: Some(normalize_directory_path(trimmed)),
            });
        }
    }

    let start_dir = resolve_initial_picker_directory(initial_path);
    let script = concat!(
        "on run argv\n",
        "  set promptText to \"Select Workspace Folder\"\n",
        "  set hasStart to false\n",
        "  set startAlias to missing value\n",
        "  if (count of argv) > 0 then\n",
        "    try\n",
        "      set startAlias to POSIX file (item 1 of argv) as alias\n",
        "      set hasStart to true\n",
        "    end try\n",
        "  end if\n",
        "  if hasStart then\n",
        "    set chosenFolder to choose folder with prompt promptText default location startAlias\n",
        "  else\n",
        "    set chosenFolder to choose folder with prompt promptText\n",
        "  end if\n",
        "  return POSIX path of chosenFolder\n",
        "end run"
    );

    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .arg(&start_dir)
        .output()
        .map_err(|e| format!("Failed to launch macOS folder picker: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let selected = normalize_directory_path(&stdout);
        if selected.is_empty() {
            return Ok(PickDirectoryResponse {
                cancelled: true,
                path: None,
            });
        }
        return Ok(PickDirectoryResponse {
            cancelled: false,
            path: Some(selected),
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr_lower = stderr.to_lowercase();
    if stderr.contains("-128") || stderr_lower.contains("user canceled") {
        return Ok(PickDirectoryResponse {
            cancelled: true,
            path: None,
        });
    }

    let detail = stderr.trim();
    Err(if detail.is_empty() {
        "Native folder picker exited with an error".to_string()
    } else {
        detail.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn test_system_time_to_iso_epoch() {
        let epoch = UNIX_EPOCH + Duration::from_millis(1700000000123);
        let iso = system_time_to_iso(epoch);
        assert_eq!(iso, "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn test_list_workspaces_and_sessions() {
        let app_state = AppState::new();
        let ws = list_workspaces(&app_state);
        assert!(!ws.default_workspace.is_empty());
        assert!(!ws.workspaces.is_empty());

        let sessions = list_sessions(&app_state);
        // Should return a valid list (0 or more depending on local brain directory)
        for s in sessions.iter().take(3) {
            assert!(!s.id.is_empty());
            assert!(!s.title.is_empty());
        }
    }

    #[test]
    fn test_normalize_and_resolve_picker_directory() {
        assert_eq!(normalize_directory_path(" /Users/jason/projects/ "), "/Users/jason/projects");
        assert_eq!(normalize_directory_path("/"), "/");
        assert_eq!(normalize_directory_path("///"), "/");
        assert_eq!(normalize_directory_path("   "), "");

        let home = home_dir();
        let resolved_missing = resolve_initial_picker_directory(Some("/nonexistent_root_dir_xyz/sub"));
        assert_eq!(resolved_missing, normalize_directory_path(&home.to_string_lossy()));
    }

    #[test]
    fn test_pick_directory_dialog_mock_cases() {
        let prev = env::var("AGY_MOCK_PICK_DIR").ok();

        env::set_var("AGY_MOCK_PICK_DIR", "/Users/tester/workspace/demo-repo/");
        let selected = pick_directory_dialog(Some("/Users/tester")).expect("mock selection should succeed");
        assert!(!selected.cancelled);
        assert_eq!(selected.path.as_deref(), Some("/Users/tester/workspace/demo-repo"));

        env::set_var("AGY_MOCK_PICK_DIR", "__CANCEL__");
        let cancelled = pick_directory_dialog(None).expect("mock cancel should succeed");
        assert!(cancelled.cancelled);
        assert!(cancelled.path.is_none());

        env::set_var("AGY_MOCK_PICK_DIR", "__ERROR__");
        let err = pick_directory_dialog(None).expect_err("mock error should return Err");
        assert!(err.contains("Mock directory picker error"));

        match prev {
            Some(v) => env::set_var("AGY_MOCK_PICK_DIR", v),
            None => env::remove_var("AGY_MOCK_PICK_DIR"),
        }
    }

    #[test]
    fn test_frontend_static_assets_and_layout() {
        let public_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public");
        let index_html = fs::read_to_string(public_dir.join("index.html"))
            .expect("public/index.html should exist");
        let app_js = fs::read_to_string(public_dir.join("app.js"))
            .expect("public/app.js should exist");
        let precheck_js = fs::read_to_string(public_dir.join("precheckModal.js"))
            .expect("public/precheckModal.js should exist");

        // Precheck modal markup exists
        assert!(index_html.contains("id=\"precheckModal\""));

        // #newSessionBtn is inside #sidebar before #sidebarList, and not inside .topbar
        let topbar_start_idx = index_html.find("class=\"topbar\"").expect(".topbar should exist");
        let topbar_end_idx = index_html.find("</header>").expect("</header> should exist");
        let sidebar_idx = index_html.find("id=\"sidebar\"").expect("#sidebar should exist");
        let new_session_idx = index_html.find("id=\"newSessionBtn\"").expect("#newSessionBtn should exist");
        let sidebar_list_idx = index_html.find("id=\"sidebarList\"").expect("#sidebarList should exist");
        assert!(
            topbar_start_idx < topbar_end_idx && topbar_end_idx < sidebar_idx,
            ".topbar header must close before #sidebar"
        );
        assert!(
            sidebar_idx < new_session_idx && new_session_idx < sidebar_list_idx,
            "#newSessionBtn must be inside #sidebar above #sidebarList"
        );

        // #cwdInput and #browsePathBtn are inside .composer-wrap above .composer-box
        let composer_wrap_idx = index_html.find("class=\"composer-wrap\"").expect(".composer-wrap should exist");
        let cwd_input_idx = index_html.find("id=\"cwdInput\"").expect("#cwdInput should exist");
        let browse_btn_idx = index_html.find("id=\"browsePathBtn\"").expect("#browsePathBtn should exist");
        let composer_box_idx = index_html.find("class=\"composer-box\"").expect(".composer-box should exist");
        assert!(
            composer_wrap_idx < cwd_input_idx && cwd_input_idx < composer_box_idx,
            "#cwdInput must be inside .composer-wrap above .composer-box"
        );
        assert!(
            composer_wrap_idx < browse_btn_idx && browse_btn_idx < composer_box_idx,
            "#browsePathBtn must be inside .composer-wrap above .composer-box"
        );

        // Model and effort pill toggles are inside .composer-footer / .composer-actions beside #sendBtn
        let styles_css = fs::read_to_string(public_dir.join("styles.css"))
            .expect("public/styles.css should exist");
        let composer_footer_idx = index_html
            .find("class=\"composer-footer\"")
            .expect(".composer-footer should exist");
        let composer_actions_idx = index_html
            .find("class=\"composer-actions\"")
            .expect(".composer-actions should exist");
        let model_toggle_idx = index_html
            .find("id=\"modelToggleBtn\"")
            .expect("#modelToggleBtn should exist");
        let effort_toggle_idx = index_html
            .find("id=\"effortToggleBtn\"")
            .expect("#effortToggleBtn should exist");
        let send_btn_idx = index_html
            .find("id=\"sendBtn\"")
            .expect("#sendBtn should exist");
        assert!(
            composer_footer_idx < composer_actions_idx
                && composer_actions_idx < model_toggle_idx
                && model_toggle_idx < effort_toggle_idx
                && effort_toggle_idx < send_btn_idx,
            "#modelToggleBtn and #effortToggleBtn must be inside .composer-actions beside #sendBtn"
        );
        assert!(styles_css.contains(".composer-pill-toggle"));
        assert!(app_js.contains("cycleModelSelection"));
        assert!(app_js.contains("cycleEffortSelection"));

        // Frontend scripts use Tauri IPC exclusively with zero legacy /api/ HTTP fallbacks
        assert!(app_js.contains("__TAURI__"));
        assert!(!app_js.contains("/api/"));
        assert!(precheck_js.contains("run_prechecks"));
        assert!(!precheck_js.contains("/api/"));
    }
}
