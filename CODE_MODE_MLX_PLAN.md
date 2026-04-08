# Code Mode — MLX Engine Support (Option A)

## Context

Code Mode currently spawns `ollama launch claude` to run the Claude Code agent.
This plan adds an `"mlx"` engine path that spawns the `claude` CLI **directly**,
redirecting it to the app's existing proxy server (`proxy.rs`) via environment
variables. No Claude CLI config files are touched.

### How it works

```
claude CLI
  └─ ANTHROPIC_BASE_URL=http://127.0.0.1:{proxy_port}
  └─ ANTHROPIC_API_KEY={proxy_api_key}
         │
         ▼
  App proxy (proxy.rs, already running on port 1337 by default)
  └─ receives  POST /v1/messages  (Anthropic format)
  └─ tries     MLX /v1/messages   → 404
  └─ fallback  transform_anthropic_to_openai()
             → POST /v1/chat/completions  (OpenAI format)
             → transform_and_forward_stream()  (OpenAI SSE → Anthropic SSE)
         │
         ▼
  MLX server  (localhost:{mlx_session_port})
```

---

## DO / DO NOT

### ✅ DO
- Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` as **process-level env vars** on the spawned `claude` child process only
- Reuse the existing `CodeAgentState`, `CodeAgentDoneEvent`, and all streaming/diff logic unchanged
- Detect the engine type in the **frontend** (if the chosen model is in the MLX session list → engine `"mlx"`, else → engine `"ollama"`)
- Keep the Ollama path 100% unchanged — only add an `else if` branch
- Guard: if engine is `"mlx"` and proxy is not running, return a clear error string to the frontend before spawning
- Use `ANTHROPIC_API_KEY` (not `ANTHROPIC_AUTH_TOKEN`) — that is what the `claude` CLI reads

### ❌ DO NOT
- Do **not** write to `~/.claude/`, `~/.config/claude/`, or any Claude CLI config file
- Do **not** modify or restart the proxy server from `code_agent.rs` — that is the frontend's responsibility
- Do **not** rename the existing `ollama_model` parameter in the Tauri command — add new params alongside it to avoid a breaking change in the JS invoke call structure
- Do **not** add LiteLLM as a dependency
- Do **not** change the proxy logic in `proxy.rs` — the existing fallback mechanism already handles Anthropic → MLX correctly
- Do **not** add a new Tauri plugin or crate
- Do **not** modify any test files

---

## Files to change

| File | Change |
|------|--------|
| `src-tauri/src/core/code_agent.rs` | Add `engine`, `proxy_port`, `proxy_api_key` params; add `find_claude_binary()`; add MLX branch |
| `web-app/src/containers/CodeModePanel.tsx` | Import `useLocalApiServer` + `useAppState`; detect engine; pass new params |
| `web-app/src/components/CodeModelSelector.tsx` | Add MLX section showing running MLX sessions |

---

## Stage 1 — Rust backend (`code_agent.rs`)

### 1-A  Add `find_claude_binary()`

Add after the existing `find_ollama_binary()` function (around line 657):

```rust
/// Find the `claude` CLI binary.
/// Searches the augmented PATH (same nvm/volta dirs used by spawn_code_agent),
/// then falls back to known fixed locations.
fn find_claude_binary(extra_paths: &[PathBuf]) -> Option<PathBuf> {
    // Search extra_paths first (nvm versions, volta, homebrew)
    for dir in extra_paths {
        let candidate = dir.join("claude");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // Then fall back to system PATH
    if let Some(paths) = env::var_os("PATH") {
        for entry in env::split_paths(&paths) {
            let candidate = entry.join("claude");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
```

### 1-B  Update `spawn_code_agent` signature

Change from:
```rust
pub async fn spawn_code_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
    project_dir: String,
    prompt: String,
    ollama_model: String,
    permission_mode: String,
) -> Result<(), String>
```

To (add three new params at the end, keep existing names intact):
```rust
pub async fn spawn_code_agent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CodeAgentState>,
    project_dir: String,
    prompt: String,
    ollama_model: String,
    permission_mode: String,
    engine: String,           // "ollama" | "mlx"
    proxy_port: Option<u16>,  // required when engine == "mlx"
    proxy_api_key: Option<String>, // required when engine == "mlx"
) -> Result<(), String>
```

### 1-C  Add MLX branch in `spawn_code_agent`

Replace the block starting at `// Build the ollama launch command` (line ~207)
with an `if engine == "mlx" { ... } else { ... }` structure:

**Ollama branch** — keep exactly as-is, just wrapped in `else`.

**MLX branch** — new code:
```rust
if engine == "mlx" {
    // Validate required params
    let port = proxy_port.ok_or("proxy_port is required for MLX engine")?;
    let api_key = proxy_api_key.unwrap_or_default();

    log::info!("[CodeAgent] Building MLX/claude-direct command:");
    log::info!("  mlx_model:   {}", ollama_model);
    log::info!("  proxy_port:  {}", port);

    // Build extra PATH (same as ollama branch)
    let home = dirs::home_dir().unwrap_or_default();
    let mut extra_paths: Vec<PathBuf> = vec![
        home.join(".volta/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];
    let nvm_versions_dir = home.join(".nvm/versions/node");
    if nvm_versions_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            versions.sort_unstable_by(|a, b| b.cmp(a));
            extra_paths.splice(0..0, versions);
        }
    }

    let claude_bin = find_claude_binary(&extra_paths)
        .ok_or_else(|| "claude binary not found. Install with: npm i -g @anthropic-ai/claude-code".to_string())?;

    let current_path = std::env::var("PATH").unwrap_or_default();
    let prepend = extra_paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":");

    let mut cmd = Command::new(&claude_bin);
    cmd.arg("--model").arg(&ollama_model)
        .arg("-p")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose");

    if permission_mode == "auto_accept" {
        cmd.arg("--dangerously-skip-permissions");
    }

    cmd.arg(&prompt);

    cmd.env("ANTHROPIC_BASE_URL", format!("http://127.0.0.1:{}", port));
    cmd.env("ANTHROPIC_API_KEY", &api_key);
    cmd.env("PATH", format!("{}:{}", prepend, current_path));
    cmd.current_dir(&workspace);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    cmd
} else {
    // ... existing ollama branch, unchanged ...
}
```

> **Note:** The `if/else` must produce a `Command` value that feeds into the
> existing `cmd.spawn()` call below. Refactor the tail of `spawn_code_agent`
> so `cmd` is returned from the branch and the rest of the function
> (spawn, stdout/stderr readers, etc.) is shared.

### Stage 1 verification

```bash
cd src-tauri
cargo check --features mlx 2>&1 | grep -E "error|warning.*unused"
```
Expected: zero errors. Warnings about unused variables are acceptable temporarily.

---

## Stage 2 — Frontend: `CodeModelSelector.tsx`

Add a second section to the dropdown that lists **currently running MLX sessions**.

### 2-A  Fetch running MLX sessions

Inside `CodeModelSelector`, add a `useState` + `useEffect` that calls:
```ts
invoke<string[]>('plugin:mlx|get_mlx_loaded_models')
```
Store the result in local state `mlxModels: string[]`.

On any error (MLX plugin not available / macOS only), set `mlxModels = []` silently.

### 2-B  Render MLX section

After the existing `recommended` section in the dropdown, add:
```tsx
{mlxModels.length > 0 && (
  <>
    <DropdownMenuSeparator />
    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
      MLX (running)
    </div>
    {mlxModels.map((model) => (
      <DropdownMenuItem
        key={`mlx:${model}`}
        onClick={() => onChange(`mlx:${model}`)}
        className="flex items-center justify-between gap-2"
      >
        <div className="flex flex-col">
          <span className="font-medium">{model}</span>
          <span className="text-xs text-muted-foreground">MLX • on-device</span>
        </div>
        {value === `mlx:${model}` && <span>✓</span>}
      </DropdownMenuItem>
    ))}
  </>
)}
```

**Convention:** MLX model IDs in Code Mode are prefixed with `mlx:` (e.g. `mlx:mlx-community/Qwen3-8B`). This prefix is the signal for engine detection in `CodeModePanel`.

### Stage 2 verification

Open the app, load an MLX model via the main chat panel, then open Code Mode.
The model selector dropdown should show an "MLX (running)" section with the loaded model.

---

## Stage 3 — Frontend: `CodeModePanel.tsx`

### 3-A  Import server state

Add at the top of the file:
```ts
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useAppState } from '@/hooks/useAppState'
```

Inside the component, read:
```ts
const { serverPort, apiKey } = useLocalApiServer()
const serverStatus = useAppState((state) => state.serverStatus)
```

### 3-B  Derive engine + model from `codeModel`

Replace the existing single `codeModel` usage in `handleSend` with:
```ts
const isMlxModel = codeModel.startsWith('mlx:')
const engine = isMlxModel ? 'mlx' : 'ollama'
const resolvedModel = isMlxModel ? codeModel.slice(4) : codeModel
// e.g. "mlx:mlx-community/Qwen3-8B" → "mlx-community/Qwen3-8B"
```

### 3-C  Guard: proxy must be running for MLX

At the start of `handleSend`, before the `invoke` call:
```ts
if (isMlxModel && serverStatus !== 'running') {
  appendOutput({
    type: 'error',
    content: t('code-mode:proxyNotRunning'),   // add to i18n
    timestamp: Date.now(),
  })
  return
}
```

### 3-D  Update `invoke` call

Change:
```ts
await invoke('spawn_code_agent', {
  projectDir,
  prompt: promptToSend,
  ollamaModel: codeModel,
  permissionMode,
})
```

To:
```ts
await invoke('spawn_code_agent', {
  projectDir,
  prompt: promptToSend,
  ollamaModel: resolvedModel,
  permissionMode,
  engine,
  proxyPort:   isMlxModel ? serverPort : null,
  proxyApiKey: isMlxModel ? apiKey     : null,
})
```

### 3-E  Add i18n key

In the relevant `en.json` (or `he.json`) translation file under the `code-mode`
namespace, add:
```json
"proxyNotRunning": "Local API Server must be running to use MLX models. Enable it in Settings → Local API Server."
```

### Stage 3 verification

With MLX model loaded and Local API Server running:
1. Select the MLX model in Code Mode selector
2. Click Run
3. Confirm in Tauri logs: `[CodeAgent] Building MLX/claude-direct command`
4. Confirm `claude` process spawns (check Activity Monitor or `ps aux | grep claude`)
5. Confirm output events appear in the UI panel

With Local API Server **stopped**:
1. Select MLX model, click Run
2. Confirm the error message `proxyNotRunning` appears in the output panel
3. No `claude` process spawns

---

## Stage 4 — End-to-end smoke test

Prerequisites:
- MLX model loaded in the app (e.g. via Settings → Models → load an MLX model)
- Local API Server running (Settings → Local API Server → Start)
- `claude` CLI installed globally: `npm i -g @anthropic-ai/claude-code`

Test steps:
1. Open Code Mode panel
2. Select the MLX model from the dropdown (it should appear under "MLX (running)")
3. Choose a small test project directory
4. Type: `List the files in the root of this project`
5. Click Run
6. Verify: thinking bubble + file read tool call appear in the output
7. Click Stop — verify the agent stops cleanly
8. Check Tauri logs for `[CodeAgent] Process finished` or `[CodeAgent] Stopped by user`

---

## Out of scope (do not implement)

- Auto-starting the Local API Server when Code Mode is opened — left to user configuration
- Auto-detecting which MLX model the user wants to load — user loads it via main chat UI
- Changing the default proxy port or API key generation
- Supporting MLX models that are not currently loaded (only running sessions are shown)
