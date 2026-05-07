pub mod app;
#[cfg(feature = "cli")]
pub mod cli;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod code_agent;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod ollama_agent;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod plan_agent;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod planner_config;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod sim_capture;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod test_runner;
pub mod downloads;
pub mod extensions;
pub mod filesystem;
pub mod http;
pub mod mcp;
pub mod server;
pub mod setup;
pub mod state;
pub mod system;
pub mod threads;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod updater;
