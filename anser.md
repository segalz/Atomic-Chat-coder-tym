# תשובות לשאלות על CODE_MODE_IMPLEMENTATION_PLAN

---

## סעיף 1 — תאימות Qwen2.5-Coder-32B עם Claude CLI tool calls

### מה נמצא:

**Qwen2.5-Coder-32B תומך ב-tool calling, אבל בפורמט OpenAI (Hermes-style), לא בפורמט Anthropic.**

- המודל לא אומן על `tool_use` content blocks של Anthropic.
- כש-self-hosted עם vLLM, לפעמים ה-tool calls נכתבים בתוך תגיות `<tools>` בתוכן התשובה במקום במערך `tool_calls`.
- דרך Ollama — tool calls עובדים סבירים.

### פתרון — Proxy חובה:

כדי להפעיל את Claude Code CLI עם מודל מקומי, **חובה proxy שמתרגם** Anthropic Messages API → OpenAI-compatible API.

שתי אופציות עיקריות:
1. **claude-code-router** — proxy ייעודי שמיירט בקשות Anthropic ומתרגם ל-OpenAI format, מנתב ל-llama.cpp / LM Studio.
2. **LiteLLM Proxy** — שכבת תרגום כללית יותר. הקליינט (Claude Code) חושב שהוא מדבר עם Anthropic, אבל הבקשות מנותבות למנוע מקומי.

**הגדרה:**
```bash
export ANTHROPIC_BASE_URL="http://localhost:4000"  # LiteLLM / claude-code-router
export ANTHROPIC_AUTH_TOKEN="dummy-key"             # ערך כלשהו, המנוע מקומי
```

### אזהרה חשובה:
Tool calling דרך proxy **פחות אמין** מ-Claude. המודל לא אומן על הפורמט של Anthropic, אז פיצ'רים שתלויים ב-structured tool calling (עריכת קבצים, הרצת פקודות) יהיו מוגבלים. זה הסיכון העיקרי של כל התוכנית.

---

## סעיף 2 — ANTHROPIC_API_KEY vs ANTHROPIC_AUTH_TOKEN

**Claude Code תומך בשניהם:**
- `ANTHROPIC_API_KEY` — מפתח API סטנדרטי
- `ANTHROPIC_AUTH_TOKEN` — משמש יותר כשעובדים דרך proxy

**בגלל שאתה רוצה לעבוד רק עם מודל מקומי בלי API key:**
- צריך להגדיר `ANTHROPIC_BASE_URL` לכתובת ה-proxy המקומי
- `ANTHROPIC_AUTH_TOKEN` יכול להיות כל ערך dummy (למשל `"local"`) — ה-proxy לא יבדוק אותו
- **לא להגדיר** `ANTHROPIC_API_KEY` כדי למנוע חיוב בטעות מ-Anthropic

**הפרויקט כבר תומך בזה!** ב-`src-tauri/src/core/system/commands.rs` (שורות 204-367) יש פקודה `launch_claude_code_with_config` שמגדירה את `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, ו-`ANTHROPIC_DEFAULT_*_MODEL` ב-shell config של המשתמש.

---

## סעיף 3 — TurboQuant

**לא נמצא פרויקט או שיטת quantization בשם "TurboQuant"** בחיפוש נרחב באינטרנט וב-GitHub.

שיטות quantization מוכרות למודלים מקומיים:

| שיטה | שימוש עיקרי | מתאים ל-Qwen2.5-Coder-32B? |
|-------|-------------|---------------------------|
| **GGUF** | llama.cpp, CPU+GPU | כן, הכי נפוץ |
| **GPTQ** | GPU, דרך vLLM/AutoGPTQ | כן |
| **AWQ** | GPU, יעיל | כן |
| **EXL2** | ExLlamaV2, GPU | כן |
| **BitsAndBytes** | QLoRA 4/8-bit | כן |

### המלצה:
- **GGUF Q4_K_M** — איזון טוב בין איכות לביצועים, עובד עם llama.cpp / LM Studio
- **GGUF Q5_K_M** — אם יש מספיק VRAM, איכות טובה יותר
- **AWQ** — אם רץ על GPU עם vLLM

אם "TurboQuant" הוא שם פנימי שנתת לגישת quantization מסוימת, אשמח לפרטים נוספים.

---

## סעיף 4 — Agent אחד בכל פעם (הסבר)

### מה השאלה המקורית:
בתוכנית, `CodeAgentState` מחזיק `Option<Child>` אחד — כלומר רק process אחד של Claude Code CLI יכול לרוץ בכל רגע נתון. השאלה הייתה: **מה קורה אם המשתמש מנסה להריץ code agent חדש בזמן שריצה קודמת עדיין פעילה?**

### התשובה:
צריך להחליט על אחת משלוש אסטרטגיות:

**אופציה א' — עצור את הקודם (המלצה):**
- כשהמשתמש לוחץ "Run" חדש, שולחים SIGTERM ל-child process הפעיל
- ממתינים עד 5 שניות, אם לא נעצר — SIGKILL
- רק אז מתחילים ריצה חדשה
- **הגיוני כי:** Claude Code CLI מנהל session — שתי ריצות על אותו קוד יכולות להתנגש

**אופציה ב' — חסום את הכפתור:**
- כל עוד agent רץ, כפתור "Run" מושבת (disabled)
- המשתמש חייב ללחוץ "Stop" לפני שמריץ שוב
- **פשוט יותר, אבל חוויית משתמש פחות טובה**

**אופציה ג' — מספר agents במקביל:**
- `HashMap<ThreadId, Child>` במקום `Option<Child>`
- כל thread יכול להריץ agent משלו
- **מסובך יותר, לא מומלץ לגרסה ראשונה**

### מה קיים כבר בפרויקט:
הפרויקט כבר משתמש בדיוק בדפוס הזה עבור MCP servers ו-LlamaCpp sessions:
- `HashMap<String, RunningServiceEnum>` ב-`AppState` (`src-tauri/src/core/state.rs`)
- Graceful shutdown עם SIGTERM → SIGKILL ב-`src-tauri/plugins/tauri-plugin-llamacpp/src/process.rs`

**ניתן לעקוב אחרי אותו pattern בדיוק.**

---

## סעיף 5 — וידוא עצירה והצגת חשיבה

### עצירה (Stop):
- Claude Code CLI תומך ב-**SIGTERM** לעצירה גרייספול
- ב-UI צריך כפתור "Stop" שקורא ל-`child.kill()` (SIGTERM)
- הדפוס כבר קיים ב-`src-tauri/plugins/tauri-plugin-llamacpp/src/process.rs`:
  ```rust
  // Send SIGTERM first, wait 5 seconds, fallback to SIGKILL
  ```
- חשוב: אחרי עצירה, לנקות את ה-state ולעדכן את ה-UI

### הצגת חשיבה (Thinking):
- Claude Code CLI מדפיס output ל-stdout בזמן אמת
- צריך לקרוא את ה-stdout דרך `BufReader` ולהעביר ל-UI בזמן אמת (streaming)
- הדפוס כבר קיים ב-`tauri-plugin-foundation-models` — מנטר stdout/stderr עם `BufReader`
- ניתן לפרסר את ה-output ולהפריד בין:
  - **Thinking** — מחשבות ותכנון של ה-agent
  - **Tool calls** — פקודות שהוא מריץ
  - **Results** — תוצאות
- Claude Code CLI מוציא output מובנה שניתן לפרסר (JSON mode עם `--output-format json` או streaming)

### המלצה:
להשתמש ב-`--output-format stream-json` כדי לקבל events מובנים שקל לפרסר ולהציג ב-UI.

---

## סעיף 6 — בטיחות (--dangerously-skip-permissions) — המלצה

### הבעיה:
מודל מקומי (Qwen2.5-Coder-32B) **פחות אמין מ-Claude** ב-tool calling. הוא עלול:
- להזות פקודות הרסניות (`rm -rf /`, `git push --force`)
- לייצר tool calls לא תקינים שנפרסים בצורה לא צפויה
- לא לעקוב אחרי הוראות בטיחות כמו שצפוי

### המלצה — גישה מדורגת:

**ברירת מחדל — מצב מוגבל:**
```bash
claude --disallowedTools "Bash(rm:*) Bash(git push:*) Bash(sudo:*)"
```

**לא להשתמש ב-`--dangerously-skip-permissions` בגרסה ראשונה.**

במקום זה:

1. **`--permission-mode default`** — Claude Code ישאל לפני כל פעולה. הכי בטוח.
2. **`--permission-mode acceptEdits`** — אישור אוטומטי לעריכת קבצים, אבל שאילתה לפני shell commands.
3. **`--disallowedTools`** — רשימה שחורה של פקודות מסוכנות. **עובד גם ב-bypass mode.**

### יישום ב-UI:
```
[Code Mode Settings]
  Permission Level: [ Safe (default) | Edit Only | Full Access ]
  Blocked Commands: [rm -rf, git push --force, sudo, ...]
  [x] Show confirmation before shell commands
  [x] Show thinking process
```

### חשוב:
`--allowedTools` **לא עובד** ב-bypass mode (באג ידוע). תמיד להשתמש ב-`--disallowedTools` כ-safety net.

---

## שאלות שנשארו פתוחות (מהשאלות המקוריות)

### בחירת מודל ב-Code Mode:
**המלצה:** אותו dropdown כמו Chat, אבל מסנן רק מודלים שתומכים ב-tool calling. ניתן להוסיף תגית "Code Compatible" ליד מודלים שנבדקו.

### היסטוריה של ריצות:
**המלצה:** לשמור את ה-output של כל ריצה כ-thread/message בהיסטוריה הקיימת. כל ריצת code agent = הודעה חדשה ב-thread.

### Chat + Code במקביל:
**המלצה לגרסה ראשונה:** לא. Code agent רץ בתוך thread — המשתמש יכול לצ'אט ב-threads אחרים, אבל לא באותו thread בזמן שה-agent פעיל. זה מפשט מאוד את ניהול ה-state.

---

## סיכום — צעדים הבאים

1. **שלב 1 (קריטי):** הקמת proxy (LiteLLM / claude-code-router) + בדיקה שהמודל המקומי מייצר tool calls תקינים דרך ה-proxy
2. **שלב 2:** שימוש ב-patterns קיימים בפרויקט (MCP process management) להרצת Claude Code CLI כ-child process
3. **שלב 3:** UI — כפתור Run/Stop, הצגת output בזמן אמת, permission level

**ההמלצה שלי:** להתחיל מבדיקת שלב 1 בטרמינל. אם tool calls לא עובדים טוב דרך proxy, צריך לחשב מסלול מחדש לפני שמשקיעים בשלבים 2-3.
