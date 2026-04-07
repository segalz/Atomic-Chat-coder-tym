# Stage 4 — UX: Output rendering + Diffs + Test runner

> **מה שונה מהגרסה הקודמת:** פורמט ה-output מגיע מ-claude (via `ollama launch claude`),
> לא מ-claw-code. יש לאמת ב-Stage 0 את הפורמט ולעדכן בהתאם.

---

## Deliverables

- Output Panel מציג בצורה readable: thinking, tool use, קוד, שגיאות
- Diff view — מה השתנה לאחר כל write
- Test runner — הרצת בדיקות עם אישור מפורש
- Copy All + Clear + Collapsible sections

---

## שלב 4.1 — Output rendering מעודכן

**קובץ:** `web-app/src/containers/CodeModePanel.tsx` → `OutputLine` component

### סוגי שורות ו-UI שלהם

| type | UI |
|---|---|
| `assistant` | טקסט רגיל, markdown |
| `tool_use` | `🔧 Reading src/Form.tsx...` (gray, collapsible) |
| `tool_result` | `✅ Done` / `❌ Error` (collapsible) |
| `permission_request` | כרטיס עם [Approve] [Deny] |
| `system` | טקסט קטן, muted |
| `error` | אדום, bold |
| `done` | ירוק `✅ Agent finished` |

### OutputLine component

```typescript
function OutputLine({ line }: { line: AgentOutputLine }) {
  switch (line.type) {
    case 'assistant':
      return <MarkdownBlock content={line.content} />

    case 'tool_use':
      return (
        <CollapsibleSection icon="🔧" title={line.toolName ?? 'Tool'}>
          <pre>{line.content}</pre>
        </CollapsibleSection>
      )

    case 'tool_result':
      const isError = line.content.startsWith('Error')
      return (
        <CollapsibleSection
          icon={isError ? '❌' : '✅'}
          title={isError ? 'Error' : 'Result'}
          defaultOpen={isError}
        >
          <pre>{line.content}</pre>
        </CollapsibleSection>
      )

    case 'permission_request':
      return <PermissionCard content={line.content} />

    case 'error':
      return <div className="output-error">{line.content}</div>

    case 'done':
      return <div className="output-done">✅ Agent finished</div>

    default:
      return <div className="output-system">{line.content}</div>
  }
}
```

### PermissionCard (מצב ask)

```typescript
function PermissionCard({ content }: { content: string }) {
  const handleApprove = async () => {
    // שלח 'y\n' ל-stdin של ה-process
    await invoke('send_agent_input', { text: 'y' })
  }
  const handleDeny = async () => {
    await invoke('send_agent_input', { text: 'n' })
  }

  return (
    <div className="permission-card">
      <div className="permission-content">{content}</div>
      <div className="permission-buttons">
        <button onClick={handleApprove}>✅ Approve</button>
        <button onClick={handleDeny}>❌ Deny</button>
      </div>
    </div>
  )
}
```

> **הערה:** `send_agent_input` דורש stdin pipe פתוח ב-Rust.
> לממש ב-Stage 1 אם permission mode = "ask".

---

## שלב 4.2 — UX controls

```typescript
// מעל ה-output panel:
<div className="output-controls">
  <button onClick={copyAll}>Copy All</button>
  <button onClick={clearOutput}>Clear</button>
  <button onClick={collapseAll}>Collapse All</button>
</div>
```

```typescript
const copyAll = () => {
  const text = agentOutput
    .map(line => `[${line.type}] ${line.content}`)
    .join('\n')
  navigator.clipboard.writeText(text)
}
```

---

## שלב 4.3 — Diff View (לאחר כתיבה)

כאשר claude כותב קובץ, מציג diff של מה שהשתנה.

### זיהוי write events

```typescript
// ב-event listener:
if (line.type === 'tool_result' && line.toolName?.includes('write')) {
  // הצג diff
  showDiff(line)
}
```

### diff_snapshot event

ה-Rust backend יכול לייצר diff אחרי כל write:

```rust
// אחרי tool_result של write_file:
fn generate_diff(workspace: &Path, paths: &[&str]) -> String {
    // git diff אם קיים
    if let Ok(out) = Command::new("git")
        .args(["diff", "--no-ext-diff", "--"])
        .args(paths)
        .current_dir(workspace)
        .output()
    {
        return String::from_utf8_lossy(&out.stdout).to_string();
    }
    // fallback — אין git
    String::new()
}
```

### UI: Diff block

```typescript
function DiffBlock({ patch }: { patch: string }) {
  if (!patch) return null
  return (
    <CollapsibleSection icon="📝" title="Changes" defaultOpen={false}>
      <pre className="diff-block">{patch}</pre>
    </CollapsibleSection>
  )
}
```

---

## שלב 4.4 — Test Runner

> **Note:** Test runner הוא feature עתידי — ניתן לדחות לאחר MVP.

### תצורה per-workspace

```json
{
  "/Users/zvi/my-app": {
    "testCommand": "yarn test",
    "testArgv": ["yarn", "test"],
    "timeoutSeconds": 60
  }
}
```

### UX flow

```
[Run Tests] button
  ↓
permission_request { reason: "RUN_TESTS", command: "yarn test" }
  ↓
UI: [Approve] [Deny]
  ↓
backend: הרץ את הפקודה ב-workspace
  ↓
stream stdout/stderr → code-agent-output events
  ↓
test_finished { exit_code, duration_ms }
```

### Commands נדרשים (עתידי)

```typescript
invoke('request_test_run', { runId, workspaceRoot })
invoke('cancel_test_run', { runId, testId })
```

---

## CSS — קובץ נפרד

**קובץ:** `web-app/src/containers/CodeModePanel.css`

```css
.output-panel { /* scrollable */ }
.output-error { color: var(--red-11); font-weight: bold; }
.output-done  { color: var(--green-11); }
.output-system { color: var(--gray-10); font-size: 0.85em; }
.permission-card {
  border: 1px solid var(--yellow-7);
  border-radius: 8px;
  padding: 12px;
  background: var(--yellow-2);
}
.diff-block {
  font-family: monospace;
  font-size: 0.8em;
  white-space: pre;
  overflow-x: auto;
}
```

---

## Event additions (Stage 4 — עתידי)

| event | payload | מתי |
|---|---|---|
| `diff_snapshot` | `{ paths, patch, isTruncated }` | אחרי כל file write |
| `test_started` | `{ testId, command }` | test החל |
| `test_output_delta` | `{ testId, stream, text }` | output streaming |
| `test_finished` | `{ testId, exitCode, duration }` | test הסתיים |

---

## בדיקות הצלחה

- [ ] tool_use מוצג עם שם הכלי + collapsible
- [ ] tool_result ✅/❌ לפי תוצאה
- [ ] permission_request מציג Approve/Deny
- [ ] Copy All + Clear עובדים
- [ ] Diff מוצג אחרי write (אם git קיים)
- [ ] Output לא קופא ב-long runs (auto-scroll)

---

## Do / Don't

- **Do:** כל styling ב-CodeModePanel.css
- **Do:** collapsible ברירת מחדל לתוצאות ארוכות
- **Don't:** parse terminal text — render events בלבד
- **Don't:** hardcode test command — per-workspace config
