fn main() {
    println!("cargo:rerun-if-changed=capabilities/");
    #[cfg(not(feature = "cli"))]
    tauri_build::build()
}
