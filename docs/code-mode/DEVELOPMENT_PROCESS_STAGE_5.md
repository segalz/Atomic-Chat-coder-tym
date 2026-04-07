# Stage 5 — שיפורים עתידיים: Model Hub + Cleanup

> **שינוי מהתוכנית המקורית:** Stage 5 הקודם היה "embed claw-code-local".
> עכשיו אנחנו עם `ollama launch claude` — אין צורך ב-embedding.
> Stage 5 מתמקד בשיפוש UX ו-cleanup.

---

## Deliverables

- [ ] ניקוי קוד ישן (Claude CLI / Cline CLI)
- [ ] i18n מלא לכל מחרוזות Code Mode
- [ ] Model Hub — הורדת מודלים ישירות מה-UI
- [ ] Tests מקיפים
- [ ] E2E עם `ollama launch claude` אמיתי

---

## שלב 5.1 — ניקוי קוד ישן

### Rust

```rust
// הסר מ-code_agent.rs:
// - find_claude_binary()
// - find_cline_binary()
// - check_claude_cli()
// - check_cline_cli()
// - כל env vars של Anthropic (ANTHROPIC_BASE_URL, etc.)

// הסר מ-lib.rs:
// - check_claude_cli
// - check_cline_cli
```

### TypeScript

```typescript
// הסר מ-CodeModePanel.tsx:
// - port discovery (plugin:mlx|find_mlx_session_by_model)
// - plugin:llamacpp|find_session_by_model
// - serverUrl state

// הסר routes לא בשימוש:
// - web-app/src/routes/project-mode/ (אם קיים)
```

---

## שלב 5.2 — i18n מלא

```json
{
  "codeMode": "Code",
  "chatMode": "Chat",
  "selectCodeModel": "בחר מודל קוד",
  "ollamaRequired": "Ollama נדרש",
  "ollamaRequiredDescription": "Code Mode דורש Ollama עם מודל מקומי.",
  "installOllama": "התקן Ollama",
  "checkAgain": "בדוק שוב",
  "modelNotInstalled": "המודל לא מותקן",
  "pullCommand": "ollama pull {model}",
  "copyCommand": "העתק פקודה",
  "agentRunning": "Agent פועל...",
  "stopAgent": "עצור",
  "sendPrompt": "שלח",
  "browseFolder": "בחר תיקייה",
  "projectFolder": "תיקיית פרויקט",
  "ollamaStatus": "Ollama {version}",
  "modelInstalled": "{model} מותקן",
  "noProjectSelected": "בחר תיקיית פרויקט להתחיל",
  "permissionAsk": "שאל הרשאות",
  "permissionAutoAccept": "קבל הכל אוטומטית",
  "approveAction": "אפשר",
  "denyAction": "דחה",
  "copyAll": "העתק הכל",
  "clearOutput": "נקה"
}
```

---

## שלב 5.3 — Model Hub (הורדת מודלים מה-UI)

### UI

```
┌──────────────────────────────────────────────────┐
│  Model Hub                                        │
├──────────────────────────────────────────────────┤
│  ✅ qwen3-coder:30b          ~20 GB    [הסר]      │
│  ✅ qwen2.5-coder:7b         4.7 GB    [הסר]      │
├──────────────────────────────────────────────────┤
│  Qwen3-Coder-Next   52 GB   SWE 70.6%  [הורד]   │
│  DeepSeek-Coder V2   9 GB              [הורד]    │
└──────────────────────────────────────────────────┘
```

### Rust command

```rust
#[tauri::command]
pub async fn pull_ollama_model(
    model_id: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let ollama = find_ollama_binary().ok_or("Ollama not found")?;

    let mut child = tokio::process::Command::new(&ollama)
        .arg("pull")
        .arg(&model_id)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    // stream progress → UI
    let stdout = child.stdout.take().unwrap();
    let reader = tokio::io::BufReader::new(stdout);
    let mut lines = tokio::io::AsyncBufReadExt::lines(reader);

    while let Ok(Some(line)) = lines.next_line().await {
        app_handle.emit("ollama-pull-progress", &line).ok();
    }

    child.wait().await.map_err(|e| e.to_string())?;
    Ok(())
}
```

---

## שלב 5.4 — Tests

### Unit tests (Rust)

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn test_validate_workspace_rejects_root() {
        assert!(validate_workspace("/").is_err());
    }

    #[test]
    fn test_validate_workspace_rejects_nonexistent() {
        assert!(validate_workspace("/nonexistent/path/xyz").is_err());
    }

    #[test]
    fn test_validate_workspace_accepts_valid_dir() {
        assert!(validate_workspace("/tmp").is_ok());
    }
}
```

### Frontend tests

```typescript
// code-mode-store.test.ts
test('codeModel persists between sessions', () => {
  const { setCodeModel } = useCodeModeStore.getState()
  setCodeModel('qwen3-coder-next')
  // simulate reload
  expect(useCodeModeStore.getState().codeModel).toBe('qwen3-coder-next')
})

test('availableCodeModels resets on reload', () => {
  // availableCodeModels לא ב-persist
  expect(useCodeModeStore.getState().availableCodeModels).toEqual([])
})
```

### E2E בדיקות

- [ ] Chat Mode → לא נפגע
- [ ] Toggle Chat ↔ Code → חלק
- [ ] Code Mode: בחר מודל → נשמר
- [ ] Code Mode: ללא Ollama → הודעה ברורה
- [ ] Code Mode: ללא מודל → הוראת pull
- [ ] Code Mode: auto_accept → agent מבצע ללא שאלות
- [ ] Code Mode: ask → agent עוצר לאישור
- [ ] Code Mode: Stop → agent נעצר
- [ ] Code Mode: ללא projectDir → שגיאה

---

## שלב 5.5 — עתידי: Bundle Ollama

> אם רוצים **אפס התקנות** למשתמש:

```
אפשרות א: Bundle ollama binary עם הapp
  → Tauri sidecar: ollama binary מוכלל ב-bundle
  → auto-install models ב-first run
  → גדול יותר (~100MB+) אבל seamless

אפשרות ב: Ollama auto-installer
  → בכניסה ראשונה לCode Mode: הצג wizard
  → "Code Mode דורש Ollama — להתקין?"
  → הפעל installer script

אפשרות ג: כבר כמו שיש (user מתקין Ollama)
  → הכי פשוט לפיתוח
  → Ollama פופולרי — רוב developers כבר מותקן
```

---

## Do / Don't

- **Do:** נקה קוד ישן לפני release
- **Do:** i18n על כל מחרוזת נראית למשתמש
- **Don't:** הוסף Model Hub לפני שה-MVP עובד
- **Don't:** Bundle Ollama בשלב ראשון — יסבך את הbuild
