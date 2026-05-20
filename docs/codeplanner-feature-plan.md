# CodePlanner Feature Plan

## Objective

Add a lightweight `CodePlanner` stage to the existing direct Ollama coding-agent flow.

The goal is to reduce the amount of context sent to heavy local models such as `qwen3-coder-next:latest`. The model should receive a compact code map before it starts reasoning, instead of exploring the repository blindly.

This is not a new MCP server and does not modify CodeHelper. It is an app-side feature in the current agent flow.

Current status: do not enable CodePlanner automatically by default. Runtime QA showed that injecting a plan into every run can hurt long autonomous loops by increasing prompt/context size, especially when the task is broad or the planner is not confident. The runtime path is gated behind `ATOMIC_CODE_PLANNER=1` for future testing and must stay off by default.

## Core Idea

```text
User coding request
  -> CodePlanner builds a compact context pack
  -> Large model receives the plan
  -> Large model reads only recommended files
  -> Existing edit and approval flow continues
```

## Files To Inspect First

- `web-app/src/containers/CodingAgentPanel/index.tsx`
  - Starts the direct Ollama agent through `start_ollama_agent`.
- `src-tauri/src/core/ollama_agent.rs`
  - Main direct Ollama agent loop.
  - Builds the initial system/user messages.
  - Executes direct-agent tools.
- `src-tauri/src/core/mcp/agent_bridge.rs`
  - Defines OpenAI-style tool schemas exposed to the direct Ollama agent.

## Proposed Changes

### 1. Add CodePlanner in `ollama_agent.rs`

Add a helper similar to:

```rust
async fn build_code_plan(project_dir: &str, user_prompt: &str) -> Result<String, String>
```

It should:

- Run `rg --files` in the project.
- Skip heavy directories such as `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, and `.cache`.
- Extract keywords from the user task.
- Rank relevant files by path/name matches.
- Build a compact Markdown context pack.

Suggested context pack:

```md
## CodePlanner Context Pack

### Task
...

### Relevant Files
- ...

### Dependency Tree
...

### Skeleton
...

### Risk Areas
...

### Recommended Read Scope
- ...
```

If re-enabled behind an explicit toggle/config, inject this context pack before the first Ollama request:

```rust
let code_plan = build_code_plan(project_dir, user_prompt).await
    .unwrap_or_else(|e| format!("CodePlanner failed: {e}\nProceed with targeted search."));

let mut messages: Vec<Value> = vec![
    json!({ "role": "system", "content": SYSTEM_PROMPT }),
    json!({
        "role": "system",
        "content": format!(
            "Use this CodePlanner context before exploring files. Avoid broad repository scans unless necessary.\n\n{}",
            code_plan
        )
    }),
    json!({ "role": "user", "content": user_prompt }),
];
```

Emit simple progress logs:

```rust
emit_text_delta(app, "CodePlanner: preparing compact code context...".to_string());
emit_text_delta(app, "CodePlanner: context pack ready.".to_string());
```

If CodePlanner fails, do not fail the agent. Fall back to the old behavior with a warning.

### 2. Optional Tool: `code_plan`

Current status: do not expose `code_plan` to the model by default. Repeated planner calls during a run can grow message history and hurt performance.

Add a direct-agent tool named `code_plan`.

Purpose:

- Let the model ask for a narrower plan during execution.
- Avoid broad `grep` or repeated full-file reads.

Schema location:

- `src-tauri/src/core/mcp/agent_bridge.rs`

Execution location:

- `src-tauri/src/core/ollama_agent.rs`, inside `execute_tool`.

Tool behavior:

```rust
"code_plan" => {
    let task = args["task"].as_str().ok_or("code_plan: missing 'task'")?;
    build_code_plan(project_dir, task).await
}
```

## Phase 1 Heuristics

Keep the first version simple.

Skeleton extraction can be regex-based:

- JS/TS/TSX:
  - `function Name(`
  - `export function Name(`
  - `const Name = (`
  - `export const Name = (`
  - `class Name`
- Rust:
  - `fn name(`
  - `pub fn name(`
  - `struct Name`
  - `enum Name`
- Python:
  - `def name(`
  - `class Name`

Dependency hints can be shallow:

- JS/TS imports from `./` and `../`
- Rust `mod` and `use crate::`
- Python `import` and `from ... import ...`

Limit dependency depth to 1-2.

## Context Limits

Keep the plan small:

- Max relevant files: 40
- Max skeleton files: 20
- Max symbols per file: 20
- Max dependency depth: 2
- Target output: 12KB-20KB

If the plan gets too large, truncate low-confidence entries.

## What Not To Do In Phase 1

- Do not create a new MCP server.
- Do not modify CodeHelper.
- Do not change Ollama model settings.
- Do not change the legacy Claude backend.
- Do not add React UI unless needed for basic status display.
- Do not replace existing edit approval behavior.

## Verification

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

If cheap:

```bash
cargo test --manifest-path src-tauri/Cargo.toml agent_bridge
```

Manual smoke test:

1. Start the app.
2. Select the direct Ollama backend.
3. Run a coding request.
4. With default settings, confirm the agent log does not show CodePlanner progress.
5. With `ATOMIC_CODE_PLANNER=1`, confirm the agent log shows CodePlanner progress.
6. Confirm the model explores fewer files before editing only when the flag is enabled.
7. Confirm edit approval still works.

## Expected Benefit

This does not make `qwen3-coder-next:latest` smaller.

It should reduce:

- blind repository exploration
- prompt prefill size
- KV cache growth from unnecessary context
- repeated file reads
- total work done by the large model

The goal is to make the large model work on less, better context.
