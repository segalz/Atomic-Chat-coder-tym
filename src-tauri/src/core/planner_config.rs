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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointFailureAdvisorMode {
    Auto,
    Claude,
    Antigravity,
    Codex,
}

impl Default for PointFailureAdvisorMode {
    fn default() -> Self {
        PointFailureAdvisorMode::Auto
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvisorCloudPolicy {
    AutoWithConfiguredAdvisors,
    AskBeforeCloudAdvisor,
    LocalOnly,
}

impl Default for AdvisorCloudPolicy {
    fn default() -> Self {
        AdvisorCloudPolicy::AskBeforeCloudAdvisor
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationAdvisorPolicy {
    ManualOnly,
    AutoOnStuck,
    AskBeforeCloudAdvisor,
}

impl Default for ConversationAdvisorPolicy {
    fn default() -> Self {
        ConversationAdvisorPolicy::ManualOnly
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AdvisorCliCommandConfig {
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub enabled: bool,
}

impl AdvisorCliCommandConfig {
    fn disabled(command: &str) -> Self {
        AdvisorCliCommandConfig {
            command: command.to_string(),
            enabled: false,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AdvisorCliCommandsConfig {
    #[serde(default = "default_claude_cli")]
    pub claude: AdvisorCliCommandConfig,
    #[serde(default = "default_antigravity_cli")]
    pub antigravity: AdvisorCliCommandConfig,
    #[serde(default = "default_codex_cli")]
    pub codex: AdvisorCliCommandConfig,
}

impl Default for AdvisorCliCommandsConfig {
    fn default() -> Self {
        AdvisorCliCommandsConfig {
            claude: default_claude_cli(),
            antigravity: default_antigravity_cli(),
            codex: default_codex_cli(),
        }
    }
}

fn default_claude_cli() -> AdvisorCliCommandConfig {
    AdvisorCliCommandConfig::disabled("claude -p")
}

fn default_antigravity_cli() -> AdvisorCliCommandConfig {
    AdvisorCliCommandConfig::disabled("antigravity ask")
}

fn default_codex_cli() -> AdvisorCliCommandConfig {
    AdvisorCliCommandConfig::disabled("codex exec")
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AdvisorAttemptBudgetConfig {
    #[serde(default = "default_max_advisor_calls_per_run")]
    pub max_advisor_calls_per_run: u32,
    #[serde(default = "default_max_advisor_calls_per_signature")]
    pub max_advisor_calls_per_signature: u32,
    #[serde(default = "default_advisor_cooldown_seconds")]
    pub advisor_cooldown_seconds: u64,
}

impl Default for AdvisorAttemptBudgetConfig {
    fn default() -> Self {
        AdvisorAttemptBudgetConfig {
            max_advisor_calls_per_run: default_max_advisor_calls_per_run(),
            max_advisor_calls_per_signature: default_max_advisor_calls_per_signature(),
            advisor_cooldown_seconds: default_advisor_cooldown_seconds(),
        }
    }
}

fn default_max_advisor_calls_per_run() -> u32 {
    3
}

fn default_max_advisor_calls_per_signature() -> u32 {
    1
}

fn default_advisor_cooldown_seconds() -> u64 {
    120
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PointFailureAdvisorConfig {
    #[serde(default)]
    pub mode: PointFailureAdvisorMode,
    #[serde(default)]
    pub commands: AdvisorCliCommandsConfig,
    #[serde(default = "default_advisor_fallback_order")]
    pub fallback_order: Vec<String>,
    #[serde(default)]
    pub loop_policy: AdvisorCloudPolicy,
    #[serde(default)]
    pub conversation_policy: ConversationAdvisorPolicy,
    #[serde(default)]
    pub budgets: AdvisorAttemptBudgetConfig,
}

impl Default for PointFailureAdvisorConfig {
    fn default() -> Self {
        PointFailureAdvisorConfig {
            mode: PointFailureAdvisorMode::Auto,
            commands: AdvisorCliCommandsConfig::default(),
            fallback_order: default_advisor_fallback_order(),
            loop_policy: AdvisorCloudPolicy::AskBeforeCloudAdvisor,
            conversation_policy: ConversationAdvisorPolicy::ManualOnly,
            budgets: AdvisorAttemptBudgetConfig::default(),
        }
    }
}

fn default_advisor_fallback_order() -> Vec<String> {
    vec![
        "claude".to_string(),
        "antigravity".to_string(),
        "codex".to_string(),
    ]
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CodingAgentConfig {
    pub ollama_url: String,
    pub code_model: String,
    pub vision_model: String,
    pub max_iterations: u32,
    pub auto_verify: bool,
    #[serde(default)]
    pub point_failure_advisor: PointFailureAdvisorConfig,
}

impl Default for CodingAgentConfig {
    fn default() -> Self {
        CodingAgentConfig {
            ollama_url: "http://localhost:11434".to_string(),
            code_model: "qwen3-coder:30b".to_string(),
            vision_model: "qwen2.5vl:7b".to_string(),
            max_iterations: 40,
            auto_verify: false,
            point_failure_advisor: PointFailureAdvisorConfig::default(),
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
                            log::info!(
                                "[PlannerConfig] Loaded bundled config from {:?}",
                                bundled_path
                            );
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
pub fn get_coding_agent_config<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<CodingAgentConfig, String> {
    Ok(PlannerConfig::load(&app).coding_agent)
}

#[tauri::command]
pub fn get_point_failure_advisor_config<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<PointFailureAdvisorConfig, String> {
    Ok(PlannerConfig::load(&app).coding_agent.point_failure_advisor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_failure_advisor_defaults_are_conservative() {
        let config = PointFailureAdvisorConfig::default();

        assert_eq!(config.mode, PointFailureAdvisorMode::Auto);
        assert_eq!(
            config.fallback_order,
            vec!["claude", "antigravity", "codex"]
        );
        assert!(!config.commands.claude.enabled);
        assert!(!config.commands.antigravity.enabled);
        assert!(!config.commands.codex.enabled);
        assert_eq!(
            config.loop_policy,
            AdvisorCloudPolicy::AskBeforeCloudAdvisor
        );
        assert_eq!(
            config.conversation_policy,
            ConversationAdvisorPolicy::ManualOnly
        );
        assert_eq!(config.budgets.max_advisor_calls_per_run, 3);
        assert_eq!(config.budgets.max_advisor_calls_per_signature, 1);
        assert_eq!(config.budgets.advisor_cooldown_seconds, 120);
    }

    #[test]
    fn coding_agent_config_parses_without_advisor_section() {
        let raw = r#"
ollama_url = "http://localhost:11434"
code_model = "qwen3-coder-next:latest"
vision_model = "qwen2.5vl:7b"
max_iterations = 250
auto_verify = false
"#;

        let config: CodingAgentConfig = toml::from_str(raw).unwrap();

        assert_eq!(config.code_model, "qwen3-coder-next:latest");
        assert_eq!(
            config.point_failure_advisor.conversation_policy,
            ConversationAdvisorPolicy::ManualOnly
        );
        assert!(!config.point_failure_advisor.commands.claude.enabled);
    }

    #[test]
    fn coding_agent_config_parses_advisor_overrides() {
        let raw = r#"
ollama_url = "http://localhost:11434"
code_model = "qwen3-coder-next:latest"
vision_model = "qwen2.5vl:7b"
max_iterations = 250
auto_verify = false

[point_failure_advisor]
mode = "claude"
fallback_order = ["claude", "codex"]
loop_policy = "local_only"
conversation_policy = "auto_on_stuck"

[point_failure_advisor.commands.claude]
command = "claude -p"
enabled = true

[point_failure_advisor.budgets]
max_advisor_calls_per_run = 2
max_advisor_calls_per_signature = 1
advisor_cooldown_seconds = 60
"#;

        let config: CodingAgentConfig = toml::from_str(raw).unwrap();
        let advisor = config.point_failure_advisor;

        assert_eq!(advisor.mode, PointFailureAdvisorMode::Claude);
        assert_eq!(advisor.fallback_order, vec!["claude", "codex"]);
        assert_eq!(advisor.loop_policy, AdvisorCloudPolicy::LocalOnly);
        assert_eq!(
            advisor.conversation_policy,
            ConversationAdvisorPolicy::AutoOnStuck
        );
        assert!(advisor.commands.claude.enabled);
        assert_eq!(advisor.commands.claude.command, "claude -p");
        assert_eq!(advisor.commands.codex.command, "codex exec");
        assert_eq!(advisor.budgets.max_advisor_calls_per_run, 2);
        assert_eq!(advisor.budgets.advisor_cooldown_seconds, 60);
    }
}
