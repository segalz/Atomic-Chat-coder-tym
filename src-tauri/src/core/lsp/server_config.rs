use crate::core::lsp::extension_map::resolve_server_for_path;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct LspResolution {
    pub root_dir: PathBuf,
    pub root_uri: String,
    pub language_id: String,
    pub server_command: String,
    pub is_degraded: bool,
}

impl LspResolution {
    pub fn is_degraded(&self) -> bool {
        self.is_degraded
    }

    pub fn server_command(&self) -> &str {
        &self.server_command
    }

    pub fn server_args(&self, root_dir: &Path) -> Vec<String> {
        if self.server_command == "typescript-language-server" {
            let mut args = vec![format!("--stdio"), format!("--tsserver-path=node")];
            if let Some(node_modules) = root_dir.join("node_modules").to_str() {
                args.push(format!("--nodePath={}", node_modules));
            }
            args
        } else {
            vec![]
        }
    }
}

pub fn resolve_lsp_root(project_dir: &str, file_path: &Path) -> Result<LspResolution, String> {
    let project_path = Path::new(project_dir);
    let file_path = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        project_path.join(file_path)
    };

    let server_binary = resolve_server_for_path(&file_path).unwrap_or_else(|| {
        crate::core::lsp::extension_map::LspServerBinary {
            name: "typescript".to_string(), // Default fallback
            command: "typescript-language-server".to_string(),
            version: "1.0.0".to_string(),
        }
    });

    let root_dir = project_path.to_path_buf();
    let root_uri = if root_dir.to_string_lossy().starts_with("file://") {
        root_dir.to_string_lossy().to_string()
    } else {
        format!("file://{}", root_dir.to_string_lossy())
    };

    Ok(LspResolution {
        root_dir,
        root_uri,
        language_id: server_binary.name,
        server_command: server_binary.command,
        is_degraded: false,
    })
}
