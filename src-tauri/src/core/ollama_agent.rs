//! S1 — Ollama Agent Loop & Context Manager
//!
//! Drives Ollama's OpenAI-compatible /v1/chat/completions endpoint directly via
//! async HTTP streaming. Implements:
//!   - Streaming text deltas and tool call accumulation
//!   - Self-Healing Engine: up to 3 auto-retries on parse or tool errors
//!   - Context Protection: prunes oldest tool_result messages when history grows large
//!   - Search/Replace paradigm enforced for all file edits
//!   - Typed Tauri events: text_delta, tool_call_start, tool_call_result, diff_proposed, done

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_HEAL_RETRIES: u32 = 3;
const MAX_ITERATIONS: u32 = 40;
const DIRECT_AGENT_IDLE_TIMEOUT_SECS: u64 = 10 * 60;
const DIRECT_AGENT_MAX_RUNTIME_SECS: u64 = 45 * 60;
const DIRECT_AGENT_HTTP_TIMEOUT_SECS: u64 = 120;
/// Prune when history exceeds this many messages (keeps first system message + recent N)
const CONTEXT_PRUNE_THRESHOLD: usize = 60;
const CONTEXT_KEEP_RECENT: usize = 30;
const TOOL_RESULT_CONTEXT_MAX_BYTES: usize = 12 * 1024;
const CODE_PLAN_MAX_RELEVANT_FILES: usize = 40;
const CODE_PLAN_MAX_SKELETON_FILES: usize = 20;
const CODE_PLAN_MAX_SYMBOLS_PER_FILE: usize = 20;
const CODE_PLAN_MAX_DEPENDENCY_FILES: usize = 20;
const CODE_PLAN_MAX_DEPENDENCIES_PER_FILE: usize = 12;
const CODE_PLAN_MAX_CONTENT_SCAN_FILES: usize = 400;
const CODE_PLAN_MAX_FILE_BYTES: u64 = 256 * 1024;
const CODE_PLAN_MAX_OUTPUT_BYTES: usize = 20 * 1024;

const BLACKLISTED_DIRS: &[&str] = &[
    "node_modules",
    "ios/Pods",
    ".git",
    "target",
    "dist",
    ".expo",
    ".next",
    "build",
    "__pycache__",
    ".cache",
    ".turbo",
];

const SYSTEM_PROMPT: &str = "\
You are a local-first coding assistant running on Ollama. You help the user write, edit, \
and understand code in their project.

## File Editing Rules — MANDATORY
NEVER produce whole-file rewrites or unified diffs.
For every file edit, use the edit_file tool with EXACT search/replace blocks:
  - `search`: the exact text that currently exists in the file (unique, verbatim)
  - `replace`: the new text that should replace it
If a change spans multiple locations, call edit_file once per location.
If you must create a new file, use write_file.

## Calculations & Non-AI Tasks
For any task that does not require reasoning — math, unit conversions, data transformations, \
sorting, counting — use the run_python tool instead of answering in text. \
Always print the result with print().

## Context Hygiene
- Never read the same file twice unless its content has changed.
- Prefer grep and list_dir to orient yourself before reading full files.
- Stay focused: do not explore files unrelated to the task.
";

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct AgentTextDeltaEvent {
    pub text: String,
    pub kind: String,
}

#[derive(Clone, Serialize)]
pub struct AgentToolCallStartEvent {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct AgentToolCallResultEvent {
    pub id: String,
    pub name: String,
    pub result: String,
    pub is_error: bool,
}

#[derive(Clone, Serialize)]
pub struct AgentDiffProposedEvent {
    pub call_id: String,
    pub path: String,
    /// The exact search text (for display)
    pub search: String,
    /// The replacement text (for display)
    pub replace: String,
}

#[derive(Clone, Serialize)]
pub struct AgentEditIntentRequestEvent {
    pub call_id: String,
    pub tool_name: String,
    pub path: String,
}

#[derive(Clone, Serialize)]
pub struct AgentDoneEvent {
    pub success: bool,
    pub error: Option<String>,
}

// ── Tauri State ───────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct OllamaAgentState {
    pub cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// Pending diff approvals: call_id → oneshot sender (true = approved, false = rejected)
    pub pending_diffs: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    /// Pending early edit intent approvals: call_id → oneshot sender.
    pub pending_edit_intents: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    pub running: Arc<Mutex<bool>>,
}

// ── Accumulated tool call from SSE stream ─────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

fn emit_agent_delta<R: Runtime>(app: &AppHandle<R>, text: impl Into<String>, kind: &str) {
    let text = text.into();
    if text.trim().is_empty() {
        return;
    }

    let _ = app.emit(
        "agent-text-delta",
        AgentTextDeltaEvent {
            text,
            kind: kind.to_string(),
        },
    );
}

fn emit_text_delta<R: Runtime>(app: &AppHandle<R>, text: impl Into<String>) {
    emit_agent_delta(app, text, "text");
}

fn emit_thinking_delta<R: Runtime>(app: &AppHandle<R>, text: impl Into<String>) {
    emit_agent_delta(app, text, "thinking");
}

fn split_content_delta(
    text: &str,
    in_think_block: &mut bool,
    carry: &mut String,
) -> Vec<(String, &'static str)> {
    const OPEN_TAG: &str = "<think>";
    const CLOSE_TAG: &str = "</think>";

    carry.push_str(text);
    let mut segments = Vec::new();

    loop {
        if *in_think_block {
            if let Some(end) = carry.find(CLOSE_TAG) {
                if end > 0 {
                    segments.push((carry[..end].to_string(), "thinking"));
                }
                carry.drain(..end + CLOSE_TAG.len());
                *in_think_block = false;
                continue;
            }

            let emit_len = safe_emit_len(carry, CLOSE_TAG);
            if emit_len > 0 {
                segments.push((carry[..emit_len].to_string(), "thinking"));
                carry.drain(..emit_len);
            }
            break;
        }

        if let Some(start) = carry.find(OPEN_TAG) {
            if start > 0 {
                segments.push((carry[..start].to_string(), "text"));
            }
            carry.drain(..start + OPEN_TAG.len());
            *in_think_block = true;
            continue;
        }

        let emit_len = safe_emit_len(carry, OPEN_TAG);
        if emit_len > 0 {
            segments.push((carry[..emit_len].to_string(), "text"));
            carry.drain(..emit_len);
        }
        break;
    }

    segments
}

fn safe_emit_len(buffer: &str, pending_tag: &str) -> usize {
    let bytes = buffer.as_bytes();
    let tag_bytes = pending_tag.as_bytes();
    let max_keep = tag_bytes.len().saturating_sub(1).min(bytes.len());
    let mut keep = 0;

    for len in 1..=max_keep {
        if tag_bytes.starts_with(&bytes[bytes.len() - len..]) {
            keep = len;
        }
    }

    let mut emit_len = buffer.len().saturating_sub(keep);
    while emit_len > 0 && !buffer.is_char_boundary(emit_len) {
        emit_len -= 1;
    }
    emit_len
}

fn emit_content_delta<R: Runtime>(
    app: &AppHandle<R>,
    text: &str,
    in_think_block: &mut bool,
    carry: &mut String,
) {
    for (segment, kind) in split_content_delta(text, in_think_block, carry) {
        match kind {
            "thinking" => emit_thinking_delta(app, segment),
            _ => emit_text_delta(app, segment),
        }
    }
}

// ── Tool schemas (OpenAI function calling format) ─────────────────────────────

/// Delegates to agent_bridge so schemas are defined in a single place (S2).
fn tool_definitions() -> Value {
    crate::core::mcp::agent_bridge::tool_schemas()
}

fn code_planner_enabled() -> bool {
    matches!(
        std::env::var("ATOMIC_CODE_PLANNER").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("on") | Some("ON")
    )
}

// ── CodePlanner ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct CodePlanCandidate {
    path: String,
    score: usize,
    reasons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CodePlanDependency {
    hint: String,
    target: Option<String>,
}

async fn build_code_plan(project_dir: &str, user_prompt: &str) -> Result<String, String> {
    let root = PathBuf::from(project_dir);
    let output = tokio::process::Command::new("rg")
        .arg("--files")
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("CodePlanner failed to run rg --files: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("CodePlanner file scan failed: {}", stderr.trim()));
    }

    let all_files = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .filter(|path| !path_has_blacklisted_segment(path))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let all_file_set = all_files.iter().cloned().collect::<HashSet<_>>();

    let keywords = extract_task_keywords(user_prompt);
    let relevant_files = rank_code_plan_files_with_content(&root, &all_files, &keywords).await?;
    let high_confidence_count = relevant_files
        .iter()
        .filter(|candidate| candidate.score > 0)
        .count();

    let mut dependency_sections = Vec::new();
    let mut skeleton_sections = Vec::new();

    for candidate in relevant_files
        .iter()
        .filter(|candidate| is_text_code_file(&candidate.path))
        .take(CODE_PLAN_MAX_DEPENDENCY_FILES)
    {
        let Some(content) = read_plan_file_if_small(&root, &candidate.path).await? else {
            continue;
        };

        let dependencies =
            build_dependency_lines(&root, &all_file_set, &candidate.path, &content).await?;
        if !dependencies.is_empty() {
            dependency_sections.push(format!(
                "- `{}`\n{}",
                candidate.path,
                dependencies
                    .into_iter()
                    .take(CODE_PLAN_MAX_DEPENDENCIES_PER_FILE)
                    .map(|dep| format!("  - {}", dep))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
    }

    for candidate in relevant_files
        .iter()
        .filter(|candidate| is_skeleton_supported_file(&candidate.path))
        .take(CODE_PLAN_MAX_SKELETON_FILES)
    {
        let Some(content) = read_plan_file_if_small(&root, &candidate.path).await? else {
            continue;
        };

        let symbols = unique_limited(
            extract_file_skeleton(&candidate.path, &content),
            CODE_PLAN_MAX_SYMBOLS_PER_FILE,
        );
        if !symbols.is_empty() {
            skeleton_sections.push(format!(
                "#### `{}`\n{}",
                candidate.path,
                symbols
                    .into_iter()
                    .take(CODE_PLAN_MAX_SYMBOLS_PER_FILE)
                    .map(|symbol| format!("- {}", symbol))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
    }

    let recommended_scope = relevant_files
        .iter()
        .take(12)
        .map(|candidate| format!("- `{}`", candidate.path))
        .collect::<Vec<_>>();

    let mut plan = String::new();
    plan.push_str("## CodePlanner Context Pack\n\n");
    plan.push_str("### Task\n");
    plan.push_str(&truncate_for_plan(user_prompt.trim(), 1600));
    plan.push_str("\n\n");

    plan.push_str("### Keywords\n");
    if keywords.is_empty() {
        plan.push_str("- No strong task keywords extracted.\n");
    } else {
        plan.push_str(
            &keywords
                .iter()
                .map(|keyword| format!("- `{}`", keyword))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        plan.push('\n');
    }
    plan.push('\n');

    plan.push_str("### Relevant Files\n");
    if relevant_files.is_empty() {
        plan.push_str("- No project files found by `rg --files` after directory filtering.\n");
    } else {
        if high_confidence_count == 0 {
            plan.push_str(
                "- No high-confidence filename matches; these are general source candidates.\n",
            );
        }
        for candidate in relevant_files.iter().take(CODE_PLAN_MAX_RELEVANT_FILES) {
            let reason_text = if candidate.reasons.is_empty() {
                "general source candidate".to_string()
            } else {
                candidate.reasons.join("; ")
            };
            plan.push_str(&format!(
                "- `{}` (score {}; {})\n",
                candidate.path, candidate.score, reason_text
            ));
        }
    }
    plan.push('\n');

    plan.push_str("### Dependency Tree\n");
    if dependency_sections.is_empty() {
        plan.push_str("- No shallow local dependency hints found in the relevant files.\n");
    } else {
        plan.push_str(&dependency_sections.join("\n"));
        plan.push('\n');
    }
    plan.push('\n');

    plan.push_str("### Skeleton\n");
    if skeleton_sections.is_empty() {
        plan.push_str("- No supported skeleton symbols found in the relevant files.\n");
    } else {
        plan.push_str(&skeleton_sections.join("\n\n"));
        plan.push('\n');
    }
    plan.push('\n');

    plan.push_str("### Risk Areas\n");
    for risk in build_risk_areas(&relevant_files, high_confidence_count) {
        plan.push_str(&format!("- {}\n", risk));
    }
    plan.push('\n');

    plan.push_str("### Recommended Read Scope\n");
    if recommended_scope.is_empty() {
        plan.push_str(
            "- Use `grep` or `code_plan` with narrower terms before reading full files.\n",
        );
    } else {
        plan.push_str(&recommended_scope.join("\n"));
        plan.push('\n');
    }

    Ok(truncate_plan_output(plan))
}

async fn locate_code(
    project_dir: &str,
    query: &str,
    max_results: Option<usize>,
) -> Result<String, String> {
    match locate_code_inner(project_dir, query, max_results).await {
        Ok(result) => Ok(result),
        Err(e) => Ok(format!(
            "locate_code unavailable: {}.\nFallback: continue with targeted grep/list_dir/read_file. Do not stop the coding task because locate_code failed.",
            e
        )),
    }
}

async fn locate_code_inner(
    project_dir: &str,
    query: &str,
    max_results: Option<usize>,
) -> Result<String, String> {
    let root = PathBuf::from(project_dir);
    let output = tokio::process::Command::new("rg")
        .arg("--files")
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("locate_code failed to run rg --files: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("locate_code file scan failed: {}", stderr.trim()));
    }

    let all_files = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .filter(|path| !path_has_blacklisted_segment(path))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let all_file_set = all_files.iter().cloned().collect::<HashSet<_>>();
    let keywords = extract_task_keywords(query);
    let relevant_files = rank_code_plan_files_with_content(&root, &all_files, &keywords).await?;
    let limit = max_results.unwrap_or(10).clamp(1, 20);

    let mut output = String::new();
    output.push_str("## locate_code results\n\n");
    output.push_str("Query: ");
    output.push_str(&truncate_for_plan(query.trim(), 500));
    output.push_str("\n\n");

    output.push_str("Keywords:");
    if keywords.is_empty() {
        output.push_str(" none\n\n");
    } else {
        output.push('\n');
        for keyword in &keywords {
            output.push_str(&format!("- `{}`\n", keyword));
        }
        output.push('\n');
    }

    if relevant_files.is_empty() {
        output.push_str(
            "No relevant files found. Try a narrower query or use grep with exact symbols.\n",
        );
        return Ok(output);
    }

    output.push_str("Relevant files:\n");
    for (index, candidate) in relevant_files.iter().take(limit).enumerate() {
        let reason_text = if candidate.reasons.is_empty() {
            "general source candidate".to_string()
        } else {
            candidate.reasons.join("; ")
        };
        output.push_str(&format!(
            "{}. `{}`\n   score: {}\n   reasons: {}\n",
            index + 1,
            candidate.path,
            candidate.score,
            reason_text
        ));

        if is_skeleton_supported_file(&candidate.path) {
            if let Some(content) = read_plan_file_if_small(&root, &candidate.path).await? {
                let symbols = unique_limited(extract_file_skeleton(&candidate.path, &content), 8);
                if !symbols.is_empty() {
                    output.push_str("   symbols:");
                    for symbol in symbols {
                        output.push_str(&format!(" `{}`", symbol));
                    }
                    output.push('\n');
                }

                let dependencies = build_dependency_lines(
                    &root,
                    &all_file_set,
                    &candidate.path,
                    &content,
                )
                .await?;
                if !dependencies.is_empty() {
                    output.push_str("   dependency hints:");
                    for dependency in dependencies.into_iter().take(4) {
                        output.push_str(&format!(" `{}`", dependency));
                    }
                    output.push('\n');
                }
            }
        }
    }

    output.push_str("\nNext step: read only the top matching files or grep exact symbols if confidence is low.\n");
    Ok(truncate_plan_output(output))
}

fn extract_task_keywords(prompt: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "about",
        "after",
        "again",
        "agent",
        "allow",
        "also",
        "before",
        "build",
        "change",
        "check",
        "code",
        "could",
        "create",
        "direct",
        "does",
        "done",
        "edit",
        "file",
        "files",
        "find",
        "first",
        "from",
        "have",
        "implement",
        "inside",
        "into",
        "make",
        "model",
        "modify",
        "need",
        "only",
        "phase",
        "please",
        "project",
        "read",
        "request",
        "should",
        "stage",
        "task",
        "that",
        "this",
        "tool",
        "update",
        "use",
        "user",
        "using",
        "what",
        "when",
        "where",
        "with",
        "without",
        "would",
        "your",
    ];

    let mut seen = HashSet::new();
    let mut keywords = Vec::new();

    for raw in prompt.split(|c: char| !c.is_ascii_alphanumeric()) {
        let term = raw
            .trim_matches(|c: char| c == '_' || c == '-')
            .to_ascii_lowercase();

        if term.len() < 3 || STOP_WORDS.contains(&term.as_str()) || !seen.insert(term.clone()) {
            continue;
        }

        keywords.push(term);
    }

    keywords
}

#[cfg(test)]
fn rank_code_plan_files(files: &[String], keywords: &[String]) -> Vec<CodePlanCandidate> {
    let mut candidates = files
        .iter()
        .map(|path| candidate_from_path(path, keywords))
        .collect::<Vec<_>>();

    filter_sort_and_limit_candidates(&mut candidates);
    candidates
}

async fn rank_code_plan_files_with_content(
    root: &Path,
    files: &[String],
    keywords: &[String],
) -> Result<Vec<CodePlanCandidate>, String> {
    let mut candidates_by_path = files
        .iter()
        .map(|path| (path.clone(), candidate_from_path(path, keywords)))
        .collect::<HashMap<_, _>>();

    let mut scan_paths = files
        .iter()
        .filter(|path| is_text_code_file(path))
        .collect::<Vec<_>>();
    scan_paths.sort_by(|a, b| {
        general_source_priority(b)
            .cmp(&general_source_priority(a))
            .then_with(|| a.cmp(b))
    });

    for path in scan_paths
        .into_iter()
        .take(CODE_PLAN_MAX_CONTENT_SCAN_FILES)
    {
        let Some(content) = read_plan_file_if_small(root, path).await? else {
            continue;
        };

        let (content_score, content_reasons) = score_code_plan_content(path, &content, keywords);
        if content_score == 0 {
            continue;
        }

        let candidate = candidates_by_path
            .entry(path.clone())
            .or_insert_with(|| candidate_from_path(path, keywords));
        candidate.score += content_score;
        for reason in content_reasons {
            push_unique(&mut candidate.reasons, reason);
        }
    }

    let mut candidates = candidates_by_path.into_values().collect::<Vec<_>>();
    filter_sort_and_limit_candidates(&mut candidates);
    Ok(candidates)
}

fn candidate_from_path(path: &str, keywords: &[String]) -> CodePlanCandidate {
    let (score, reasons) = score_code_plan_file_with_reasons(path, keywords);
    CodePlanCandidate {
        path: path.to_string(),
        score,
        reasons,
    }
}

fn filter_sort_and_limit_candidates(candidates: &mut Vec<CodePlanCandidate>) {
    let has_positive_scores = candidates.iter().any(|candidate| candidate.score > 0);
    if has_positive_scores {
        candidates.retain(|candidate| candidate.score > 0);
    } else {
        for candidate in candidates.iter_mut() {
            if general_source_priority(&candidate.path) > 0 {
                push_unique(
                    &mut candidate.reasons,
                    "fallback source file when no keyword match is available".to_string(),
                );
            }
        }
        candidates.retain(|candidate| general_source_priority(&candidate.path) > 0);
    }

    candidates.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| general_source_priority(&b.path).cmp(&general_source_priority(&a.path)))
            .then_with(|| a.path.cmp(&b.path))
    });
    candidates.truncate(CODE_PLAN_MAX_RELEVANT_FILES);
}

fn score_code_plan_file_with_reasons(path: &str, keywords: &[String]) -> (usize, Vec<String>) {
    let lower_path = path.to_ascii_lowercase();
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_ascii_lowercase();
    let stem = Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let path_tokens = lower_path
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();

    let mut score = 0usize;
    let mut reasons = Vec::new();
    for keyword in keywords {
        if stem == *keyword || file_name == *keyword {
            score += 18;
            push_unique(
                &mut reasons,
                format!("filename exactly matches `{}`", keyword),
            );
        } else if stem.contains(keyword) || file_name.contains(keyword) {
            score += 12;
            push_unique(&mut reasons, format!("filename contains `{}`", keyword));
        }

        if path_tokens.iter().any(|token| token == keyword) {
            score += 10;
            push_unique(&mut reasons, format!("path segment matches `{}`", keyword));
        } else if lower_path.contains(keyword) {
            score += 5;
            push_unique(&mut reasons, format!("path contains `{}`", keyword));
        }
    }

    if score > 0 {
        score += general_source_priority(path);
    }

    (score, reasons)
}

fn score_code_plan_content(path: &str, content: &str, keywords: &[String]) -> (usize, Vec<String>) {
    if keywords.is_empty() {
        return (0, Vec::new());
    }

    let mut score = 0usize;
    let mut reasons = Vec::new();

    for symbol in extract_file_skeleton(path, content) {
        let lower = symbol.to_ascii_lowercase();
        for keyword in keywords {
            if lower.contains(keyword) {
                score += 14;
                push_unique(
                    &mut reasons,
                    format!("symbol `{}` matches `{}`", symbol, keyword),
                );
            }
        }
    }

    for dependency in extract_dependency_hints(path, content) {
        let lower = dependency.hint.to_ascii_lowercase();
        for keyword in keywords {
            if lower.contains(keyword) {
                score += 8;
                push_unique(
                    &mut reasons,
                    format!("dependency hint matches `{}`", keyword),
                );
            }
        }
    }

    for line in content.lines().take(240) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.len() > 240 {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        for keyword in keywords {
            if lower.contains(keyword) {
                score += 2;
                push_unique(&mut reasons, format!("content mentions `{}`", keyword));
            }
        }

        if reasons.len() >= 8 {
            break;
        }
    }

    (score, reasons.into_iter().take(8).collect())
}

fn general_source_priority(path: &str) -> usize {
    let lower = path.to_ascii_lowercase();
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");

    let mut score = match extension {
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" => 4,
        "md" | "toml" | "json" | "yaml" | "yml" => 2,
        _ => 0,
    };

    if lower.starts_with("src/") || lower.starts_with("src-tauri/") || lower.contains("/src/") {
        score += 3;
    }
    if lower.contains("test") || lower.contains("spec") {
        score += 1;
    }

    score
}

async fn read_plan_file_if_small(root: &Path, rel_path: &str) -> Result<Option<String>, String> {
    let path = root.join(rel_path);
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };

    if !metadata.is_file() || metadata.len() > CODE_PLAN_MAX_FILE_BYTES {
        return Ok(None);
    }

    match tokio::fs::read_to_string(&path).await {
        Ok(content) => Ok(Some(content)),
        Err(_) => Ok(None),
    }
}

fn is_text_code_file(path: &str) -> bool {
    matches!(
        Path::new(path).extension().and_then(|ext| ext.to_str()),
        Some(
            "rs" | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "py"
                | "md"
                | "toml"
                | "json"
                | "yaml"
                | "yml"
        )
    )
}

fn is_skeleton_supported_file(path: &str) -> bool {
    matches!(
        Path::new(path).extension().and_then(|ext| ext.to_str()),
        Some("rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py")
    )
}

async fn build_dependency_lines(
    root: &Path,
    all_files: &HashSet<String>,
    source_path: &str,
    content: &str,
) -> Result<Vec<String>, String> {
    let direct_dependencies = extract_dependency_hints(source_path, content)
        .into_iter()
        .map(|dependency| resolve_dependency_target(source_path, dependency, all_files))
        .collect::<Vec<_>>();
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    let mut nested_targets = Vec::new();

    for dependency in direct_dependencies
        .iter()
        .take(CODE_PLAN_MAX_DEPENDENCIES_PER_FILE)
    {
        let line = match &dependency.target {
            Some(target) => {
                nested_targets.push(target.clone());
                format!("{} -> `{}`", dependency.hint, target)
            }
            None => dependency.hint.clone(),
        };

        if seen.insert(line.clone()) {
            lines.push(line);
        }
    }

    for target in nested_targets {
        if lines.len() >= CODE_PLAN_MAX_DEPENDENCIES_PER_FILE {
            break;
        }

        let Some(target_content) = read_plan_file_if_small(root, &target).await? else {
            continue;
        };

        for dependency in extract_dependency_hints(&target, &target_content)
            .into_iter()
            .map(|dependency| resolve_dependency_target(&target, dependency, all_files))
        {
            let Some(nested_target) = dependency.target else {
                continue;
            };

            let line = format!("`{}` -> `{}`", target, nested_target);
            if seen.insert(line.clone()) {
                lines.push(line);
            }

            if lines.len() >= CODE_PLAN_MAX_DEPENDENCIES_PER_FILE {
                break;
            }
        }
    }

    Ok(lines)
}

fn extract_dependency_hints(path: &str, content: &str) -> Vec<CodePlanDependency> {
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    let mut deps = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }

        let dependency = match extension {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
                if (trimmed.starts_with("import ")
                    || trimmed.starts_with("export ")
                    || trimmed.contains("import("))
                    && extract_quoted_local_spec(trimmed).is_some()
                {
                    Some(CodePlanDependency {
                        hint: truncate_for_plan(trimmed, 180),
                        target: None,
                    })
                } else {
                    None
                }
            }
            "rs" => {
                if trimmed.starts_with("mod ")
                    || trimmed.starts_with("pub mod ")
                    || trimmed.starts_with("use crate::")
                    || trimmed.starts_with("pub use crate::")
                {
                    Some(CodePlanDependency {
                        hint: truncate_for_plan(trimmed, 180),
                        target: None,
                    })
                } else {
                    None
                }
            }
            "py" => {
                if trimmed.starts_with("from .") {
                    Some(CodePlanDependency {
                        hint: truncate_for_plan(trimmed, 180),
                        target: None,
                    })
                } else {
                    None
                }
            }
            _ => None,
        };

        if let Some(dependency) = dependency {
            deps.push(dependency);
        }

        if deps.len() >= CODE_PLAN_MAX_DEPENDENCIES_PER_FILE {
            break;
        }
    }

    deps
}

fn resolve_dependency_target(
    source_path: &str,
    mut dependency: CodePlanDependency,
    all_files: &HashSet<String>,
) -> CodePlanDependency {
    dependency.target = resolve_dependency_hint_target(source_path, &dependency.hint, all_files);
    dependency
}

fn resolve_dependency_hint_target(
    source_path: &str,
    hint: &str,
    all_files: &HashSet<String>,
) -> Option<String> {
    let extension = Path::new(source_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");

    match extension {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            let spec = extract_quoted_local_spec(hint)?;
            resolve_js_ts_dependency(source_path, spec, all_files)
        }
        "rs" => resolve_rust_dependency(source_path, hint, all_files),
        "py" => resolve_python_dependency(source_path, hint, all_files),
        _ => None,
    }
}

fn extract_quoted_local_spec(line: &str) -> Option<&str> {
    for quote in ['"', '\''] {
        let mut rest = line;
        while let Some(start) = rest.find(quote) {
            let after_start = &rest[start + 1..];
            let Some(end) = after_start.find(quote) else {
                break;
            };
            let spec = &after_start[..end];
            if spec.starts_with("./") || spec.starts_with("../") {
                return Some(spec);
            }
            rest = &after_start[end + 1..];
        }
    }

    None
}

fn resolve_js_ts_dependency(
    source_path: &str,
    spec: &str,
    all_files: &HashSet<String>,
) -> Option<String> {
    let source_dir = Path::new(source_path).parent().unwrap_or(Path::new(""));
    let base = normalize_project_path(source_dir.join(spec));
    find_existing_dependency_path(
        &base,
        &["ts", "tsx", "js", "jsx", "mjs", "cjs", "json"],
        all_files,
    )
}

fn resolve_rust_dependency(
    source_path: &str,
    hint: &str,
    all_files: &HashSet<String>,
) -> Option<String> {
    let trimmed = hint
        .trim()
        .trim_end_matches(';')
        .trim_start_matches("pub ")
        .trim_start_matches("use ")
        .trim_start_matches("mod ");

    if hint.trim_start().starts_with("mod ") || hint.trim_start().starts_with("pub mod ") {
        let module = trimmed
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .find(|part| !part.is_empty())?;
        let source_dir = Path::new(source_path).parent().unwrap_or(Path::new(""));
        let base = normalize_project_path(source_dir.join(module));
        return find_existing_dependency_path(&base, &["rs"], all_files);
    }

    let crate_path = trimmed
        .strip_prefix("crate::")
        .or_else(|| trimmed.strip_prefix("use crate::"))
        .or_else(|| trimmed.strip_prefix("pub use crate::"))?;
    let prefix = if source_path.starts_with("src-tauri/src/") {
        "src-tauri/src"
    } else {
        "src"
    };
    let base = format!("{}/{}", prefix, crate_path.replace("::", "/"));
    find_existing_dependency_path(&base, &["rs"], all_files)
}

fn resolve_python_dependency(
    source_path: &str,
    hint: &str,
    all_files: &HashSet<String>,
) -> Option<String> {
    let trimmed = hint.trim();
    let rest = trimmed.strip_prefix("from ")?;
    let module = rest.split_whitespace().next()?;
    if !module.starts_with('.') {
        return None;
    }

    let dot_count = module.chars().take_while(|c| *c == '.').count();
    let module_tail = module.trim_start_matches('.');
    let mut base_dir = Path::new(source_path)
        .parent()
        .unwrap_or(Path::new(""))
        .to_path_buf();
    for _ in 1..dot_count {
        base_dir.pop();
    }
    let base = if module_tail.is_empty() {
        normalize_project_path(base_dir)
    } else {
        normalize_project_path(base_dir.join(module_tail.replace('.', "/")))
    };

    find_existing_dependency_path(&base, &["py"], all_files)
}

fn find_existing_dependency_path(
    base: &str,
    extensions: &[&str],
    all_files: &HashSet<String>,
) -> Option<String> {
    if all_files.contains(base) {
        return Some(base.to_string());
    }

    for ext in extensions {
        let candidate = format!("{}.{}", base, ext);
        if all_files.contains(&candidate) {
            return Some(candidate);
        }

        let index_candidate = format!("{}/index.{}", base, ext);
        if all_files.contains(&index_candidate) {
            return Some(index_candidate);
        }

        let mod_candidate = format!("{}/mod.{}", base, ext);
        if all_files.contains(&mod_candidate) {
            return Some(mod_candidate);
        }

        let init_candidate = format!("{}/__init__.{}", base, ext);
        if all_files.contains(&init_candidate) {
            return Some(init_candidate);
        }
    }

    None
}

fn normalize_project_path(path: PathBuf) -> String {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(part) => normalized.push(part),
            _ => {}
        }
    }
    normalized.to_string_lossy().replace('\\', "/")
}

fn extract_file_skeleton(path: &str, content: &str) -> Vec<String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    let mut symbols = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        let symbol = match extension {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => extract_js_ts_symbol(trimmed),
            "rs" => extract_rust_symbol(trimmed),
            "py" => extract_python_symbol(trimmed),
            _ => None,
        };

        if let Some(symbol) = symbol {
            symbols.push(symbol);
        }

        if symbols.len() >= CODE_PLAN_MAX_SYMBOLS_PER_FILE {
            break;
        }
    }

    symbols
}

fn extract_js_ts_symbol(line: &str) -> Option<String> {
    let line = line
        .strip_prefix("export default ")
        .or_else(|| line.strip_prefix("export "))
        .unwrap_or(line);
    let line = line.strip_prefix("async ").unwrap_or(line);

    if let Some(rest) = line.strip_prefix("function ") {
        return extract_identifier(rest).map(|name| format!("function {}", name));
    }
    if let Some(rest) = line.strip_prefix("class ") {
        return extract_identifier(rest).map(|name| format!("class {}", name));
    }
    if let Some(rest) = line.strip_prefix("interface ") {
        return extract_identifier(rest).map(|name| format!("interface {}", name));
    }
    if let Some(rest) = line.strip_prefix("type ") {
        return extract_identifier(rest).map(|name| format!("type {}", name));
    }

    for prefix in ["const ", "let ", "var "] {
        if let Some(rest) = line.strip_prefix(prefix) {
            if rest.contains("=>") || rest.contains("= (") || rest.contains("= async (") {
                return extract_identifier(rest).map(|name| format!("const {}", name));
            }
        }
    }

    None
}

fn extract_rust_symbol(line: &str) -> Option<String> {
    let line = line
        .strip_prefix("pub(crate) ")
        .or_else(|| line.strip_prefix("pub "))
        .unwrap_or(line);
    let line = line.strip_prefix("async ").unwrap_or(line);

    if let Some(rest) = line.strip_prefix("fn ") {
        return extract_identifier(rest).map(|name| format!("fn {}", name));
    }
    if let Some(rest) = line.strip_prefix("struct ") {
        return extract_identifier(rest).map(|name| format!("struct {}", name));
    }
    if let Some(rest) = line.strip_prefix("enum ") {
        return extract_identifier(rest).map(|name| format!("enum {}", name));
    }

    None
}

fn extract_python_symbol(line: &str) -> Option<String> {
    let line = line.strip_prefix("async ").unwrap_or(line);

    if let Some(rest) = line.strip_prefix("def ") {
        return extract_identifier(rest).map(|name| format!("def {}", name));
    }
    if let Some(rest) = line.strip_prefix("class ") {
        return extract_identifier(rest).map(|name| format!("class {}", name));
    }

    None
}

fn extract_identifier(input: &str) -> Option<String> {
    let identifier = input
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect::<String>();

    if identifier.is_empty() {
        None
    } else {
        Some(identifier)
    }
}

fn build_risk_areas(
    relevant_files: &[CodePlanCandidate],
    high_confidence_count: usize,
) -> Vec<String> {
    let mut risks = Vec::new();
    let joined = relevant_files
        .iter()
        .map(|candidate| candidate.path.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("\n");

    if high_confidence_count == 0 {
        risks.push(
            "No high-confidence filename match; use targeted grep before editing.".to_string(),
        );
    }
    if joined.contains("ollama_agent.rs") {
        risks.push(
            "Direct agent loop changes can affect streaming, tool execution, cancellation, and edit approval."
                .to_string(),
        );
    }
    if joined.contains("agent_bridge.rs") {
        risks.push("Tool schemas must stay in sync with execute_tool behavior.".to_string());
    }
    if joined.contains("codingagentpanel") {
        risks.push(
            "Frontend event handling should keep existing direct-agent event contracts."
                .to_string(),
        );
    }

    risks.push("Read the recommended files before editing; this plan is heuristic.".to_string());
    risks
}

fn truncate_for_plan(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push_str("...");
    }
    output
}

fn truncate_plan_output(mut plan: String) -> String {
    if plan.len() <= CODE_PLAN_MAX_OUTPUT_BYTES {
        return plan;
    }

    let marker = "\n\n[CodePlanner truncated low-confidence entries.]\n";
    let max_len = CODE_PLAN_MAX_OUTPUT_BYTES.saturating_sub(marker.len());
    let mut truncate_at = max_len.min(plan.len());
    while truncate_at > 0 && !plan.is_char_boundary(truncate_at) {
        truncate_at -= 1;
    }
    plan.truncate(truncate_at);
    plan.push_str(marker);
    plan
}

fn truncate_tool_result_for_context(mut result: String) -> String {
    if result.len() <= TOOL_RESULT_CONTEXT_MAX_BYTES {
        return result;
    }

    let marker =
        "\n\n[Tool result truncated for model context. Full result was shown in the app log.]\n";
    let max_len = TOOL_RESULT_CONTEXT_MAX_BYTES.saturating_sub(marker.len());
    let mut truncate_at = max_len.min(result.len());
    while truncate_at > 0 && !result.is_char_boundary(truncate_at) {
        truncate_at -= 1;
    }
    result.truncate(truncate_at);
    result.push_str(marker);
    result
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn unique_limited(values: Vec<String>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for value in values {
        if seen.insert(value.clone()) {
            result.push(value);
        }
        if result.len() >= limit {
            break;
        }
    }

    result
}

// ── Tool execution ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileEditPermission {
    Allowed,
    Ask,
    Denied,
}

impl FileEditPermission {
    fn from_option(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("allowed") => Self::Allowed,
            Some("ask") => Self::Ask,
            Some("denied") => Self::Denied,
            _ => Self::Ask,
        }
    }
}

async fn ensure_file_edit_allowed<R: Runtime>(
    app: &AppHandle<R>,
    call_id: &str,
    tool_name: &str,
    path: &std::path::Path,
    edit_permission: Arc<Mutex<FileEditPermission>>,
    pending_edit_intents: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
) -> Result<(), String> {
    let current_permission = *edit_permission.lock().await;

    match current_permission {
        FileEditPermission::Allowed => Ok(()),
        FileEditPermission::Denied => Err(
            "File edits are disabled for this request because it looks like a question, calculation, or explanation. Answer in text only unless the user explicitly asks to modify files or code."
                .to_string(),
        ),
        FileEditPermission::Ask => {
            let (tx, rx) = oneshot::channel::<bool>();
            {
                let mut guard = pending_edit_intents.lock().await;
                guard.insert(call_id.to_string(), tx);
            }

            let _ = app.emit(
                "agent-edit-intent-request",
                AgentEditIntentRequestEvent {
                    call_id: call_id.to_string(),
                    tool_name: tool_name.to_string(),
                    path: path.to_string_lossy().into_owned(),
                },
            );

            let approved = rx.await.unwrap_or(false);
            {
                let mut guard = edit_permission.lock().await;
                *guard = if approved {
                    FileEditPermission::Allowed
                } else {
                    FileEditPermission::Denied
                };
            }

            if approved {
                Ok(())
            } else {
                Err("User chose answer-only for this request; do not edit files.".to_string())
            }
        }
    }
}

async fn execute_tool<R: Runtime>(
    app: &AppHandle<R>,
    call_id: &str,
    name: &str,
    args: &Value,
    project_dir: &str,
    pending_diffs: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    pending_edit_intents: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    edit_permission: Arc<Mutex<FileEditPermission>>,
) -> Result<String, String> {
    match name {
        "read_file" => {
            let path = resolve_path(args, "path", project_dir)?;
            tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| format!("read_file failed for '{}': {}", path.display(), e))
        }

        "write_file" => {
            let path = resolve_path(args, "path", project_dir)?;
            let content = args["content"]
                .as_str()
                .ok_or("write_file: missing 'content'")?
                .to_string();

            ensure_file_edit_allowed(
                app,
                call_id,
                name,
                &path,
                edit_permission.clone(),
                pending_edit_intents,
            )
            .await?;

            // S2: Validate JS/TS AST before the diff reaches the UI.
            // Errors are returned to the S1 self-healing loop, not the user.
            crate::core::mcp::agent_bridge::validate_js_ts(&content, &path)?;

            // Emit diff_proposed and wait for approval
            let (tx, rx) = oneshot::channel::<bool>();
            {
                let mut guard = pending_diffs.lock().await;
                guard.insert(call_id.to_string(), tx);
            }

            let _ = app.emit(
                "agent-diff-proposed",
                AgentDiffProposedEvent {
                    call_id: call_id.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    search: String::new(),
                    replace: content.clone(),
                },
            );

            let approved = rx.await.unwrap_or(false);
            if !approved {
                return Err("User rejected the file write.".to_string());
            }

            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("write_file: cannot create dirs: {}", e))?;
            }
            tokio::fs::write(&path, &content)
                .await
                .map_err(|e| format!("write_file failed for '{}': {}", path.display(), e))?;
            Ok(format!(
                "Written {} bytes to {}",
                content.len(),
                path.display()
            ))
        }

        "edit_file" => {
            let path = resolve_path(args, "path", project_dir)?;
            let search = args["search"]
                .as_str()
                .ok_or("edit_file: missing 'search'")?
                .to_string();
            let replace = args["replace"]
                .as_str()
                .ok_or("edit_file: missing 'replace'")?
                .to_string();

            ensure_file_edit_allowed(
                app,
                call_id,
                name,
                &path,
                edit_permission.clone(),
                pending_edit_intents,
            )
            .await?;

            let current = tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| format!("edit_file: cannot read '{}': {}", path.display(), e))?;

            if !current.contains(&search) {
                return Err(format!(
                    "edit_file: search text not found in '{}'. Make sure 'search' is an exact, verbatim substring.",
                    path.display()
                ));
            }

            // S2: Apply search/replace in-memory and validate the resulting AST
            // before the diff is ever shown to the user.
            let new_content = current.replacen(&search, &replace, 1);
            crate::core::mcp::agent_bridge::validate_js_ts(&new_content, &path)?;

            // Emit diff_proposed and wait for approval
            let (tx, rx) = oneshot::channel::<bool>();
            {
                let mut guard = pending_diffs.lock().await;
                guard.insert(call_id.to_string(), tx);
            }

            let _ = app.emit(
                "agent-diff-proposed",
                AgentDiffProposedEvent {
                    call_id: call_id.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    search: search.clone(),
                    replace: replace.clone(),
                },
            );

            let approved = rx.await.unwrap_or(false);
            if !approved {
                return Err("User rejected the edit.".to_string());
            }

            // new_content already computed and validated above (S2 gate)
            tokio::fs::write(&path, &new_content)
                .await
                .map_err(|e| format!("edit_file: write failed for '{}': {}", path.display(), e))?;
            Ok(format!("Edit applied to {}", path.display()))
        }

        "list_dir" => {
            let path = resolve_path(args, "path", project_dir)?;
            let mut entries = tokio::fs::read_dir(&path)
                .await
                .map_err(|e| format!("list_dir failed for '{}': {}", path.display(), e))?;

            let mut names: Vec<String> = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                // Skip blacklisted directories
                if is_blacklisted(&name) {
                    continue;
                }
                let suffix = if entry.path().is_dir() { "/" } else { "" };
                names.push(format!("{}{}", name, suffix));
            }
            names.sort();
            Ok(names.join("\n"))
        }

        "grep" => {
            let pattern = args["pattern"].as_str().ok_or("grep: missing 'pattern'")?;
            let path = resolve_path(args, "path", project_dir)?;
            let file_glob = args["file_glob"].as_str().unwrap_or("*");

            let mut cmd = tokio::process::Command::new("grep");
            cmd.arg("-rn")
                .arg("--include")
                .arg(file_glob)
                .arg("--color=never");

            // Exclude blacklisted dirs
            for dir in BLACKLISTED_DIRS {
                cmd.arg("--exclude-dir").arg(dir);
            }

            cmd.arg(pattern).arg(&path);

            let output = cmd
                .output()
                .await
                .map_err(|e| format!("grep failed: {}", e))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.is_empty() {
                Ok("No matches found.".to_string())
            } else {
                // Truncate large results
                let truncated: String = stdout.lines().take(200).collect::<Vec<_>>().join("\n");
                Ok(truncated)
            }
        }

        "run_shell" => {
            let command = args["command"]
                .as_str()
                .ok_or("run_shell: missing 'command'")?;
            let cwd = args["cwd"].as_str().unwrap_or(project_dir);

            let output = tokio::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .current_dir(cwd)
                .output()
                .await
                .map_err(|e| format!("run_shell failed: {}", e))?;

            let mut result = String::new();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if !stdout.is_empty() {
                result.push_str(&stdout.lines().take(300).collect::<Vec<_>>().join("\n"));
            }
            if !stderr.is_empty() {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str("[stderr]\n");
                result.push_str(&stderr.lines().take(100).collect::<Vec<_>>().join("\n"));
            }
            if !output.status.success() {
                result.push_str(&format!("\n[exit code: {:?}]", output.status.code()));
            }
            Ok(if result.is_empty() {
                "(no output)".to_string()
            } else {
                result
            })
        }

        "run_python" => {
            let code = args["code"].as_str().ok_or("run_python: missing 'code'")?;

            let output = tokio::process::Command::new("python3")
                .arg("-c")
                .arg(code)
                .output()
                .await
                .map_err(|e| format!("run_python: failed to launch python3: {}", e))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if output.status.success() {
                Ok(if stdout.is_empty() {
                    "(no output)".to_string()
                } else {
                    stdout.trim_end().to_string()
                })
            } else {
                Err(format!(
                    "run_python error:\n{}",
                    if stderr.is_empty() { stdout } else { stderr }
                ))
            }
        }

        "locate_code" => {
            let query = args["query"]
                .as_str()
                .ok_or("locate_code: missing 'query'")?;
            let root = if args["path"].is_string() {
                resolve_path(args, "path", project_dir)?
            } else {
                PathBuf::from(project_dir)
            };
            let max_results = args["max_results"]
                .as_u64()
                .map(|value| value as usize);

            locate_code(
                root.to_string_lossy().as_ref(),
                query,
                max_results,
            )
            .await
        }

        "find_and_analyze_code" => {
            let query = args["query"]
                .as_str()
                .ok_or("find_and_analyze_code: missing 'query'")?;
            let root = if args["path"].is_string() {
                resolve_path(args, "path", project_dir)?
            } else {
                PathBuf::from(project_dir)
            };

            let output = tokio::process::Command::new("rg")
                .arg("--files")
                .current_dir(&root)
                .output()
                .await
                .map_err(|e| format!("find_and_analyze_code failed to list files: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("find_and_analyze_code failed: {}", stderr.trim()));
            }

            let query_terms = query
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .filter(|term| term.len() >= 3)
                .map(|term| term.to_lowercase())
                .collect::<Vec<_>>();

            let mut matches = String::new();
            for file in String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|file| !path_has_blacklisted_segment(file))
                .filter(|file| {
                    if query_terms.is_empty() {
                        return true;
                    }
                    let lower = file.to_lowercase();
                    query_terms.iter().any(|term| lower.contains(term))
                })
                .take(80)
            {
                matches.push_str("- ");
                matches.push_str(file);
                matches.push('\n');
            }

            if matches.is_empty() {
                Ok(format!(
                    "No filename matches found for query '{}'. Use grep with targeted terms next.",
                    query
                ))
            } else {
                Ok(format!(
                    "Relevant files for query '{}':\n{}Use read_file or grep on the most relevant paths before editing.",
                    query, matches
                ))
            }
        }

        unknown => Err(format!("Unknown tool: {}", unknown)),
    }
}

fn resolve_path(args: &Value, key: &str, project_dir: &str) -> Result<PathBuf, String> {
    let raw = args[key]
        .as_str()
        .ok_or_else(|| format!("Missing required argument '{}'", key))?;
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        Ok(p)
    } else {
        Ok(PathBuf::from(project_dir).join(p))
    }
}

fn is_blacklisted(name: &str) -> bool {
    BLACKLISTED_DIRS.iter().any(|b| {
        let last = b.split('/').last().unwrap_or(b);
        name == last
    })
}

fn path_has_blacklisted_segment(path: &str) -> bool {
    path.split('/').any(is_blacklisted)
}

// ── Context pruning ───────────────────────────────────────────────────────────

/// Drop oldest tool_result messages when history exceeds threshold.
/// Always preserves the first (system) message and the most recent CONTEXT_KEEP_RECENT messages.
fn prune_context(messages: &mut Vec<Value>) {
    if messages.len() <= CONTEXT_PRUNE_THRESHOLD {
        return;
    }

    let system: Vec<Value> = messages
        .iter()
        .filter(|m| m["role"].as_str() == Some("system"))
        .cloned()
        .collect();

    let non_system: Vec<Value> = messages
        .iter()
        .filter(|m| m["role"].as_str() != Some("system"))
        .cloned()
        .collect();

    let keep_start = non_system.len().saturating_sub(CONTEXT_KEEP_RECENT);
    let pruned_count = keep_start;

    let mut kept: Vec<Value> = system;
    kept.extend(non_system.into_iter().skip(keep_start));
    *messages = kept;

    log::info!(
        "[OllamaAgent] Context pruned: dropped {} old messages",
        pruned_count
    );
}

// ── SSE streaming ─────────────────────────────────────────────────────────────

struct StreamResult {
    text: String,
    tool_calls: Vec<PartialToolCall>,
}

async fn stream_completion<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    ollama_url: &str,
    model: &str,
    messages: &[Value],
    tools: &Value,
) -> Result<StreamResult, String> {
    match stream_completion_inner(app, client, ollama_url, model, messages, tools).await {
        Ok(result) => Ok(result),
        Err(e) if is_stream_timeout_error(&e) => {
            log::warn!(
                "[OllamaAgent] Streaming timed out; retrying current turn without streaming: {}",
                e
            );
            non_stream_completion(app, client, ollama_url, model, messages, tools).await
        }
        Err(e) => Err(e),
    }
}

async fn stream_completion_inner<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    ollama_url: &str,
    model: &str,
    messages: &[Value],
    tools: &Value,
) -> Result<StreamResult, String> {
    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "stream": true,
        "options": {
            "num_ctx": 32768,
        }
    });

    let response = client
        .post(ollama_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request to Ollama failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama returned HTTP {}: {}", status, text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    let mut full_text = String::new();
    // tool_calls_map: index → PartialToolCall
    let mut tool_calls_map: HashMap<usize, PartialToolCall> = HashMap::new();
    let mut in_think_block = false;
    let mut content_carry = String::new();

    loop {
        let next_chunk = timeout(
            Duration::from_secs(DIRECT_AGENT_IDLE_TIMEOUT_SECS),
            stream.next(),
        )
        .await
        .map_err(|_| {
            format!(
                "idle timeout: no Ollama stream output for {} seconds",
                DIRECT_AGENT_IDLE_TIMEOUT_SECS
            )
        })?;

        let Some(chunk) = next_chunk else {
            break;
        };

        let bytes = chunk.map_err(|e| format!("Stream read error: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete lines from buffer
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() || line == "data: [DONE]" {
                continue;
            }

            let json_str = if line.starts_with("data: ") {
                &line[6..]
            } else {
                &line
            };

            let chunk_val: Value = match serde_json::from_str(json_str) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let delta = &chunk_val["choices"][0]["delta"];

            // Text content
            if let Some(text) = delta["content"].as_str() {
                if !text.is_empty() {
                    full_text.push_str(text);
                    emit_content_delta(app, text, &mut in_think_block, &mut content_carry);
                }
            }

            for key in ["reasoning_content", "reasoning", "thinking"] {
                if let Some(text) = delta[key].as_str() {
                    emit_thinking_delta(app, text.to_string());
                }
            }

            // Tool call fragments
            if let Some(tc_array) = delta["tool_calls"].as_array() {
                for tc_chunk in tc_array {
                    let index = tc_chunk["index"].as_u64().unwrap_or(0) as usize;
                    let entry = tool_calls_map.entry(index).or_default();

                    if let Some(id) = tc_chunk["id"].as_str() {
                        if entry.id.is_empty() {
                            entry.id = id.to_string();
                        }
                    }
                    if let Some(name) = tc_chunk["function"]["name"].as_str() {
                        if entry.name.is_empty() {
                            entry.name = name.to_string();
                        }
                    }
                    if let Some(args_frag) = tc_chunk["function"]["arguments"].as_str() {
                        entry.arguments.push_str(args_frag);
                    }
                }
            }
        }
    }

    if !content_carry.is_empty() {
        if in_think_block {
            emit_thinking_delta(app, std::mem::take(&mut content_carry));
        } else {
            emit_text_delta(app, std::mem::take(&mut content_carry));
        }
    }

    let mut tool_calls: Vec<PartialToolCall> = tool_calls_map.into_values().collect();
    tool_calls.sort_by_key(|tc| tc.id.clone());

    Ok(StreamResult {
        text: full_text,
        tool_calls,
    })
}

async fn non_stream_completion<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    ollama_url: &str,
    model: &str,
    messages: &[Value],
    tools: &Value,
) -> Result<StreamResult, String> {
    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "stream": false,
        "options": {
            "num_ctx": 32768,
        }
    });

    let response = client
        .post(ollama_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request to Ollama failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama returned HTTP {}: {}", status, text));
    }

    let response_value: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;
    let message = &response_value["choices"][0]["message"];

    let text = message["content"].as_str().unwrap_or_default().to_string();
    if !text.is_empty() {
        let mut in_think_block = false;
        let mut content_carry = String::new();
        emit_content_delta(app, &text, &mut in_think_block, &mut content_carry);
        if !content_carry.is_empty() {
            if in_think_block {
                emit_thinking_delta(app, content_carry);
            } else {
                emit_text_delta(app, content_carry);
            }
        }
    }

    for key in ["reasoning_content", "reasoning", "thinking"] {
        if let Some(reasoning) = message[key].as_str() {
            emit_thinking_delta(app, reasoning.to_string());
        }
    }

    let tool_calls = message["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .filter_map(|(index, call)| {
                    let name = call["function"]["name"].as_str()?.to_string();
                    let arguments = call["function"]["arguments"]
                        .as_str()
                        .unwrap_or("{}")
                        .to_string();
                    let id = call["id"]
                        .as_str()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("call_{}", index));

                    Some(PartialToolCall {
                        id,
                        name,
                        arguments,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(StreamResult { text, tool_calls })
}

fn is_stream_timeout_error(error: &str) -> bool {
    error.contains("idle timeout") || error.contains("timed out") || error.contains("deadline")
}

// ── Agent loop ────────────────────────────────────────────────────────────────

async fn run_agent_loop<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    ollama_url: &str,
    model: &str,
    project_dir: &str,
    user_prompt: &str,
    pending_diffs: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    pending_edit_intents: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    edit_permission: Arc<Mutex<FileEditPermission>>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let tools = tool_definitions();
    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];

    if code_planner_enabled() {
        emit_text_delta(
            app,
            "CodePlanner: preparing compact code context...".to_string(),
        );
        let code_plan = match build_code_plan(project_dir, user_prompt).await {
            Ok(plan) => {
                emit_text_delta(app, "CodePlanner: context pack ready.".to_string());
                plan
            }
            Err(e) => {
                let warning = format!("CodePlanner failed: {e}\nProceed with targeted search.");
                emit_text_delta(app, warning.clone());
                warning
            }
        };
        messages.push(json!({
            "role": "system",
            "content": format!(
                "Use this CodePlanner context before exploring files. Avoid broad repository scans unless necessary.\n\n{}",
                code_plan
            )
        }));
    }

    messages.push(json!({ "role": "user", "content": user_prompt }));

    let mut iteration = 0u32;
    let mut heal_retries = 0u32;

    loop {
        if cancel.is_cancelled() {
            return Err("cancelled".to_string());
        }
        if iteration >= MAX_ITERATIONS {
            return Err(format!("Reached max iterations ({})", MAX_ITERATIONS));
        }
        iteration += 1;

        // Context protection: prune if needed
        prune_context(&mut messages);

        log::info!(
            "[OllamaAgent] Iteration {} — {} messages in context",
            iteration,
            messages.len()
        );
        emit_text_delta(
            app,
            format!(
                "Agent iteration {}: asking Ollama model {}…",
                iteration, model
            ),
        );

        // Stream from Ollama
        let stream_result = tokio::select! {
            res = stream_completion(app, client, ollama_url, model, &messages, &tools) => res,
            _ = cancel.cancelled() => return Err("cancelled".to_string()),
        };

        let StreamResult { text, tool_calls } = match stream_result {
            Ok(r) => {
                heal_retries = 0; // successful response resets heal counter
                r
            }
            Err(e) => {
                heal_retries += 1;
                log::warn!(
                    "[OllamaAgent] Stream error (attempt {}/{}): {}",
                    heal_retries,
                    MAX_HEAL_RETRIES,
                    e
                );
                if heal_retries >= MAX_HEAL_RETRIES {
                    return Err(format!(
                        "Ollama stream failed after {} retries: {}",
                        MAX_HEAL_RETRIES, e
                    ));
                }
                // Inject corrective message and retry
                messages.push(json!({
                    "role": "user",
                    "content": format!("[SYSTEM: Previous response failed with error: {}. Please try again.]", e)
                }));
                continue;
            }
        };

        // Append assistant message to history
        if tool_calls.is_empty() {
            messages.push(json!({ "role": "assistant", "content": text }));
            // No tool calls → model is done
            log::info!("[OllamaAgent] Agent finished — no more tool calls");
            return Ok(());
        } else {
            // Build assistant message with tool_calls array
            let tc_json: Vec<Value> = tool_calls
                .iter()
                .map(|tc| {
                    json!({
                        "id": tc.id,
                        "type": "function",
                        "function": { "name": tc.name, "arguments": tc.arguments }
                    })
                })
                .collect();

            messages.push(json!({
                "role": "assistant",
                "content": if text.is_empty() { Value::Null } else { Value::String(text) },
                "tool_calls": tc_json
            }));
        }

        // Execute each tool call
        for tc in &tool_calls {
            if cancel.is_cancelled() {
                return Err("cancelled".to_string());
            }

            // Parse arguments
            let args: Value = match serde_json::from_str(&tc.arguments) {
                Ok(v) => v,
                Err(e) => {
                    heal_retries += 1;
                    let err_msg = format!(
                        "Failed to parse arguments for tool '{}': {}. Raw: {}",
                        tc.name, e, tc.arguments
                    );
                    log::warn!(
                        "[OllamaAgent] JSON parse error (heal {}/{}): {}",
                        heal_retries,
                        MAX_HEAL_RETRIES,
                        err_msg
                    );

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": format!("[ERROR] {}", err_msg)
                    }));

                    if heal_retries >= MAX_HEAL_RETRIES {
                        return Err(format!(
                            "Self-healing exhausted after {} retries",
                            MAX_HEAL_RETRIES
                        ));
                    }
                    continue;
                }
            };

            // Emit tool_call_start
            let _ = app.emit(
                "agent-tool-call-start",
                AgentToolCallStartEvent {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                },
            );

            log::info!("[OllamaAgent] Executing tool '{}' (id={})", tc.name, tc.id);

            // Execute tool
            let exec_result = execute_tool(
                app,
                &tc.id,
                &tc.name,
                &args,
                project_dir,
                pending_diffs.clone(),
                pending_edit_intents.clone(),
                edit_permission.clone(),
            )
            .await;

            let (result_content, is_error) = match exec_result {
                Ok(output) => {
                    heal_retries = 0;
                    (output, false)
                }
                Err(e) => {
                    heal_retries += 1;
                    log::warn!(
                        "[OllamaAgent] Tool '{}' error (heal {}/{}): {}",
                        tc.name,
                        heal_retries,
                        MAX_HEAL_RETRIES,
                        e
                    );

                    if heal_retries >= MAX_HEAL_RETRIES {
                        return Err(format!(
                            "Self-healing exhausted: tool '{}' kept failing: {}",
                            tc.name, e
                        ));
                    }
                    (format!("[ERROR] {}", e), true)
                }
            };

            // Emit tool_call_result
            let _ = app.emit(
                "agent-tool-call-result",
                AgentToolCallResultEvent {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    result: result_content.clone(),
                    is_error,
                },
            );

            // Append tool result to message history
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": truncate_tool_result_for_context(result_content)
            }));
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_ollama_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, OllamaAgentState>,
    project_dir: String,
    prompt: String,
    model: String,
    ollama_base_url: Option<String>,
    edit_permission: Option<String>,
) -> Result<(), String> {
    // Guard: only one agent at a time
    {
        let mut running = state.running.lock().await;
        if *running {
            return Err("An Ollama agent is already running. Stop it first.".to_string());
        }
        *running = true;
    }

    let base_url = ollama_base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
    let ollama_url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

    let cancel = CancellationToken::new();
    {
        let mut guard = state.cancel.lock().await;
        *guard = Some(cancel.clone());
    }

    let pending_diffs = state.pending_diffs.clone();
    let pending_diffs_for_cleanup = state.pending_diffs.clone();
    let pending_edit_intents = state.pending_edit_intents.clone();
    let pending_edit_intents_for_cleanup = state.pending_edit_intents.clone();
    let running_arc = state.running.clone();
    let cancel_arc = state.cancel.clone();
    let app_clone = app.clone();
    let edit_permission = Arc::new(Mutex::new(FileEditPermission::from_option(edit_permission)));

    emit_text_delta(
        &app,
        format!(
            "Ollama agent started with model {} in {}",
            model, project_dir
        ),
    );

    tokio::spawn(async move {
        let client = Client::builder()
            .timeout(Duration::from_secs(DIRECT_AGENT_HTTP_TIMEOUT_SECS))
            .build()
            .expect("Failed to build HTTP client");

        let loop_cancel = cancel.clone();
        let result = match timeout(
            Duration::from_secs(DIRECT_AGENT_MAX_RUNTIME_SECS),
            run_agent_loop(
                &app_clone,
                &client,
                &ollama_url,
                &model,
                &project_dir,
                &prompt,
                pending_diffs,
                pending_edit_intents,
                edit_permission,
                loop_cancel,
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                cancel.cancel();
                Err(format!(
                    "max runtime timeout: direct Ollama agent exceeded {} seconds",
                    DIRECT_AGENT_MAX_RUNTIME_SECS
                ))
            }
        };

        // Cleanup state
        {
            let mut g = running_arc.lock().await;
            *g = false;
        }
        {
            let mut g = cancel_arc.lock().await;
            *g = None;
        }
        {
            let mut g = pending_diffs_for_cleanup.lock().await;
            g.clear();
        }
        {
            let mut g = pending_edit_intents_for_cleanup.lock().await;
            g.clear();
        }

        match result {
            Ok(()) => {
                log::info!("[OllamaAgent] Completed successfully");
                let _ = app_clone.emit(
                    "agent-done",
                    AgentDoneEvent {
                        success: true,
                        error: None,
                    },
                );
            }
            Err(ref e) if e == "cancelled" => {
                log::info!("[OllamaAgent] Cancelled by user");
                let _ = app_clone.emit(
                    "agent-done",
                    AgentDoneEvent {
                        success: false,
                        error: None,
                    },
                );
            }
            Err(e) => {
                log::error!("[OllamaAgent] Error: {}", e);
                let _ = app_clone.emit(
                    "agent-done",
                    AgentDoneEvent {
                        success: false,
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_ollama_agent(state: State<'_, OllamaAgentState>) -> Result<(), String> {
    let guard = state.cancel.lock().await;
    if let Some(token) = guard.as_ref() {
        token.cancel();
        drop(guard);

        let pending = {
            let mut guard = state.pending_diffs.lock().await;
            guard.drain().map(|(_, tx)| tx).collect::<Vec<_>>()
        };
        let pending_edit_intents = {
            let mut guard = state.pending_edit_intents.lock().await;
            guard.drain().map(|(_, tx)| tx).collect::<Vec<_>>()
        };

        for tx in pending {
            let _ = tx.send(false);
        }
        for tx in pending_edit_intents {
            let _ = tx.send(false);
        }

        Ok(())
    } else {
        Err("No Ollama agent is running.".to_string())
    }
}

/// Called by the UI to approve early file-edit intent for ambiguous requests.
#[tauri::command]
pub async fn approve_agent_edit_intent(
    state: State<'_, OllamaAgentState>,
    call_id: String,
) -> Result<(), String> {
    let mut guard = state.pending_edit_intents.lock().await;
    if let Some(tx) = guard.remove(&call_id) {
        let _ = tx.send(true);
        Ok(())
    } else {
        Err(format!("No pending edit intent with id '{}'", call_id))
    }
}

/// Called by the UI to reject early file-edit intent for ambiguous requests.
#[tauri::command]
pub async fn reject_agent_edit_intent(
    state: State<'_, OllamaAgentState>,
    call_id: String,
) -> Result<(), String> {
    let mut guard = state.pending_edit_intents.lock().await;
    if let Some(tx) = guard.remove(&call_id) {
        let _ = tx.send(false);
        Ok(())
    } else {
        Err(format!("No pending edit intent with id '{}'", call_id))
    }
}

/// Called by the UI to approve a pending diff (edit_file / write_file).
#[tauri::command]
pub async fn approve_agent_diff(
    state: State<'_, OllamaAgentState>,
    call_id: String,
) -> Result<(), String> {
    let mut guard = state.pending_diffs.lock().await;
    if let Some(tx) = guard.remove(&call_id) {
        let _ = tx.send(true);
        Ok(())
    } else {
        Err(format!("No pending diff with id '{}'", call_id))
    }
}

/// Called by the UI to reject a pending diff (edit_file / write_file).
#[tauri::command]
pub async fn reject_agent_diff(
    state: State<'_, OllamaAgentState>,
    call_id: String,
) -> Result<(), String> {
    let mut guard = state.pending_diffs.lock().await;
    if let Some(tx) = guard.remove(&call_id) {
        let _ = tx.send(false);
        Ok(())
    } else {
        Err(format!("No pending diff with id '{}'", call_id))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prune_context_leaves_system_and_recent() {
        let mut messages: Vec<Value> = vec![json!({"role": "system", "content": "sys"})];
        for i in 0..80 {
            messages.push(json!({"role": "user", "content": format!("msg {}", i)}));
        }

        prune_context(&mut messages);

        // System message preserved
        assert_eq!(messages[0]["role"], "system");
        // Total should be system + CONTEXT_KEEP_RECENT
        assert_eq!(messages.len(), 1 + CONTEXT_KEEP_RECENT);
    }

    #[test]
    fn test_prune_context_noop_when_small() {
        let mut messages: Vec<Value> = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "hello"}),
        ];
        let original_len = messages.len();
        prune_context(&mut messages);
        assert_eq!(messages.len(), original_len);
    }

    #[test]
    fn test_is_blacklisted() {
        assert!(is_blacklisted("node_modules"));
        assert!(is_blacklisted(".git"));
        assert!(is_blacklisted("Pods"));
        assert!(!is_blacklisted("src"));
        assert!(!is_blacklisted("components"));
    }

    #[test]
    fn test_code_plan_keywords_split_identifiers() {
        let keywords = extract_task_keywords("Use start_ollama_agent for CodePlanner");
        assert!(keywords.contains(&"start".to_string()));
        assert!(keywords.contains(&"ollama".to_string()));
        assert!(keywords.contains(&"codeplanner".to_string()));
        assert!(!keywords.contains(&"agent".to_string()));
    }

    #[test]
    fn test_code_plan_ranking_matches_identifier_parts() {
        let files = vec![
            "README.md".to_string(),
            "src-tauri/src/core/ollama_agent.rs".to_string(),
            "web-app/src/containers/CodingAgentPanel/index.tsx".to_string(),
        ];
        let keywords = extract_task_keywords("start_ollama_agent");
        let ranked = rank_code_plan_files(&files, &keywords);

        assert_eq!(ranked[0].path, "src-tauri/src/core/ollama_agent.rs");
    }

    #[tokio::test]
    async fn test_locate_code_reports_ranked_files() {
        let output = locate_code(
            env!("CARGO_MANIFEST_DIR"),
            "ollama agent tool schemas",
            Some(5),
        )
        .await
        .unwrap();

        assert!(output.contains("## locate_code results"));
        assert!(output.contains("Relevant files:"));
        assert!(output.contains("ollama_agent.rs") || output.contains("agent_bridge.rs"));
    }

    #[tokio::test]
    async fn test_locate_code_failure_returns_fallback() {
        let output = locate_code(
            "/definitely/not/a/project/root",
            "anything",
            Some(5),
        )
        .await
        .unwrap();

        assert!(output.contains("locate_code unavailable"));
        assert!(output.contains("Fallback: continue"));
    }

    #[test]
    fn test_code_plan_content_scoring_reports_reasons() {
        let keywords = extract_task_keywords("start ollama backend");
        let (score, reasons) = score_code_plan_content(
            "src-tauri/src/core/ollama_agent.rs",
            "use crate::core::ollama_backend;\npub fn start_ollama_backend() {}\n",
            &keywords,
        );

        assert!(score > 0);
        assert!(reasons.iter().any(|reason| reason.contains("symbol")));
        assert!(reasons
            .iter()
            .any(|reason| reason.contains("dependency hint")));
    }

    #[test]
    fn test_code_plan_resolves_local_dependencies() {
        let files = [
            "src/App.tsx",
            "src/components/Button.tsx",
            "src/components/theme/index.ts",
            "src-tauri/src/core/mcp/agent_bridge.rs",
            "src-tauri/src/core/tools.rs",
        ]
        .into_iter()
        .map(ToString::to_string)
        .collect::<HashSet<_>>();

        assert_eq!(
            resolve_dependency_hint_target(
                "src/App.tsx",
                "import Button from './components/Button'",
                &files,
            ),
            Some("src/components/Button.tsx".to_string())
        );
        assert_eq!(
            resolve_dependency_hint_target(
                "src/App.tsx",
                "import theme from './components/theme'",
                &files,
            ),
            Some("src/components/theme/index.ts".to_string())
        );
        assert_eq!(
            resolve_dependency_hint_target(
                "src-tauri/src/core/ollama_agent.rs",
                "use crate::core::mcp::agent_bridge;",
                &files,
            ),
            Some("src-tauri/src/core/mcp/agent_bridge.rs".to_string())
        );
        assert_eq!(
            resolve_dependency_hint_target("src-tauri/src/core/mod.rs", "pub mod tools;", &files),
            Some("src-tauri/src/core/tools.rs".to_string())
        );
    }

    #[test]
    fn test_code_plan_truncation_preserves_marker() {
        let plan = "x".repeat(CODE_PLAN_MAX_OUTPUT_BYTES + 100);
        let truncated = truncate_plan_output(plan);

        assert!(truncated.len() <= CODE_PLAN_MAX_OUTPUT_BYTES);
        assert!(truncated.contains("CodePlanner truncated"));
    }

    #[test]
    fn test_tool_result_context_truncation_preserves_marker() {
        let result = "x".repeat(TOOL_RESULT_CONTEXT_MAX_BYTES + 100);
        let truncated = truncate_tool_result_for_context(result);

        assert!(truncated.len() <= TOOL_RESULT_CONTEXT_MAX_BYTES);
        assert!(truncated.contains("Tool result truncated"));
    }

    #[test]
    fn test_code_plan_extracts_simple_skeletons() {
        let ts_symbols = extract_file_skeleton(
            "component.tsx",
            "export function Panel() {}\nconst useThing = () => null;\nclass Widget {}\n",
        );
        assert!(ts_symbols.contains(&"function Panel".to_string()));
        assert!(ts_symbols.contains(&"const useThing".to_string()));
        assert!(ts_symbols.contains(&"class Widget".to_string()));

        let rust_symbols = extract_file_skeleton(
            "agent.rs",
            "pub fn start_agent() {}\nstruct AgentState {}\nenum AgentEvent {}\n",
        );
        assert!(rust_symbols.contains(&"fn start_agent".to_string()));
        assert!(rust_symbols.contains(&"struct AgentState".to_string()));
        assert!(rust_symbols.contains(&"enum AgentEvent".to_string()));
    }

    #[test]
    fn test_split_content_delta_extracts_thinking_block() {
        let mut in_think_block = false;
        let mut carry = String::new();

        let segments = split_content_delta(
            "before <think>hidden</think> after",
            &mut in_think_block,
            &mut carry,
        );

        assert_eq!(
            segments,
            vec![
                ("before ".to_string(), "text"),
                ("hidden".to_string(), "thinking"),
                (" after".to_string(), "text"),
            ]
        );
        assert!(!in_think_block);
        assert!(carry.is_empty());
    }

    #[test]
    fn test_split_content_delta_handles_split_think_tags() {
        let mut in_think_block = false;
        let mut carry = String::new();

        let first = split_content_delta("alpha <thi", &mut in_think_block, &mut carry);
        let second = split_content_delta("nk>beta</thi", &mut in_think_block, &mut carry);
        let third = split_content_delta("nk> gamma", &mut in_think_block, &mut carry);

        assert_eq!(first, vec![("alpha ".to_string(), "text")]);
        assert_eq!(second, vec![("beta".to_string(), "thinking")]);
        assert_eq!(third, vec![(" gamma".to_string(), "text")]);
        assert!(!in_think_block);
        assert!(carry.is_empty());
    }

    #[test]
    fn test_resolve_path_relative() {
        let args = json!({"path": "src/main.tsx"});
        let result = resolve_path(&args, "path", "/home/user/project").unwrap();
        assert_eq!(result, PathBuf::from("/home/user/project/src/main.tsx"));
    }

    #[test]
    fn test_resolve_path_absolute() {
        let args = json!({"path": "/tmp/file.txt"});
        let result = resolve_path(&args, "path", "/home/user/project").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/file.txt"));
    }
}
