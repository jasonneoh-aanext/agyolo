use crate::models::{PrecheckResult, PrechecksReport};
use crate::sessions::now_iso_string;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_PAUSE_DURATION_MS: u64 = 2000;

pub const CHECK_ID_AGY_CLI: &str = "agy_cli";
pub const CHECK_ID_AGY_AUTH: &str = "agy_auth";

struct PrecheckDefinition {
    id: &'static str,
    title: &'static str,
    description: &'static str,
}

const DEF_AGY_CLI: PrecheckDefinition = PrecheckDefinition {
    id: CHECK_ID_AGY_CLI,
    title: "AGY CLI Binary",
    description: "Verify Antigravity CLI (agy) is installed and executable",
};

const DEF_AGY_AUTH: PrecheckDefinition = PrecheckDefinition {
    id: CHECK_ID_AGY_AUTH,
    title: "AGY Authentication",
    description: "Verify Antigravity CLI has active authentication credentials",
};

fn create_check_result(
    def: &PrecheckDefinition,
    ok: bool,
    detail: String,
    remediation: Option<String>,
    meta: Value,
) -> PrecheckResult {
    PrecheckResult {
        id: def.id.to_string(),
        title: def.title.to_string(),
        description: def.description.to_string(),
        ok,
        status: if ok {
            "passed".to_string()
        } else {
            "failed".to_string()
        },
        detail,
        remediation: if ok { None } else { remediation },
        meta,
    }
}

/// Replace leading home directory path with `~` for concise display in UI.
pub fn shorten_home_path(target_path: &str, home_dir: &str) -> String {
    if target_path.is_empty() || home_dir.is_empty() {
        return target_path.to_string();
    }
    if target_path == home_dir {
        return "~".to_string();
    }
    let prefix = format!("{}/", home_dir.trim_end_matches('/'));
    if target_path.starts_with(&prefix) {
        return format!("~/{}", &target_path[prefix.len()..]);
    }
    target_path.to_string()
}

/// Check if a file exists and has executable permission bits.
pub fn is_executable_file(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

/// Resolve the `agy` binary path from configured `agy_bin` or `PATH`.
pub fn resolve_agy_binary_path(configured_agy_bin: &str, path_env: &str) -> Option<String> {
    if !configured_agy_bin.is_empty() && is_executable_file(Path::new(configured_agy_bin)) {
        return Some(configured_agy_bin.to_string());
    }

    for dir in path_env.split(':').filter(|s| !s.trim().is_empty()) {
        let candidate = Path::new(dir).join("agy");
        if is_executable_file(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

/// Precheck 1: Verify `agy` CLI binary exists, is executable, and responds to `--version`.
pub fn check_agy_cli_with_options(
    agy_bin_override: Option<&str>,
    home_dir: &str,
    path_env: &str,
) -> PrecheckResult {
    let configured_agy_bin = agy_bin_override
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| env::var("AGY_BIN").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| {
            Path::new(home_dir)
                .join(".local/bin/agy")
                .to_string_lossy()
                .to_string()
        });

    let Some(resolved_bin) = resolve_agy_binary_path(&configured_agy_bin, path_env) else {
        let exists_but_not_executable = fs::metadata(&configured_agy_bin)
            .map(|m| m.is_file() && (m.permissions().mode() & 0o111) == 0)
            .unwrap_or(false);

        let display_path = shorten_home_path(&configured_agy_bin, home_dir);
        let detail = if exists_but_not_executable {
            format!("AGY binary at {} is not executable", display_path)
        } else {
            format!("AGY binary not found at {} or in PATH", display_path)
        };
        let remediation = if exists_but_not_executable {
            format!("Run \"chmod +x {}\" in your terminal.", display_path)
        } else {
            "Install Antigravity CLI (https://antigravity.google/docs/install) or set the AGY_BIN environment variable.".to_string()
        };

        return create_check_result(
            &DEF_AGY_CLI,
            false,
            detail,
            Some(remediation),
            json!({
                "binaryPath": configured_agy_bin,
                "version": Value::Null
            }),
        );
    };

    let display_path = shorten_home_path(&resolved_bin, home_dir);
    match Command::new(&resolved_bin).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let raw_stdout = String::from_utf8_lossy(&output.stdout);
            let raw_stderr = String::from_utf8_lossy(&output.stderr);
            let combined = if !raw_stdout.trim().is_empty() {
                raw_stdout.trim()
            } else {
                raw_stderr.trim()
            };
            let first_line = combined.lines().next().unwrap_or("unknown").trim();
            let stripped_agy = first_line
                .strip_prefix("agy ")
                .or_else(|| first_line.strip_prefix("AGY "))
                .unwrap_or(first_line)
                .trim();
            let version = stripped_agy
                .strip_prefix('v')
                .or_else(|| stripped_agy.strip_prefix('V'))
                .unwrap_or(stripped_agy)
                .trim();
            let final_version = if version.is_empty() {
                first_line.to_string()
            } else {
                version.to_string()
            };

            create_check_result(
                &DEF_AGY_CLI,
                true,
                format!("Found agy v{} ({})", final_version, display_path),
                None,
                json!({
                    "binaryPath": resolved_bin,
                    "version": final_version
                }),
            )
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let first_err = stderr
                .lines()
                .next()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .unwrap_or_else(|| format!("exit status {}", output.status));
            create_check_result(
                &DEF_AGY_CLI,
                false,
                format!("Failed to execute {} --version: {}", display_path, first_err),
                Some(
                    "Verify your agy binary installation or reinstall Antigravity CLI.".to_string(),
                ),
                json!({
                    "binaryPath": resolved_bin,
                    "version": Value::Null
                }),
            )
        }
        Err(err) => create_check_result(
            &DEF_AGY_CLI,
            false,
            format!("Failed to execute {} --version: {}", display_path, err),
            Some("Verify your agy binary installation or reinstall Antigravity CLI.".to_string()),
            json!({
                "binaryPath": resolved_bin,
                "version": Value::Null
            }),
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenInspection {
    pub valid: bool,
    pub reason: Option<String>,
    pub project_id: Option<String>,
    pub user_tier: Option<String>,
}

/// Parse an ISO-8601 / RFC3339 date-time string into Unix epoch seconds.
fn parse_iso8601_epoch_secs(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    if s.as_bytes().get(4).copied()? != b'-' {
        return None;
    }
    let month: i32 = s.get(5..7)?.parse().ok()?;
    if s.as_bytes().get(7).copied()? != b'-' {
        return None;
    }
    let day: i32 = s.get(8..10)?.parse().ok()?;
    let sep = s.as_bytes().get(10).copied()?;
    if sep != b'T' && sep != b't' && sep != b' ' {
        return None;
    }
    let hour: i32 = s.get(11..13)?.parse().ok()?;
    if s.as_bytes().get(13).copied()? != b':' {
        return None;
    }
    let minute: i32 = s.get(14..16)?.parse().ok()?;
    if s.as_bytes().get(16).copied()? != b':' {
        return None;
    }
    let second: i32 = s.get(17..19)?.parse().ok()?;

    let rest = &s[19..];
    // Skip fractional seconds if present
    let tz_part = if let Some(after_dot) = rest.strip_prefix('.') {
        let digits_len = after_dot
            .bytes()
            .take_while(|b| b.is_ascii_digit())
            .count();
        &after_dot[digits_len..]
    } else {
        rest
    };

    let offset_secs: i64 = if tz_part.is_empty() || tz_part.eq_ignore_ascii_case("Z") {
        0
    } else if tz_part.starts_with('+') || tz_part.starts_with('-') {
        let sign: i64 = if tz_part.starts_with('-') { -1 } else { 1 };
        let tz_digits = &tz_part[1..];
        let (tz_h, tz_m) = if let Some((h, m)) = tz_digits.split_once(':') {
            (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?)
        } else if tz_digits.len() == 4 {
            (
                tz_digits[0..2].parse::<i64>().ok()?,
                tz_digits[2..4].parse::<i64>().ok()?,
            )
        } else {
            return None;
        };
        sign * (tz_h * 3600 + tz_m * 60)
    } else {
        return None;
    };

    // Convert civil date to days since 1970-01-01 (Howard Hinnant's algorithm)
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let m = month as u32;
    let d = day as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era as i64) * 146097 + (doe as i64) - 719468;

    let utc_secs =
        days * 86400 + (hour as i64) * 3600 + (minute as i64) * 60 + (second as i64) - offset_secs;
    Some(utc_secs)
}

/// Inspect a stored OAuth token JSON payload to determine if it contains valid credentials.
pub fn inspect_stored_token_payload(parsed: &Value) -> TokenInspection {
    let Some(record) = parsed.as_object() else {
        return TokenInspection {
            valid: false,
            reason: Some("Token file does not contain a JSON object".to_string()),
            project_id: None,
            user_tier: None,
        };
    };

    let token_source = record
        .get("token")
        .and_then(|v| v.as_object())
        .or_else(|| record.get("Token").and_then(|v| v.as_object()))
        .unwrap_or(record);

    let access_token = token_source
        .get("access_token")
        .or_else(|| token_source.get("AccessToken"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    let refresh_token = token_source
        .get("refresh_token")
        .or_else(|| token_source.get("RefreshToken"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    let id_token = record
        .get("id_token")
        .or_else(|| record.get("IDToken"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    if access_token.is_empty() && refresh_token.is_empty() && id_token.is_empty() {
        return TokenInspection {
            valid: false,
            reason: Some("Stored token file is empty or missing OAuth tokens".to_string()),
            project_id: None,
            user_tier: None,
        };
    }

    if refresh_token.is_empty() {
        if let Some(expiry_raw) = token_source
            .get("expiry")
            .or_else(|| token_source.get("Expiry"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if let Some(expiry_secs) = parse_iso8601_epoch_secs(expiry_raw) {
                let now_secs = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                if expiry_secs <= now_secs {
                    return TokenInspection {
                        valid: false,
                        reason: Some("Stored OAuth access token has expired".to_string()),
                        project_id: None,
                        user_tier: None,
                    };
                }
            }
        }
    }

    let project_id = record
        .get("project_id")
        .or_else(|| record.get("projectId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let user_tier = record
        .get("user_tier")
        .or_else(|| record.get("userTier"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    TokenInspection {
        valid: true,
        reason: None,
        project_id,
        user_tier,
    }
}

/// Precheck 2: Verify `agy` CLI authentication is configured and valid.
pub fn check_agy_auth_with_options(
    home_dir: &str,
    agy_cli_dir: &Path,
    env_map: &HashMap<String, String>,
    check_macos_keychain: bool,
) -> PrecheckResult {
    // 1. Direct OAuth token or Gemini API key via environment variables
    if let Some(token) = env_map.get("JETSKI_OAUTH_TOKEN") {
        if !token.trim().is_empty() {
            return create_check_result(
                &DEF_AGY_AUTH,
                true,
                "Authenticated via JETSKI_OAUTH_TOKEN environment variable".to_string(),
                None,
                json!({
                    "method": "env_oauth_token",
                    "source": "JETSKI_OAUTH_TOKEN"
                }),
            );
        }
    }

    if let Some(api_key) = env_map.get("GEMINI_API_KEY") {
        if !api_key.trim().is_empty() {
            return create_check_result(
                &DEF_AGY_AUTH,
                true,
                "Authenticated via GEMINI_API_KEY environment variable".to_string(),
                None,
                json!({
                    "method": "gemini_api_key",
                    "source": "GEMINI_API_KEY"
                }),
            );
        }
    }

    // 2. Stored OAuth token files in ~/.gemini/antigravity-cli or ~/.gemini
    let token_candidates = [
        agy_cli_dir.join("antigravity-oauth-token"),
        agy_cli_dir.join("antigravity-cli-oauth-token"),
        Path::new(home_dir)
            .join(".gemini")
            .join("jetski-standalone-oauth-token"),
    ];

    let mut diagnostic_failure_detail: Option<String> = None;

    for token_path in &token_candidates {
        let Ok(meta) = fs::metadata(token_path) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }

        let token_path_str = token_path.to_string_lossy().to_string();
        let display_path = shorten_home_path(&token_path_str, home_dir);

        match fs::read_to_string(token_path) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(parsed) => {
                    let inspection = inspect_stored_token_payload(&parsed);
                    if inspection.valid {
                        let suffix = inspection
                            .project_id
                            .as_ref()
                            .map(|p| format!(" · project: {}", p))
                            .unwrap_or_default();
                        return create_check_result(
                            &DEF_AGY_AUTH,
                            true,
                            format!("Authenticated via OAuth token ({}{})", display_path, suffix),
                            None,
                            json!({
                                "method": "oauth_token_file",
                                "source": token_path_str,
                                "projectId": inspection.project_id,
                                "userTier": inspection.user_tier
                            }),
                        );
                    }
                    if let Some(reason) = inspection.reason {
                        diagnostic_failure_detail = Some(format!("{} ({})", reason, display_path));
                    }
                }
                Err(_) => {
                    diagnostic_failure_detail =
                        Some(format!("Malformed token file at {}", display_path));
                }
            },
            Err(err) if err.kind() == ErrorKind::PermissionDenied => {
                return create_check_result(
                    &DEF_AGY_AUTH,
                    true,
                    format!("Authenticated via OAuth token ({})", display_path),
                    None,
                    json!({
                        "method": "oauth_token_file",
                        "source": token_path_str
                    }),
                );
            }
            Err(_) => {
                diagnostic_failure_detail =
                    Some(format!("Malformed token file at {}", display_path));
            }
        }
    }

    // 3. Application Default Credentials (ADC) when enabled via env or settings.json
    let mut adc_enabled = matches!(
        env_map.get("AGY_ADC_AUTH").map(|s| s.as_str()),
        Some("true") | Some("1")
    ) || env_map
        .get("GOOGLE_APPLICATION_CREDENTIALS")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    if !adc_enabled {
        let settings_path = agy_cli_dir.join("settings.json");
        let settings_display = shorten_home_path(&settings_path.to_string_lossy(), home_dir);
        match fs::read_to_string(&settings_path) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(settings) => {
                    if settings
                        .get("enableAdc")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        adc_enabled = true;
                    }
                }
                Err(_) => {
                    if diagnostic_failure_detail.is_none() {
                        diagnostic_failure_detail =
                            Some(format!("Malformed JSON in {}", settings_display));
                    }
                }
            },
            Err(err) => {
                if err.kind() != ErrorKind::NotFound
                    && err.kind() != ErrorKind::PermissionDenied
                    && diagnostic_failure_detail.is_none()
                {
                    diagnostic_failure_detail =
                        Some(format!("Unable to read settings at {}", settings_display));
                }
            }
        }
    }

    if adc_enabled {
        let adc_path = env_map
            .get("GOOGLE_APPLICATION_CREDENTIALS")
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(home_dir)
                    .join(".config")
                    .join("gcloud")
                    .join("application_default_credentials.json")
            });
        let adc_path_str = adc_path.to_string_lossy().to_string();
        let display_adc = shorten_home_path(&adc_path_str, home_dir);
        match fs::metadata(&adc_path) {
            Ok(meta) if meta.is_file() && meta.len() > 0 => {
                return create_check_result(
                    &DEF_AGY_AUTH,
                    true,
                    format!(
                        "Authenticated via Application Default Credentials ({})",
                        display_adc
                    ),
                    None,
                    json!({
                        "method": "adc",
                        "source": adc_path_str
                    }),
                );
            }
            Ok(_) => {
                if diagnostic_failure_detail.is_none() {
                    diagnostic_failure_detail =
                        Some(format!("ADC credentials file at {} is empty", display_adc));
                }
            }
            Err(_) => {
                if diagnostic_failure_detail.is_none() {
                    diagnostic_failure_detail = Some(format!(
                        "ADC enabled but credentials file not found at {}",
                        display_adc
                    ));
                }
            }
        }
    }

    // 4. OS Keyring (macOS Keychain via `security find-generic-password`)
    if check_macos_keychain && cfg!(target_os = "macos") {
        for service_name in ["antigravity", "antigravity-cli"] {
            if let Ok(output) = Command::new("security")
                .args(["find-generic-password", "-s", service_name, "-a", "gemini"])
                .output()
            {
                if output.status.success() {
                    return create_check_result(
                        &DEF_AGY_AUTH,
                        true,
                        format!("Authenticated via macOS Keychain ({})", service_name),
                        None,
                        json!({
                            "method": "macos_keychain",
                            "source": format!("keychain:{}/gemini", service_name)
                        }),
                    );
                }
            }
        }
    }

    create_check_result(
        &DEF_AGY_AUTH,
        false,
        diagnostic_failure_detail.unwrap_or_else(|| {
            "No active Antigravity CLI authentication credentials found".to_string()
        }),
        Some("Run \"agy\" or \"agy login\" in your terminal and complete sign-in.".to_string()),
        json!({
            "method": Value::Null,
            "source": Value::Null
        }),
    )
}

/// Run all startup prechecks (or a single check when `check_id` is provided).
pub fn run_prechecks(check_id: Option<&str>) -> Result<PrechecksReport, String> {
    let requested = check_id.map(|s| s.trim()).unwrap_or("");
    if !requested.is_empty()
        && requested != CHECK_ID_AGY_CLI
        && requested != CHECK_ID_AGY_AUTH
    {
        return Err(format!(
            "Unknown precheck id \"{}\". Valid ids: {}, {}",
            requested, CHECK_ID_AGY_CLI, CHECK_ID_AGY_AUTH
        ));
    }

    let home_dir = env::var("HOME").unwrap_or_else(|_| "/Users/jason".to_string());
    let path_env = env::var("PATH").unwrap_or_default();
    let agy_cli_dir = Path::new(&home_dir).join(".gemini/antigravity-cli");
    let env_map: HashMap<String, String> = env::vars().collect();

    let mut checks = Vec::new();
    if requested.is_empty() || requested == CHECK_ID_AGY_CLI {
        checks.push(check_agy_cli_with_options(None, &home_dir, &path_env));
    }
    if requested.is_empty() || requested == CHECK_ID_AGY_AUTH {
        checks.push(check_agy_auth_with_options(
            &home_dir,
            &agy_cli_dir,
            &env_map,
            true,
        ));
    }

    let ok = !checks.is_empty() && checks.iter().all(|c| c.ok);
    Ok(PrechecksReport {
        ok,
        checked_at: now_iso_string(),
        pause_duration_ms: DEFAULT_PAUSE_DURATION_MS,
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_shorten_home_path() {
        assert_eq!(
            shorten_home_path("/Users/tester/.local/bin/agy", "/Users/tester"),
            "~/.local/bin/agy"
        );
        assert_eq!(shorten_home_path("/Users/tester", "/Users/tester"), "~");
        assert_eq!(
            shorten_home_path("/opt/homebrew/bin/agy", "/Users/tester"),
            "/opt/homebrew/bin/agy"
        );
    }

    #[test]
    fn test_inspect_stored_token_payload() {
        let valid_nested = json!({
            "token": {
                "access_token": "ya29.test",
                "refresh_token": "1//test-refresh",
                "expiry": "2020-01-01T00:00:00Z"
            },
            "project_id": "test-proj-123",
            "user_tier": "ephemeral"
        });
        let res = inspect_stored_token_payload(&valid_nested);
        assert!(res.valid);
        assert_eq!(res.project_id.as_deref(), Some("test-proj-123"));
        assert_eq!(res.user_tier.as_deref(), Some("ephemeral"));

        let expired_no_refresh = json!({
            "token": {
                "access_token": "ya29.expired",
                "expiry": "2020-01-01T00:00:00Z"
            }
        });
        let expired_res = inspect_stored_token_payload(&expired_no_refresh);
        assert!(!expired_res.valid);
        assert!(expired_res
            .reason
            .unwrap_or_default()
            .contains("expired"));

        let empty_obj = json!({});
        let empty_res = inspect_stored_token_payload(&empty_obj);
        assert!(!empty_res.valid);
    }

    #[test]
    fn test_check_agy_cli_and_auth() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "agyolo-rust-precheck-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let bin_dir = tmp_dir.join(".local/bin");
        let agy_cli_dir = tmp_dir.join(".gemini/antigravity-cli");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&agy_cli_dir).unwrap();

        let fake_agy = bin_dir.join("agy");
        {
            let mut f = fs::File::create(&fake_agy).unwrap();
            writeln!(f, "#!/bin/sh\necho \"agy 0.2.5\"").unwrap();
        }
        let mut perms = fs::metadata(&fake_agy).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&fake_agy, perms).unwrap();

        let home_str = tmp_dir.to_string_lossy().to_string();
        let cli_res = check_agy_cli_with_options(
            Some(&fake_agy.to_string_lossy()),
            &home_str,
            "",
        );
        assert!(cli_res.ok);
        assert!(cli_res.detail.contains("0.2.5"));

        // Non-executable binary should fail with chmod remediation
        let mut no_exec = fs::metadata(&fake_agy).unwrap().permissions();
        no_exec.set_mode(0o644);
        fs::set_permissions(&fake_agy, no_exec).unwrap();
        let cli_fail = check_agy_cli_with_options(
            Some(&fake_agy.to_string_lossy()),
            &home_str,
            "",
        );
        assert!(!cli_fail.ok);
        assert!(cli_fail.detail.contains("not executable"));
        assert!(cli_fail
            .remediation
            .unwrap_or_default()
            .contains("chmod +x"));

        // Auth via OAuth token file
        let token_path = agy_cli_dir.join("antigravity-oauth-token");
        fs::write(
            &token_path,
            serde_json::to_string(&json!({
                "token": {
                    "access_token": "ya29.valid",
                    "refresh_token": "1//refresh"
                },
                "project_id": "demo-project"
            }))
            .unwrap(),
        )
        .unwrap();

        let empty_env = HashMap::new();
        let auth_res = check_agy_auth_with_options(&home_str, &agy_cli_dir, &empty_env, false);
        assert!(auth_res.ok);
        assert!(auth_res.detail.contains("demo-project"));

        // Missing auth when token removed
        fs::remove_file(&token_path).unwrap();
        let auth_fail = check_agy_auth_with_options(&home_str, &agy_cli_dir, &empty_env, false);
        assert!(!auth_fail.ok);
        assert!(auth_fail
            .remediation
            .unwrap_or_default()
            .contains("agy login"));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_run_prechecks_invalid_id() {
        let err = run_prechecks(Some("unknown_id")).unwrap_err();
        assert!(err.contains("Unknown precheck id"));
    }
}
