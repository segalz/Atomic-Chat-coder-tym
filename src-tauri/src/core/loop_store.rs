use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

const DB_FILE_NAME: &str = "loop_state.sqlite";

#[derive(Debug, Clone)]
pub struct LoopStoreState {
    db_path: PathBuf,
    pool: Arc<Mutex<Option<SqlitePool>>>,
}

#[derive(Debug, Clone)]
pub struct LoopSessionRecord {
    pub id: String,
    pub project_dir: Option<String>,
    pub prompt: Option<String>,
    pub status: String,
    pub current_run: u32,
    pub max_runs: u32,
    pub interval_seconds: Option<u32>,
    pub backend: Option<String>,
    pub model: Option<String>,
    pub last_step: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LoopEventRecord {
    pub loop_id: String,
    pub run_number: u32,
    pub event_type: String,
    pub payload: Value,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LoopToolCallRecord {
    pub call_id: String,
    pub loop_id: String,
    pub run_number: u32,
    pub tool_name: String,
    pub status: String,
    pub args_summary: Option<String>,
    pub result_signature: Option<String>,
    pub elapsed_ms: Option<u128>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopSessionSummary {
    pub id: String,
    pub project_dir: Option<String>,
    pub prompt: Option<String>,
    pub status: String,
    pub current_run: u32,
    pub max_runs: u32,
    pub updated_at: String,
    pub last_step: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopDurableStatus {
    pub enabled: bool,
    pub db_path: Option<String>,
    pub session_count: i64,
    pub pending_wakeups: i64,
    pub latest_session: Option<LoopSessionSummary>,
    pub last_event_type: Option<String>,
}

impl LoopDurableStatus {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            db_path: None,
            session_count: 0,
            pending_wakeups: 0,
            latest_session: None,
            last_event_type: None,
        }
    }
}

impl LoopStoreState {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            db_path: base_dir.join(DB_FILE_NAME),
            pool: Arc::new(Mutex::new(None)),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    async fn pool(&self) -> Result<SqlitePool, String> {
        let mut guard = self.pool.lock().await;
        if let Some(pool) = guard.as_ref() {
            return Ok(pool.clone());
        }

        if let Some(parent) = self.db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create loop store directory: {error}"))?;
        }

        let options = SqliteConnectOptions::new()
            .filename(&self.db_path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .map_err(|error| format!("Failed to open loop store: {error}"))?;

        run_migrations(&pool).await?;
        *guard = Some(pool.clone());
        Ok(pool)
    }

    pub async fn upsert_session(&self, record: LoopSessionRecord) -> Result<(), String> {
        let pool = self.pool().await?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO loop_sessions (
                id, project_dir, prompt, status, current_run, max_runs,
                interval_seconds, backend, model, last_step, last_error, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
            ON CONFLICT(id) DO UPDATE SET
                project_dir = COALESCE(excluded.project_dir, loop_sessions.project_dir),
                prompt = COALESCE(excluded.prompt, loop_sessions.prompt),
                status = excluded.status,
                current_run = excluded.current_run,
                max_runs = excluded.max_runs,
                interval_seconds = COALESCE(excluded.interval_seconds, loop_sessions.interval_seconds),
                backend = COALESCE(excluded.backend, loop_sessions.backend),
                model = COALESCE(excluded.model, loop_sessions.model),
                last_step = excluded.last_step,
                last_error = COALESCE(excluded.last_error, loop_sessions.last_error),
                updated_at = excluded.updated_at
            "#,
        )
        .bind(record.id)
        .bind(record.project_dir)
        .bind(record.prompt)
        .bind(record.status)
        .bind(i64::from(record.current_run))
        .bind(i64::from(record.max_runs))
        .bind(record.interval_seconds.map(i64::from))
        .bind(record.backend)
        .bind(record.model)
        .bind(record.last_step)
        .bind(record.last_error)
        .bind(now)
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to upsert loop session: {error}"))?;
        Ok(())
    }

    pub async fn append_event(&self, record: LoopEventRecord) -> Result<(), String> {
        let pool = self.pool().await?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let payload = serde_json::to_string(&record.payload)
            .map_err(|error| format!("Failed to serialize loop event payload: {error}"))?;

        sqlx::query(
            r#"
            INSERT OR IGNORE INTO loop_events (
                id, loop_id, run_number, event_type, payload_json, seq, created_at, idempotency_key
            )
            VALUES (
                ?1, ?2, ?3, ?4, ?5,
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM loop_events WHERE loop_id = ?2),
                ?6, ?7
            )
            "#,
        )
        .bind(id)
        .bind(record.loop_id)
        .bind(i64::from(record.run_number))
        .bind(record.event_type)
        .bind(payload)
        .bind(now)
        .bind(record.idempotency_key)
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to append loop event: {error}"))?;
        Ok(())
    }

    pub async fn upsert_tool_call(&self, record: LoopToolCallRecord) -> Result<(), String> {
        let pool = self.pool().await?;
        let now = Utc::now().to_rfc3339();
        let elapsed_ms = record
            .elapsed_ms
            .map(|value| value.min(i64::MAX as u128) as i64);
        sqlx::query(
            r#"
            INSERT INTO loop_tool_calls (
                call_id, loop_id, run_number, tool_name, status, args_summary,
                result_signature, elapsed_ms, is_error, started_at, completed_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CASE WHEN ?5 = 'completed' THEN ?10 ELSE NULL END)
            ON CONFLICT(call_id) DO UPDATE SET
                status = excluded.status,
                result_signature = COALESCE(excluded.result_signature, loop_tool_calls.result_signature),
                elapsed_ms = COALESCE(excluded.elapsed_ms, loop_tool_calls.elapsed_ms),
                is_error = excluded.is_error,
                completed_at = CASE WHEN excluded.status = 'completed' THEN excluded.started_at ELSE loop_tool_calls.completed_at END
            "#,
        )
        .bind(record.call_id)
        .bind(record.loop_id)
        .bind(i64::from(record.run_number))
        .bind(record.tool_name)
        .bind(record.status)
        .bind(record.args_summary)
        .bind(record.result_signature)
        .bind(elapsed_ms)
        .bind(record.is_error)
        .bind(now)
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to upsert loop tool call: {error}"))?;
        Ok(())
    }

    pub async fn store_checkpoint(
        &self,
        loop_id: &str,
        run_number: u32,
        checkpoint_json: String,
        resume_prompt: String,
        source_event_id: Option<String>,
    ) -> Result<(), String> {
        let pool = self.pool().await?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO loop_checkpoints (
                loop_id, run_number, checkpoint_json, resume_prompt, source_event_id, created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(loop_id, run_number) DO UPDATE SET
                checkpoint_json = excluded.checkpoint_json,
                resume_prompt = excluded.resume_prompt,
                source_event_id = excluded.source_event_id,
                created_at = excluded.created_at
            "#,
        )
        .bind(loop_id)
        .bind(i64::from(run_number))
        .bind(checkpoint_json)
        .bind(resume_prompt)
        .bind(source_event_id)
        .bind(now)
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to store loop checkpoint: {error}"))?;
        Ok(())
    }

    pub async fn durable_status(
        &self,
        loop_id: Option<String>,
    ) -> Result<LoopDurableStatus, String> {
        let pool = self.pool().await?;

        let session_count = sqlx::query("SELECT COUNT(*) AS count FROM loop_sessions")
            .fetch_one(&pool)
            .await
            .map_err(|error| format!("Failed to count loop sessions: {error}"))?
            .try_get::<i64, _>("count")
            .map_err(|error| format!("Failed to read loop session count: {error}"))?;

        let pending_wakeups = sqlx::query(
            "SELECT COUNT(*) AS count FROM loop_wakeups WHERE status IN ('pending', 'claimed')",
        )
        .fetch_one(&pool)
        .await
        .map_err(|error| format!("Failed to count loop wakeups: {error}"))?
        .try_get::<i64, _>("count")
        .map_err(|error| format!("Failed to read loop wakeup count: {error}"))?;

        let latest_session = if let Some(loop_id) = loop_id.as_deref() {
            sqlx::query(
                r#"
                SELECT id, project_dir, prompt, status, current_run, max_runs, updated_at, last_step, last_error
                FROM loop_sessions
                WHERE id = ?1
                LIMIT 1
                "#,
            )
            .bind(loop_id)
            .fetch_optional(&pool)
            .await
        } else {
            sqlx::query(
                r#"
                SELECT id, project_dir, prompt, status, current_run, max_runs, updated_at, last_step, last_error
                FROM loop_sessions
                ORDER BY updated_at DESC
                LIMIT 1
                "#,
            )
            .fetch_optional(&pool)
            .await
        }
        .map_err(|error| format!("Failed to read latest loop session: {error}"))?
        .map(row_to_session_summary)
        .transpose()?;

        let last_event_type = if let Some(session) = latest_session.as_ref() {
            sqlx::query(
                "SELECT event_type FROM loop_events WHERE loop_id = ?1 ORDER BY seq DESC LIMIT 1",
            )
            .bind(&session.id)
            .fetch_optional(&pool)
            .await
            .map_err(|error| format!("Failed to read latest loop event: {error}"))?
            .map(|row| row.try_get::<String, _>("event_type"))
            .transpose()
            .map_err(|error| format!("Failed to decode latest loop event: {error}"))?
        } else {
            None
        };

        Ok(LoopDurableStatus {
            enabled: true,
            db_path: Some(self.db_path.display().to_string()),
            session_count,
            pending_wakeups,
            latest_session,
            last_event_type,
        })
    }
}

async fn run_migrations(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS loop_sessions (
            id TEXT PRIMARY KEY,
            project_dir TEXT,
            prompt TEXT,
            status TEXT NOT NULL,
            current_run INTEGER NOT NULL DEFAULT 0,
            max_runs INTEGER NOT NULL DEFAULT 1,
            interval_seconds INTEGER,
            backend TEXT,
            model TEXT,
            last_step TEXT,
            last_error TEXT,
            lease_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to create loop_sessions table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS loop_events (
            id TEXT PRIMARY KEY,
            loop_id TEXT NOT NULL,
            run_number INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            seq INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            idempotency_key TEXT UNIQUE,
            FOREIGN KEY(loop_id) REFERENCES loop_sessions(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to create loop_events table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS loop_wakeups (
            id TEXT PRIMARY KEY,
            loop_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            due_at TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            idempotency_key TEXT UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(loop_id) REFERENCES loop_sessions(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to create loop_wakeups table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS loop_checkpoints (
            loop_id TEXT NOT NULL,
            run_number INTEGER NOT NULL,
            checkpoint_json TEXT NOT NULL,
            resume_prompt TEXT NOT NULL,
            source_event_id TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY(loop_id, run_number),
            FOREIGN KEY(loop_id) REFERENCES loop_sessions(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to create loop_checkpoints table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS loop_tool_calls (
            call_id TEXT PRIMARY KEY,
            loop_id TEXT NOT NULL,
            run_number INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            status TEXT NOT NULL,
            args_summary TEXT,
            result_signature TEXT,
            elapsed_ms INTEGER,
            is_error INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            FOREIGN KEY(loop_id) REFERENCES loop_sessions(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to create loop_tool_calls table: {error}"))?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_loop_events_loop_seq ON loop_events(loop_id, seq);",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to create loop_events index: {error}"))?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_loop_wakeups_due ON loop_wakeups(status, due_at);")
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to create loop_wakeups index: {error}"))?;

    Ok(())
}

fn row_to_session_summary(row: sqlx::sqlite::SqliteRow) -> Result<LoopSessionSummary, String> {
    let current_run = row
        .try_get::<i64, _>("current_run")
        .map_err(|error| format!("Failed to decode current_run: {error}"))?;
    let max_runs = row
        .try_get::<i64, _>("max_runs")
        .map_err(|error| format!("Failed to decode max_runs: {error}"))?;
    Ok(LoopSessionSummary {
        id: row
            .try_get("id")
            .map_err(|error| format!("Failed to decode loop id: {error}"))?,
        project_dir: row
            .try_get("project_dir")
            .map_err(|error| format!("Failed to decode project_dir: {error}"))?,
        prompt: row
            .try_get("prompt")
            .map_err(|error| format!("Failed to decode prompt: {error}"))?,
        status: row
            .try_get("status")
            .map_err(|error| format!("Failed to decode status: {error}"))?,
        current_run: current_run.max(0) as u32,
        max_runs: max_runs.max(0) as u32,
        updated_at: row
            .try_get("updated_at")
            .map_err(|error| format!("Failed to decode updated_at: {error}"))?,
        last_step: row
            .try_get("last_step")
            .map_err(|error| format!("Failed to decode last_step: {error}"))?,
        last_error: row
            .try_get("last_error")
            .map_err(|error| format!("Failed to decode last_error: {error}"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn stores_session_event_and_checkpoint() {
        let temp = TempDir::new().unwrap();
        let store = LoopStoreState::new(temp.path().to_path_buf());

        store
            .upsert_session(LoopSessionRecord {
                id: "loop-1".to_string(),
                project_dir: Some("/tmp/project".to_string()),
                prompt: Some("fix build".to_string()),
                status: "running".to_string(),
                current_run: 1,
                max_runs: 3,
                interval_seconds: Some(60),
                backend: Some("direct-ollama".to_string()),
                model: Some("qwen".to_string()),
                last_step: Some("started".to_string()),
                last_error: None,
            })
            .await
            .unwrap();

        store
            .append_event(LoopEventRecord {
                loop_id: "loop-1".to_string(),
                run_number: 1,
                event_type: "run_started".to_string(),
                payload: serde_json::json!({ "goal": "fix build" }),
                idempotency_key: Some("loop-1:1:run_started".to_string()),
            })
            .await
            .unwrap();

        store
            .store_checkpoint(
                "loop-1",
                1,
                "{\"loop_id\":\"loop-1\"}".to_string(),
                "resume prompt".to_string(),
                None,
            )
            .await
            .unwrap();

        let status = store
            .durable_status(Some("loop-1".to_string()))
            .await
            .unwrap();
        assert!(status.enabled);
        assert_eq!(status.session_count, 1);
        assert_eq!(status.last_event_type.as_deref(), Some("run_started"));
        assert_eq!(status.latest_session.unwrap().current_run, 1);
    }
}
