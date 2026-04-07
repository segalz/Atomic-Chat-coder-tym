# Atomic Chat — Code Mode עם Ollama + Claude Code

> **עדכון ארכיטקטורה (2026-04-07):** עברנו ל-**`ollama launch claude`** כ-engine.
> הסיבה: פקודה אחת, Ollama מנהל הכל (מודל + API + agent), בחירת מודל חופשית.
> **100% מקומי, 0 עלות, פרטיות מלאה.**

---

## חזון

```
משתמש בוחר מודל קוד (Qwen3-Coder-30B / qwen3-coder-next / כל מודל Ollama)
   ↓
Atomic Chat מריץ: ollama launch claude --model <selected>
   ↓
Claude Code agent רץ על הפרויקט עם המודל המקומי
   ↓
הפלט זורם ל-CodeModePanel בזמן אמת
```

### מבנה Header — Code Mode

```
┌─────────────────────────────────────────────────────────────┐
│  ☘ Qwen3-Coder-30B ▽  ⚙  ●     [ Chat     Code ]          │
│    ↑ Code Mode model selector (נפרד מ-Chat)                 │
└─────────────────────────────────────────────────────────────┘
```

### מסך Code Mode

```
┌─────────────────────────────────────────────────────────────┐
│  Header: [Qwen3-Coder-30B ▽]  ⚙ ●   [ Chat | ▪Code ]      │
├─────────────────────────────────────────────────────────────┤
│  📁 /Users/zvi/projects/my-app                [Browse]      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  📖 Reading src/components/Form.tsx...                       │
│  ✏️  Editing line 87: fixed lastName setter...               │
│  💻 Running: npm test...                                     │
│  ✅ All tests passed. 1 file changed.                        │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  [Ask permissions ▽]                                         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  תקן את הבאג בטופס הדיווח...              [→] / [■] │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### ארכיטקטורה

```
┌─ Atomic Chat (Tauri) ─────────────────────────────────────────┐
│                                                                │
│  React Frontend                                                │
│  ├─ Header: CodeModelSelector (▽) + [Chat | Code] toggle      │
│  ├─ Chat Mode: כמו היום (ללא שינוי)                           │
│  └─ Code Mode: ProjectBar + PermissionSelector + OutputPanel  │
│         │                                                      │
│         │ invoke('spawn_code_agent', {                         │
│         │   projectDir, prompt,                                │
│         │   ollamaModel,      ← "qwen3-coder:30b"             │
│         │   permissionMode }) ← "ask" | "auto_accept"         │
│         ▼                                                      │
│  Rust Backend — code_agent.rs                                  │
│  ├─ spawn_code_agent()  → spawns ollama subprocess             │
│  ├─ stop_code_agent()   → kills subprocess                     │
│  ├─ check_ollama()      → ollama --version                     │
│  ├─ list_ollama_models()→ ollama list (מסנן מודלי קוד)         │
│  └─ streams stdout → emits Tauri events → frontend            │
│         │                                                      │
│         │  ollama launch claude \                              │
│         │    --model qwen3-coder:30b \                         │
│         │    [--dangerously-skip-permissions] (auto_accept)    │
│         │    -p "{prompt}"                                     │
│         ▼                                                      │
│  Ollama (installed locally — חד פעמי)                          │
│  ├─ מנהל את המודל (download, serve, inference)                 │
│  ├─ Claude Code agent loop built-in                            │
│  └─ Qwen3-Coder-30B / qwen3-coder-next / כל מודל             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## מודלים נתמכים (Code Mode)

| שם תצוגה | ollama model id | גודל | איכות קוד |
|---|---|---|---|
| **Qwen3-Coder-Next** | `qwen3-coder-next` | 52 GB | ⭐⭐⭐⭐⭐ SWE 70.6% |
| **Qwen3-Coder 30B** | `qwen3-coder:30b` | ~20 GB | ⭐⭐⭐⭐⭐ |
| **Qwen2.5-Coder 32B** | `qwen2.5-coder:32b` | 20 GB | ⭐⭐⭐⭐ |
| **Qwen2.5-Coder 7B** | `qwen2.5-coder:7b` | 4.7 GB | ⭐⭐⭐ מהיר |
| **DeepSeek-Coder V2** | `deepseek-coder-v2:16b` | 9 GB | ⭐⭐⭐⭐ |
| **CodeLlama 13B** | `codellama:13b` | 7.4 GB | ⭐⭐⭐ |

> המשתמש יכול להוסיף כל מודל Ollama — הרשימה היא ברירת מחדל בלבד.

---

## מה קיים כבר ✅

| רכיב | מיקום | סטטוס |
|---|---|---|
| **CodeModePanel** | `web-app/src/containers/CodeModePanel.tsx` | קיים — צריך עדכון |
| **code-mode-store** | `web-app/src/stores/code-mode-store.ts` | קיים — צריך `codeModel` |
| **code_agent.rs** | `src-tauri/src/core/code_agent.rs` | קיים — צריך Ollama |
| **ModeToggle** | `web-app/src/routes/index.tsx` | קיים |
| permissionMode | code-mode-store.ts | קיים ✅ |

---

## שלבי מימוש

---

### ✅ שלב 0 (בוצע): תשתית קיימת
- code_agent.rs קיים
- CodeModePanel קיים
- store עם permissionMode קיים
- ModeToggle קיים

---

### שלב 1: Rust Backend — החלפה ל-Ollama

**קובץ:** `src-tauri/src/core/code_agent.rs`

#### 1.1 — `find_ollama_binary()`
```rust
fn find_ollama_binary() -> Option<PathBuf> {
    // חפש ב-PATH
    if let Ok(path) = which::which("ollama") { return Some(path); }
    // נתיבים ידועים על macOS
    for p in ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"] {
        if Path::new(p).exists() { return Some(PathBuf::from(p)); }
    }
    None
}
```

#### 1.2 — `check_ollama()` (Tauri command)
```rust
#[tauri::command]
pub async fn check_ollama() -> Result<String, String> {
    let ollama = find_ollama_binary()
        .ok_or("Ollama not found. Install: https://ollama.com")?;
    let out = Command::new(&ollama).arg("--version").output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
```

#### 1.3 — `list_ollama_models()` (Tauri command)
```rust
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let ollama = find_ollama_binary().ok_or("Ollama not found")?;
    let out = Command::new(&ollama).arg("list").output()
        .map_err(|e| e.to_string())?;
    // parse: שורות שמכילות "coder" / "code" / "deepseek"
    let models = String::from_utf8_lossy(&out.stdout)
        .lines()
        .skip(1) // header
        .filter_map(|l| l.split_whitespace().next().map(|s| s.to_string()))
        .collect();
    Ok(models)
}
```

#### 1.4 — `spawn_code_agent()` (מעודכן)
```rust
#[tauri::command]
pub async fn spawn_code_agent(
    project_dir: String,
    prompt: String,
    ollama_model: String,      // "qwen3-coder:30b"
    permission_mode: String,   // "ask" | "auto_accept"
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let ollama = find_ollama_binary().ok_or("Ollama not found")?;

    let mut cmd = Command::new(&ollama);
    cmd.arg("launch").arg("claude");
    cmd.arg("--model").arg(&ollama_model);
    cmd.arg("-p").arg(&prompt);
    cmd.current_dir(&project_dir);

    // auto_accept = skip permission prompts
    if permission_mode == "auto_accept" {
        cmd.arg("--dangerously-skip-permissions");
    }

    // spawn + stream stdout → Tauri events
    // (אותה לוגיקה כמו הקיים ב-code_agent.rs)
    spawn_and_stream(cmd, app_handle).await
}
```

#### 1.5 — עדכן `lib.rs`
```rust
// הסר: check_claude_cli, check_cline_cli
// הוסף:
.invoke_handler(tauri::generate_handler![
    spawn_code_agent,
    stop_code_agent,
    check_ollama,          // חדש
    list_ollama_models,    // חדש
])
```

**בדיקת הצלחה שלב 1:**
- [ ] `check_ollama` → מחזיר version string
- [ ] `list_ollama_models` → מחזיר מודלים מותקנים
- [ ] `spawn_code_agent` → Ollama רץ, events זורמים
- [ ] `stop_code_agent` → process נעצר

---

### שלב 2: Store — הוספת `codeModel`

**קובץ:** `web-app/src/stores/code-mode-store.ts`

#### 2.1 — הוסף שדות

```typescript
// בתוך CodeModeState:
codeModel: string           // "qwen3-coder:30b"
setCodeModel: (model: string) => void
availableCodeModels: string[]
setAvailableCodeModels: (models: string[]) => void
```

ברירת מחדל:
```typescript
codeModel: 'qwen3-coder:30b',
availableCodeModels: [],
```

Persist:
```typescript
// ב-partialize — הוסף:
codeModel: state.codeModel,
```

**בדיקת הצלחה שלב 2:**
- [ ] `codeModel` נשמר בין sessions
- [ ] `availableCodeModels` מתמלא בכניסה לCode Mode

---

### שלב 3: CodeModelSelector Component

**קובץ חדש:** `web-app/src/components/CodeModelSelector.tsx`

```
Dropdown trigger: [Qwen3-Coder-30B ▽]

Popup:
┌──────────────────────────────────────────────────┐
│ מודלים מותקנים:                                  │
│ ● Qwen3-Coder-Next      qwen3-coder-next  ✓      │
│   Qwen3-Coder 30B       qwen3-coder:30b           │
│   Qwen2.5-Coder 7B      qwen2.5-coder:7b          │
├──────────────────────────────────────────────────┤
│ מודלים מומלצים (לא מותקנים):                     │
│   Qwen3-Coder 30B       ollama pull ...           │
│   DeepSeek-Coder V2     ollama pull ...           │
└──────────────────────────────────────────────────┘
```

Props:
```typescript
interface CodeModelSelectorProps {
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}
```

לוגיקה:
- בטעינה → `invoke('list_ollama_models')` → מציג מה מותקן
- מודלים לא מותקנים → מציג עם "ollama pull" hint
- `disabled={isAgentRunning}`

**בדיקת הצלחה שלב 3:**
- [ ] Dropdown מציג מודלים מותקנים
- [ ] בחירה מעדכנת store
- [ ] מושבת בזמן ריצה

---

### שלב 4: Header — שילוב CodeModelSelector

**קובץ:** `web-app/src/routes/index.tsx` (או שם header component)

כשמצב הוא `code`:
```typescript
{mode === 'code' && (
  <CodeModelSelector
    value={codeModel}
    onChange={setCodeModel}
    disabled={isAgentRunning}
  />
)}
{mode === 'chat' && (
  <ModelSelector ... /> // הקיים — לא משתנה
)}
```

**בדיקת הצלחה שלב 4:**
- [ ] Header מציג CodeModelSelector רק ב-Code Mode
- [ ] Chat Mode לא נפגע

---

### שלב 5: CodeModePanel — חיבור לOllama

**קובץ:** `web-app/src/containers/CodeModePanel.tsx`

#### 5.1 — `handleSend` מעודכן
```typescript
const handleSend = async () => {
  if (!projectDir) return showError('בחר תיקיית פרויקט')
  if (!codeModel) return showError('בחר מודל')

  clearOutput()
  setAgentRunning(true)

  await invoke('spawn_code_agent', {
    projectDir,
    prompt: draftPrompt,
    ollamaModel: codeModel,       // ← חדש
    permissionMode,
  })
}
```

#### 5.2 — Onboarding בכניסה לCode Mode
```typescript
useEffect(() => {
  if (mode !== 'code') return

  invoke('check_ollama')
    .then(v => setOllamaStatus({ ok: true, version: v }))
    .catch(() => setOllamaStatus({ ok: false }))

  invoke('list_ollama_models')
    .then(models => setAvailableCodeModels(models))
}, [mode])
```

#### 5.3 — Onboarding UI

אם Ollama לא מותקן:
```
┌──────────────────────────────────────────────────┐
│  ⚠️  Ollama נדרש                                 │
│                                                   │
│  Code Mode מריץ AI agent מקומי דרך Ollama.       │
│                                                   │
│  [התקן Ollama]    [בדוק שוב]                     │
└──────────────────────────────────────────────────┘
```

אם המודל לא מותקן:
```
┌──────────────────────────────────────────────────┐
│  ⚠️  מודל לא מותקן                               │
│                                                   │
│  ollama pull qwen3-coder:30b                      │
│                                                   │
│  [העתק פקודה]    [בדוק שוב]                      │
└──────────────────────────────────────────────────┘
```

אם הכל תקין — status bar:
```
✅ Ollama v0.x  |  ✅ Qwen3-Coder-30B מותקן
```

**בדיקת הצלחה שלב 5:**
- [ ] אם Ollama חסר → הודעה + קישור
- [ ] אם מודל חסר → הוראת `ollama pull`
- [ ] אם הכל תקין → agent רץ
- [ ] פלט זורם לPanel

---

### שלב 6: ניקוי

- [ ] **6.1** הסר קוד Claude CLI ישן מ-`code_agent.rs`
- [ ] **6.2** הסר `check_claude_cli` / `check_cline_cli` מ-`lib.rs`
- [ ] **6.3** עדכן i18n:
  ```json
  {
    "codeMode": "Code",
    "chatMode": "Chat",
    "selectCodeModel": "בחר מודל קוד",
    "ollamaNotFound": "Ollama לא מותקן",
    "modelNotInstalled": "מודל לא מותקן",
    "installOllama": "התקן Ollama",
    "checkAgain": "בדוק שוב",
    "copyCommand": "העתק פקודה"
  }
  ```
- [ ] **6.4** עדכן tests

---

## סדר ביצוע

```
✅ שלב 0: תשתית קיימת (code_agent.rs, store, panel, toggle)
  ↓
⬜ שלב 1: Rust — החלפה ל-ollama launch claude
           check_ollama + list_ollama_models + spawn_code_agent
  ↓
⬜ שלב 2: Store — הוספת codeModel
  ↓
⬜ שלב 3: CodeModelSelector component
  ↓
⬜ שלב 4: Header — שילוב CodeModelSelector
  ↓
⬜ שלב 5: CodeModePanel — חיבור + Onboarding
  ↓
⬜ שלב 6: ניקוי + i18n + tests
```

**כל שלב נבדק לפני המשך.**

---

## הערות טכניות

### הפקודה המדויקת

```bash
# auto_accept (agent פועל בלי לשאול):
ollama launch claude \
  --model qwen3-coder:30b \
  --dangerously-skip-permissions \
  -p "תקן את הבאג בטופס..."

# ask (agent שואל לפני כל פעולה):
ollama launch claude \
  --model qwen3-coder:30b \
  -p "תקן את הבאג בטופס..."
```

> **לאמת לפני מימוש:** flags מדויקים של `ollama launch claude`
> (ייתכן ש-`--dangerously-skip-permissions` הוא flag של claude ולא ollama)

### Permission Mode

| permissionMode | התנהגות |
|---|---|
| `ask` | agent עוצר לפני כל שינוי |
| `auto_accept` | agent פועל אוטומטית |

### מודלים מומלצים לפי חומרה

| RAM | מודל מומלץ |
|---|---|
| 8 GB | `qwen2.5-coder:7b` |
| 16 GB | `qwen3-coder:30b` |
| 32 GB+ | `qwen3-coder-next` (80B/3B active) |

### שאלות פתוחות

| # | שאלה | עדיפות |
|---|---|---|
| 1 | מהי הפקודה המדויקת לauto-accept ב-`ollama launch claude`? | גבוהה |
| 2 | האם `ollama launch claude` מחזיר JSON stream? | גבוהה |
| 3 | האם אפשר לשלוח stdin ל-agent (approve/deny)? | בינונית |
| 4 | האם `ollama launch` תומך ב-`-p` flag? | גבוהה |
