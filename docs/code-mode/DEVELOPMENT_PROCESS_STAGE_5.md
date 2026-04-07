## Stage 5 — Upgrade: embed claw-code-local in-process

**Code tasks**

- Add `claw-code-local` crates as dependencies (or vendor/submodule) and execute the agent runtime in-process.
- Replace sidecar parsing with direct event emission.
- Keep the exact same UI contract so the frontend does not change.

**Testing tasks**

- Run the same contract + security suite used for sidecar mode.

**Exit criteria**

- No stdout parsing; permissions + workspace enforcement are deterministic and testable.

Practical checklist (recommended tasks before embedding)

- Specify dependency source and versioning for `claw-code-local` (git/path/crate) and verify the workspace dependency graph to avoid version conflicts.
- Verify async runtime compatibility (Tokio vs async-std) between `src-tauri` and `claw-code-local`; document required runtime features and adapters.
- Define Cargo feature flags for optional functionality; avoid enabling heavy features by default and document the chosen feature set.
- Implement contract-level tests validating event ordering, `permission_request`/`permission_resolved` flows, cancellation behavior, and `assistant_delta` streaming semantics.
- Ensure workspace safety and sandboxing: reproduce Stage 3 workspace boundary tests and enforce deny-by-default permission checks in embedded mode.
- Plan a staged removal of sidecar-specific code (feature-flagged or branch-based rollout) and ensure shared event-forwarding logic remains intact.
- Update Tauri build/packaging and CI to include the embedded dependency; add macOS CI jobs to verify packaging implications early.
- Replace stdout/stderr parsing with structured logging, event channels, and observability hooks (structured logs, spans, metrics) for debugging.
- Add a rollback / feature-flag strategy (build matrix, toggles) to allow reverting to sidecar if regressions are detected.


Clarifications & examples

- Dependency pinning: prefer a fixed `rev` or published version instead of floating `branch` to keep builds reproducible. Example:

```toml
# /src-tauri/Cargo.toml
[dependencies]
claw-code-local = { git = "https://github.com/your-org/claw-code-local", rev = "0123456abcdef" }
```

- Feature-flag example (switch between `sidecar` and `embedded` at build time):

```toml
[features]
default = ["sidecar"]
sidecar = []
embedded = ["claw-code-local/embed-runtime"]
```

- Async/runtime note: if `claw-code-local` uses `tokio`, ensure `src-tauri` enables the same runtime features (or provide a runtime adapter). Example dependency hint:

```toml
[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "time"] }
```

- Spike recommendation: add a minimal test file in `src-tauri` that imports the crate and calls a basic start/stop API to validate build and linkage quickly. Pseudocode:

```rust
// src-tauri/src/engine_spike.rs
pub fn engine_spike() -> Result<(), Box<dyn std::error::Error>> {
  // adapt to the actual crate API
  let mut engine = claw_code_local::Engine::new()?;
  engine.start()?;
  engine.stop()?;
  Ok(())
}
```

- CI / packaging note: add a CI job `embed-engine-macos` (matrix includes `macos-latest`) that runs `cargo build --manifest-path=src-tauri/Cargo.toml` and the spike test; fail on build or linkage errors.

- Observability: stop parsing stdout; use structured logging (`tracing`) and emit events/spans via the existing event-forwarding channel so debugging works without human parsing.

- Packaging size: embedding the engine may increase binary size—add a size-check step in CI and document any native dependencies required for packaging on macOS.


**Do / Don’t**

- Do: preserve the contract so migration is “engine swap”.
- Don’t: fork UI logic per engine.
