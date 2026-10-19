use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AskQuestionDef {
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub is_multi_select: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiItem {
    pub id: String,
    pub step_index: usize,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bypass_sandbox: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_background: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<AskQuestionDef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed_answers: Option<BTreeMap<usize, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnState {
    pub has_unpaired_tool_calls: bool,
    pub has_pending_background_work: bool,
    pub pending_background_count: usize,
    pub pending_background_summary: Option<String>,
    pub is_latest_step_final_planner_response: bool,
    pub is_turn_complete: bool,
    pub latest_activity_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub after_item_id: Option<String>,
    pub after_step_index: Option<usize>,
    pub min_tool_step_index: usize,
    pub turn_start_step_index: usize,
    pub is_workspace_trust: bool,
    pub title: String,
    pub target: String,
    pub reason: String,
    pub question: String,
    pub options: Vec<String>,
    pub snippet: String,
    pub status: String,
    pub detected_at: String,
    pub approved_at: Option<String>,
    pub key_sent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionMeta {
    pub is_running: bool,
    pub turn_id: Option<String>,
    pub state: String,
    pub message: String,
    pub status_message: String,
    pub progress_label: String,
    pub has_pending_question: bool,
    pub pending_background_count: usize,
}

impl Default for LiveSessionMeta {
    fn default() -> Self {
        Self {
            is_running: false,
            turn_id: None,
            state: "idle".to_string(),
            message: "Idle".to_string(),
            status_message: "Idle".to_string(),
            progress_label: String::new(),
            has_pending_question: false,
            pending_background_count: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub step_count: usize,
    pub updated_at: String,
    pub workspace: String,
    #[serde(flatten)]
    pub live: LiveSessionMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResponse {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    pub workspace: String,
    pub raw_steps: Vec<serde_json::Value>,
    pub items: Vec<UiItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_state: Option<TurnState>,
    pub permissions: Vec<PermissionRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten)]
    pub live: LiveSessionMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesResponse {
    pub default_workspace: String,
    pub workspaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDirectoryResponse {
    pub cancelled: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsListResponse {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAskQuestion {
    pub session_id: Option<String>,
    pub step_index: usize,
    pub questions: Vec<AskQuestionDef>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswerInput {
    #[serde(default)]
    pub selected_indices: Vec<usize>,
    #[serde(default)]
    pub write_in: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestionSubmission {
    pub action: String,
    pub answers: Vec<AskAnswerInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnExitResult {
    pub turn_id: String,
    pub session_id: Option<String>,
    pub exit_code: i32,
    pub signal: Option<i32>,
    pub auto_approvals_count: usize,
    pub auto_approvals: Vec<PermissionRecord>,
    pub items: Vec<UiItem>,
    pub permissions: Vec<PermissionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEventEnvelope {
    pub event: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckResult {
    pub id: String,
    pub title: String,
    pub description: String,
    pub ok: bool,
    pub status: String,
    pub detail: String,
    pub remediation: Option<String>,
    pub meta: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrechecksReport {
    pub ok: bool,
    pub checked_at: String,
    pub pause_duration_ms: u64,
    pub checks: Vec<PrecheckResult>,
}
