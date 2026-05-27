pub mod app;
#[cfg(feature = "cli")]
pub mod cli;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod code_agent;
pub mod downloads;
pub mod extensions;
pub mod filesystem;
pub mod http;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod lsp;
pub mod mcp;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod ollama_agent;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod plan_agent;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod planner_config;
pub mod server;
pub mod setup;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod sim_capture;
pub mod state;
pub mod system;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod test_runner;
pub mod threads;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod updater;
