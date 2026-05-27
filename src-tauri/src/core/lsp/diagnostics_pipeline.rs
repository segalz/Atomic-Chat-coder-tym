use crate::core::lsp::protocol::Diagnostic;
use crate::core::lsp::server_config::resolve_lsp_root;
use crate::core::lsp::session::{LspServerConfig, LspSessionManager};
use log::{debug, error};
use notify::{Config, RecommendedWatcher, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

pub const DEBOUNCE_DELAY: Duration = Duration::from_millis(500);

pub struct DiagnosticsPipeline {
    watcher: Option<RecommendedWatcher>,
    sender: Option<mpsc::UnboundedSender<PathBuf>>,
    pending_changes: Arc<tokio::sync::Mutex<HashMap<PathBuf, tokio::time::Instant>>>,
    workspace_roots: Arc<Mutex<Vec<PathBuf>>>,
    manager: LspSessionManager,
}

#[derive(Clone, Serialize)]
struct DiagnosticsUpdatedPayload {
    uri: String,
    diagnostics: Vec<Diagnostic>,
}

impl DiagnosticsPipeline {
    pub fn new(manager: LspSessionManager) -> Self {
        Self {
            watcher: None,
            sender: None,
            pending_changes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            workspace_roots: Arc::new(Mutex::new(Vec::new())),
            manager,
        }
    }

    pub async fn start<R: Runtime>(&mut self, app: AppHandle<R>) -> Result<(), Box<dyn Error>> {
        let (sender, mut receiver) = mpsc::unbounded_channel::<PathBuf>();
        let pending_changes = Arc::clone(&self.pending_changes);
        let workspace_roots = Arc::clone(&self.workspace_roots);
        let sender_clone = sender.clone();

        let watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| match res {
                Ok(event) => {
                    if let Some(path) = event.paths.first() {
                        let _ = sender_clone.send(path.clone());
                    }
                }
                Err(e) => {
                    error!("Watcher error: {:?}", e);
                }
            },
            Config::default(),
        )?;

        let manager_clone = self.manager.clone();
        let app_clone = app.clone();

        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Some(path) => {
                        let changes = Arc::clone(&pending_changes);
                        let roots = Arc::clone(&workspace_roots);
                        let path_clone = path.clone();
                        let manager = manager_clone.clone();
                        let app = app_clone.clone();

                        tokio::spawn(async move {
                            if !Self::should_track_path(&path_clone) {
                                return;
                            }

                            let deadline = tokio::time::Instant::now() + DEBOUNCE_DELAY;
                            {
                                let mut debounce_map = changes.lock().await;
                                debounce_map.insert(path_clone.clone(), deadline);
                            }

                            sleep(DEBOUNCE_DELAY).await;

                            let mut should_trigger = false;
                            {
                                let mut debounce_map = changes.lock().await;
                                if debounce_map
                                    .get(&path_clone)
                                    .is_some_and(|latest_deadline| *latest_deadline == deadline)
                                {
                                    debounce_map.remove(&path_clone);
                                    should_trigger = true;
                                }
                            }

                            if should_trigger {
                                debug!("Debounce complete for: {:?}", path_clone);
                                let project_dir = Self::project_dir_for_path(&path_clone, &roots);
                                if let Some(payload) = Self::trigger_diagnostics_refresh_impl(
                                    path_clone,
                                    project_dir,
                                    manager,
                                )
                                .await
                                {
                                    if let Err(error) = app.emit("lsp-diagnostics-updated", payload)
                                    {
                                        error!(
                                            "Failed to emit LSP diagnostics update: {:?}",
                                            error
                                        );
                                    }
                                }
                            }
                        });
                    }
                    None => break,
                }
            }
        });

        self.sender = Some(sender);
        self.watcher = Some(watcher);

        Ok(())
    }

    pub fn add_workspace_root(&mut self, root: PathBuf) -> Result<(), Box<dyn Error>> {
        if let Some(ref mut watcher) = self.watcher {
            watcher.watch(&root, notify::RecursiveMode::Recursive)?;
            {
                let mut roots = self.workspace_roots.lock().unwrap();
                if !roots.iter().any(|existing| existing == &root) {
                    roots.push(root);
                }
            }
        }
        Ok(())
    }

    pub fn remove_workspace_root(&mut self, root: &PathBuf) -> Result<(), Box<dyn Error>> {
        if let Some(ref mut watcher) = self.watcher {
            watcher.unwatch(root)?;
            self.workspace_roots
                .lock()
                .unwrap()
                .retain(|existing| existing != root);
        }
        Ok(())
    }

    pub async fn trigger_diagnostics_refresh(&self, file_path: PathBuf) {
        let project_dir = Self::project_dir_for_path(&file_path, &self.workspace_roots);
        let _ =
            Self::trigger_diagnostics_refresh_impl(file_path, project_dir, self.manager.clone())
                .await;
    }

    async fn trigger_diagnostics_refresh_impl(
        file_path: PathBuf,
        project_dir: PathBuf,
        manager: LspSessionManager,
    ) -> Option<DiagnosticsUpdatedPayload> {
        debug!("Diagnostics refresh triggered for: {:?}", file_path);

        let project_dir = project_dir.to_string_lossy().to_string();

        let resolution = match resolve_lsp_root(&project_dir, &file_path) {
            Ok(r) => r,
            Err(_) => return None,
        };

        if resolution.is_degraded() {
            return None;
        }

        let config = LspServerConfig {
            language_id: resolution.language_id.clone(),
            root_uri: resolution.root_uri.clone(),
            root_name: resolution.root_dir.as_os_str().to_string_lossy().into(),
            command: resolution.server_command().to_string(),
            args: resolution.server_args(&resolution.root_dir),
            initialization_options: Some(serde_json::json!({
                "trace.server": "verbose",
                "trace.client": "verbose",
            })),
        };

        let session = manager.get_or_start(config).await?;

        let uri = url::Url::from_file_path(&file_path)
            .map(|u| u.to_string())
            .unwrap_or_else(|_| file_path.to_string_lossy().to_string());

        let diagnostics = session.diagnostics_for_file(&file_path).await;

        Some(DiagnosticsUpdatedPayload { uri, diagnostics })
    }

    fn project_dir_for_path(
        file_path: &PathBuf,
        workspace_roots: &Arc<Mutex<Vec<PathBuf>>>,
    ) -> PathBuf {
        let roots = workspace_roots.lock().unwrap();
        roots
            .iter()
            .filter(|root| file_path.starts_with(root))
            .max_by_key(|root| root.components().count())
            .cloned()
            .unwrap_or_else(|| file_path.parent().unwrap_or(file_path).to_path_buf())
    }

    fn should_track_path(path: &PathBuf) -> bool {
        if path
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .any(|segment| {
                matches!(
                    segment,
                    ".git" | "node_modules" | "target" | "dist" | "build" | ".next"
                )
            })
        {
            return false;
        }

        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension,
                    "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "json" | "toml"
                )
            })
    }
}
