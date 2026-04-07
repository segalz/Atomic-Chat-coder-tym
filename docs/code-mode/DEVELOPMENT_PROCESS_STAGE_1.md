## Stage 1 — Backend: Agent service + sidecar engine (MVP)

### Stage 1 deliverables (what must exist after this stage)

- A **Tauri-backed agent service** that can run exactly one Code Mode run end-to-end (including permissions) using a sidecar engine.
- A **sidecar engine adapter** (`ClawSidecarEngine`) that speaks a **structured IO protocol** (NDJSON events out + structured control messages in).
- A reliable **cancel** implementation that does not leave zombie processes.

### Tauri API surface (make this explicit in code)

Define a stable command + event surface early (names can change, behavior must not):

- Commands (UI → backend):
  - `start_code_agent(run_config) -> run_id`
  - `send_code_agent_input(run_id, text)`
  - `respond_code_agent_permission(run_id, request_id, decision)`
  - `cancel_code_agent(run_id)`
- Events (backend → UI):
  - `code_agent_event` with payload matching the event schema in this doc (minimum set).

The backend must be the only place that:

- Parses engine output
- Decides whether to pause/resume the run
- Enforces workspace boundary rules (deny-by-default on ambiguity)

### Run state model (backend-owned)

Implement a per-run state machine in Rust (in-memory is fine for MVP):

- Identifiers: `run_id`, `workspace_root`, `model_id`
- Status: `starting | running | awaiting_permission | cancelling | finished | error`
- Engine handles: child process handle, stdout/stderr reader tasks, and an optional pending permission request `{ request_id, ... }`

This state machine is what prevents “stdin hacks” and UI race conditions.

**Code tasks**

- Implement an agent service in `src-tauri` that:
  - spawns the engine process
  - streams parsed events to the UI
  - supports cancel (kill + cleanup)
  - stores `run_id` + status state
- Implement `ClawSidecarEngine`:
  - configure `OPENAI_BASE_URL=http://localhost:1337/v1` and a non-empty `OPENAI_API_KEY`
  - pass through selected model id
  - emit NDJSON events (patch `claw-code-local` if needed to add an event-emitter mode)
- Implement a structured permission handshake:
  - engine emits `permission_request`
  - backend pauses run execution
  - UI replies allow/deny
  - backend forwards the decision

### Engine IO protocol (NDJSON) — do not depend on terminal formatting

For UI compatibility, the sidecar engine must support a mode that:

- Writes **one JSON object per line** on stdout (NDJSON).
- Accepts structured control messages on stdin (also NDJSON, or a clearly documented single-line protocol).

Example (engine → backend):

```json
{"type":"assistant_delta","run_id":"...","text_delta":"Hello"}
```

Example (backend → engine):

```json
{"type":"user_message","text":"Continue, but do not edit files yet."}
```

**Important:** do not ship Stage 1 relying on “pretty terminal output” + parsing. The UI must render events, not terminal text.
 
Robustness & implementation notes

- Partial JSON frames: NDJSON is stream-oriented; implement reading that tolerates partial writes (engine may write chunks). Use a buffered line reader and treat each newline-terminated line as one JSON object. If the engine may emit very long events, guard with a max-line length and drop/emit an error event on overflow.
- Stderr noise: do not treat stderr as events. Capture stderr to logs and surface `run_error` events for fatal stderr messages only. Prefer engine-side sinks for structured diagnostics.
- Timeouts and backpressure: apply read timeouts when awaiting critical control events (permission_resolved) to avoid deadlocks. Apply output buffering limits to avoid OOM on slow consumers.

Engine adapter skeleton (recommended starting point)

```rust
// ClawSidecarEngine (synchronous pseudocode - adapt async/Tokio as needed)
pub struct ClawSidecarEngine {
  child: std::process::Child,
}

impl ClawSidecarEngine {
  pub fn spawn(cmd: &str, args: &[&str], envs: &[(&str,&str)]) -> Result<Self> {
    let mut child = std::process::Command::new(cmd)
      .args(args)
      .envs(envs.iter().cloned())
      .stdin(std::process::Stdio::piped())
      .stdout(std::process::Stdio::piped())
      .stderr(std::process::Stdio::piped())
      .spawn()?;

    // Spawn stdout reader thread: read lines, parse JSON per-line
    let out = child.stdout.take().unwrap();
    std::thread::spawn(move || {
      let reader = std::io::BufReader::new(out);
      for line in reader.lines() {
        match line {
          Ok(l) => match serde_json::from_str::<serde_json::Value>(&l) {
            Ok(ev) => handle_event(ev),
            Err(e) => log::warn!("invalid json from engine: {}", e),
          },
          Err(e) => { log::error!("stdout read error: {}", e); break; }
        }
      }
    });

    // Stderr reader: pipe to structured logs
    let err = child.stderr.take().unwrap();
    std::thread::spawn(move || {
      let r = std::io::BufReader::new(err);
      for line in r.lines() { if let Ok(l)=line { log::error!("engine: {}", l); } }
    });

    Ok(Self { child })
  }

  pub fn write_control(&mut self, msg: &serde_json::Value) -> Result<()> {
    if let Some(stdin) = &mut self.child.stdin {
      let line = serde_json::to_string(msg)? + "\n";
      stdin.write_all(line.as_bytes())?;
      stdin.flush()?;
    }
    Ok(())
  }
}
```

Permission reason codes (recommended canonical set)

- `OUT_OF_WORKSPACE`
- `DESTRUCTIVE_COMMAND`
- `FILE_WRITE`
- `RUN_TESTS`
- `AMBIGUOUS_PERMISSION_REQUEST`
- `READ_ONLY_MODE_VIOLATION`

Use these codes in `permission_request` and `permission_resolved` so the backend and UI share a fixed vocabulary.

Mock engine (small test helper)

Provide a tiny mock binary for tests that emits NDJSON events and waits for permission decisions on stdin. Example pseudocode (Rust):

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
  // emit run_started
  println!("{}", serde_json::json!({"type":"run_started","run_id":"mock","workspace_root":"."}));
  // emit assistant_delta
  println!("{}", serde_json::json!({"type":"assistant_delta","run_id":"mock","text_delta":"Hello"}));
  // request permission
  println!("{}", serde_json::json!({"type":"permission_request","run_id":"mock","request_id":"r1","tool_name":"write_file","reason_code":"FILE_WRITE","paths":["/path"]}));
  // read stdin for decision line
  let mut input = String::new();
  std::io::stdin().read_line(&mut input)?;
  // echo permission_resolved and finish
  println!("{}", serde_json::json!({"type":"permission_resolved","run_id":"mock","request_id":"r1","decision":"allow"}));
  println!("{}", serde_json::json!({"type":"run_finished","run_id":"mock","summary":"done"}));
  Ok(())
}
```

Testing & CI guidance (practical)

- Add a `mock-engine` binary under `rust/tools/mock-engine` that tests NDJSON parsing and permission handshake. Use it in integration tests to validate the adapter without requiring the real engine.
- Unit tests: parse partial JSON chunks (simulate line-splitting), verify handler recovers from invalid JSON lines, verify write_control marshals newline-delimited JSON.
- Integration tests: spawn `mock-engine`, start an `AgentRun`, assert event sequence, send permission decision via `write_control`, assert continuation and final `run_finished`.

### Permissions: structured handshake (no PTY/TTY prompts)

The engine must surface permission requests as explicit events and wait for a decision:

1. Engine emits:
   - `permission_request { request_id, tool_name, required_mode, input, reason_code?, reason?, tool_call_id?, test_id?, paths?, command?, argv? }`
2. Backend transitions run state to `awaiting_permission` and forwards the event to UI.
3. UI responds with allow/deny.
4. Backend sends a structured decision back to the engine:
   - `permission_decision { request_id, decision, reason_code?, reason?, tool_call_id?, test_id? }`
5. Engine continues and emits `permission_resolved`.

**Known gap to address:** the current `claw-code-local` CLI uses a human prompt (`Approve this tool call? [y/N]:`) and reads from stdin. That is not sufficient for a robust UI integration. Stage 1 includes adding a dedicated **UI/NDJSON mode** (or equivalent) so permission requests/decisions are machine-readable and deterministic.

### Cancellation & cleanup (define behavior precisely)

Cancel must:

- Transition state to `cancelling`
- Terminate the engine process (prefer killing the process group on Unix)
- Stop stdout/stderr reader tasks
- Emit `run_finished` (or `run_error` with a clear “cancelled” reason)
- Guarantee no zombies (wait/reap the child)

Define timeouts:

- Grace period for clean shutdown
- Escalation to forced kill if needed

**Testing tasks**

- Unit: base URL builder and model mapping.
- Unit: event parsing (partial chunks, ordering, stderr).
- Integration: mock-engine binary that emits NDJSON + accepts permission decisions.
  - Include a cancel test: start mock engine, cancel mid-stream, assert the process is gone and the run reaches a terminal state.

**Exit criteria**

- Start → stream → permission request → allow/deny → continue → finish works end-to-end.
- Cancel is reliable and does not leave zombie processes.

**Do / Don’t**

- Do: build around structured events only.
- Don’t: rely on PTY/TTY prompt flows for permissions in the UI path.

---

