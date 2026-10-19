use crate::models::{AskQuestionDef, TurnState, UiItem};
use regex::Regex;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct ParsedSystemMessage {
    pub timestamp: Option<String>,
    pub sender: String,
    pub priority: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ParsedTranscript {
    pub raw_steps: Vec<Value>,
    pub items: Vec<UiItem>,
    pub turn_state: TurnState,
    pub workspace_cwd: String,
}

fn task_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)Tool is running as a background task with task id:\s*([^\s\x22'<>]+)")
            .unwrap()
    })
}

fn finished_task_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)Task id [\x22']?([^\x22'\s]+)[\x22']?\s+(?:finished|completed|terminated|stopped|failed|exited)",
        )
        .unwrap()
    })
}

fn uuid_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b")
            .unwrap()
    })
}

fn sys_preamble_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)The following is a <SYSTEM_MESSAGE> not actually sent by the user\.[^\n]*\n*")
            .unwrap()
    })
}

fn sys_block_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<SYSTEM_MESSAGE>\s*(.*?)\s*</SYSTEM_MESSAGE>").unwrap())
}

fn sys_header_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)^\[Message\]\s+timestamp=(\S+)\s+sender=(\S+)\s+priority=(\S+)\s+content=(.*)$")
            .unwrap()
    })
}

fn user_request_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>").unwrap())
}

fn workspace_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)Active Workspaces:\s*\r?\n-\s*([^\r\n]+)").unwrap())
}

pub fn strip_system_messages(raw_content: &str) -> String {
    let without_preamble = sys_preamble_regex().replace_all(raw_content, "");
    let without_blocks = sys_block_regex().replace_all(&without_preamble, "");
    without_blocks.trim().to_string()
}

pub fn parse_system_messages(raw_content: &str) -> Vec<ParsedSystemMessage> {
    let mut results = Vec::new();
    for cap in sys_block_regex().captures_iter(raw_content) {
        let inner = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if let Some(hcap) = sys_header_regex().captures(inner) {
            results.push(ParsedSystemMessage {
                timestamp: hcap.get(1).map(|m| m.as_str().to_string()),
                sender: hcap.get(2).map(|m| m.as_str().to_string()).unwrap_or_default(),
                priority: hcap.get(3).map(|m| m.as_str().to_string()).unwrap_or_default(),
                content: hcap
                    .get(4)
                    .map(|m| m.as_str().trim().to_string())
                    .unwrap_or_default(),
            });
        } else {
            results.push(ParsedSystemMessage {
                timestamp: None,
                sender: "system".to_string(),
                priority: "NORMAL".to_string(),
                content: inner.to_string(),
            });
        }
    }
    results
}

pub fn extract_user_request(raw_content: &str) -> String {
    if let Some(cap) = user_request_regex().captures(raw_content) {
        if let Some(inner) = cap.get(1) {
            return strip_system_messages(inner.as_str());
        }
    }
    strip_system_messages(raw_content)
}

pub fn parse_ask_question_output(raw_output: &str) -> BTreeMap<usize, String> {
    let mut answers = BTreeMap::new();
    for line in raw_output.lines() {
        let trimmed = line.trim_end();
        if let Some(rest) = trimmed.strip_prefix('A') {
            if let Some((num_str, val)) = rest.split_once(':') {
                if let Ok(q_num) = num_str.trim().parse::<usize>() {
                    if q_num >= 1 {
                        answers.insert(q_num - 1, val.trim().to_string());
                    }
                }
            }
        }
    }
    answers
}

pub fn extract_background_task_id(raw_output: &str) -> Option<String> {
    task_id_regex()
        .captures(raw_output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
}

fn normalize_task_short_id(task_id: &str) -> String {
    task_id
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn task_ids_match(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let short_a = normalize_task_short_id(a);
    let short_b = normalize_task_short_id(b);
    !short_a.is_empty() && short_a == short_b
}

fn is_subagent_complete_on_disk(subagent_id: &str, brain_dirs: &[PathBuf]) -> bool {
    if subagent_id.is_empty() {
        return false;
    }
    for brain_dir in brain_dirs {
        let logs_dir = brain_dir
            .join(subagent_id)
            .join(".system_generated")
            .join("logs");
        let full_path = logs_dir.join("transcript_full.jsonl");
        let compact_path = logs_dir.join("transcript.jsonl");
        let t_path = if full_path.exists() {
            full_path
        } else if compact_path.exists() {
            compact_path
        } else {
            continue;
        };

        if let Ok(content) = fs::read_to_string(&t_path) {
            if let Some(last_line) = content.lines().rev().find(|l| !l.trim().is_empty()) {
                if let Ok(step) = serde_json::from_str::<Value>(last_line) {
                    let is_planner = step.get("type").and_then(|v| v.as_str())
                        == Some("PLANNER_RESPONSE");
                    let is_done =
                        step.get("status").and_then(|v| v.as_str()) == Some("DONE");
                    let has_tools = step
                        .get("tool_calls")
                        .and_then(|v| v.as_array())
                        .map(|arr| !arr.is_empty())
                        .unwrap_or(false);
                    if is_planner && is_done && !has_tools {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[derive(Debug, Clone)]
struct PendingBgTask {
    tool_idx: usize,
    step_index: usize,
}

#[derive(Debug, Clone)]
struct PendingSubagent {
    tool_idx: usize,
    step_index: usize,
}

#[derive(Debug, Clone)]
struct PendingTimer {
    condition: String,
    prompt: String,
    tool_idx: usize,
    step_index: usize,
}

fn resolve_bg_task(
    task_id: &str,
    wakeup_content: Option<&str>,
    items: &mut [UiItem],
    pending_bg_tasks: &mut HashMap<String, PendingBgTask>,
    bg_tool_by_task_id: &HashMap<String, usize>,
) {
    if task_id.is_empty() {
        return;
    }
    let matched_key = pending_bg_tasks
        .keys()
        .find(|k| task_ids_match(k, task_id))
        .cloned();
    if let Some(ref k) = matched_key {
        pending_bg_tasks.remove(k);
    }

    let short_id = normalize_task_short_id(task_id);
    let tool_idx = bg_tool_by_task_id
        .get(task_id)
        .or_else(|| bg_tool_by_task_id.get(&short_id))
        .copied();

    if let Some(idx) = tool_idx {
        if let Some(item) = items.get_mut(idx) {
            if let Some(wc) = wakeup_content {
                let existing = item.output.as_deref().unwrap_or("").trim();
                item.output = Some(if existing.is_empty() {
                    wc.to_string()
                } else {
                    format!("{}\n\n--- Background Task Completed ---\n{}", existing, wc)
                });
            }
            item.status = Some("done".to_string());
        }
    }
}

fn clear_timers_on_message(
    sender: &str,
    items: &mut [UiItem],
    pending_timers: &mut HashMap<String, PendingTimer>,
) {
    let keys_to_remove: Vec<String> = pending_timers
        .iter()
        .filter(|(_, timer)| {
            timer.condition == "any"
                || (!sender.is_empty()
                    && (timer.condition == sender || task_ids_match(&timer.condition, sender)))
        })
        .map(|(k, _)| k.clone())
        .collect();

    for k in keys_to_remove {
        if let Some(timer) = pending_timers.remove(&k) {
            if let Some(item) = items.get_mut(timer.tool_idx) {
                if item.status.as_deref() == Some("running") {
                    item.status = Some("done".to_string());
                }
            }
        }
    }
}

fn process_system_wakeup_messages(
    sys_messages: &[ParsedSystemMessage],
    items: &mut [UiItem],
    pending_bg_tasks: &mut HashMap<String, PendingBgTask>,
    pending_subagents: &mut Vec<(String, PendingSubagent)>,
    pending_timers: &mut HashMap<String, PendingTimer>,
    bg_tool_by_task_id: &HashMap<String, usize>,
) {
    for msg in sys_messages {
        let sender = msg.sender.as_str();
        let content = msg.content.as_str();

        if content
            .to_lowercase()
            .contains("all your subagents and background tasks have been stopped")
        {
            for bg in pending_bg_tasks.values() {
                if let Some(it) = items.get_mut(bg.tool_idx) {
                    it.status = Some("done".to_string());
                }
            }
            for (_, sub) in pending_subagents.iter() {
                if let Some(it) = items.get_mut(sub.tool_idx) {
                    it.status = Some("done".to_string());
                }
            }
            for timer in pending_timers.values() {
                if let Some(it) = items.get_mut(timer.tool_idx) {
                    it.status = Some("done".to_string());
                }
            }
            pending_bg_tasks.clear();
            pending_subagents.clear();
            pending_timers.clear();
            continue;
        }

        clear_timers_on_message(sender, items, pending_timers);

        let task_id_from_content = finished_task_regex()
            .captures(content)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        let short_sender = normalize_task_short_id(sender).to_lowercase();
        let is_task_sender = short_sender.starts_with("task-")
            && short_sender[5..].chars().all(|c| c.is_ascii_digit());

        if task_id_from_content.is_some() || is_task_sender {
            let target_task_id = task_id_from_content.as_deref().unwrap_or(sender);
            resolve_bg_task(
                target_task_id,
                Some(content),
                items,
                pending_bg_tasks,
                bg_tool_by_task_id,
            );

            let matching_timers: Vec<String> = pending_timers
                .keys()
                .filter(|k| task_ids_match(k, target_task_id))
                .cloned()
                .collect();
            for tk in matching_timers {
                if let Some(timer) = pending_timers.remove(&tk) {
                    if let Some(it) = items.get_mut(timer.tool_idx) {
                        let existing = it.output.as_deref().unwrap_or("").trim();
                        it.output = Some(if existing.is_empty() {
                            content.to_string()
                        } else {
                            format!("{}\n\n--- Timer Fired ---\n{}", existing, content)
                        });
                        it.status = Some("done".to_string());
                    }
                }
            }
            continue;
        }

        // Subagent wakeup
        if !sender.is_empty() && sender != "system" {
            let exact_pos = pending_subagents.iter().position(|(k, _)| k == sender);
            let placeholder_pos = if exact_pos.is_none() {
                pending_subagents
                    .iter()
                    .position(|(k, _)| k.starts_with("subagent-pending-"))
            } else {
                None
            };

            if let Some(pos) = exact_pos.or(placeholder_pos) {
                let (_, entry) = pending_subagents.remove(pos);
                let still_pending_for_tool = pending_subagents
                    .iter()
                    .any(|(_, s)| s.tool_idx == entry.tool_idx);
                if let Some(it) = items.get_mut(entry.tool_idx) {
                    let short_sender_id: String = sender.chars().take(8).collect();
                    let existing = it.output.as_deref().unwrap_or("").trim();
                    it.output = Some(if existing.is_empty() {
                        content.to_string()
                    } else {
                        format!(
                            "{}\n\n--- Subagent Response ({}) ---\n{}",
                            existing, short_sender_id, content
                        )
                    });
                    if !still_pending_for_tool {
                        it.status = Some("done".to_string());
                    }
                }
                continue;
            }
        }

        // Scheduled timer wakeup matching prompt or sender
        if !pending_timers.is_empty() {
            let mut matched_key = pending_timers
                .iter()
                .find(|(tk, timer)| {
                    (!timer.prompt.is_empty() && content.contains(&timer.prompt))
                        || task_ids_match(tk, sender)
                })
                .map(|(tk, _)| tk.clone());

            if matched_key.is_none() && sender == "system" {
                matched_key = pending_timers.keys().next().cloned();
            }

            if let Some(tk) = matched_key {
                if let Some(timer) = pending_timers.remove(&tk) {
                    if let Some(it) = items.get_mut(timer.tool_idx) {
                        let existing = it.output.as_deref().unwrap_or("").trim();
                        it.output = Some(if existing.is_empty() {
                            content.to_string()
                        } else {
                            format!("{}\n\n--- Timer Fired ---\n{}", existing, content)
                        });
                        it.status = Some("done".to_string());
                    }
                }
            }
        }
    }
}

pub fn parse_transcript_lines(
    raw_lines: &[&str],
    baseline_step_count: usize,
    brain_dirs: &[PathBuf],
) -> ParsedTranscript {
    let mut raw_steps: Vec<Value> = Vec::new();
    for line in raw_lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            raw_steps.push(val);
        }
    }

    let mut items: Vec<UiItem> = Vec::new();
    let mut pending_tool_indices: Vec<usize> = Vec::new();
    let mut workspace_cwd = String::new();

    let mut pending_bg_tasks: HashMap<String, PendingBgTask> = HashMap::new();
    let mut pending_subagents: Vec<(String, PendingSubagent)> = Vec::new();
    let mut pending_timers: HashMap<String, PendingTimer> = HashMap::new();
    let mut bg_tool_by_task_id: HashMap<String, usize> = HashMap::new();

    for (idx_in_vec, step) in raw_steps.iter().enumerate() {
        let step_index = step
            .get("step_index")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(idx_in_vec);
        let created_at = step
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let raw_content = step.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let step_type = step.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let step_source = step.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let step_status = step.get("status").and_then(|v| v.as_str()).unwrap_or("");

        let sys_messages = parse_system_messages(raw_content);

        if step_type == "USER_INPUT" {
            pending_tool_indices.clear();
            if !sys_messages.is_empty() {
                process_system_wakeup_messages(
                    &sys_messages,
                    &mut items,
                    &mut pending_bg_tasks,
                    &mut pending_subagents,
                    &mut pending_timers,
                    &bg_tool_by_task_id,
                );
            }
            let cleaned_user_text = extract_user_request(raw_content);
            if !cleaned_user_text.is_empty() {
                items.push(UiItem {
                    id: format!("step-{}-user", step_index),
                    step_index,
                    role: "user".to_string(),
                    content: Some(cleaned_user_text),
                    tool_name: None,
                    summary: None,
                    detail: None,
                    bypass_sandbox: None,
                    is_background: None,
                    background_task_id: None,
                    args: None,
                    output: None,
                    questions: None,
                    parsed_answers: None,
                    status: None,
                    created_at,
                });
            }
            continue;
        }

        if step_source == "SYSTEM" || step_type == "SYSTEM_MESSAGE" {
            if workspace_cwd.is_empty() && !raw_content.is_empty() {
                if let Some(cap) = workspace_regex().captures(raw_content) {
                    if let Some(ws) = cap.get(1) {
                        workspace_cwd = ws.as_str().trim().to_string();
                    }
                }
            }
            if !sys_messages.is_empty() {
                process_system_wakeup_messages(
                    &sys_messages,
                    &mut items,
                    &mut pending_bg_tasks,
                    &mut pending_subagents,
                    &mut pending_timers,
                    &bg_tool_by_task_id,
                );
            }
            continue;
        }

        if step_type == "PLANNER_RESPONSE" {
            if let Some(thinking) = step.get("thinking").and_then(|v| v.as_str()) {
                let trimmed = thinking.trim();
                if !trimmed.is_empty() {
                    items.push(UiItem {
                        id: format!("step-{}-thought", step_index),
                        step_index,
                        role: "thought".to_string(),
                        content: Some(trimmed.to_string()),
                        tool_name: None,
                        summary: None,
                        detail: None,
                        bypass_sandbox: None,
                        is_background: None,
                        background_task_id: None,
                        args: None,
                        output: None,
                        questions: None,
                        parsed_answers: None,
                        status: None,
                        created_at: created_at.clone(),
                    });
                }
            }

            if let Some(tool_calls) = step.get("tool_calls").and_then(|v| v.as_array()) {
                if !tool_calls.is_empty() {
                    pending_tool_indices.clear();
                    for (tc_idx, tc) in tool_calls.iter().enumerate() {
                        let tc_name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                        let args_val = match tc.get("args") {
                            Some(Value::String(s)) => {
                                serde_json::from_str::<Value>(s).unwrap_or(Value::Object(Default::default()))
                            }
                            Some(v) => v.clone(),
                            None => Value::Object(Default::default()),
                        };

                        if workspace_cwd.is_empty() {
                            if let Some(cwd) = args_val.get("Cwd").and_then(|v| v.as_str()) {
                                workspace_cwd = cwd.trim().to_string();
                            } else if let Some(abs) =
                                args_val.get("AbsolutePath").and_then(|v| v.as_str())
                            {
                                if let Some(parent) = Path::new(abs.trim()).parent() {
                                    workspace_cwd = parent.to_string_lossy().into_owned();
                                }
                            } else if let Some(target) =
                                args_val.get("TargetFile").and_then(|v| v.as_str())
                            {
                                if let Some(parent) = Path::new(target.trim()).parent() {
                                    workspace_cwd = parent.to_string_lossy().into_owned();
                                }
                            }
                        }

                        if tc_name == "ask_question" {
                            let summary = args_val
                                .get("toolAction")
                                .or_else(|| args_val.get("toolSummary"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("Question from Antigravity")
                                .to_string();
                            let questions: Vec<AskQuestionDef> = args_val
                                .get("questions")
                                .and_then(|q| serde_json::from_value(q.clone()).ok())
                                .unwrap_or_default();

                            let item_idx = items.len();
                            items.push(UiItem {
                                id: format!("step-{}-ask-{}", step_index, tc_idx),
                                step_index,
                                role: "ask_question".to_string(),
                                content: None,
                                tool_name: Some("ask_question".to_string()),
                                summary: Some(summary),
                                detail: None,
                                bypass_sandbox: None,
                                is_background: None,
                                background_task_id: None,
                                args: Some(args_val),
                                output: None,
                                questions: Some(questions),
                                parsed_answers: Some(BTreeMap::new()),
                                status: Some("waiting".to_string()),
                                created_at: created_at.clone(),
                            });
                            pending_tool_indices.push(item_idx);
                            continue;
                        }

                        let summary = args_val
                            .get("toolAction")
                            .or_else(|| args_val.get("toolSummary"))
                            .or_else(|| args_val.get("CommandLine"))
                            .or_else(|| args_val.get("AbsolutePath"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| args_val.to_string());

                        let detail = args_val
                            .get("CommandLine")
                            .or_else(|| args_val.get("AbsolutePath"))
                            .or_else(|| args_val.get("TargetFile"))
                            .or_else(|| args_val.get("Url"))
                            .or_else(|| args_val.get("query"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let bypass_sandbox = args_val
                            .get("BypassSandbox")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        let item_idx = items.len();
                        items.push(UiItem {
                            id: format!("step-{}-tool-{}", step_index, tc_idx),
                            step_index,
                            role: "tool_call".to_string(),
                            content: None,
                            tool_name: Some(tc_name.to_string()),
                            summary: Some(summary),
                            detail: Some(detail),
                            bypass_sandbox: Some(bypass_sandbox),
                            is_background: None,
                            background_task_id: None,
                            args: Some(args_val),
                            output: None,
                            questions: None,
                            parsed_answers: None,
                            status: Some("running".to_string()),
                            created_at: created_at.clone(),
                        });
                        pending_tool_indices.push(item_idx);
                    }
                }
            }

            if let Some(content_str) = step.get("content").and_then(|v| v.as_str()) {
                let trimmed = content_str.trim();
                if !trimmed.is_empty() {
                    items.push(UiItem {
                        id: format!("step-{}-assistant", step_index),
                        step_index,
                        role: "assistant".to_string(),
                        content: Some(trimmed.to_string()),
                        tool_name: None,
                        summary: None,
                        detail: None,
                        bypass_sandbox: None,
                        is_background: None,
                        background_task_id: None,
                        args: None,
                        output: None,
                        questions: None,
                        parsed_answers: None,
                        status: None,
                        created_at,
                    });
                }
            }
            continue;
        }

        if step_type == "GENERIC" {
            let target_idx = pending_tool_indices
                .iter()
                .copied()
                .find(|&idx| items.get(idx).map(|it| it.output.is_none()).unwrap_or(false));

            if let Some(t_idx) = target_idx {
                let (role, tool_name, args_val) = {
                    let item = &mut items[t_idx];
                    item.output = Some(raw_content.to_string());
                    (
                        item.role.clone(),
                        item.tool_name.clone().unwrap_or_default(),
                        item.args.clone().unwrap_or(Value::Null),
                    )
                };

                let is_daemon = args_val
                    .get("IsDaemon")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if role == "ask_question" {
                    items[t_idx].status = Some("done".to_string());
                    items[t_idx].parsed_answers = Some(parse_ask_question_output(raw_content));
                } else if tool_name == "run_command" && !is_daemon {
                    let bg_task_id = extract_background_task_id(raw_content);
                    if bg_task_id.is_some() || step_status == "RUNNING" {
                        let task_id =
                            bg_task_id.unwrap_or_else(|| format!("step-{}-bg", step_index));
                        pending_bg_tasks.insert(
                            task_id.clone(),
                            PendingBgTask {
                                tool_idx: t_idx,
                                step_index,
                            },
                        );
                        bg_tool_by_task_id.insert(task_id.clone(), t_idx);
                        let short = normalize_task_short_id(&task_id);
                        if !short.is_empty() {
                            bg_tool_by_task_id.insert(short, t_idx);
                        }
                        items[t_idx].is_background = Some(true);
                        items[t_idx].background_task_id = Some(task_id);
                        items[t_idx].status = Some("running".to_string());
                    } else {
                        items[t_idx].status = Some("done".to_string());
                    }
                } else if tool_name == "invoke_subagent" {
                    items[t_idx].status = Some("done".to_string());
                    let mut uuids = Vec::new();
                    let mut seen = HashSet::new();
                    for cap in uuid_regex().captures_iter(raw_content) {
                        if let Some(m) = cap.get(1) {
                            let u = m.as_str().to_lowercase();
                            if seen.insert(u.clone()) {
                                uuids.push(u);
                            }
                        }
                    }
                    if !uuids.is_empty() {
                        for uuid in uuids {
                            pending_subagents.push((
                                uuid,
                                PendingSubagent {
                                    tool_idx: t_idx,
                                    step_index,
                                },
                            ));
                        }
                        items[t_idx].status = Some("running".to_string());
                        items[t_idx].is_background = Some(true);
                    } else if step_status != "ERROR" {
                        let count = args_val
                            .get("Subagents")
                            .and_then(|v| v.as_array())
                            .map(|a| a.len().max(1))
                            .unwrap_or(1);
                        for s_idx in 0..count {
                            let key = format!("subagent-pending-{}-{}", step_index, s_idx);
                            pending_subagents.push((
                                key,
                                PendingSubagent {
                                    tool_idx: t_idx,
                                    step_index,
                                },
                            ));
                        }
                        items[t_idx].status = Some("running".to_string());
                        items[t_idx].is_background = Some(true);
                    }
                } else if tool_name == "send_message" {
                    items[t_idx].status = Some("done".to_string());
                    if let Some(recipient) = args_val.get("Recipient").and_then(|v| v.as_str()) {
                        if !recipient.is_empty() && step_status != "ERROR" {
                            pending_subagents.push((
                                recipient.to_string(),
                                PendingSubagent {
                                    tool_idx: t_idx,
                                    step_index,
                                },
                            ));
                            items[t_idx].status = Some("running".to_string());
                            items[t_idx].is_background = Some(true);
                        }
                    }
                } else if tool_name == "schedule" && !is_daemon {
                    let timer_task_id = extract_background_task_id(raw_content)
                        .unwrap_or_else(|| format!("timer-{}", step_index));
                    if step_status != "ERROR" {
                        let condition = args_val
                            .get("TimerCondition")
                            .and_then(|v| v.as_str())
                            .unwrap_or("never")
                            .to_string();
                        let prompt = args_val
                            .get("Prompt")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        pending_timers.insert(
                            timer_task_id,
                            PendingTimer {
                                condition,
                                prompt,
                                tool_idx: t_idx,
                                step_index,
                            },
                        );
                        items[t_idx].status = Some("running".to_string());
                        items[t_idx].is_background = Some(true);
                    } else {
                        items[t_idx].status = Some("done".to_string());
                    }
                } else if tool_name == "manage_task" {
                    items[t_idx].status = Some("done".to_string());
                    let action = args_val.get("Action").and_then(|v| v.as_str()).unwrap_or("");
                    let target_id = args_val.get("TaskId").and_then(|v| v.as_str()).unwrap_or("");
                    let lower_raw = raw_content.to_lowercase();
                    let is_terminated = action == "kill"
                        || lower_raw.contains("not running")
                        || lower_raw.contains("status: done")
                        || lower_raw.contains("completed")
                        || lower_raw.contains("terminated")
                        || lower_raw.contains("killed");
                    if !target_id.is_empty() && is_terminated {
                        resolve_bg_task(
                            target_id,
                            None,
                            &mut items,
                            &mut pending_bg_tasks,
                            &bg_tool_by_task_id,
                        );
                        let matching_timers: Vec<String> = pending_timers
                            .keys()
                            .filter(|k| task_ids_match(k, target_id))
                            .cloned()
                            .collect();
                        for tk in matching_timers {
                            if let Some(timer) = pending_timers.remove(&tk) {
                                if let Some(it) = items.get_mut(timer.tool_idx) {
                                    it.status = Some("done".to_string());
                                }
                            }
                        }
                    }
                } else if tool_name == "manage_subagents" {
                    items[t_idx].status = Some("done".to_string());
                    let action = args_val.get("Action").and_then(|v| v.as_str()).unwrap_or("");
                    if action == "kill_all" {
                        for (_, sub) in pending_subagents.iter() {
                            if let Some(it) = items.get_mut(sub.tool_idx) {
                                it.status = Some("done".to_string());
                            }
                        }
                        pending_subagents.clear();
                    } else if action == "kill" {
                        if let Some(cids) =
                            args_val.get("ConversationIds").and_then(|v| v.as_array())
                        {
                            for cid_val in cids {
                                if let Some(cid) = cid_val.as_str() {
                                    if let Some(pos) =
                                        pending_subagents.iter().position(|(k, _)| k == cid)
                                    {
                                        let (_, entry) = pending_subagents.remove(pos);
                                        if let Some(it) = items.get_mut(entry.tool_idx) {
                                            it.status = Some("done".to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    items[t_idx].status = Some("done".to_string());
                }
            } else {
                items.push(UiItem {
                    id: format!("step-{}-generic", step_index),
                    step_index,
                    role: "tool_call".to_string(),
                    content: None,
                    tool_name: Some("tool_result".to_string()),
                    summary: Some("Tool output".to_string()),
                    detail: Some(String::new()),
                    bypass_sandbox: None,
                    is_background: None,
                    background_task_id: None,
                    args: Some(Value::Object(Default::default())),
                    output: Some(raw_content.to_string()),
                    questions: None,
                    parsed_answers: None,
                    status: Some("done".to_string()),
                    created_at,
                });
            }

            if !sys_messages.is_empty() {
                process_system_wakeup_messages(
                    &sys_messages,
                    &mut items,
                    &mut pending_bg_tasks,
                    &mut pending_subagents,
                    &mut pending_timers,
                    &bg_tool_by_task_id,
                );
            }
        }
    }

    // Check on-disk subagent completion for any remaining pending subagents with UUIDs
    if !pending_subagents.is_empty() && !brain_dirs.is_empty() {
        let mut completed_sub_ids = Vec::new();
        for (sub_id, entry) in pending_subagents.iter() {
            if !sub_id.starts_with("subagent-pending-")
                && is_subagent_complete_on_disk(sub_id, brain_dirs)
            {
                completed_sub_ids.push((sub_id.clone(), entry.tool_idx));
            }
        }
        for (sub_id, tool_idx) in completed_sub_ids {
            pending_subagents.retain(|(k, _)| k != &sub_id);
            let still_pending = pending_subagents
                .iter()
                .any(|(_, s)| s.tool_idx == tool_idx);
            if !still_pending {
                if let Some(it) = items.get_mut(tool_idx) {
                    it.status = Some("done".to_string());
                }
            }
        }
    }

    let has_unpaired_tool_calls = pending_tool_indices
        .iter()
        .any(|&idx| items.get(idx).map(|it| it.output.is_none()).unwrap_or(false));

    let active_bg_count = pending_bg_tasks
        .values()
        .filter(|t| t.step_index >= baseline_step_count)
        .count();
    let active_sub_count = pending_subagents
        .iter()
        .filter(|(_, s)| s.step_index >= baseline_step_count)
        .count();
    let active_timer_count = pending_timers
        .values()
        .filter(|tm| tm.step_index >= baseline_step_count)
        .count();

    let has_pending_background_work =
        active_bg_count > 0 || active_sub_count > 0 || active_timer_count > 0;

    let is_latest_step_final_planner_response = raw_steps
        .last()
        .map(|step| {
            let s_idx = step
                .get("step_index")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .unwrap_or(raw_steps.len().saturating_sub(1));
            let is_planner =
                step.get("type").and_then(|v| v.as_str()) == Some("PLANNER_RESPONSE");
            let is_done = step.get("status").and_then(|v| v.as_str()) == Some("DONE");
            let has_tools = step
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            s_idx >= baseline_step_count && is_planner && is_done && !has_tools
        })
        .unwrap_or(false);

    let is_turn_complete = is_latest_step_final_planner_response
        && !has_unpaired_tool_calls
        && !has_pending_background_work;

    let mut bg_parts = Vec::new();
    if active_bg_count > 0 {
        bg_parts.push(format!(
            "{} background task{}",
            active_bg_count,
            if active_bg_count > 1 { "s" } else { "" }
        ));
    }
    if active_sub_count > 0 {
        bg_parts.push(format!(
            "{} subagent{}",
            active_sub_count,
            if active_sub_count > 1 { "s" } else { "" }
        ));
    }
    if active_timer_count > 0 {
        bg_parts.push(format!(
            "{} timer{}",
            active_timer_count,
            if active_timer_count > 1 { "s" } else { "" }
        ));
    }
    let pending_background_summary = if bg_parts.is_empty() {
        None
    } else {
        Some(format!("Waiting for {}...", bg_parts.join(", ")))
    };

    let mut latest_activity_label = String::new();
    for it in items.iter().rev() {
        if it.role == "ask_question" && it.status.as_deref() == Some("waiting") {
            latest_activity_label = format!(
                "Waiting for answer: {}",
                it.summary.as_deref().unwrap_or("AskQuestion")
            );
            break;
        }
        if it.role == "tool_call" {
            let tname = it.tool_name.as_deref().unwrap_or("tool");
            let label = it
                .summary
                .as_deref()
                .filter(|s| !s.is_empty())
                .or_else(|| it.detail.as_deref())
                .unwrap_or("");
            latest_activity_label = format!("{}: {}", tname, label).trim().to_string();
            break;
        }
        if it.role == "thought" {
            let first_line: String = it
                .content
                .as_deref()
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(50)
                .collect();
            latest_activity_label = format!("Thinking: {}", first_line);
            break;
        }
    }
    if let Some(ref bg_sum) = pending_background_summary {
        latest_activity_label = bg_sum.clone();
    }

    let turn_state = TurnState {
        has_unpaired_tool_calls,
        has_pending_background_work,
        pending_background_count: active_bg_count + active_sub_count + active_timer_count,
        pending_background_summary,
        is_latest_step_final_planner_response,
        is_turn_complete,
        latest_activity_label,
    };

    ParsedTranscript {
        raw_steps,
        items,
        turn_state,
        workspace_cwd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_background_task_and_wakeup_lifecycle() {
        let step0 = r#"{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>Run a background build</USER_REQUEST>"}"#;
        let step1 = r#"{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","thinking":"Starting build in background","tool_calls":[{"name":"run_command","args":{"CommandLine":"npm run build","Cwd":"/Users/jason/projects/agy-test","toolAction":"Running build"}}]}"#;
        let step2 = r#"{"step_index":2,"type":"GENERIC","status":"RUNNING","content":"Created At: 2026-10-16T12:00:00Z\nTool is running as a background task with task id: conv-123/task-1"}"#;
        let step3 = r#"{"step_index":3,"type":"PLANNER_RESPONSE","status":"DONE","content":"I started the build in the background.","tool_calls":[]}"#;

        let mid = parse_transcript_lines(&[step0, step1, step2, step3], 0, &[]);
        assert!(mid.turn_state.has_pending_background_work);
        assert!(!mid.turn_state.is_turn_complete);
        assert_eq!(mid.workspace_cwd, "/Users/jason/projects/agy-test");

        let step4 = r#"{"step_index":4,"type":"USER_INPUT","content":"The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-16T12:00:05Z sender=conv-123/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id \"conv-123/task-1\" finished with result:\n\nThe command exited with code 0.\nOutput:\nBUILD_SUCCESS\n</SYSTEM_MESSAGE>"}"#;
        let step5 = r#"{"step_index":5,"type":"PLANNER_RESPONSE","status":"DONE","content":"The background build succeeded.","tool_calls":[]}"#;

        let fin = parse_transcript_lines(&[step0, step1, step2, step3, step4, step5], 0, &[]);
        assert!(!fin.turn_state.has_pending_background_work);
        assert!(fin.turn_state.is_turn_complete);
        let user_msgs: Vec<_> = fin.items.iter().filter(|i| i.role == "user").collect();
        assert_eq!(user_msgs.len(), 1);
        let tool = fin.items.iter().find(|i| i.role == "tool_call").unwrap();
        assert_eq!(tool.status.as_deref(), Some("done"));
        assert!(tool.output.as_deref().unwrap().contains("BUILD_SUCCESS"));
    }

    #[test]
    fn test_subagent_and_timer_early_cancel() {
        let s0 = r#"{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>Spawn subagent</USER_REQUEST>"}"#;
        let s1 = r#"{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"invoke_subagent","args":{"Subagents":[{"TypeName":"research","Role":"Researcher","Prompt":"Audit"}]}},{"name":"schedule","args":{"DurationSeconds":300,"Prompt":"Check progress","TimerCondition":"any"}}]}"#;
        let s2 = r#"{"step_index":2,"type":"GENERIC","status":"DONE","content":"Spawned subagent with conversationID: 11111111-2222-3333-4444-555555555555"}"#;
        let s3 = r#"{"step_index":3,"type":"GENERIC","status":"DONE","content":"Tool is running as a background task with task id: conv-999/task-2"}"#;
        let s4 = r#"{"step_index":4,"type":"PLANNER_RESPONSE","status":"DONE","content":"Waiting...","tool_calls":[]}"#;

        let mid = parse_transcript_lines(&[s0, s1, s2, s3, s4], 0, &[]);
        assert!(mid.turn_state.has_pending_background_work);
        assert_eq!(mid.turn_state.pending_background_count, 2);
        assert!(!mid.turn_state.is_turn_complete);

        let s5 = r#"{"step_index":5,"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-16T12:01:00Z sender=11111111-2222-3333-4444-555555555555 priority=NORMAL content=Audit complete: 0 issues.\n</SYSTEM_MESSAGE>"}"#;
        let s6 = r#"{"step_index":6,"type":"PLANNER_RESPONSE","status":"DONE","content":"Done.","tool_calls":[]}"#;

        let fin = parse_transcript_lines(&[s0, s1, s2, s3, s4, s5, s6], 0, &[]);
        assert!(!fin.turn_state.has_pending_background_work);
        assert!(fin.turn_state.is_turn_complete);
    }
}
