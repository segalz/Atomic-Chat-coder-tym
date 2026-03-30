# Atomic Chat + Claude Code CLI + Local Qwen — תוכנית מימוש

## חזון

Atomic Chat הופך ל-**GUI של Claude Code CLI עם מודל מקומי**.
המנוע של Anthropic (Claude Code CLI) — המוח מקומי (Qwen2.5-Coder-32B).
**100% מקומי, 0 עלות, פרטיות מלאה.**

### מבנה Header חדש

```
┌─────────────────────────────────────────────────────────────┐
│  ☘ Qwen3_5-4B_Q4_K_M ▽  ⚙  ●     [ Chat     Code ]       │
│                                     ▲ 2 tabs ליד המודל     │
└─────────────────────────────────────────────────────────────┘
```

**2 מצבים:**
- **Chat** — צ'אט רגיל עם מודל (כמו היום)
- **Code** — Claude Code CLI עם מודל מקומי על פרויקט

### מסך ראשי — Chat Mode (ברירת מחדל, כמו היום)

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Model ▽  ⚙ ●   [ Chat | ▪Code ]                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│              How can I help you today?                        │
│                                                              │
│  ┌─ ChatInput ───────────────────────────────────────────┐  │
│  │  Ask me anything...                                    │  │
│  │  [+]  [🔗]                                     [→]    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### מסך ראשי — Code Mode

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Model ▽  ⚙ ●   [ Chat | ▪Code ]                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ Project Bar ─────────────────────────────────────────┐  │
│  │  📁 /Users/zvi/projects/my-app            [Browse]     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Screenshot Drop Zone ────────────────────────────────┐  │
│  │  📸 Drop screenshot to identify code file              │  │
│  │  ┌──────────────────────────────────────────────────┐ │  │
│  │  │ ✅ OwnerDataStep.tsx (High Confidence)            │ │  │
│  │  │ 📊 Dependency Tree: 14 local, 8 external         │ │  │
│  │  │ [Copy Context]                                    │ │  │
│  │  └──────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Prompt ──────────────────────────────────────────────┐  │
│  │  תקן את הבאג בטופס הדיווח — השם משפחה לא נשמר...      │  │
│  │                                                        │  │
│  │  [📎 OwnerDataStep.tsx + 14 deps]                      │  │
│  │  [+]                                        [▶ Run]   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Claude Code Output (streaming) ──────────────────────┐  │
│  │  📖 Reading OwnerDataStep.tsx...                       │  │
│  │  ✏️  Editing line 87: fixed lastName setter...          │  │
│  │  💻 Running: npm test...                               │  │
│  │  ✅ All tests passed. 1 file changed.                  │  │
│  │                                              [■ Stop]  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### ארכיטקטורה

```
┌─ Atomic Chat (Tauri) ──────────────────────────────────────┐
│                                                             │
│  React Frontend                                             │
│  ├─ Header: Model selector + [Chat | Code] toggle          │
│  ├─ Chat Mode: ChatInput → existing chat flow              │
│  └─ Code Mode: ProjectBar + DropZone + Prompt + Output     │
│         │                                                   │
│         │ invoke('spawn_code_agent', { projectDir, prompt })│
│         ▼                                                   │
│  Rust Backend (Tauri)                                       │
│  ├─ spawn_code_agent() → spawns Claude CLI subprocess      │
│  ├─ stop_code_agent()  → kills subprocess                  │
│  └─ streams stdout JSON → emits Tauri events to frontend   │
│         │                                                   │
│         │ ANTHROPIC_BASE_URL=http://127.0.0.1:1234         │
│         ▼                                                   │
│  Claude Code CLI (installed globally)                       │
│  ├─ --output-format stream-json                            │
│  ├─ --cwd /path/to/project                                 │
│  ├─ Reads, edits, runs commands on the project             │
│  └─ Talks to local model via Anthropic Messages API        │
│         │                                                   │
│         ▼                                                   │
│  Local Model Server (already running)                       │
│  ├─ LM Studio / MLX Server at 127.0.0.1:1234              │
│  ├─ Qwen2.5-Coder-32B-Instruct                            │
│  └─ Future: TurboQuant for 300K context                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## שלב 1: וידוא תקשורת — Claude CLI ↔ מודל מקומי

**מטרה:** לוודא ש-Claude Code CLI מצליח לדבר עם Qwen דרך LM Studio.

### דרישות מקדימות
- [ ] Claude Code CLI מותקן: `npm install -g @anthropic-ai/claude-code`
- [ ] LM Studio רץ עם Qwen2.5-Coder-32B על `127.0.0.1:1234`

### משימות

- [ ] **1.1** בדוק האם LM Studio תומך ב-Anthropic Messages API:
  ```bash
  curl http://127.0.0.1:1234/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: lm-studio" \
    -d '{"model":"qwen2.5-coder-32b-instruct","max_tokens":50,"messages":[{"role":"user","content":"Say hello"}]}'
  ```
  - אם מחזיר תשובה בפורמט Anthropic → עבור ל-1.3
  - אם 404/error → צריך proxy (1.2)

- [ ] **1.2** (רק אם צריך) בנה Anthropic proxy:
  - צור `tools/anthropic-proxy.py` — FastAPI server ~150 שורות
  - מתרגם `/v1/messages` (Anthropic) → `/v1/chat/completions` (OpenAI)
  - מתרגם streaming SSE בחזרה
  - ירוץ על port 1235, מפנה ל-1234

- [ ] **1.3** בדוק Claude CLI עם המודל המקומי:
  ```bash
  ANTHROPIC_BASE_URL=http://127.0.0.1:1234 \
  ANTHROPIC_AUTH_TOKEN=lm-studio \
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  claude -p "What is 2+2?" --model qwen2.5-coder-32b-instruct
  ```

- [ ] **1.4** בדוק streaming:
  ```bash
  ANTHROPIC_BASE_URL=http://127.0.0.1:1234 \
  ANTHROPIC_AUTH_TOKEN=lm-studio \
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  claude -p "Write a hello world in Python" \
    --model qwen2.5-coder-32b-instruct \
    --output-format stream-json
  ```
  - וודא שהפלט הוא JSON-lines שזורמות

- [ ] **1.5** בדוק עבודה על פרויקט:
  ```bash
  cd /tmp && mkdir test-project && cd test-project
  echo 'console.log("hello")' > index.js
  ANTHROPIC_BASE_URL=http://127.0.0.1:1234 \
  ANTHROPIC_AUTH_TOKEN=lm-studio \
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  claude -p "Read index.js and add a function that adds two numbers" \
    --model qwen2.5-coder-32b-instruct \
    --output-format stream-json \
    --dangerously-skip-permissions
  ```
  - וודא שהקובץ נערך בפועל

### בדיקת הצלחה
- [ ] Claude CLI מקבל תשובה מ-Qwen המקומי
- [ ] Streaming JSON עובד
- [ ] Claude CLI מצליח לקרוא ולערוך קבצים בפרויקט
- [ ] תעד את הפורמט המדויק של ה-env vars וה-flags שעובדים

---

## שלב 2: Tauri Backend — Claude Code Spawner

**מטרה:** פקודות Rust ב-Tauri שמפעילות/עוצרות Claude CLI ומזרימות פלט ל-React.

### משימות

- [ ] **2.1** קרא את הפקודה הקיימת `launch_claude_code_with_config` ב-`src-tauri/src/`:
  - הבן מה היא עושה
  - האם אפשר להרחיב אותה או צריך חדשה

- [ ] **2.2** צור module חדש `src-tauri/src/core/code_agent.rs`:
  ```rust
  use std::process::Stdio;
  use tokio::process::Command;
  use tokio::io::{AsyncBufReadExt, BufReader};

  // State: track running process
  struct CodeAgentState {
      child: Option<tokio::process::Child>,
  }

  #[tauri::command]
  async fn spawn_code_agent(
      app: AppHandle,
      project_dir: String,
      prompt: String,
      model_id: String,
      context: Option<String>,
      server_url: Option<String>,  // default: http://127.0.0.1:1234
  ) -> Result<(), String>

  #[tauri::command]
  async fn stop_code_agent(
      state: State<CodeAgentState>
  ) -> Result<(), String>

  #[tauri::command]
  async fn check_claude_cli() -> Result<String, String>
  // Returns version string or error
  ```

- [ ] **2.3** ב-`spawn_code_agent`:
  - הרכב prompt מלא: `{user_prompt}\n\n{context}` (אם יש context)
  - הגדר env vars:
    ```
    ANTHROPIC_BASE_URL = server_url || "http://127.0.0.1:1234"
    ANTHROPIC_AUTH_TOKEN = "lm-studio"
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1"
    ```
  - הרץ:
    ```
    claude -p "{full_prompt}" \
      --output-format stream-json \
      --model {model_id} \
      --dangerously-skip-permissions
    ```
  - `cwd` = `project_dir`
  - קרא stdout שורה-שורה, שלח כל שורה כ-event:
    ```rust
    app.emit("code-agent-output", &json_line)?;
    ```
  - בסיום, שלח event:
    ```rust
    app.emit("code-agent-done", &exit_code)?;
    ```

- [ ] **2.4** ב-`stop_code_agent`:
  - `child.kill()` ← עוצר את ה-process
  - שלח event `code-agent-stopped`

- [ ] **2.5** ב-`check_claude_cli`:
  - הרץ `claude --version`
  - החזר version string או error

- [ ] **2.6** רשום את ה-commands ב-`main.rs`:
  ```rust
  .invoke_handler(tauri::generate_handler![
      // ... existing commands ...
      code_agent::spawn_code_agent,
      code_agent::stop_code_agent,
      code_agent::check_claude_cli,
  ])
  ```

- [ ] **2.7** עדכן capabilities (`src-tauri/capabilities/default.json`):
  - הוסף הרשאות shell spawn אם חסרות

### בדיקת הצלחה
- [ ] `check_claude_cli` → מחזיר version
- [ ] `spawn_code_agent` → מפעיל Claude CLI, events זורמים ל-frontend
- [ ] `stop_code_agent` → עוצר את ה-process
- [ ] בדוק עם frontend console: `listen('code-agent-output', console.log)`

---

## שלב 3: Code Mode Toggle בHeader

**מטרה:** כפתור [Chat | Code] ליד בורר המודל ב-Header.

### משימות

- [ ] **3.1** צור store `web-app/src/stores/code-mode-store.ts`:
  ```typescript
  import { create } from 'zustand'
  import { persist } from 'zustand/middleware'

  type AppMode = 'chat' | 'code'

  interface CodeModeState {
    mode: AppMode
    projectDir: string
    isAgentRunning: boolean
    agentOutput: AgentOutputLine[]

    setMode: (mode: AppMode) => void
    setProjectDir: (dir: string) => void
    setAgentRunning: (running: boolean) => void
    appendOutput: (line: AgentOutputLine) => void
    clearOutput: () => void
  }

  interface AgentOutputLine {
    type: 'system' | 'assistant' | 'tool_use' | 'tool_result' | 'error' | 'done'
    content: string
    toolName?: string
    timestamp: number
  }
  ```
  - `persist` → שומר mode + projectDir ב-localStorage

- [ ] **3.2** הוסף 3-tab switcher ל-Header (`HeaderPage.tsx` או `DropdownModelProvider.tsx`):
  - ליד בורר המודל, מימין
  - 2 tabs כמו בצילום: `[ Chat     Code ]`
  - Tab פעיל מודגש (רקע כהה, כמו בתמונה)
  - עיצוב: rounded-full, dark background for active tab

  ```tsx
  const modes: { key: AppMode; label: string }[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'code', label: 'Code' },
  ]

  <div className="flex items-center gap-1 rounded-full bg-muted p-1">
    {modes.map(({ key, label }) => (
      <button
        key={key}
        className={cn(
          'rounded-full px-4 py-1.5 text-sm transition-colors',
          mode === key
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
        onClick={() => setMode(key)}
      >
        {label}
      </button>
    ))}
  </div>
  ```

- [ ] **3.3** עדכן `web-app/src/routes/index.tsx`:
  - `mode === 'chat'` → המסך הנוכחי (ללא שינוי)
  - `mode === 'code'` → הצג `CodeModePanel` + modified `ChatInput`

- [ ] **3.4** הסר `common:projectMode` מהתפריט הצדדי (`NavMain.tsx`)

### בדיקת הצלחה
- [ ] Toggle מופיע ליד המודל ב-Header
- [ ] לחיצה על Code → מסך ראשי משתנה
- [ ] לחיצה על Chat → חזרה למסך רגיל
- [ ] הבחירה נשמרת (refresh → אותו mode)

---

## שלב 4: Code Mode UI — Project Bar + Drop Zone

**מטרה:** ב-Code Mode, מסך ראשי מציג בורר תיקיה, drop zone לצילומי מסך, ותצוגת context.

### משימות

- [ ] **4.1** צור `web-app/src/containers/CodeModePanel.tsx`:
  - **Project Bar:**
    - שדה תיקיה + כפתור Browse
    - `invoke('open_dialog', { directory: true })` → `setProjectDir()`
    - מציג שם התיקיה בלבד (לא path מלא) + tooltip עם path מלא

  - **Screenshot Drop Zone:**
    - אזור גרירה מתקפל (collapsible)
    - משתמש ב-`extractVisibleText()` מ-`vision-analyzer.ts` הקיים
    - משתמש ב-`scoreFilesByContent()` מ-`file-matcher.ts` הקיים
    - High confidence → auto-analyze (ניתוח עץ תלויות אוטומטי)
    - Low confidence → הצג candidates לבחירה
    - אחרי זיהוי → הצג:
      - שם הקובץ שנמצא
      - מספר תלויות
      - כפתור "Copy Context"

  - **Context Badge (מתחת ל-drop zone):**
    - מופיע אחרי זיהוי מוצלח
    - לדוגמה: `📎 OwnerDataStep.tsx + 14 deps (~2,400 tokens)`
    - לחיצה → מציג/מסתיר preview של הקונטקסט

- [ ] **4.2** חבר ל-ChatInput:
  - ב-Code Mode, ה-ChatInput הקיים עדיין עובד לכתיבת prompt
  - אבל כפתור Send → הופך ל- **"▶ Run"**
  - לחיצה על Run → `invoke('spawn_code_agent', { projectDir, prompt, model, context })`
  - ה-context הוא ה-bundledContext מה-Vision (אם יש)

- [ ] **4.3** השתמש ב-services הקיימים:
  - `vision-analyzer.ts` → חילוץ טקסט מצילום מסך
  - `file-matcher.ts` → TF-IDF scoring
  - `project-analyzer.ts` → עץ תלויות
  - `context-bundler.ts` → בניית markdown context
  - `project-dna.ts` → זיהוי tech stack

### בדיקת הצלחה
- [ ] בורר תיקיה עובד
- [ ] גרירת צילום מסך → זיהוי קובץ
- [ ] עץ תלויות נבנה
- [ ] Context badge מופיע
- [ ] כפתור Run שולח prompt + context ל-`spawn_code_agent`

---

## שלב 5: Streaming Output Panel

**מטרה:** תצוגת פלט חי מ-Claude CLI — רואים מה הוא עושה בזמן אמת.

### משימות

- [ ] **5.1** צור `web-app/src/containers/CodeOutputPanel.tsx`:
  - מאזין ל-Tauri events: `code-agent-output`, `code-agent-done`, `code-agent-stopped`
  - מפרסר כל שורת JSON מ-Claude CLI:
    ```typescript
    // Claude CLI stream-json format:
    { type: "system", subtype: "init", cwd: "...", model: "..." }
    { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
    { type: "tool_use", name: "Read", input: { file_path: "..." } }
    { type: "tool_result", content: "..." }
    { type: "result", subtype: "success" }
    ```

  - תצוגה לכל סוג:
    | Type | תצוגה |
    |---|---|
    | `system/init` | `🚀 Working on /path/to/project with qwen2.5-coder...` |
    | `assistant` | Markdown rendered text |
    | `tool_use: Read` | `📖 Reading src/components/Form.tsx` |
    | `tool_use: Edit` | `✏️ Editing src/components/Form.tsx` |
    | `tool_use: Bash` | `💻 Running: npm test` |
    | `tool_use: Write` | `📝 Creating src/utils/helper.ts` |
    | `tool_use: Glob` | `🔍 Searching for *.tsx files` |
    | `tool_use: Grep` | `🔍 Searching for "onChange" in code` |
    | `tool_result` | Collapsible output block |
    | `error` | Red error message |
    | `result/success` | `✅ Done` |

- [ ] **5.2** כפתור Stop:
  - `invoke('stop_code_agent')` → עוצר ה-process
  - מופיע רק כש-`isAgentRunning === true`

- [ ] **5.3** UX:
  - Auto-scroll לתחתית
  - כפתור "Copy All" — מעתיק כל הפלט
  - כפתור "Clear" — מנקה פלט קודם
  - Collapsible tool results (ברירת מחדל: מקופל)
  - גלילה חלקה, פונט mono

- [ ] **5.4** חבר את הפאנל למסך הראשי:
  - ב-Code Mode, הפאנל מופיע מתחת ל-prompt
  - כש-agent רץ, הוא תופס את רוב המסך
  - כשלא רץ, הוא מוסתר או מציג פלט אחרון

### בדיקת הצלחה
- [ ] פלט streaming מוצג בזמן אמת
- [ ] כל סוג הודעה מוצג נכון
- [ ] Stop עוצר את ה-agent
- [ ] Auto-scroll עובד
- [ ] Copy All עובד
- [ ] UX חלק — לא קופץ, לא איטי

---

## שלב 6: ניקוי, i18n, ובדיקות

**מטרה:** הסרת Project Mode הישן, עברית, בדיקות end-to-end.

### משימות

- [ ] **6.1** הסר routes ישנים:
  - מחק `web-app/src/routes/project-mode/` (כולל vision, plan, translation)
  - עדכן `web-app/src/constants/routes.ts` — הסר project-mode routes
  - עדכן `web-app/src/routeTree.gen.ts` — רגנרציה

- [ ] **6.2** העבר services שצריך לשמור:
  - `web-app/src/services/pm/` → ישאר (Vision, file-matcher, analyzer, bundler)
  - `web-app/src/containers/pm/` → ישאר מה שנדרש ל-CodeModePanel
  - מחק containers שלא בשימוש (PlanComposer, PlanResultView, TranslationSearchPanel)

- [ ] **6.3** הסר מתפריט צד:
  - `NavMain.tsx` → הסר `common:projectMode` link

- [ ] **6.4** i18n — הוסף מפתחות:
  ```json
  {
    "codeMode": "Code Mode",
    "chatMode": "Chat",
    "projectFolder": "Project Folder",
    "browseFolder": "Browse",
    "dropScreenshot": "Drop screenshot to identify code",
    "runAgent": "Run",
    "stopAgent": "Stop",
    "agentRunning": "Agent is working...",
    "agentDone": "Done",
    "installClaudeCli": "Install Claude Code CLI",
    "noModelServer": "No model server detected"
  }
  ```
  - הוסף תרגום עברית ב-`web-app/src/locales/he/`

- [ ] **6.5** עדכן tests שנשברו:
  - `SettingsMenu.test.tsx`
  - `useTools.test.ts`
  - `general.test.tsx`, `interface.test.tsx`
  - הוסף test ל-code-mode-store

- [ ] **6.6** בדיקות end-to-end:
  - [ ] Chat Mode → עובד כמו קודם (אין regression)
  - [ ] Toggle Chat ↔ Code → חלק
  - [ ] Code Mode: Browse folder → תיקיה נבחרת
  - [ ] Code Mode: Drop screenshot → קובץ מזוהה
  - [ ] Code Mode: Write prompt → Run → output streaming
  - [ ] Code Mode: Stop → agent נעצר
  - [ ] Code Mode: בלי תיקיה → הודעת שגיאה
  - [ ] Code Mode: בלי Claude CLI → הודעת התקנה

### בדיקת הצלחה
- [ ] אין references ל-project-mode routes (grep)
- [ ] Chat Mode עובד ללא שינוי
- [ ] Code Mode עובד end-to-end
- [ ] טסטים עוברים
- [ ] עברית תקינה

---

## שלב 7: Setup & Auto-Install

**מטרה:** חוויית onboarding חלקה — אם חסר משהו, להנחות את המשתמש.

### משימות

- [ ] **7.1** בכניסה ל-Code Mode, בדוק:
  ```typescript
  const cliVersion = await invoke('check_claude_cli')
  const serverOk = await fetch('http://127.0.0.1:1234/v1/models').then(r => r.ok).catch(() => false)
  ```

- [ ] **7.2** אם Claude CLI לא מותקן:
  ```
  ┌─────────────────────────────────────────┐
  │  ⚠️ Claude Code CLI Required             │
  │                                          │
  │  Code Mode uses Claude Code CLI engine   │
  │  with your local Qwen model.             │
  │                                          │
  │  [Install: npm i -g @anthropic-ai/claude-code]  │
  │  [Check Again]                           │
  └──────────────────────────────────────────┘
  ```

- [ ] **7.3** אם model server לא רץ:
  ```
  ┌─────────────────────────────────────────┐
  │  ⚠️ No Model Server Detected             │
  │                                          │
  │  Start a model in the Models tab or      │
  │  run LM Studio on port 1234.             │
  │                                          │
  │  [Go to Models]  [Check Again]           │
  └──────────────────────────────────────────┘
  ```

- [ ] **7.4** אם הכל תקין — הצג status bar:
  ```
  ✅ Claude CLI v1.x  |  ✅ Qwen2.5-Coder-32B @ 127.0.0.1:1234
  ```

### בדיקת הצלחה
- [ ] משתמש חדש בלי Claude CLI → מקבל הנחיה
- [ ] משתמש בלי model server → מקבל הנחיה
- [ ] הכל תקין → status ירוק

---

## סדר ביצוע

```
שלב 1: Claude CLI ↔ Qwen (ידני, בטרמינל)
  ↓
שלב 2: Tauri spawner (Rust backend)
  ↓
שלב 3: Header toggle [Chat | Code]
  ↓
שלב 4: Code Mode UI (folder + drop zone + prompt)
  ↓
שלב 5: Streaming output panel
  ↓
שלב 6: ניקוי + tests
  ↓
שלב 7: Auto-install + onboarding
```

**כל שלב נבדק לפני שממשיכים הלאה.**

---

## הערות טכניות

### Environment Variables ל-Claude CLI
```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:1234
ANTHROPIC_AUTH_TOKEN=lm-studio
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
```

### Claude CLI Flags
```bash
claude -p "{prompt}"              # Non-interactive mode
  --output-format stream-json     # JSON-lines streaming
  --model {model_id}              # Model to use
  --dangerously-skip-permissions  # No TTY = no permission prompts
  --allowedTools "Read Edit Bash Write Glob Grep"  # Optional: restrict tools
```

### JSON Streaming Format
```jsonl
{"type":"system","subtype":"init","cwd":"/path","model":"qwen2.5-coder-32b-instruct"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me look at..."}]}}
{"type":"tool_use","name":"Read","input":{"file_path":"src/Form.tsx"}}
{"type":"tool_result","content":"import React from 'react'..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I see the bug..."}]}}
{"type":"tool_use","name":"Edit","input":{"file_path":"src/Form.tsx","old_string":"...","new_string":"..."}}
{"type":"tool_result","content":"File edited successfully"}
{"type":"result","subtype":"success","cost_usd":0}
```

### אבטחה
- `--dangerously-skip-permissions` נדרש כי אין TTY
- Claude CLI **יכול** לערוך/למחוק קבצים ולהריץ כל פקודה
- מיטיגציה: Output Panel מציג הכל בזמן אמת + כפתור Stop
- אופציונלי: `--allowedTools` להגבלת הכלים הזמינים

### תשתית קיימת שנשתמש בה
| רכיב | מיקום |
|---|---|
| TurboQuant extension (MLX + KV cache) | `extensions/turboquant-extension/` |
| MLX server binary | bundled in Tauri (`mlx-server`) |
| `launch_claude_code_with_config` | `src-tauri/src/` |
| `tauri-plugin-shell` (spawn) | Cargo.toml |
| Vision analyzer (text extraction) | `web-app/src/services/pm/vision-analyzer.ts` |
| File matcher (TF-IDF scoring) | `web-app/src/services/pm/file-matcher.ts` |
| Project analyzer (dependency tree) | `web-app/src/services/pm/project-analyzer.ts` |
| Context bundler (markdown builder) | `web-app/src/services/pm/context-bundler.ts` |
| Project DNA (tech stack detection) | `web-app/src/services/pm/project-dna.ts` |
