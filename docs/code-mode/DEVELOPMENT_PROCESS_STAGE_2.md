# Stage 2 — Frontend: UI wiring + Model Selector

> **מה קיים:** CodeModePanel, store עם permissionMode, ModeToggle.
> **מה נדרש:** הוספת codeModel לstore + CodeModelSelector component + חיבור לOllama.

---

## Deliverables

- Store עם `codeModel` + `availableCodeModels`
- `CodeModelSelector` component — dropdown לבחירת מודל קוד
- Header מציג `CodeModelSelector` רק ב-Code Mode
- `CodeModePanel` מחובר ל-`ollamaModel` + Onboarding UI
- Chat Mode לא נפגע

---

## שלב 2.1 — Store: הוספת codeModel

**קובץ:** `web-app/src/stores/code-mode-store.ts`

```typescript
// הוסף לממשק CodeModeState:
codeModel: string                    // "qwen3-coder:30b"
setCodeModel: (model: string) => void
availableCodeModels: string[]
setAvailableCodeModels: (models: string[]) => void

// ברירת מחדל:
codeModel: 'qwen3-coder:30b',
availableCodeModels: [],

// actions:
setCodeModel: (model) => set({ codeModel: model }),
setAvailableCodeModels: (models) => set({ availableCodeModels: models }),

// partialize (persist):
codeModel: state.codeModel,
// availableCodeModels — לא persist (נטען מחדש בכל פתיחה)
```

---

## שלב 2.2 — CodeModelSelector Component

**קובץ חדש:** `web-app/src/components/CodeModelSelector.tsx`

```typescript
interface CodeModelSelectorProps {
  value: string
  onChange: (model: string) => void
  availableModels: string[]
  disabled?: boolean
}
```

### UI מוצג

```
Trigger button:
  [Qwen3-Coder-30B ▽]   ← bold, icon, chevron

Dropdown popup:
┌──────────────────────────────────────────────────┐
│ מותקן                                            │
│ ● qwen3-coder:30b         Qwen3-Coder 30B   ✓   │
│   qwen2.5-coder:32b       Qwen2.5-Coder 32B      │
│   qwen2.5-coder:7b        Qwen2.5-Coder 7B       │
├──────────────────────────────────────────────────┤
│ מומלץ (לא מותקן)                                  │
│   qwen3-coder-next    ollama pull qwen3-coder-next│
│   deepseek-coder-v2   ollama pull ...             │
└──────────────────────────────────────────────────┘
```

### לוגיקה

```typescript
// מודלים מומלצים ברירת מחדל
const RECOMMENDED_MODELS = [
  { id: 'qwen3-coder-next',       label: 'Qwen3-Coder-Next',  size: '52GB', note: 'SWE 70.6%' },
  { id: 'qwen3-coder:30b',        label: 'Qwen3-Coder 30B',   size: '~20GB' },
  { id: 'qwen2.5-coder:32b',      label: 'Qwen2.5-Coder 32B', size: '20GB' },
  { id: 'qwen2.5-coder:7b',       label: 'Qwen2.5-Coder 7B',  size: '4.7GB', note: 'מהיר' },
  { id: 'deepseek-coder-v2:16b',  label: 'DeepSeek-Coder V2', size: '9GB' },
]

// installed = availableModels מ-store
// לא מותקן = RECOMMENDED_MODELS שלא ב-installed
```

### Props

| prop | סוג | תיאור |
|---|---|---|
| `value` | `string` | המודל הנבחר |
| `onChange` | `(model: string) => void` | שינוי מודל |
| `availableModels` | `string[]` | מותקנים (מ-ollama list) |
| `disabled` | `boolean?` | `true` בזמן ריצת agent |

---

## שלב 2.3 — Header: שילוב CodeModelSelector

**קובץ:** `web-app/src/routes/index.tsx` (או header component)

```typescript
const { mode, codeModel, setCodeModel, availableCodeModels, isAgentRunning } = useCodeModeStore()

// בתוך ה-header:
{mode === 'chat' && (
  <ModelSelector ... />     // קיים — לא משתנה
)}
{mode === 'code' && (
  <CodeModelSelector
    value={codeModel}
    onChange={setCodeModel}
    availableModels={availableCodeModels}
    disabled={isAgentRunning}
  />
)}
```

---

## שלב 2.4 — CodeModePanel: Onboarding + חיבור

**קובץ:** `web-app/src/containers/CodeModePanel.tsx`

### בכניסה ל-Code Mode

```typescript
useEffect(() => {
  if (mode !== 'code') return

  // בדוק Ollama
  invoke<string>('check_ollama')
    .then(version => setOllamaStatus({ ok: true, version }))
    .catch(() => setOllamaStatus({ ok: false }))

  // טען מודלים מותקנים
  invoke<string[]>('list_ollama_models')
    .then(models => setAvailableCodeModels(models))
    .catch(() => {})
}, [mode])
```

### Onboarding states

**Ollama לא מותקן:**
```
┌────────────────────────────────────────────┐
│  ⚠️  Ollama נדרש                           │
│                                             │
│  Code Mode מריץ AI agent מקומי.            │
│  יש להתקין Ollama כדי להמשיך.              │
│                                             │
│  [התקן Ollama]         [בדוק שוב]          │
└────────────────────────────────────────────┘
```

**מודל לא מותקן:**
```
┌────────────────────────────────────────────┐
│  ⚠️  המודל לא מותקן                        │
│                                             │
│  ollama pull qwen3-coder:30b               │
│                                             │
│  [העתק פקודה]          [בדוק שוב]          │
└────────────────────────────────────────────┘
```

**הכל תקין — status bar:**
```
✅ Ollama v0.6.x  |  ✅ qwen3-coder:30b מותקן
```

### `handleSend` מעודכן

```typescript
const { codeModel, projectDir, draftPrompt, permissionMode } = useCodeModeStore()

const handleSend = async () => {
  if (!projectDir) {
    appendOutput({ type: 'error', content: 'בחר תיקיית פרויקט', timestamp: Date.now() })
    return
  }
  if (!codeModel) {
    appendOutput({ type: 'error', content: 'בחר מודל', timestamp: Date.now() })
    return
  }

  clearOutput()
  setAgentRunning(true)

  try {
    await invoke('spawn_code_agent', {
      projectDir,
      prompt: draftPrompt,
      ollamaModel: codeModel,     // ← חדש
      permissionMode,
    })
  } catch (e) {
    appendOutput({ type: 'error', content: String(e), timestamp: Date.now() })
  } finally {
    setAgentRunning(false)
  }
}
```

### Event listeners (קיים — ממשיך לעבוד)

```typescript
useEffect(() => {
  const unlisten1 = listen('code-agent-output', (e) => {
    appendOutput(e.payload as AgentOutputLine)
  })
  const unlisten2 = listen('code-agent-done', () => {
    setAgentRunning(false)
  })
  const unlisten3 = listen('code-agent-error', (e) => {
    appendOutput({ type: 'error', content: String(e.payload), timestamp: Date.now() })
    setAgentRunning(false)
  })

  return () => {
    unlisten1.then(fn => fn())
    unlisten2.then(fn => fn())
    unlisten3.then(fn => fn())
  }
}, [])
```

---

## Frontend Run State Machine

```
idle
  → [שלח] → starting
  → [spawn_code_agent invoke] → running
  → [code-agent-done] → idle
  → [code-agent-error] → idle (עם הודעת שגיאה)
  → [עצור] → cancelling → idle
```

---

## Type Safety

```typescript
// web-app/src/lib/code-agent/events.ts
export type AgentOutputLine =
  | { type: 'assistant';         content: string; timestamp: number }
  | { type: 'tool_use';          content: string; toolName?: string; timestamp: number }
  | { type: 'tool_result';       content: string; toolName?: string; timestamp: number }
  | { type: 'permission_request'; content: string; timestamp: number }
  | { type: 'system';            content: string; timestamp: number }
  | { type: 'error';             content: string; timestamp: number }
  | { type: 'done';              content: string; timestamp: number }
```

---

## בדיקות הצלחה

- [ ] `codeModel` נשמר ב-store בין sessions
- [ ] `availableCodeModels` מתמלא בכניסה לCode Mode
- [ ] Header מציג `CodeModelSelector` ב-Code Mode בלבד
- [ ] Chat Mode לא נפגע
- [ ] Onboarding מוצג נכון (Ollama חסר / מודל חסר / הכל תקין)
- [ ] `handleSend` מעביר `ollamaModel` ל-Rust
- [ ] Events מגיעים ומוצגים ב-panel
- [ ] Stop עובד

---

## Do / Don't

- **Do:** שמור CodeModelSelector נפרד מ-Chat ModelSelector
- **Do:** בדוק Ollama + מודלים בכל כניסה לCode Mode
- **Do:** טיפוסים מפורשים — לא `any`
- **Don't:** שנה את Chat Mode
- **Don't:** רשום event listeners מרובים — unlisten on unmount
