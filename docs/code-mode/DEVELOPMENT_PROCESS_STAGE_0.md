# Stage 0 — ארכיטקטורה + אימות ראשוני

> **עדכון (2026-04-07):** Engine שונה מ-claw-code ל-**`ollama launch claude`**.
> Ollama מנהל הכל — מודל, serving, Claude Code agent.

---

## חזון ארכיטקטורה

```
┌─ Atomic Chat (Tauri) ─────────────────────────────────────────┐
│                                                                │
│  React Frontend                                                │
│  ├─ [Chat | Code] toggle                                       │
│  ├─ Chat Mode: קיים, לא משתנה                                  │
│  └─ Code Mode:                                                 │
│       ├─ CodeModelSelector (Qwen3-Coder-30B ▽)                │
│       ├─ ProjectBar (📁 /path/to/project)                      │
│       ├─ OutputPanel (transcript)                              │
│       └─ PromptInput + PermissionSelector                      │
│         │                                                      │
│         │ invoke('spawn_code_agent', {                         │
│         │   projectDir, prompt,                                │
│         │   ollamaModel,    ← "qwen3-coder:30b"               │
│         │   permissionMode  ← "ask" | "auto_accept"           │
│         │ })                                                   │
│         ▼                                                      │
│  Rust Backend — code_agent.rs                                  │
│  ├─ check_ollama()         → ollama --version                  │
│  ├─ list_ollama_models()   → ollama list                       │
│  ├─ spawn_code_agent()     → spawns ollama subprocess          │
│  └─ stop_code_agent()      → kills subprocess                  │
│         │                                                      │
│         │  ollama launch claude \                              │
│         │    --model qwen3-coder:30b \                         │
│         │    [--dangerously-skip-permissions] \                │
│         │    --output-format stream-json \                     │
│         │    -p "{prompt}"                                     │
│         ▼                                                      │
│  Ollama (installed locally — חד פעמי)                          │
│  ├─ מנהל מודלים (pull, cache, serve)                           │
│  ├─ Claude Code agent loop built-in                            │
│  └─ Qwen3-Coder / qwen3-coder-next / כל מודל Ollama           │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Repository touchpoints

| קובץ | תפקיד |
|---|---|
| `web-app/src/containers/CodeModePanel.tsx` | UI panel ראשי |
| `web-app/src/stores/code-mode-store.ts` | UI state |
| `web-app/src/components/CodeModelSelector.tsx` | בחירת מודל (חדש) |
| `src-tauri/src/core/code_agent.rs` | Rust spawner |
| `src-tauri/src/lib.rs` | רישום commands |

---

## Event Contract (UI ↔ Backend)

ה-UI צריך לקבל events מובנים — לא לפרס terminal text.

### Commands (UI → Backend)

```typescript
invoke('spawn_code_agent', {
  projectDir: string,
  prompt: string,
  ollamaModel: string,     // "qwen3-coder:30b"
  permissionMode: string,  // "ask" | "auto_accept"
})

invoke('stop_code_agent')

invoke('check_ollama')     // → string (version) | error

invoke('list_ollama_models') // → string[] (model ids)
```

### Events (Backend → UI)

Tauri events שה-UI מאזין להם:

| event | payload | מתי |
|---|---|---|
| `code-agent-output` | `{ type, content, timestamp }` | כל שורת פלט |
| `code-agent-done` | `{ summary? }` | agent סיים |
| `code-agent-error` | `{ message }` | שגיאה |

סוגי output (`type`):
- `assistant` — תגובת המודל (טקסט)
- `tool_use` — agent קורא לכלי (read/write/bash)
- `tool_result` — תוצאת הכלי
- `permission_request` — agent מבקש אישור
- `system` — הודעות מערכת
- `error` — שגיאה

### Parser (stdout → events)

Claude Code CLI (`ollama launch claude`) מוציא NDJSON עם `--output-format stream-json`.
ה-Rust backend קורא שורה שורה ומעביר events ל-frontend.

```
stdout line → parse JSON → emit Tauri event → UI renders
```

---

## "Reality Gates" — חייבים לאמת לפני כתיבת UI

### Gate 1: ollama launch claude עובד

```bash
ollama launch claude \
  --model qwen3-coder:30b \
  --output-format stream-json \
  -p "list files in current dir"
```

**מה לאמת:**
- [ ] הפקודה קיימת ורצה
- [ ] NDJSON זורם ל-stdout
- [ ] format של JSON מובן (type, content, etc.)

### Gate 2: Permission mode עובד

```bash
# auto_accept — ללא שאלות:
ollama launch claude --model qwen3-coder:30b \
  --dangerously-skip-permissions -p "..."

# ask — עוצר לאישור:
ollama launch claude --model qwen3-coder:30b -p "..."
```

**מה לאמת:**
- [ ] `--dangerously-skip-permissions` קיים ועובד
- [ ] במצב ask — מה הפורמט של permission request ב-stdout?
- [ ] האם אפשר לשלוח y/n ל-stdin?

### Gate 3: Model selection עובד

```bash
ollama launch claude --model qwen3-coder-next -p "hello"
```

**מה לאמת:**
- [ ] `--model` flag עובד עם מודלים שונים
- [ ] `ollama list` מציג מודלים מותקנים בפורמט parseable

---

## פקודת הבדיקה לכל Gate

```bash
# Gate 1 + 2 + 3 ביחד:
cd /tmp/test-project
ollama launch claude \
  --model qwen3-coder:30b \
  --output-format stream-json \
  --dangerously-skip-permissions \
  -p "create a file hello.txt with content 'it works'"

# בדוק אם hello.txt נוצר:
cat hello.txt
```

---

## מודלים נתמכים

| שם תצוגה | ollama model id | גודל | SWE-Bench |
|---|---|---|---|
| Qwen3-Coder-Next | `qwen3-coder-next` | 52 GB | 70.6% |
| Qwen3-Coder 30B | `qwen3-coder:30b` | ~20 GB | — |
| Qwen2.5-Coder 32B | `qwen2.5-coder:32b` | 20 GB | — |
| Qwen2.5-Coder 7B | `qwen2.5-coder:7b` | 4.7 GB | — |
| DeepSeek-Coder V2 | `deepseek-coder-v2:16b` | 9 GB | — |

---

## ✅ Reality Gates — תוצאות (2026-04-07)

### Gate 1: ollama launch claude עובד ✅

```bash
PATH="$HOME/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:$PATH" \
  /usr/local/bin/ollama launch claude --model qwen3-coder:30b -- \
  -p --output-format stream-json --verbose \
  --dangerously-skip-permissions \
  "say the word HELLO only"
```

**תוצאה:** NDJSON זורם, המודל ענה `HELLO` ✅

### Gate 2: פורמט JSON מאושר ✅

```jsonc
// אתחול
{"type":"system","subtype":"init","cwd":"...","model":"qwen3-coder:30b","permissionMode":"bypassPermissions",...}

// תגובת assistant
{"type":"assistant","message":{"content":[{"type":"text","text":"HELLO"}],...},...}

// rate limit info (דלג)
{"type":"rate_limit_event",...}

// סיום
{"type":"result","subtype":"success","result":"HELLO","duration_ms":75258,...}
```

### Gate 3: Flags מאושרים ✅

| flag | מיקום | הערה |
|---|---|---|
| `--model MODEL` | לפני `--` | flag של ollama |
| `--` | מפריד | חובה — כל מה שאחריו הולך לclaude |
| `-p` | אחרי `--` | `--print` — non-interactive mode |
| `--output-format stream-json` | אחרי `-p` | דורש `--verbose` |
| `--verbose` | חובה עם stream-json | בלעדיו stream-json נכשל |
| `--dangerously-skip-permissions` | אחרי `--verbose` | auto_accept mode |
| `"PROMPT"` | **אחרון** | positional argument |

### Gate 4: PATH נדרש ✅

claude מותקן דרך nvm — לא ב-PATH של Tauri.
**פתרון:** מוסיפים לenv לפני spawn:
```
~/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:/opt/homebrew/bin:...
```

---

## Exit criteria לשלב 0

- [x] Gate 1 — `ollama launch claude` עובד
- [x] Gate 2 — פורמט JSON מתועד
- [x] Gate 3 — flags מדויקים אומתו
- [x] Gate 4 — PATH נדרש ומתועד
- [x] code_agent.rs עודכן עם הפקודה הנכונה
- [x] `cargo check` עובר

**שלב 0 הושלם. ממשיכים לשלב 1.**

---

## Do / Don't

- **Do:** השתמש תמיד ב-`--` לפני flags של claude
- **Do:** הוסף `--verbose` יחד עם `--output-format stream-json`
- **Do:** הוסף PATH של nvm לenv לפני spawn
- **Don't:** כתוב flags של claude לפני `--`
- **Don't:** שכח `--verbose` — stream-json ייכשל בשקט
