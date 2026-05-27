use notify::{Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;

pub struct LspWatcher {
    _watcher: notify::RecommendedWatcher,
}

impl std::fmt::Debug for LspWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspWatcher").finish()
    }
}

impl LspWatcher {
    pub fn start(
        workspace_root: PathBuf,
        on_change: impl Fn(PathBuf) + Send + Sync + 'static,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (tx, mut rx) = mpsc::unbounded_channel();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                for path in event.paths {
                    let _ = tx.send(path);
                }
            }
        })?;

        watcher.watch(&workspace_root, RecursiveMode::Recursive)?;

        tokio::spawn(async move {
            let mut pending_changes = false;
            let mut last_path = None;

            loop {
                tokio::select! {
                    Some(path) = rx.recv() => {
                        pending_changes = true;
                        last_path = Some(path);
                    }
                    _ = sleep(Duration::from_millis(500)), if pending_changes => {
                        if let Some(p) = last_path.take() {
                            on_change(p);
                        }
                        pending_changes = false;
                    }
                }
            }
        });

        Ok(Self { _watcher: watcher })
    }
}
