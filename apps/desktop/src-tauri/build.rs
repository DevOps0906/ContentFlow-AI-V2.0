fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["retry", "quit_app"])),
    )
    .expect("failed to run tauri-build");
}
