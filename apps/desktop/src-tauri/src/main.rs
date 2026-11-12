#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod os;
mod sidecar;

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// Fixed on purpose: the WebView storage (local mode data) is keyed by origin.
pub const PORT: u16 = 34110;

#[tauri::command]
fn retry(app: AppHandle) {
    sidecar::restart(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Only the bundled pages and the sidecar origin may load in the main window.
fn is_internal(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("127.0.0.1") => url.port() == Some(PORT),
            _ => false,
        },
        _ => false,
    }
}

/// Opens web links in the system browser; anything else is dropped.
fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

fn main() {
    let app = tauri::Builder::default()
        // Must be first: a second launch exits here, before any sidecar is started.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(sidecar::State::default())
        .invoke_handler(tauri::generate_handler![retry, quit_app])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("ContentFlow AI")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 560.0)
                .on_navigation(|url| {
                    if is_internal(url) {
                        true
                    } else {
                        open_external(url);
                        false
                    }
                })
                .on_new_window(|url, _features| {
                    open_external(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            sidecar::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the ContentFlow app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            sidecar::stop(handle);
        }
    });
}
