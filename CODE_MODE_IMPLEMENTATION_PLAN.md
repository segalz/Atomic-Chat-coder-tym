# Atomic Chat + Cline CLI + Local Model — תוכנית מימוש

> **עדכון ארכיטקטורה (2026-03-31):** אחרי בדיקות מעמיקות ואפיון טכני, עברנו מ-**Claude CLI** ל-**Cline CLI**.
> הסיבה: Cline מדבר OpenAI API ישירות — ללא proxy, ללא אימות שמות מודלים, ללא תלות ב-Anthropic.
> האפיון המלא נמצא ב-[`docs/code-mode-spec/code-mode-spec.md`](docs/code-mode-spec/code-mode-spec.md).

## חזון

Atomic Chat הופך ל-**GUI של Cline CLI עם מודל מקומי**.
המנוע: Cline CLI — המוח מקומי (Qwen2.5-Coder / כל מודל OpenAI-compatible).
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
- **Code** — Cline CLI עם מודל מקומי על פרויקט

### מסך ראשי — Code Mode

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Model ▽  ⚙ ●   [ Chat | ▪Code ]                   │
├─────────────────────────────────────────────────────────────┤
│  📁 /Users/zvi/projects/my-app                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  (scrollable output — chat style)                            │
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

### ארכיטקטורה (מעודכן — Cline CLI)

```
┌─ Atomic Chat (Tauri) ──────────────────────────────────────┐
│                                                             │
│  React Frontend                                             │
│  ├─ Header: Model selector + [Chat | Code] toggle          │
│  ├─ Chat Mode: ChatInput → existing chat flow              │
│  └─ Code Mode: ProjectBar + PermissionSelector + Output    │
│         │                                                   │
│         │ invoke('spawn_code_agent', {                      │
│         │   projectDir, prompt, modelId,                    │
│         │   permissionMode, serverUrl })                    │
│         ▼                                                   │
│  Rust Backend (Tauri) — code_agent.rs                       │
│  ├─ spawn_code_agent() → spawns Cline CLI subprocess        │
│  ├─ stop_code_agent()  → kills subprocess                   │
│  └─ streams stdout JSON → emits Tauri events to frontend   │
│         │                                                   │
│         │  cline --base-url http://127.0.0.1:{port}/v1     │
│         │         --model {modelId}                         │
│         │         --json [--yolo if auto_accept]            │
│         ▼                                                   │
│  Cline CLI (installed globally: npm i -g @cline/cline)      │
│  ├─ OpenAI API native (no proxy needed!)                    │
│  ├─ Reads, edits, runs commands on the project             │
│  └─ 5 permission modes (Phase 1: 2 modes)                  │
│         │                                                   │
│         │ OpenAI /v1/chat/completions                       │
│         ▼                                                   │
│  llama-server (TurboQuant — כבר קיים!)                      │
│  ├─ tauri-plugin-mlx → port דינמי per model                │
│  ├─ OpenAI-compatible API                                   │
│  └─ Qwen2.5-Coder-32B / כל מודל                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### מציאת פורט llama-server

```
Frontend queries:
  plugin:mlx|find_mlx_session_by_model(modelId)
    → { port, api_key } or null
  fallback: plugin:llamacpp|find_session_by_model(modelId)
    → { port, api_key } or null
  → serverUrl = http://127.0.0.1:{port}/v1
```

---

## ✅ שלב 1: וידוא תקשורת — CLI ↔ מודל מקומי

> **סטטוס: בוצע** (בוצע עם Claude CLI + proxy. עם Cline נדרש אימות נפרד — ראה שלב 2.)

**מה בוצע:** אומתה תקשורת בין CLI ל-proxy פנימי ול-llama-server. streaming JSON עובד.

---

## ✅ שלב 2: Tauri Backend — Code Agent Spawner

> **סטטוס: בוצע (בסיס)** — `code_agent.rs` נוצר ועובד עם Claude CLI.
> **נדרש עדכון:** להחליף Claude CLI ב-Cline CLI (ראה שלב 2 עדכון).

### מה קיים
- `src-tauri/src/core/code_agent.rs` — spawn, stop, stream stdout → Tauri events
- Events: `code-agent-output`, `code-agent-done`, `code-agent-error`
- רשום ב-`lib.rs`: `spawn_code_agent`, `stop_code_agent`, `check_claude_cli`

### שלב 2-עדכון: החלפת Claude CLI → Cline CLI (עדיין נדרש)

- [ ] **2-U.1** עדכן `spawn_code_agent` ב-`code_agent.rs`:
  - **הסר:** `--output-format stream-json`, `--verbose`, `--dangerously-skip-permissions`
  - **הסר:** env vars של Anthropic (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_*_MODEL`)
  - **הוסף פרמטר:** `permission_mode: String` — `"ask"` או `"auto_accept"`
  - **הרץ:**
    ```bash
    cline \
      --base-url http://127.0.0.1:{port}/v1 \
      --model {model_id} \
      --json \
      [--yolo]     # רק אם permission_mode == "auto_accept"
      -p "{prompt}"
    ```
  - **לוגיקת permission_mode:**
    ```rust
    if permission_mode == "auto_accept" {
        cmd.arg("--yolo");
    }
    // "ask" mode: no --yolo → Cline asks before each action
    ```

- [ ] **2-U.2** שנה `find_claude_binary` → `find_cline_binary`:
  - חפש `cline` ב-PATH ובנתיבים ידועים
  - שגיאה: `"Cline CLI not found. Install: npm install -g @cline/cline"`

- [ ] **2-U.3** שנה `check_claude_cli` → `check_cline_cli`:
  - הרץ `cline --version`

- [ ] **2-U.4** עדכן `lib.rs` — שנה `check_claude_cli` → `check_cline_cli`

- [ ] **2-U.5** עדכן signature ב-`spawn_code_agent` (TypeScript side) בכל מקום שקורא לו:
  - הוסף `permissionMode: string` לפרמטרים
  - הוסף `serverUrl: string` (חובה — מגיע מ-port discovery)

### בדיקת הצלחה
- [ ] `check_cline_cli` → מחזיר version
- [ ] `spawn_code_agent` עם `auto_accept` → Cline רץ עם `--yolo`, events זורמים
- [ ] `spawn_code_agent` עם `ask` → Cline רץ ללא `--yolo`
- [ ] `stop_code_agent` → עוצר את ה-process

---

## ✅ שלב 3: Code Mode Toggle בHeader + Store

> **סטטוס: בוצע (בסיס)** — Toggle קיים, store קיים, NavMain נוקה.
> **נדרש הוספה:** שדה `permissionMode` ב-store.

### מה קיים
- `web-app/src/stores/code-mode-store.ts` — Zustand + persist
- ModeToggle ב-`routes/index.tsx` (כפתורי Chat/Code, z-50)
- `NavMain.tsx` — הוסר `common:projectMode` link

### שלב 3-עדכון: הוספת permissionMode לstore (עדיין נדרש)

- [ ] **3-U.1** הוסף ל-`code-mode-store.ts`:
  ```typescript
  permissionMode: 'ask' | 'auto_accept'
  setPermissionMode: (mode: 'ask' | 'auto_accept') => void
  ```
  - ברירת מחדל: `'auto_accept'`
  - **persist: כן** (נשמר בין sessions)

### בדיקת הצלחה
- [ ] Store מכיל `permissionMode` עם persist

---

## שלב 4: PermissionModeSelector + CodeModePanel שיפורים

> **סטטוס CodeModePanel: בוצע (בסיס)** — Project Bar, Output, Input קיימים.
> **נדרש הוספה:** PermissionModeSelector + חיבור permissionMode לrun.

### מה קיים
- `web-app/src/containers/CodeModePanel.tsx` — chat-like layout עובד
- Project folder picker, auto-scroll, Stop button, event listeners
- Port discovery (MLX → llamacpp fallback) קיים

### משימות

- [ ] **4.1** צור `web-app/src/components/PermissionModeSelector.tsx`:

  ```
  [Ask permissions ▽]    ← trigger button (icon + label + chevron)

  Dropdown popup (מראה כמו screenshot של Cline):
  ┌──────────────────────────────────────────┐
  │ 🤚  Ask permissions               ✓ (אם נבחר) │
  │     Always ask before making changes     │
  ├──────────────────────────────────────────┤
  │ </>  Auto accept edits            ✓ (אם נבחר) │
  │      Automatically accept all file edits │
  └──────────────────────────────────────────┘
  ```

  - מקבל: `value: 'ask' | 'auto_accept'`, `onChange`, `disabled`
  - `disabled={isAgentRunning}` — לא ניתן לשנות בזמן ריצה
  - checkmark ליד האפשרות הנבחרת
  - כל אפשרות: אייקון + title (bold) + subtitle (muted)

- [ ] **4.2** הטמע ב-`CodeModePanel.tsx`:
  - הוסף `PermissionModeSelector` מעל ה-textarea (בתוך אזור הקלט)
  - חבר ל-`permissionMode` / `setPermissionMode` מה-store
  - העבר `permissionMode` ל-`spawn_code_agent` invoke

- [ ] **4.3** עדכן `handleSend` ב-`CodeModePanel.tsx`:
  - הוסף `permissionMode` לפרמטרים של `invoke('spawn_code_agent', { ..., permissionMode })`

### בדיקת הצלחה
- [ ] PermissionModeSelector מופיע מעל textarea
- [ ] בחירה משתנה ונשמרת ב-store
- [ ] מושבת בזמן ריצה
- [ ] המראה קרוב לscreenshot של Cline (icon + title + subtitle + checkmark)
- [ ] permissionMode עובר ל-Rust backend

---

## שלב 5: שיפור Output Panel

> **סטטוס: בוצע (בסיס)** — OutputLine renderer קיים עם פורמט Claude CLI.
> **נדרש:** עדכון לפורמט Cline + approve/deny buttons למצב `ask`.

### משימות

- [ ] **5.1** עדכן `OutputLine` ב-`CodeModePanel.tsx` לפורמט Cline JSON:
  - **חקור** את פורמט ה-JSON stream של Cline (`cline --json`) לפני מימוש
  - עדכן parsers לפי הפורמט האמיתי
  - שמור פונקציונליות קיימת לפורמטים אחרים (fallback לraw text)

- [ ] **5.2** Approve/Deny buttons (מצב `ask`):
  - כאשר `permissionMode == 'ask'` ו-Cline שולח permission request:
    ```
    ┌─────────────────────────────────────────┐
    │ Cline wants to write: src/Form.tsx      │
    │              [Approve]  [Deny]          │
    └─────────────────────────────────────────┘
    ```
  - לחיצה → שלח `y\n` / `n\n` ל-stdin של ה-process
  - **הערה:** מחייב stdin pipe פתוח ב-Rust — להוסיף ל-`spawn_code_agent`

- [ ] **5.3** UX שיפורים:
  - כפתור "Copy All" — מעתיק את כל הפלט
  - כפתור "Clear" — מנקה פלט קודם
  - Collapsible tool results (ברירת מחדל: מקופל)

### בדיקת הצלחה
- [ ] פלט Cline מוצג נכון (tool calls, results, text)
- [ ] Approve/Deny עובד במצב `ask`
- [ ] Copy All + Clear עובדים

---

## שלב 6: ניקוי, i18n, ובדיקות

### משימות

- [ ] **6.1** הסר routes ישנים (Project Mode):
  - מחק `web-app/src/routes/project-mode/` (כולל vision, plan, translation)
  - עדכן `web-app/src/constants/routes.ts`
  - עדכן `web-app/src/routeTree.gen.ts` — רגנרציה

- [ ] **6.2** העבר services שצריך לשמור:
  - `web-app/src/services/pm/` → ישאר (Vision, file-matcher, analyzer, bundler)
  - מחק containers שלא בשימוש (PlanComposer, PlanResultView, TranslationSearchPanel)

- [ ] **6.3** i18n — עדכן מפתחות:
  ```json
  {
    "codeMode": "Code Mode",
    "chatMode": "Chat",
    "projectFolder": "Project Folder",
    "runAgent": "Send",
    "stopAgent": "Stop",
    "askPermissions": "Ask permissions",
    "autoAcceptEdits": "Auto accept edits",
    "installClineCli": "Install Cline CLI",
    "noModelServer": "No model server detected"
  }
  ```

- [ ] **6.4** עדכן tests:
  - `SettingsMenu.test.tsx`
  - `useTools.test.ts`
  - `general.test.tsx`, `interface.test.tsx`
  - הוסף test ל-code-mode-store (כולל permissionMode)

- [ ] **6.5** בדיקות end-to-end:
  - [ ] Chat Mode → עובד ללא regression
  - [ ] Toggle Chat ↔ Code → חלק
  - [ ] Code Mode: Browse folder → תיקיה נבחרת
  - [ ] Code Mode: Auto accept edits → Cline רץ עם --yolo
  - [ ] Code Mode: Ask permissions → Cline מבקש אישור
  - [ ] Code Mode: Stop → agent נעצר
  - [ ] Code Mode: בלי תיקיה → הודעת שגיאה
  - [ ] Code Mode: בלי Cline CLI → הודעת התקנה

---

## שלב 7: Setup & Onboarding

**מטרה:** חוויית onboarding חלקה — אם Cline לא מותקן, להנחות.

### משימות

- [ ] **7.1** בכניסה ל-Code Mode, בדוק:
  ```typescript
  const cliVersion = await invoke('check_cline_cli')
  // sessionPort מ-port discovery
  ```

- [ ] **7.2** אם Cline CLI לא מותקן:
  ```
  ┌─────────────────────────────────────────┐
  │  ⚠️ Cline CLI Required                   │
  │                                          │
  │  Code Mode uses Cline CLI engine         │
  │  with your local model.                  │
  │                                          │
  │  [Install: npm i -g @cline/cline]        │
  │  [Check Again]                           │
  └──────────────────────────────────────────┘
  ```

- [ ] **7.3** אם model session לא נמצא:
  ```
  ┌─────────────────────────────────────────┐
  │  ⚠️ No Running Model Session             │
  │                                          │
  │  Load a model in the Models tab first.   │
  │                                          │
  │  [Go to Models]  [Check Again]           │
  └──────────────────────────────────────────┘
  ```

- [ ] **7.4** אם הכל תקין — status bar:
  ```
  ✅ Cline CLI v0.x  |  ✅ Qwen2.5-Coder-32B @ 127.0.0.1:{port}
  ```

---

## סדר ביצוע (מעודכן)

```
✅ שלב 1: וידוא תקשורת (Claude CLI + proxy — בוצע)
✅ שלב 2: Tauri spawner (code_agent.rs — בוצע בסיס)
✅ שלב 3: Header toggle + store (בוצע בסיס)
✅ שלב 4: CodeModePanel UI (בוצע בסיס)
✅ אפיון טכני: docs/code-mode-spec/code-mode-spec.md (בוצע)
  ↓
⬜ שלב 2-עדכון: החלפת Claude CLI → Cline CLI ב-code_agent.rs
  ↓
⬜ שלב 3-עדכון: הוספת permissionMode לstore
  ↓
⬜ שלב 4: PermissionModeSelector component + חיבור לrun
  ↓
⬜ שלב 5: עדכון Output Panel לפורמט Cline + Approve/Deny
  ↓
⬜ שלב 6: ניקוי + tests
  ↓
⬜ שלב 7: Onboarding (Cline CLI check)
```

**כל שלב נבדק לפני שממשיכים הלאה.**

---

## הערות טכניות

### Cline CLI Flags
```bash
cline \
  --base-url http://127.0.0.1:{port}/v1 \  # OpenAI endpoint של llama-server
  --model {model_id} \                       # שם המודל כפי שמוכר ל-llama-server
  --json \                                   # structured JSON stream output
  [--yolo] \                                 # auto_accept mode בלבד
  -p "{prompt}"                              # non-interactive prompt
```

> **אימות נדרש:** יש לאמת את שמות ה-flags המדויקים של Cline לפני מימוש שלב 2-עדכון.

### Permission Mode → Flags

| permissionMode | flag | התנהגות |
|---|---|---|
| `ask` | ללא `--yolo` | Cline עוצר לפני כל פעולה |
| `auto_accept` | `--yolo` | Cline פועל אוטומטית |

### מצבי הרשאות — שלב 1 (Phase 1)

| # | שם | icon | ערך | מימוש |
|---|---|---|---|---|
| 1 | Ask permissions | 🤚 | `ask` | **שלב 1** |
| 2 | Auto accept edits | `</>` | `auto_accept` | **שלב 1** |
| 3 | Plan mode | 📋 | `plan` | עתידי |
| 4 | Bypass permissions | ⚠️ | `bypass` | עתידי |
| 5 | Auto mode | ⚡ | `auto` | עתידי |

### תשתית קיימת

| רכיב | מיקום | סטטוס |
|---|---|---|
| **CodeModePanel** | `web-app/src/containers/CodeModePanel.tsx` | **קיים — בסיס** |
| **code-mode-store** | `web-app/src/stores/code-mode-store.ts` | **קיים — צריך permissionMode** |
| **code_agent.rs** | `src-tauri/src/core/code_agent.rs` | **קיים — צריך Cline** |
| **ModeToggle** | `web-app/src/routes/index.tsx` | **קיים** |
| MLX Plugin (session registry) | `src-tauri/plugins/tauri-plugin-mlx/` | קיים |
| llamacpp Plugin | `src-tauri/plugins/tauri-plugin-llamacpp/` | קיים |
| Vision analyzer | `web-app/src/services/pm/vision-analyzer.ts` | קיים |
| File matcher (TF-IDF) | `web-app/src/services/pm/file-matcher.ts` | קיים |
| Project analyzer | `web-app/src/services/pm/project-analyzer.ts` | קיים |
| Context bundler | `web-app/src/services/pm/context-bundler.ts` | קיים |

### שאלות פתוחות לפני מימוש שלב 2-עדכון

| # | שאלה | עדיפות |
|---|---|---|
| 1 | מהם ה-flags המדויקים של Cline? (`--base-url`, `--model`, `--json`, `--yolo`) | גבוהה |
| 2 | מהו פורמט ה-JSON stream של Cline? | גבוהה |
| 3 | כיצד שולחים approve/deny ל-stdin של Cline? | גבוהה |
| 4 | האם `cline` הוא שם ה-binary או שם שונה? | גבוהה |
