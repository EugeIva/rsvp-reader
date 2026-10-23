mod epub;
mod state;

use epub::AppState;
use std::sync::Mutex;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            epub: Mutex::new(None),
        })
        .setup(|app| {
            let (w, h) = state::read_window_size(app.handle()).unwrap_or((800.0, 600.0));
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("rsvp-reader")
                .inner_size(w, h);
            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            epub::open_epub,
            epub::get_chapter_html,
            epub::get_chapter_resource,
            epub::resolve_chapter_link,
            state::save_state,
            state::load_state,
            state::save_window_size,
            state::log_debug,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}