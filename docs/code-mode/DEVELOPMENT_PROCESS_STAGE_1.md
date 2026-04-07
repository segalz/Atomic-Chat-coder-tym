# Stage 1 — Backend: Ollama Agent Spawner

> **מה קיים:** `code_agent.rs` עם spawn/stop/stream — עובד עם Claude CLI ישן.
> **מה נדרש:** החלפה ל-`ollama launch claude` + הוספת check_ollama + list_ollama_models.

---

## Deliverables

- `spawn_code_agent()` מריץ `ollama launch claude --model <model>`
- `stop_code_agent()` עוצר תהליך (ללא zombies)
- `check_ollama()` מאמת ש-Ollama מותקן
- `list_ollama_models()` מחזיר מודלים מותקנים
- Events זורמים מה-stdout ל-frontend

---

## קובץ: `src-tauri/src/core/code_agent.rs`

### 1.1 — `find_ollama_binary()`

```rust
fn find_ollama_binary() -> Option<PathBuf> {
    // 1. חפש ב-PATH
    if let Ok(path) = which::which("ollama") {
        return Some(path);
    }
    // 2. נתיבים ידועים על macOS
    let known = [
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/usr/bin/ollama",
    ];
    for p in &known {
        if Path::new(p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    None
}
```

### 1.2 — `check_ollama()` (Tauri command)

```rust
#[tauri::command]
pub async fn check_ollama() -> Result<String, String> {
    let ollama = find_ollama_binary()
        .ok_or_else(|| "Ollama not found. Install: https://ollama.com".to_string())?;

    let output = tokio::process::Command::new(&ollama)
        .arg("--version")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let version = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string();

    if version.is_empty() {
        return Err("Ollama returned empty version".to_string());
    }

    Ok(version)
}
```

### 1.3 — `list_ollama_models()` (Tauri command)

```rust
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let ollama = find_ollama_binary()
        .ok_or_else(|| "Ollama not found".to_string())?;

    let output = tokio::process::Command::new(&ollama)
        .arg("list")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    // פורמט: "NAME  ID  SIZE  MODIFIED"
    // שורה ראשונה = header → skip
    let models: Vec<String> = stdout
        .lines()
        .skip(1)
        .filter_map(|line| {
            line.split_whitespace()
                .next()
                .map(|name| name.to_string())
        })
        .filter(|name| !name.is_empty())
        .collect();

    Ok(models)
}
```

### 1.4 — `spawn_code_agent()` (מעודכן)

```rust
// State גלובלי — process handle
static AGENT_CHILD: Mutex<Option<tokio::process::Child>> = Mutex::const_new(None);

#[tauri::command]
pub async fn spawn_code_agent(
    project_dir: String,
    prompt: String,
    ollama_model: String,      // "qwen3-coder:30b"
    permission_mode: String,   // "ask" | "auto_accept"
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let ollama = find_ollama_binary()
        .ok_or_else(|| "Ollama not found".to_string())?;

    // בנה את הפקודה
    let mut cmd = tokio::process::Command::new(&ollama);
    cmd.arg("launch").arg("claude");
    cmd.arg("--model").arg(&ollama_model);
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("-p").arg(&prompt);
    cmd.current_dir(&project_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // auto_accept = skip כל הבקשות לאישור
    if permission_mode == "auto_accept" {
        cmd.arg("--dangerously-skip-permissions");
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn ollama: {}", e)
    })?;

    // שמור handle לעצירה
    {
        let mut guard = AGENT_CHILD.lock().await;
        *guard = Some(child);
    }

    // Stream stdout → Tauri events
    let stdout = child.stdout.take().unwrap();
    let reader = tokio::io::BufReader::new(stdout);
    let mut lines = tokio::io::AsyncBufReadExt::lines(reader);

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() { continue; }

        // נסה לפרס JSON
        let event_type = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
            map_claude_event(&val)
        } else {
            // fallback — raw text
            AgentOutputLine {
                event_type: "assistant".to_string(),
                content: line.clone(),
                timestamp: chrono::Utc::now().timestamp_millis(),
            }
        };

        app_handle.emit("code-agent-output", &event_type).ok();
    }

    // Agent סיים
    app_handle.emit("code-agent-done", ()).ok();

    // נקה handle
    let mut guard = AGENT_CHILD.lock().await;
    *guard = None;

    Ok(())
}

/// ממפה event של claude CLI לפורמט ה-UI
fn map_claude_event(val: &serde_json::Value) -> AgentOutputLine {
    // יש לאמת ב-Stage 0 את הפורמט המדויק
    // ולעדכן את הפונקציה הזו בהתאם
    let event_type = val.get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("assistant");

    let content = val.get("text")
        .or_else(|| val.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    AgentOutputLine {
        event_type: map_type(event_type).to_string(),
        content,
        timestamp: chrono::Utc::now().timestamp_millis(),
    }
}

fn map_type(claude_type: &str) -> &str {
    match claude_type {
        "assistant" | "text" => "assistant",
        "tool_use"           => "tool_use",
        "tool_result"        => "tool_result",
        "system"             => "system",
        "result"             => "done",
        _                    => "assistant",
    }
}
```

### 1.5 — `stop_code_agent()` (קיים — לוודא)

```rust
#[tauri::command]
pub async fn stop_code_agent() -> Result<(), String> {
    let mut guard = AGENT_CHILD.lock().await;
    if let Some(mut child) = guard.take() {
        // kill process group כדי לא להשאיר zombies
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            if let Some(pid) = child.id() {
                unsafe { libc::killpg(pid as i32, libc::SIGTERM); }
            }
        }
        child.kill().await.ok();
        child.wait().await.ok();
    }
    Ok(())
}
```

---

## קובץ: `src-tauri/src/lib.rs`

```rust
.invoke_handler(tauri::generate_handler![
    // Code Mode — Ollama
    code_agent::spawn_code_agent,
    code_agent::stop_code_agent,
    code_agent::check_ollama,          // חדש
    code_agent::list_ollama_models,    // חדש

    // ... שאר commands קיימים
])
```

---

## Cancellation — התנהגות מוגדרת

| מצב | פעולה |
|---|---|
| SIGTERM נשלח | process מקבל graceful shutdown |
| אחרי 2 שניות | SIGKILL אם עדיין רץ |
| wait/reap | אחרי kill — חובה |
| event | `code-agent-done` עם `{ cancelled: true }` |

---

## Cargo.toml — תלויות נדרשות

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde"] }
which = "6"        # מציאת binary ב-PATH
libc = "0.2"       # SIGTERM/SIGKILL על Unix
```

---

## בדיקות הצלחה

- [ ] `check_ollama` → מחזיר version (e.g. "ollama version 0.6.x")
- [ ] `list_ollama_models` → מחזיר `["qwen3-coder:30b", ...]`
- [ ] `spawn_code_agent` (auto_accept) → ollama רץ, events זורמים, agent מבצע
- [ ] `spawn_code_agent` (ask) → ollama רץ ללא `--dangerously-skip-permissions`
- [ ] `stop_code_agent` → process נעצר, אין zombies
- [ ] בלי Ollama → שגיאה ברורה עם קישור להתקנה

---

## Do / Don't

- **Do:** אמת את flags של `ollama launch claude` ב-Stage 0 לפני מימוש
- **Do:** השתמש ב-`process group kill` על Unix
- **Do:** wait/reap אחרי kill
- **Don't:** תלה ב-stderr לparsing — רק stdout
- **Don't:** הנח שפורמט JSON של claude קבוע — אמת ב-Stage 0
