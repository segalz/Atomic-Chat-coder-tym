use std::sync::Arc;

use rmcp::model::{CallToolResult, JsonObject, Tool, ToolAnnotations};
use serde_json::{json, Map, Value};

use crate::core::loop_supervision::{LoopPauseMode, LoopSupervisionState};

pub const LOOP_SUPERVISION_SERVER_NAME: &str = "Loop Supervision MCP";

const LOOP_STATUS: &str = "loop_status";
const READ_LOOP_PROGRESS: &str = "read_loop_progress";
const GET_LOOP_DIFF: &str = "get_loop_diff";
const GET_LAST_LOOP_ERRORS: &str = "get_last_loop_errors";
const RUN_LOOP_AUDIT: &str = "run_loop_audit";
const LOOP_DURABLE_STATUS: &str = "loop_durable_status";
const REQUEST_SUPERVISOR_REVIEW: &str = "request_supervisor_review";
const PAUSE_LOOP: &str = "pause_loop";
const RESUME_LOOP: &str = "resume_loop";
const STOP_LOOP: &str = "stop_loop";
const APPROVE_NEXT_STAGE: &str = "approve_next_stage";
const SET_LOOP_LIMITS: &str = "set_loop_limits";

pub fn list_loop_supervision_tools() -> Vec<Tool> {
    vec![
        read_only_tool(
            LOOP_STATUS,
            "Return compact Loop Mode supervision status.",
            empty_schema(),
        ),
        read_only_tool(
            READ_LOOP_PROGRESS,
            "Return capped Loop Mode progress events.",
            object_schema(
                vec![("limit", json!({ "type": "integer", "minimum": 1 }))],
                vec![],
            ),
        ),
        read_only_tool(
            GET_LOOP_DIFF,
            "Return capped Loop Mode changed paths and captured diff metadata.",
            object_schema(
                vec![
                    ("byte_cap", json!({ "type": "integer", "minimum": 1 })),
                    ("path_cap", json!({ "type": "integer", "minimum": 1 })),
                ],
                vec![],
            ),
        ),
        read_only_tool(
            GET_LAST_LOOP_ERRORS,
            "Return capped recent Loop Mode error messages.",
            object_schema(
                vec![("limit", json!({ "type": "integer", "minimum": 1 }))],
                vec![],
            ),
        ),
        read_only_tool(
            RUN_LOOP_AUDIT,
            "Run deterministic local Loop Mode audit checks.",
            empty_schema(),
        ),
        read_only_tool(
            LOOP_DURABLE_STATUS,
            "Return SQLite-backed durable Loop Mode status.",
            object_schema(
                vec![("loop_id", json!({ "type": "string", "minLength": 1 }))],
                vec![],
            ),
        ),
        control_tool(
            REQUEST_SUPERVISOR_REVIEW,
            "Create a compact Loop Mode escalation evidence package and pause Loop scheduling when local guardrails require review.",
            object_schema(
                vec![("byte_cap", json!({ "type": "integer", "minimum": 1 }))],
                vec![],
            ),
        ),
        control_tool(
            PAUSE_LOOP,
            "Pause Loop Mode scheduling immediately or after the current run.",
            object_schema(
                vec![(
                    "mode",
                    json!({
                        "type": "string",
                        "enum": ["after_current_run", "immediate"]
                    }),
                )],
                vec![],
            ),
        ),
        control_tool(
            RESUME_LOOP,
            "Resume Loop Mode scheduling without modifying prompts or context.",
            empty_schema(),
        ),
        control_tool(
            STOP_LOOP,
            "Stop Loop Mode scheduling through supervision state.",
            empty_schema(),
        ),
        control_tool(
            APPROVE_NEXT_STAGE,
            "Release a local waiting-approval gate if one is active.",
            empty_schema(),
        ),
        control_tool(
            SET_LOOP_LIMITS,
            "Update Loop Mode supervision limits without modifying prompts.",
            object_schema(
                vec![
                    ("max_iterations", json!({ "type": "integer", "minimum": 1 })),
                    ("max_diff_bytes", json!({ "type": "integer", "minimum": 1 })),
                    (
                        "max_changed_paths",
                        json!({ "type": "integer", "minimum": 1 }),
                    ),
                    (
                        "audit_interval_runs",
                        json!({ "type": "integer", "minimum": 0 }),
                    ),
                ],
                vec![],
            ),
        ),
    ]
}

pub async fn call_loop_supervision_tool(
    state: &LoopSupervisionState,
    tool_name: &str,
    arguments: Option<Map<String, Value>>,
) -> Result<CallToolResult, String> {
    let args = arguments.unwrap_or_default();
    let result = match tool_name {
        LOOP_STATUS => json_result(state.status_response().await)?,
        READ_LOOP_PROGRESS => json_result(
            state
                .progress_response(optional_usize(&args, "limit")?)
                .await,
        )?,
        GET_LOOP_DIFF => json_result(
            state
                .diff_response(
                    optional_usize(&args, "byte_cap")?,
                    optional_usize(&args, "path_cap")?,
                )
                .await,
        )?,
        GET_LAST_LOOP_ERRORS => {
            json_result(state.errors_response(optional_usize(&args, "limit")?).await)?
        }
        RUN_LOOP_AUDIT => json_result(state.audit_response().await)?,
        LOOP_DURABLE_STATUS => {
            let loop_id = args
                .get("loop_id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            json_result(state.durable_status_response(loop_id).await?)?
        }
        REQUEST_SUPERVISOR_REVIEW => json_result(
            state
                .supervisor_review_response(optional_usize(&args, "byte_cap")?)
                .await,
        )?,
        PAUSE_LOOP => {
            let mode = optional_pause_mode(&args)?;
            json_result(
                state
                    .request_pause(mode.unwrap_or(LoopPauseMode::AfterCurrentRun))
                    .await,
            )?
        }
        RESUME_LOOP => json_result(state.resume().await)?,
        STOP_LOOP => json_result(state.request_stop().await)?,
        APPROVE_NEXT_STAGE => json_result(state.approve_next_stage().await)?,
        SET_LOOP_LIMITS => json_result(
            state
                .set_limits(
                    optional_u32(&args, "max_iterations")?,
                    optional_usize(&args, "max_diff_bytes")?,
                    optional_usize(&args, "max_changed_paths")?,
                    optional_u32(&args, "audit_interval_runs")?,
                )
                .await,
        )?,
        _ => return Err(format!("Loop supervision tool '{tool_name}' not found")),
    };

    Ok(result)
}

pub fn is_loop_supervision_tool(tool_name: &str) -> bool {
    loop_supervision_tool_names()
        .iter()
        .any(|known| known == &tool_name)
}

pub fn loop_supervision_tool_names() -> Vec<&'static str> {
    vec![
        LOOP_STATUS,
        READ_LOOP_PROGRESS,
        GET_LOOP_DIFF,
        GET_LAST_LOOP_ERRORS,
        RUN_LOOP_AUDIT,
        LOOP_DURABLE_STATUS,
        REQUEST_SUPERVISOR_REVIEW,
        PAUSE_LOOP,
        RESUME_LOOP,
        STOP_LOOP,
        APPROVE_NEXT_STAGE,
        SET_LOOP_LIMITS,
    ]
}

fn read_only_tool(name: &'static str, description: &'static str, schema: JsonObject) -> Tool {
    Tool::new(name, description, Arc::new(schema)).annotate(
        ToolAnnotations::new()
            .read_only(true)
            .destructive(false)
            .idempotent(true)
            .open_world(false),
    )
}

fn control_tool(name: &'static str, description: &'static str, schema: JsonObject) -> Tool {
    Tool::new(name, description, Arc::new(schema)).annotate(
        ToolAnnotations::new()
            .read_only(false)
            .destructive(false)
            .idempotent(false)
            .open_world(false),
    )
}

fn empty_schema() -> JsonObject {
    object_schema(vec![], vec![])
}

fn object_schema(
    properties: Vec<(&'static str, Value)>,
    required: Vec<&'static str>,
) -> JsonObject {
    let mut props = Map::new();
    for (name, schema) in properties {
        props.insert(name.to_string(), schema);
    }

    let mut schema = Map::new();
    schema.insert("type".to_string(), json!("object"));
    schema.insert("properties".to_string(), Value::Object(props));
    if !required.is_empty() {
        schema.insert(
            "required".to_string(),
            Value::Array(
                required
                    .into_iter()
                    .map(|field| Value::String(field.to_string()))
                    .collect(),
            ),
        );
    }
    schema
}

fn json_result<T: serde::Serialize>(value: T) -> Result<CallToolResult, String> {
    serde_json::to_value(value)
        .map(CallToolResult::structured)
        .map_err(|error| format!("Failed to serialize loop supervision result: {error}"))
}

fn optional_usize(args: &Map<String, Value>, key: &str) -> Result<Option<usize>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    let Some(number) = value.as_u64() else {
        return Err(format!("Argument '{key}' must be a positive integer"));
    };
    usize::try_from(number)
        .map(Some)
        .map_err(|_| format!("Argument '{key}' is too large"))
}

fn optional_u32(args: &Map<String, Value>, key: &str) -> Result<Option<u32>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    let Some(number) = value.as_u64() else {
        return Err(format!("Argument '{key}' must be a positive integer"));
    };
    u32::try_from(number)
        .map(Some)
        .map_err(|_| format!("Argument '{key}' is too large"))
}

fn optional_pause_mode(args: &Map<String, Value>) -> Result<Option<LoopPauseMode>, String> {
    let Some(value) = args.get("mode") else {
        return Ok(None);
    };
    match value.as_str() {
        Some("after_current_run") => Ok(Some(LoopPauseMode::AfterCurrentRun)),
        Some("immediate") => Ok(Some(LoopPauseMode::Immediate)),
        Some(other) => Err(format!("Unsupported pause mode '{other}'")),
        None => Err("Argument 'mode' must be a string".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn supervisor_tool_surface_is_separate_from_worker_tools() {
        let names = loop_supervision_tool_names();

        assert!(names.contains(&LOOP_STATUS));
        assert!(names.contains(&REQUEST_SUPERVISOR_REVIEW));
        assert!(names.contains(&PAUSE_LOOP));
        assert!(names.contains(&STOP_LOOP));
        assert!(!names.contains(&"read_file"));
        assert!(!names.contains(&"write_file"));
        assert!(!names.contains(&"edit_file"));
        assert!(!names.contains(&"run_shell"));
    }

    #[tokio::test]
    async fn listed_tools_have_supervisor_server_safe_annotations() {
        let tools = list_loop_supervision_tools();

        assert_eq!(tools.len(), loop_supervision_tool_names().len());
        for tool in tools {
            assert!(is_loop_supervision_tool(&tool.name));
            assert!(tool.description.is_some());
            assert!(tool.annotations.is_some());
            assert_eq!(
                tool.annotations.as_ref().and_then(|a| a.open_world_hint),
                Some(false)
            );
        }

        let review_tool = list_loop_supervision_tools()
            .into_iter()
            .find(|tool| tool.name == REQUEST_SUPERVISOR_REVIEW)
            .unwrap();
        assert_eq!(
            review_tool
                .annotations
                .as_ref()
                .and_then(|a| a.read_only_hint),
            Some(false)
        );
    }

    #[tokio::test]
    async fn dispatch_status_returns_structured_result() {
        let state = LoopSupervisionState::default();

        let result = call_loop_supervision_tool(&state, LOOP_STATUS, None)
            .await
            .unwrap();

        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.structured_content.unwrap()["source"], "loop");
    }

    #[tokio::test]
    async fn dispatch_rejects_unknown_tool() {
        let state = LoopSupervisionState::default();

        let error = call_loop_supervision_tool(&state, "read_file", None)
            .await
            .unwrap_err();

        assert!(error.contains("not found"));
    }

    #[tokio::test]
    async fn dispatch_validates_argument_types() {
        let state = LoopSupervisionState::default();
        let mut args = Map::new();
        args.insert("limit".to_string(), json!("a lot"));

        let error = call_loop_supervision_tool(&state, READ_LOOP_PROGRESS, Some(args))
            .await
            .unwrap_err();

        assert!(error.contains("limit"));
    }

    #[tokio::test]
    async fn dispatch_supervisor_review_returns_recommendation() {
        let state = LoopSupervisionState::default();
        state
            .begin_run(
                "/tmp/project".to_string(),
                "test goal".to_string(),
                1,
                2,
                None,
            )
            .await;

        let result = call_loop_supervision_tool(&state, REQUEST_SUPERVISOR_REVIEW, None)
            .await
            .unwrap();

        assert_eq!(result.is_error, Some(false));
        assert_eq!(
            result.structured_content.unwrap()["recommendation"],
            "continue"
        );
    }
}
