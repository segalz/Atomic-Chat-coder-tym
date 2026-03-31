# תוכנית בדיקות QA — Atomic Chat Code Mode

## שלב 1: וידוא תקשורת — Claude CLI ↔ מודל מקומי

### בדיקות מקדימות
- [ ] לוודא ש-Claude Code CLI מותקן (`claude --version` מחזיר גרסה)
- [ ] לוודא ש-LM Studio רץ ומאזין על `127.0.0.1:1234`
- [ ] לוודא שמודל Qwen2.5-Coder-32B טעון ב-LM Studio

### בדיקות פונקציונליות
- [ ] **1.1** שליחת בקשת curl ל-`/v1/messages` — האם חוזרת תשובה בפורמט Anthropic?
  - אם כן → ממשיכים
  - אם לא (404/error) → צריך proxy, לעבור ל-1.2
- [ ] **1.2** (אם צריך proxy) — לוודא ש-`tools/anthropic-proxy.py` רץ על port 1235 ומתרגם בקשות Anthropic ל-OpenAI ובחזרה
- [ ] **1.3** להריץ `claude -p "What is 2+2?"` עם env vars מקומיים — האם חוזרת תשובה נכונה (4)?
- [ ] **1.4** להריץ עם `--output-format stream-json` — האם הפלט הוא JSON-lines שזורמות (לא בלוק אחד)?
- [ ] **1.5** ליצור פרויקט זמני עם קובץ `index.js`, להריץ prompt שמבקש לערוך אותו — האם הקובץ נערך בפועל על הדיסק?

### קריטריוני הצלחה
- [ ] Claude CLI מקבל תשובה מ-Qwen המקומי
- [ ] Streaming JSON עובד (שורות JSON נפרדות)
- [ ] Claude CLI מצליח לקרוא ולערוך קבצים בפרויקט אמיתי
- [ ] תיעוד מלא של env vars ו-flags שעובדים (לשלבים הבאים)

---

## שלב 2: Tauri Backend — Claude Code Spawner

### בדיקות מקדימות
- [ ] לקרוא ולהבין את הפקודה הקיימת `launch_claude_code_with_config`
- [ ] לוודא שמודול `code_agent.rs` נוצר ב-`src-tauri/src/core/`
- [ ] לוודא שהפקודות רשומות ב-`main.rs` (generate_handler)
- [ ] לוודא שהרשאות shell spawn מוגדרות ב-`capabilities/default.json`

### בדיקות פונקציונליות
- [ ] **2.1** `check_claude_cli` — האם מחזיר version string תקין?
- [ ] **2.2** `check_claude_cli` — כש-CLI לא מותקן, האם מחזיר שגיאה ברורה?
- [ ] **2.3** `spawn_code_agent` — האם מפעיל subprocess של Claude CLI?
- [ ] **2.4** `spawn_code_agent` — האם env vars מוגדרים נכון (ANTHROPIC_BASE_URL, AUTH_TOKEN)?
- [ ] **2.5** `spawn_code_agent` — האם ה-cwd של ה-subprocess הוא `project_dir`?
- [ ] **2.6** `spawn_code_agent` — האם prompt + context מחוברים נכון?
- [ ] **2.7** `spawn_code_agent` — האם events `code-agent-output` נשלחים שורה-שורה?
- [ ] **2.8** `spawn_code_agent` — האם event `code-agent-done` נשלח בסיום עם exit code?
- [ ] **2.9** `stop_code_agent` — האם עוצר את ה-process בפועל?
- [ ] **2.10** `stop_code_agent` — האם event `code-agent-stopped` נשלח?
- [ ] **2.11** בדיקה מ-frontend console: `listen('code-agent-output', console.log)` — האם מוצגות שורות JSON?

### קריטריוני הצלחה
- [ ] כל 3 הפקודות עובדות (check, spawn, stop)
- [ ] Events זורמים ל-frontend בזמן אמת
- [ ] Process נעצר כשמבקשים stop

---

## שלב 3: Code Mode Toggle בHeader

### בדיקות מקדימות
- [ ] לוודא ש-store `code-mode-store.ts` נוצר עם כל ה-state הנדרש
- [ ] לוודא ש-store משתמש ב-`persist` (localStorage)

### בדיקות UI
- [ ] **3.1** Toggle `[Chat | Code]` מופיע ב-Header, ליד בורר המודל
- [ ] **3.2** Tab פעיל מודגש (רקע כהה, shadow)
- [ ] **3.3** Tab לא-פעיל בצבע muted
- [ ] **3.4** עיצוב: rounded-full, מתאים ל-design הכללי
- [ ] **3.5** Toggle נראה טוב גם ברוחב מסך צר (responsive)

### בדיקות פונקציונליות
- [ ] **3.6** לחיצה על "Code" → מסך ראשי משתנה ל-Code Mode
- [ ] **3.7** לחיצה על "Chat" → חזרה למסך Chat רגיל
- [ ] **3.8** רענון דף → הבחירה נשמרת (persist עובד)
- [ ] **3.9** Chat Mode → עובד בדיוק כמו קודם (אין שום regression)
- [ ] **3.10** הלינק `common:projectMode` הוסר מהתפריט הצדדי (`NavMain`)

### קריטריוני הצלחה
- [ ] מעבר חלק בין Chat ל-Code
- [ ] אין regression ב-Chat Mode
- [ ] הבחירה נשמרת בין רענונים

---

## שלב 4: Code Mode UI — Project Bar + Drop Zone

### בדיקות Project Bar
- [ ] **4.1** שדה תיקיה מוצג עם כפתור "Browse"
- [ ] **4.2** לחיצה על Browse → נפתח dialog בחירת תיקיה של המערכת
- [ ] **4.3** אחרי בחירה → שם התיקיה מוצג (לא path מלא)
- [ ] **4.4** Tooltip על שם התיקיה → מציג path מלא
- [ ] **4.5** התיקיה נשמרת ב-store (רענון → אותה תיקיה)

### בדיקות Screenshot Drop Zone
- [ ] **4.6** אזור גרירה מוצג עם הנחיה "Drop screenshot to identify code"
- [ ] **4.7** גרירת תמונה → `extractVisibleText()` רץ ומחלץ טקסט
- [ ] **4.8** `scoreFilesByContent()` → מוצא קובץ מתאים בפרויקט
- [ ] **4.9** High confidence → ניתוח אוטומטי של עץ תלויות
- [ ] **4.10** Low confidence → מוצגת רשימת candidates לבחירה ידנית
- [ ] **4.11** אחרי זיהוי → מוצג: שם קובץ, מספר תלויות, כפתור "Copy Context"
- [ ] **4.12** כפתור "Copy Context" → מעתיק context מלא ל-clipboard
- [ ] **4.13** אזור Drop Zone ניתן לקיפול (collapsible)

### בדיקות Context Badge
- [ ] **4.14** Badge מופיע אחרי זיהוי מוצלח (לדוגמה: `OwnerDataStep.tsx + 14 deps (~2,400 tokens)`)
- [ ] **4.15** לחיצה על badge → מציג/מסתיר preview של הקונטקסט

### בדיקות חיבור ל-ChatInput
- [ ] **4.16** ב-Code Mode כפתור Send → הופך ל- "Run"
- [ ] **4.17** לחיצה על Run → קריאה ל-`spawn_code_agent` עם projectDir, prompt, model, context
- [ ] **4.18** הרצה בלי שנבחרה תיקיה → הודעת שגיאה מתאימה
- [ ] **4.19** הרצה עם prompt ריק → כפתור Run לא פעיל (disabled) או שגיאה

### קריטריוני הצלחה
- [ ] כל flow של Drop Zone עובד end-to-end
- [ ] Context נבנה נכון ונשלח ל-agent
- [ ] שגיאות מוצגות למשתמש בצורה ברורה

---

## שלב 5: Streaming Output Panel

### בדיקות תצוגת פלט
- [ ] **5.1** פאנל מופיע מתחת ל-prompt כש-agent רץ
- [ ] **5.2** הודעת `system/init` → מציג "Working on /path with model..."
- [ ] **5.3** הודעת `assistant` → טקסט מרונדר כ-Markdown
- [ ] **5.4** הודעת `tool_use: Read` → מציג "Reading src/..."
- [ ] **5.5** הודעת `tool_use: Edit` → מציג "Editing src/..."
- [ ] **5.6** הודעת `tool_use: Bash` → מציג "Running: npm test"
- [ ] **5.7** הודעת `tool_use: Write` → מציג "Creating src/..."
- [ ] **5.8** הודעת `tool_use: Glob` → מציג "Searching for *.tsx files"
- [ ] **5.9** הודעת `tool_use: Grep` → מציג "Searching for 'keyword' in code"
- [ ] **5.10** הודעת `tool_result` → בלוק מתקפל (collapsed כברירת מחדל)
- [ ] **5.11** הודעת `error` → הודעת שגיאה באדום
- [ ] **5.12** הודעת `result/success` → "Done"
- [ ] **5.13** JSON לא תקין / הודעה לא מוכרת → לא קורס, מציג raw text

### בדיקות UX
- [ ] **5.14** Auto-scroll — הפאנל גולל אוטומטית לתחתית
- [ ] **5.15** Auto-scroll נעצר אם המשתמש גולל ידנית למעלה
- [ ] **5.16** כפתור Stop מופיע רק כש-agent רץ
- [ ] **5.17** לחיצה על Stop → agent נעצר, מוצגת הודעה
- [ ] **5.18** כפתור "Copy All" → מעתיק את כל הפלט ל-clipboard
- [ ] **5.19** כפתור "Clear" → מנקה פלט קודם
- [ ] **5.20** פונט mono לפלט
- [ ] **5.21** גלילה חלקה, ללא קפיצות
- [ ] **5.22** ביצועים — 1000+ שורות פלט לא מאט את הממשק

### בדיקות מצבים
- [ ] **5.23** Agent רץ → פאנל תופס רוב המסך
- [ ] **5.24** Agent סיים → פלט אחרון נשאר מוצג
- [ ] **5.25** הרצה חדשה → פלט קודם נמחק, פלט חדש מתחיל

### קריטריוני הצלחה
- [ ] פלט streaming בזמן אמת, ללא עיכובים
- [ ] כל סוג הודעה מוצג בצורה ייחודית ונכונה
- [ ] UX חלק — לא קופץ, לא איטי, לא קורס

---

## שלב 6: ניקוי, i18n, ובדיקות

### בדיקות ניקוי קוד
- [ ] **6.1** אין references ל-`project-mode` ב-routes (grep על כל הפרויקט)
- [ ] **6.2** `web-app/src/routes/project-mode/` — נמחק
- [ ] **6.3** `routes.ts` — אין project-mode routes
- [ ] **6.4** `routeTree.gen.ts` — רוגנרציה בוצעה ותקינה
- [ ] **6.5** `NavMain.tsx` — אין לינק ל-`common:projectMode`
- [ ] **6.6** Services שנשמרו: vision-analyzer, file-matcher, project-analyzer, context-bundler, project-dna
- [ ] **6.7** Containers שנמחקו: PlanComposer, PlanResultView, TranslationSearchPanel
- [ ] **6.8** אין קוד מת (unused imports, unused variables) בקבצים שנערכו

### בדיקות i18n
- [ ] **6.9** כל המפתחות החדשים קיימים באנגלית: codeMode, chatMode, projectFolder, browseFolder, dropScreenshot, runAgent, stopAgent, agentRunning, agentDone, installClaudeCli, noModelServer
- [ ] **6.10** כל המפתחות מתורגמים לעברית ב-`web-app/src/locales/he/`
- [ ] **6.11** ממשק בעברית — כיוון RTL תקין לכל הרכיבים החדשים
- [ ] **6.12** אין מחרוזות hardcoded בקוד (הכל דרך i18n)

### בדיקות טסטים
- [ ] **6.13** `SettingsMenu.test.tsx` — עובר
- [ ] **6.14** `useTools.test.ts` — עובר
- [ ] **6.15** `general.test.tsx` — עובר
- [ ] **6.16** `interface.test.tsx` — עובר
- [ ] **6.17** טסט חדש ל-`code-mode-store` — עובר
- [ ] **6.18** אין טסטים שבורים (`yarn test` / `vitest` עובר)

### בדיקות end-to-end (רגרסיה)
- [ ] **6.19** Chat Mode → עובד כמו קודם (שליחת הודעה, קבלת תשובה, היסטוריה)
- [ ] **6.20** Toggle Chat ↔ Code → מעבר חלק, ללא שגיאות בקונסול
- [ ] **6.21** Code Mode: Browse folder → תיקיה נבחרת
- [ ] **6.22** Code Mode: Drop screenshot → קובץ מזוהה
- [ ] **6.23** Code Mode: כתיבת prompt → Run → output streaming
- [ ] **6.24** Code Mode: Stop → agent נעצר
- [ ] **6.25** Code Mode: בלי תיקיה → הודעת שגיאה
- [ ] **6.26** Code Mode: בלי Claude CLI → הודעת התקנה

### קריטריוני הצלחה
- [ ] אין קוד מת, אין references ישנים
- [ ] i18n מלא (EN + HE)
- [ ] כל הטסטים עוברים
- [ ] אין regressions

---

## שלב 7: Setup & Auto-Install

### בדיקות זיהוי דרישות
- [ ] **7.1** כניסה ל-Code Mode → בדיקה אוטומטית של Claude CLI ו-model server
- [ ] **7.2** `check_claude_cli` נקרא בכניסה ל-Code Mode
- [ ] **7.3** בדיקת model server: fetch ל-`/v1/models` → ok או error

### בדיקות מצב "CLI חסר"
- [ ] **7.4** Claude CLI לא מותקן → מוצגת הנחיה עם פקודת התקנה
- [ ] **7.5** הנחיה כוללת `npm i -g @anthropic-ai/claude-code`
- [ ] **7.6** כפתור "Check Again" → בודק שוב האם CLI הותקן
- [ ] **7.7** אחרי התקנה + Check Again → ההנחיה נעלמת

### בדיקות מצב "שרת מודל לא רץ"
- [ ] **7.8** Model server לא רץ → מוצגת הנחיה מתאימה
- [ ] **7.9** כפתור "Go to Models" → מנווט ללשונית Models
- [ ] **7.10** כפתור "Check Again" → בודק שוב
- [ ] **7.11** אחרי הפעלת שרת + Check Again → ההנחיה נעלמת

### בדיקות מצב "הכל תקין"
- [ ] **7.12** שני הרכיבים קיימים → מוצג status bar ירוק
- [ ] **7.13** Status bar מציג: גרסת CLI + שם מודל + כתובת שרת
- [ ] **7.14** אחרי status ירוק → אפשר להשתמש ב-Code Mode רגיל

### בדיקות edge cases
- [ ] **7.15** שרת מודל קורס באמצע עבודה → הודעת שגיאה ברורה
- [ ] **7.16** CLI מותקן אבל גרסה ישנה → האם מוצגת אזהרה?
- [ ] **7.17** Port 1234 תפוס על ידי תהליך אחר → הודעה מתאימה
- [ ] **7.18** חיבור איטי לשרת מודל → timeout סביר עם הודעה

### קריטריוני הצלחה
- [ ] משתמש חדש מקבל הנחיות ברורות לכל מה שחסר
- [ ] כפתורי "Check Again" עובדים
- [ ] הכל תקין → ירוק, אפשר לעבוד

---

## סיכום — מעבר בין שלבים

| מעבר | תנאי |
|------|-------|
| שלב 1 → 2 | Claude CLI מדבר עם Qwen, streaming JSON עובד, קבצים נערכים |
| שלב 2 → 3 | Tauri commands עובדים, events זורמים ל-frontend |
| שלב 3 → 4 | Toggle עובד, Chat Mode ללא regression |
| שלב 4 → 5 | Project Bar + Drop Zone + Run שולח prompt |
| שלב 5 → 6 | Output panel מציג streaming בזמן אמת, Stop עובד |
| שלב 6 → 7 | קוד נקי, טסטים עוברים, i18n מלא |
| שלב 7 → Done | Onboarding חלק, משתמש חדש יכול להתחיל |
