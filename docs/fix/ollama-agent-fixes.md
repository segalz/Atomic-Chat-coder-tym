# Code Review — Required Fixes

## 1. `run_shell` missing timeout (HIGH)

**File:** `src-tauri/src/core/ollama_agent.rs`

Wrap the shell command with `tokio::time::timeout` to prevent the agent from hanging
indefinitely when the LLM runs a blocking command (e.g. `yarn install`, `cargo build`).

```rust
// Before
let output = tokio::process::Command::new("sh")
    .arg("-c")
    .arg(command)
    .current_dir(cwd)
    .output()
    .await
    .map_err(|e| format!("run_shell failed: {}", e))?;

// After
let output = tokio::time::timeout(
    Duration::from_secs(60),
    tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .output(),
)
.await
.map_err(|_| "run_shell timed out after 60s".to_string())?
.map_err(|e| format!("run_shell failed: {}", e))?;
```

---

## 2. Hardcoded `/home/user/project` fallback (HIGH)

**File:** `src-tauri/src/core/ollama_agent.rs`

The default fallback path in `resolve_path` calls is a Linux path that does not exist on macOS.
Replace it with the actual `project_dir` that is already available in scope.

```rust
// Before
let result = resolve_path(&args, "path", "/home/user/project").unwrap();

// After
let result = resolve_path(&args, "path", project_dir)
    .map_err(|e| format!("resolve_path failed: {}", e))?;
```

Also replace `.unwrap()` with proper error propagation using `?` or `.map_err(...)`.

---

## 3. `build_code_plan` depends on `rg` with no fallback (MEDIUM)

**File:** `src-tauri/src/core/ollama_agent.rs`

If `ripgrep` is not installed the code plan step fails silently or panics.
Either check for availability at startup and surface a clear error, or implement
a native Rust fallback using `walkdir`.

```rust
// Add at the top of build_code_plan
let rg_available = tokio::process::Command::new("rg")
    .arg("--version")
    .output()
    .await
    .is_ok();

if !rg_available {
    return Err("CodePlanner requires ripgrep (rg). Install it with: brew install ripgrep".into());
}
```

---

## 4. `prune_context` drops the initial user message (MEDIUM)

**File:** `src-tauri/src/core/ollama_agent.rs`

The current pruning strategy keeps the system message and the last 30 messages,
but may discard the very first user message that contains the original task description.
After pruning, the agent can lose track of what it was asked to do.

Fix: preserve the first `user` role message in addition to the system message.

```rust
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

    // Preserve the first user message (original task)
    let first_user = non_system
        .iter()
        .find(|m| m["role"].as_str() == Some("user"))
        .cloned();

    let keep_start = non_system.len().saturating_sub(CONTEXT_KEEP_RECENT);

    let mut kept: Vec<Value> = system;
    if let Some(first) = first_user {
        // Add first user message only if it isn't already in the kept window
        if keep_start > 0 {
            kept.push(first);
        }
    }
    kept.extend(non_system.into_iter().skip(keep_start));

    *messages = kept;
}
```

---

## 5. `CodingAgentPanel` component too large (MEDIUM)

**File:** `web-app/src/containers/CodingAgentPanel/index.tsx`

The component is 1,539 lines with 64 hooks. It handles Ollama status checks,
LSP setup, loop scheduler, diff approval, model selection, and file browsing —
all in one place. This makes it hard to test and maintain.

Recommended split:

| New file | Responsibility |
|----------|---------------|
| `useOllamaStatus.ts` | Ollama health check and restart logic |
| `useLoopScheduler.ts` | Loop timer state (loopTimes, loopInterval, loopEnabled, loopCountdown) |
| `useLspSetup.ts` | LSP initialization and diagnostics pipeline |
| `useDiffApproval.ts` | Pending diff and edit intent state |

Each hook can be independently tested and the main component becomes a
thin composition layer.
