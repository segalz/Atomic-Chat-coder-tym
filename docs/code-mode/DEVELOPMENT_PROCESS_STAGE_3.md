## Stage 3 — Safety: workspace boundaries + destructive command guardrails

### Stage 3 deliverables (what must exist after this stage)

- **Defense-in-depth**: the backend is the final authority for workspace boundaries and dangerous commands, even if the engine also enforces them.
- A deterministic permission decision policy that is:
  - **deny-by-default** on ambiguity
  - consistent across file tools and shell tools
- A test suite that proves:
  - path traversal + symlink escapes are blocked
  - destructive shell commands are blocked or require explicit approval

### Primary backend files to touch (recommended)

- Agent service (permission decision point): `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/src-tauri/src/core/code_agent.rs`
- (Recommended) Policy module: `/Users/zvisegal/devlope/Atomic-Chat-coder-tym/src-tauri/src/core/code_agent/policy.rs`

### Where enforcement happens (important)

In sidecar mode, the backend cannot “intercept” filesystem writes directly. The enforcement point is:

- Every `permission_request` event coming from the engine → backend evaluates → backend replies allow/deny.

Therefore:

- The `permission_request` payload must be machine-readable. Do **not** rely on parsing human prompt text.
- Minimum required structured fields (recommended to include as top-level fields on the event):
  - File tools: `paths: string[]` (all target paths the tool intends to read/write/edit)
  - Shell tools: `argv: string[]` (preferred) or `command: string` (fallback)
- Correlation fields (recommended):
  - Tool calls: `tool_call_id` (so the UI can associate the permission prompt with a specific tool call)
  - Test runs: `test_id` (so the UI can associate the permission prompt with the correct test run)
- If these fields are missing or cannot be extracted confidently, the backend must **deny** (fail closed) with a clear reason (e.g. `AMBIGUOUS_PERMISSION_REQUEST`).

If the engine currently emits only a human-oriented prompt or an unstructured blob, Stage 1 must include a patch to the engine’s “UI/NDJSON mode” to emit structured permission events suitable for backend enforcement.

If the backend cannot confidently evaluate the request, it must deny (fail closed).

### Permission decision scoping (one request only)

For safety and predictability, treat approvals/denials as **single-request decisions**:

- A decision applies only to one `request_id` (never “approve forever”).
- Do not cache “allow” across multiple requests unless you intentionally ship a separate feature (and document it).
- For high-risk cases (out-of-workspace or destructive commands), require explicit user approval every time.

To enable correct UI warnings, use reason codes consistently:

- `OUT_OF_WORKSPACE`
- `DESTRUCTIVE_COMMAND`
- `RUN_TESTS`
- `AMBIGUOUS_PERMISSION_REQUEST`
- `READ_ONLY_MODE_VIOLATION`

### Workspace boundary algorithm (backend)

Precompute once per run:

- `workspace_root_canon = canonicalize(workspace_root)`

For every path-like target extracted from the permission request:

1. Convert to an absolute candidate path:
   - if `target` is absolute → use it
   - if `target` is relative → `candidate = workspace_root.join(target)`
2. Canonicalize in a way that handles **new files** safely:
   - If `candidate` exists → `target_canon = canonicalize(candidate)`
   - If `candidate` does not exist:
     - `parent = candidate.parent()` must exist
     - `parent_canon = canonicalize(parent)`
     - `target_canon = parent_canon.join(candidate.file_name())`
3. Enforce boundary:
   - allow only if `target_canon.starts_with(workspace_root_canon)`
4. On any error (missing parent, canonicalize failure, missing filename) → **deny**

Notes:

- Canonicalization resolves symlinks, so a symlink escape inside the workspace will resolve outside and fail the `starts_with` check.
- Do not use string-prefix checks; use path-aware `starts_with`.
- On Windows, prefer `dunce::canonicalize`-style behavior to avoid path normalization pitfalls.

### Out-of-workspace actions (override semantics)

Default policy (recommended):

- **Always deny** any request that targets outside `workspace_root`.

Optional advanced override (if you later support it):

- Only enabled when `run_config.allow_out_of_workspace == true`.
- Requires a “strong warning” UX and a one-time confirmation.
- Approval should be scoped to **one request only** (never “forever”).

### Destructive shell command guardrails (backend)

Treat shell permissions as a classification problem:

- **deny**: commands that are obviously destructive or system-level (examples: `rm -rf`, `mkfs`, `dd`, `shutdown`, `reboot`).
- **prompt**: commands that write to disk, mutate git state, or involve redirection (examples: `>`, `>>`, `git commit`, `git reset`, `sed -i`).
- **auto-allow** (optional): clearly read-only commands (examples: `rg`, `ls`, `cat`, `git status`, `git diff`) in non-read-only mode.

Implementation guidance:

- Prefer structured data:
  - if the engine provides `argv`, evaluate based on tokens rather than substring matching.
  - if only a raw command string is available, be conservative (prompt or deny).
- If the command contains redirection (`>`, `>>`) or here-doc patterns → treat as write (prompt).
- If the command contains shell control operators (`;`, `&&`, `||`, `|`) → treat as at least prompt (often deny if combined with risky programs).
- If the command contains `sudo` → treat as deny by default.
- If the command looks like “download and execute” (examples: `curl ... | sh`, `wget ... | bash`) → treat as deny by default.
- In `read-only` mode: deny any shell command that is not clearly read-only.

### Never allow bypass / auto-approve modes

- Do not run the engine in modes that skip permission checks.
- The UI path must always route tool execution through explicit permission logic.

### Testing tasks

- Unit tests (policy):
  - `../` traversal attempts are denied
  - symlink escape attempts are denied
  - out-of-root writes are denied
  - new-file write: parent canonicalization works and still enforces boundary
- Unit tests (permission request parsing):
  - missing `paths/argv/command` → denied with `AMBIGUOUS_PERMISSION_REQUEST`
- Unit tests (shell classification):
  - deny-list examples (`rm -rf`, `mkfs`, `dd`) are denied
  - prompt examples (`git commit`, redirections) require approval
  - allowlist examples (`rg`, `git status`) can be auto-allowed (if you enable that policy)
- Integration tests:
  - engine emits permission request → backend denies → engine continues and reports denial cleanly

### Exit criteria

- Out-of-workspace modifications are blocked regardless of engine behavior.
- Dangerous shell commands are denied or gated behind explicit approval (based on policy).

### Do / Don’t

- Do: fail closed on ambiguity.
- Do: enforce in backend and engine (defense in depth).
- Don’t: trust the engine as the only enforcement layer.

---

