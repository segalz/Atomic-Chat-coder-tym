# Stage 3 — Safety: workspace boundaries + permission guardrails

> **הערה:** `ollama launch claude` כולל מנגנון permissions משלו.
> אנחנו מוסיפים שכבת הגנה **נוספת** ב-Rust backend — defense in depth.

---

## Deliverables

- Backend בודק workspace boundaries לפני הרצה
- הגדרת permissionMode ברורה (ask / auto_accept)
- הגנה על תיקיות מחוץ ל-projectDir

---

## permissionMode — מה זה אומר בפועל

| permissionMode | flag לollama | התנהגות |
|---|---|---|
| `auto_accept` | `--dangerously-skip-permissions` | agent פועל ללא שאלות |
| `ask` | ללא flag | agent עוצר לפני כל שינוי |

### מצב `ask` — approve/deny

כאשר `ollama launch claude` רץ ללא `--dangerously-skip-permissions`,
ה-agent שולח permission request ל-stdout.

**לאמת ב-Stage 0:** מהו פורמט permission request ב-stdout של claude?

אפשרויות:
1. JSON עם `type: "permission_request"` → backend מעביר ל-UI → UI מציג Approve/Deny
2. Text prompt → backend זוהה → UI מציג Approve/Deny → backend שולח `y\n` / `n\n` ל-stdin

---

## Workspace Boundary Check (לפני spawn)

```rust
pub fn validate_workspace(project_dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(project_dir);

    // חייב להיות קיים
    if !path.exists() {
        return Err(format!("Project directory does not exist: {}", project_dir));
    }

    // חייב להיות תיקייה
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", project_dir));
    }

    // canonicalize (פותר symlinks + ..)
    let canon = path.canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    // לא לאפשר root directory
    if canon == PathBuf::from("/") {
        return Err("Cannot use root directory as workspace".to_string());
    }

    Ok(canon)
}
```

**קרא ל-validate_workspace לפני spawn:**

```rust
#[tauri::command]
pub async fn spawn_code_agent(
    project_dir: String,
    ...
) -> Result<(), String> {
    // בדיקת workspace לפני הכל
    let workspace = validate_workspace(&project_dir)?;

    // ... המשך spawn
}
```

---

## Permission reason codes

ב-output events — להשתמש ב-codes עקביים:

| code | מצב |
|---|---|
| `OUT_OF_WORKSPACE` | agent מנסה לגשת מחוץ לתיקייה |
| `DESTRUCTIVE_COMMAND` | פקודה הרסנית (rm -rf, dd) |
| `FILE_WRITE` | כתיבה לקובץ |
| `RUN_TESTS` | הרצת tests |
| `AMBIGUOUS_PERMISSION_REQUEST` | לא ניתן להבין מה מבוקש |

---

## פקודות הרסניות — deny אוטומטי (עתידי)

> **הערה:** בשלב ראשון — סמוך על claude's built-in permission system.
> שכבת ה-deny הנוספת מגיע ב-iteration עתידי אם יידרש.

רשימה לעתיד:
```
rm -rf / | rm -rf ~ | mkfs | dd | shutdown | reboot
curl ... | sh | wget ... | bash | sudo rm
```

---

## Never run as root

```rust
#[cfg(unix)]
fn check_not_root() -> Result<(), String> {
    if unsafe { libc::geteuid() } == 0 {
        return Err("Refusing to run code agent as root".to_string());
    }
    Ok(())
}
```

---

## Cancellation — cleanup מוגדר

```
[stop_code_agent נקרא]
  ↓
שלח SIGTERM לprocess group
  ↓
המתן 2 שניות
  ↓
אם עדיין חי → SIGKILL
  ↓
wait/reap (אין zombies)
  ↓
emit code-agent-done { cancelled: true }
```

---

## בדיקות הצלחה

- [ ] projectDir לא קיים → שגיאה ברורה
- [ ] projectDir = "/" → שגיאה
- [ ] symlink ל-path מחוץ ל-workspace → canonicalize חושף → שגיאה
- [ ] stop_code_agent → process נעצר, ללא zombies
- [ ] auto_accept → claude רץ עם `--dangerously-skip-permissions`
- [ ] ask → claude רץ ללא flag

---

## Do / Don't

- **Do:** validate workspace לפני כל spawn
- **Do:** reap child processes תמיד
- **Do:** סמוך על claude's permission system כשכבה ראשונה
- **Don't:** הרץ כ-root
- **Don't:** אמון עיוור ב-path strings — canonicalize תמיד
