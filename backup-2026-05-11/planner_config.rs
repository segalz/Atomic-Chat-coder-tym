use tauri::{Manager, Runtime};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelConfig {
    pub translator: String,
    pub vision: String,
    pub navigator: String,
    pub architect: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OllamaConfig {
    pub base_url: String,
    pub api_path: String,
    pub request_timeout_ms: u64,
    pub max_retries: u8,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PipelineConfig {
    pub max_file_tree_lines: usize,
    pub max_context_tokens: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GeminiConfig {
    pub cli_path: String,
    pub model: String,
    pub thinking_budget: u32,
    pub timeout_ms: u64,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CodingAgentConfig {
    pub ollama_url: String,
    pub code_model: String,
    pub vision_model: String,
    pub max_iterations: u32,
    pub auto_verify: bool,
}

impl Default for CodingAgentConfig {
    fn default() -> Self {
        CodingAgentConfig {
            ollama_url: "http://localhost:11434".to_string(),
            code_model: "qwen3-coder:30b".to_string(),
            vision_model: "qwen2.5vl:7b".to_string(),
            max_iterations: 40,
            auto_verify: false,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlannerConfig {
    pub models: ModelConfig,
    pub ollama: OllamaConfig,
    pub pipeline: PipelineConfig,
    pub gemini: GeminiConfig,
    #[serde(default)]
    pub coding_agent: CodingAgentConfig,
}

impl PlannerConfig {
    fn defaults() -> Self {
        PlannerConfig {
            models: ModelConfig {
                translator: "qwen2.5:14b-instruct-q5_K_M".to_string(),
                vision: "qwen2.5vl:7b".to_string(),
                navigator: "qwen3.5:35b-a3b-q4_K_M".to_string(),
                architect: "qwen3.5:35b-a3b-q4_K_M".to_string(),
            },
            ollama: OllamaConfig {
                base_url: "http://localhost:11434".to_string(),
                api_path: "/v1/chat/completions".to_string(),
                request_timeout_ms: 120_000,
                max_retries: 2,
            },
            pipeline: PipelineConfig {
                max_file_tree_lines: 150,
                max_context_tokens: 32_000,
            },
            gemini: GeminiConfig {
                cli_path: "gemini".to_string(),
                model: "gemini-3.1-pro".to_string(),
                thinking_budget: 32_768,
                timeout_ms: 300_000,
                enabled: true,
            },
            coding_agent: CodingAgentConfig::default(),
        }
    }

    /// Load config: user override first, fall back to bundled default, then hardcoded defaults.
    pub fn load<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Self {
        // 1. Try user override at app_config_dir/planner-config.toml
        if let Ok(config_dir) = app_handle.path().app_config_dir() {
            let user_path = config_dir.join("planner-config.toml");
            if user_path.exists() {
                if let Ok(raw) = std::fs::read_to_string(&user_path) {
                    match toml::from_str::<PlannerConfig>(&raw) {
                        Ok(cfg) => {
                            log::info!("[PlannerConfig] Loaded user override from {:?}", user_path);
                            return cfg;
                        }
                        Err(e) => {
                            log::warn!("[PlannerConfig] Failed to parse user config: {e}");
                        }
                    }
                }
            }
        }

        // 2. Fall back to bundled resource
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled_path = resource_dir.join("resources").join("planner-config.toml");
            if bundled_path.exists() {
                if let Ok(raw) = std::fs::read_to_string(&bundled_path) {
                    match toml::from_str::<PlannerConfig>(&raw) {
                        Ok(cfg) => {
                            log::info!("[PlannerConfig] Loaded bundled config from {:?}", bundled_path);
                            return cfg;
                        }
                        Err(e) => {
                            log::warn!("[PlannerConfig] Failed to parse bundled config: {e}");
                        }
                    }
                }
            }
        }

        // 3. Hardcoded fallback
        log::warn!("[PlannerConfig] Using hardcoded defaults");
        Self::defaults()
    }
}

#[tauri::command]
pub fn get_planner_config<R: Runtime>(app: tauri::AppHandle<R>) -> Result<PlannerConfig, String> {
    Ok(PlannerConfig::load(&app))
}

#[tauri::command]
pub fn get_coding_agent_config<R: Runtime>(app: tauri::AppHandle<R>) -> Result<CodingAgentConfig, String> {
    Ok(PlannerConfig::load(&app).coding_agent)
}
