//! S5 — Test Verification & Regression Loop
//!
//! Detects the project's test framework (Jest / Vitest), runs tests scoped to
//! recently changed files, parses the JSON output, and emits a structured event
//! so the S1 agent loop can ingest failure traces as corrective user messages.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Mutex;
use std::sync::Arc;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TestRunner {
    Jest,
    Vitest,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedTest {
    pub suite: String,
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestRunResult {
    pub runner: Option<TestRunner>,
    pub passed: bool,
    pub total: u32,
    pub failed: u32,
    pub duration_ms: u64,
    pub failures: Vec<FailedTest>,
    /// Full raw output for feeding into the agent when tests fail.
    pub raw_output: String,
}

/// Emitted on `agent-test-result`.
#[derive(Clone, Serialize)]
pub struct AgentTestResultEvent {
    pub passed: bool,
    pub failed: u32,
    pub total: u32,
    pub failures: Vec<FailedTest>,
    /// Formatted failure trace ready to inject into S1 as a user message.
    pub heal_prompt: Option<String>,
}

// ── Tauri managed state ───────────────────────────────────────────────────────

#[derive(Default)]
pub struct TestRunnerState {
    pub running: Arc<Mutex<bool>>,
}

// ── Test runner detection ─────────────────────────────────────────────────────

/// Returns the detected test runner and the script name to invoke, or None.
async fn detect_runner(project_dir: &Path) -> Option<(TestRunner, String)> {
    // 1. Check for vitest config files first (vitest wins over jest if both present)
    for name in &["vitest.config.ts", "vitest.config.js", "vitest.config.mts"] {
        if project_dir.join(name).exists() {
            return Some((TestRunner::Vitest, "test".to_string()));
        }
    }

    // 2. Check for jest config files
    for name in &["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"] {
        if project_dir.join(name).exists() {
            return Some((TestRunner::Jest, "test".to_string()));
        }
    }

    // 3. Inspect package.json scripts
    let pkg_path = project_dir.join("package.json");
    if let Ok(content) = tokio::fs::read_to_string(&pkg_path).await {
        if let Ok(pkg) = serde_json::from_str::<Value>(&content) {
            let scripts = &pkg["scripts"];
            if scripts.is_object() {
                // Prefer a dedicated "test" script
                if let Some(test_cmd) = scripts["test"].as_str() {
                    let cmd_lower = test_cmd.to_lowercase();
                    if cmd_lower.contains("vitest") {
                        return Some((TestRunner::Vitest, "test".to_string()));
                    }
                    if cmd_lower.contains("jest") {
                        return Some((TestRunner::Jest, "test".to_string()));
                    }
                }
            }
        }
    }

    None
}

// ── Test execution ────────────────────────────────────────────────────────────

/// Build the test command arguments based on the runner.
fn build_test_args(runner: &TestRunner, changed_files: &[String]) -> Vec<String> {
    match runner {
        TestRunner::Jest => {
            let mut args = vec![
                "test".to_string(),
                "--json".to_string(),
                "--forceExit".to_string(),
                "--passWithNoTests".to_string(),
                "--findRelatedTests".to_string(),
            ];
            args.extend(changed_files.iter().cloned());
            args
        }
        TestRunner::Vitest => {
            // vitest run --reporter=json <files>
            let mut args = vec![
                "run".to_string(),
                "--reporter=json".to_string(),
                "--passWithNoTests".to_string(),
            ];
            // vitest accepts file globs positionally
            args.extend(changed_files.iter().cloned());
            args
        }
    }
}

/// Detect the package manager (yarn / npm / pnpm).
async fn detect_package_manager(project_dir: &Path) -> &'static str {
    if project_dir.join("yarn.lock").exists() {
        "yarn"
    } else if project_dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else {
        "npm"
    }
}

/// Run tests and capture output.
async fn run_tests(
    project_dir: &Path,
    runner: &TestRunner,
    changed_files: &[String],
) -> Result<(bool, String, String), String> {
    let pm = detect_package_manager(project_dir).await;
    let runner_bin = match runner {
        TestRunner::Jest => "jest",
        TestRunner::Vitest => "vitest",
    };

    // Try running via package manager first, fall back to npx/runner binary
    let (program, first_args) = if pm == "yarn" {
        ("yarn", vec![runner_bin.to_string()])
    } else {
        (pm, vec!["exec".to_string(), runner_bin.to_string()])
    };

    let mut cmd_args: Vec<String> = first_args;

    // For jest via yarn: `yarn jest --json ...`
    // For jest via npm:  `npm exec jest -- --json ...`
    // Append runner-specific flags
    let runner_args = build_test_args(runner, changed_files);
    // Strip the leading "test"/"run" subcommand since we're calling the binary directly
    let flags_start = match runner {
        TestRunner::Jest => 1,   // skip "test"
        TestRunner::Vitest => 0, // keep "run"
    };
    cmd_args.extend(runner_args[flags_start..].iter().cloned());

    log::info!("[TestRunner] {} {:?} in {}", program, cmd_args, project_dir.display());

    let output = tokio::process::Command::new(program)
        .args(&cmd_args)
        .current_dir(project_dir)
        .output()
        .await
        .map_err(|e| format!("Failed to spawn test process: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let success = output.status.success();

    Ok((success, stdout, stderr))
}

// ── Result parsing ────────────────────────────────────────────────────────────

fn parse_jest_json(json_str: &str) -> Option<(u32, u32, u64, Vec<FailedTest>)> {
    let v: Value = serde_json::from_str(json_str).ok()?;

    let total = v["numTotalTests"].as_u64().unwrap_or(0) as u32;
    let failed = v["numFailedTests"].as_u64().unwrap_or(0) as u32;
    let duration_ms = v["testResults"]
        .as_array()
        .map(|results| {
            results.iter().fold(0u64, |acc, r| {
                acc + r["endTime"].as_u64().unwrap_or(0)
                    .saturating_sub(r["startTime"].as_u64().unwrap_or(0))
            })
        })
        .unwrap_or(0);

    let mut failures = Vec::new();
    if let Some(suites) = v["testResults"].as_array() {
        for suite in suites {
            let suite_name = suite["testFilePath"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            if let Some(tests) = suite["testResults"].as_array() {
                for test in tests {
                    if test["status"].as_str() == Some("failed") {
                        let name = test["fullName"].as_str().unwrap_or("").to_string();
                        let message = test["failureMessages"]
                            .as_array()
                            .map(|msgs| {
                                msgs.iter()
                                    .filter_map(|m| m.as_str())
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        failures.push(FailedTest { suite: suite_name.clone(), name, message });
                    }
                }
            }
        }
    }

    Some((total, failed, duration_ms, failures))
}

fn parse_vitest_json(json_str: &str) -> Option<(u32, u32, u64, Vec<FailedTest>)> {
    let v: Value = serde_json::from_str(json_str).ok()?;

    // Vitest JSON reporter top-level keys
    let total = (v["numTotalTests"].as_u64()
        .or_else(|| v["testResults"].as_array().map(|a| a.len() as u64)))
        .unwrap_or(0) as u32;
    let failed = v["numFailedTests"].as_u64().unwrap_or(0) as u32;
    let duration_ms = v["testResults"]
        .as_array()
        .map(|r| {
            r.iter().fold(0u64, |acc, s| {
                acc + s["stats"]["duration"].as_u64().unwrap_or(0)
            })
        })
        .unwrap_or(0);

    let mut failures = Vec::new();
    if let Some(suites) = v["testResults"].as_array() {
        for suite in suites {
            let suite_name = suite["name"].as_str().unwrap_or("unknown").to_string();
            if let Some(tests) = suite["assertionResults"].as_array() {
                for test in tests {
                    if test["status"].as_str() == Some("failed") {
                        let name = test["fullName"].as_str().unwrap_or("").to_string();
                        let message = test["failureMessages"]
                            .as_array()
                            .map(|msgs| {
                                msgs.iter()
                                    .filter_map(|m| m.as_str())
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        failures.push(FailedTest { suite: suite_name.clone(), name, message });
                    }
                }
            }
        }
    }

    Some((total, failed, duration_ms, failures))
}

/// Extract the JSON block from mixed output (some runners print non-JSON lines before the JSON blob).
fn extract_json(output: &str) -> Option<&str> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    if end >= start {
        Some(&output[start..=end])
    } else {
        None
    }
}

fn parse_test_output(
    runner: &TestRunner,
    stdout: &str,
    stderr: &str,
    process_success: bool,
) -> TestRunResult {
    let raw_output = if stderr.is_empty() {
        stdout.to_string()
    } else {
        format!("{}\n[stderr]\n{}", stdout, stderr)
    };

    let json_src = extract_json(stdout)
        .or_else(|| extract_json(stderr));

    let parsed = json_src.and_then(|s| match runner {
        TestRunner::Jest => parse_jest_json(s),
        TestRunner::Vitest => parse_vitest_json(s),
    });

    if let Some((total, failed, duration_ms, failures)) = parsed {
        TestRunResult {
            runner: Some(runner.clone()),
            passed: failed == 0 && process_success,
            total,
            failed,
            duration_ms,
            failures,
            raw_output,
        }
    } else {
        // Fallback: no parseable JSON — treat non-zero exit as failure
        TestRunResult {
            runner: Some(runner.clone()),
            passed: process_success,
            total: 0,
            failed: if process_success { 0 } else { 1 },
            duration_ms: 0,
            failures: if process_success {
                vec![]
            } else {
                vec![FailedTest {
                    suite: "unknown".to_string(),
                    name: "unknown".to_string(),
                    message: raw_output.lines().take(50).collect::<Vec<_>>().join("\n"),
                }]
            },
            raw_output,
        }
    }
}

// ── Heal prompt builder ───────────────────────────────────────────────────────

fn build_heal_prompt(result: &TestRunResult, changed_files: &[String]) -> String {
    let mut prompt = format!(
        "[SYSTEM: Test run after your edits FAILED — {} of {} tests failed.]\n\n",
        result.failed, result.total
    );

    prompt.push_str(&format!(
        "Changed files: {}\n\n",
        changed_files.join(", ")
    ));

    for (i, f) in result.failures.iter().enumerate() {
        prompt.push_str(&format!(
            "--- Failure {} ---\nSuite: {}\nTest:  {}\n{}\n\n",
            i + 1,
            f.suite,
            f.name,
            f.message.lines().take(30).collect::<Vec<_>>().join("\n")
        ));
    }

    prompt.push_str("Please analyse the failure trace above, identify what went wrong in your recent edits, and fix it using the edit_file tool.");
    prompt
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Run tests for the given changed files and emit an `agent-test-result` event.
///
/// Returns the structured result so the frontend can optionally re-inject the
/// heal prompt into the S1 agent loop via `start_ollama_agent`.
#[tauri::command]
pub async fn run_agent_tests<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TestRunnerState>,
    project_dir: String,
    changed_files: Vec<String>,
) -> Result<TestRunResult, String> {
    // Guard: one test run at a time
    {
        let mut running = state.running.lock().await;
        if *running {
            return Err("A test run is already in progress.".to_string());
        }
        *running = true;
    }

    let dir = PathBuf::from(&project_dir);

    let result = async {
        let Some((runner, _script)) = detect_runner(&dir).await else {
            return Ok(TestRunResult {
                runner: None,
                passed: true,
                total: 0,
                failed: 0,
                duration_ms: 0,
                failures: vec![],
                raw_output: "No test runner detected (no jest/vitest config or package.json script).".to_string(),
            });
        };

        log::info!("[TestRunner] Detected runner: {:?}", runner);

        let (success, stdout, stderr) = run_tests(&dir, &runner, &changed_files).await?;
        let test_result = parse_test_output(&runner, &stdout, &stderr, success);

        let heal_prompt = if !test_result.passed {
            Some(build_heal_prompt(&test_result, &changed_files))
        } else {
            None
        };

        let _ = app.emit("agent-test-result", AgentTestResultEvent {
            passed: test_result.passed,
            failed: test_result.failed,
            total: test_result.total,
            failures: test_result.failures.clone(),
            heal_prompt,
        });

        Ok(test_result)
    }.await;

    {
        let mut running = state.running.lock().await;
        *running = false;
    }

    result
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const JEST_JSON: &str = r#"{
        "numTotalTests": 5,
        "numFailedTests": 1,
        "testResults": [
            {
                "testFilePath": "/project/src/foo.test.ts",
                "startTime": 1000,
                "endTime": 1500,
                "testResults": [
                    {
                        "status": "passed",
                        "fullName": "foo renders correctly"
                    },
                    {
                        "status": "failed",
                        "fullName": "foo handles edge case",
                        "failureMessages": ["Expected true but got false\n  at foo.test.ts:12"]
                    }
                ]
            }
        ]
    }"#;

    #[test]
    fn test_parse_jest_json() {
        let (total, failed, duration_ms, failures) = parse_jest_json(JEST_JSON).unwrap();
        assert_eq!(total, 5);
        assert_eq!(failed, 1);
        assert_eq!(duration_ms, 500);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].name, "foo handles edge case");
        assert!(failures[0].message.contains("Expected true"));
    }

    #[test]
    fn test_extract_json_strips_prefix() {
        let mixed = "some log line\n{\"numTotalTests\": 1}\ntrailing";
        let extracted = extract_json(mixed).unwrap();
        assert!(extracted.starts_with('{'));
        assert!(extracted.ends_with('}'));
    }

    #[test]
    fn test_parse_test_output_no_json_success() {
        let result = parse_test_output(&TestRunner::Jest, "(no output)", "", true);
        assert!(result.passed);
        assert_eq!(result.failed, 0);
    }

    #[test]
    fn test_parse_test_output_no_json_failure() {
        let result = parse_test_output(&TestRunner::Jest, "Error: something broke", "", false);
        assert!(!result.passed);
        assert_eq!(result.failed, 1);
    }

    #[test]
    fn test_build_heal_prompt_contains_key_info() {
        let result = TestRunResult {
            runner: Some(TestRunner::Jest),
            passed: false,
            total: 3,
            failed: 1,
            duration_ms: 200,
            failures: vec![FailedTest {
                suite: "src/foo.test.ts".to_string(),
                name: "foo works".to_string(),
                message: "Expected 1 got 2".to_string(),
            }],
            raw_output: String::new(),
        };
        let prompt = build_heal_prompt(&result, &["src/foo.ts".to_string()]);
        assert!(prompt.contains("1 of 3 tests failed"));
        assert!(prompt.contains("src/foo.ts"));
        assert!(prompt.contains("Expected 1 got 2"));
        assert!(prompt.contains("edit_file"));
    }

    #[test]
    fn test_build_jest_args_findrelated() {
        let args = build_test_args(&TestRunner::Jest, &["src/foo.ts".to_string()]);
        assert!(args.contains(&"--findRelatedTests".to_string()));
        assert!(args.contains(&"src/foo.ts".to_string()));
        assert!(args.contains(&"--json".to_string()));
    }

    #[test]
    fn test_build_vitest_args_run() {
        let args = build_test_args(&TestRunner::Vitest, &["src/bar.ts".to_string()]);
        assert!(args.contains(&"run".to_string()));
        assert!(args.contains(&"--reporter=json".to_string()));
        assert!(args.contains(&"src/bar.ts".to_string()));
    }
}
