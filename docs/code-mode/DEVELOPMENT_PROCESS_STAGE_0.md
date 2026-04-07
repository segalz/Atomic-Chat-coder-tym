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

## Exit criteria לשלב 0

- [ ] 3 Reality Gates עברו — `ollama launch claude` עובד
- [ ] פורמט ה-JSON של claude output מתועד
- [ ] ידוע איך permission ask/deny עובד
- [ ] architecture מאושרת לפני כתיבת קוד

---

## Do / Don't

- **Do:** אמת את ה-flags של `ollama launch claude` לפני מימוש
- **Do:** תעד את פורמט ה-JSON שclaude מוציא
- **Don't:** כתוב UI לפני שה-Gates עברו
- **Don't:** הנח ש-flags של claude CLI זהים ל-flags של `ollama launch claude`
