use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct LspServerBinary {
    pub name: String,
    pub command: String,
    pub version: String,
}

pub fn get_servers_for_extensions() -> HashMap<String, LspServerBinary> {
    let mut servers = HashMap::new();

    let ts_server = LspServerBinary {
        name: "typescript".to_string(),
        command: "typescript-language-server".to_string(),
        version: "1.0.0".to_string(),
    };

    servers.insert("js".to_string(), ts_server.clone());
    servers.insert("ts".to_string(), ts_server.clone());
    servers.insert("jsx".to_string(), ts_server.clone());
    servers.insert("tsx".to_string(), ts_server.clone());
    servers.insert("mjs".to_string(), ts_server.clone());
    servers.insert("cjs".to_string(), ts_server.clone());

    servers.insert(
        "go".to_string(),
        LspServerBinary {
            name: "go".to_string(),
            command: "gopls".to_string(),
            version: "1.0.0".to_string(),
        },
    );

    servers.insert(
        "py".to_string(),
        LspServerBinary {
            name: "python".to_string(),
            command: "pylsp".to_string(),
            version: "1.0.0".to_string(),
        },
    );

    servers.insert(
        "rs".to_string(),
        LspServerBinary {
            name: "rust".to_string(),
            command: "rust-analyzer".to_string(),
            version: "1.0.0".to_string(),
        },
    );

    servers
}

pub fn resolve_server_for_path(file_path: &PathBuf) -> Option<LspServerBinary> {
    let extension = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let servers = get_servers_for_extensions();
    servers.get(&extension).cloned()
}
