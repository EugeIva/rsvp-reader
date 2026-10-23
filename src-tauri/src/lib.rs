mod epub;
mod state;

use epub::AppState;
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            epub: Mutex::new(None),
        })
        // Book images are served as epub://localhost/<resource path> (built
        // with convertFileSrc on the frontend), so the webview loads and
        // caches them itself instead of receiving base64 over IPC.
        .register_asynchronous_uri_scheme_protocol("epub", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let raw = request.uri().path().trim_start_matches('/');
                let path = percent_encoding::percent_decode_str(raw)
                    .decode_utf8_lossy()
                    .into_owned();
                let response = match epub::read_resource(&app.state::<AppState>(), &path) {
                    Ok(bytes) => tauri::http::Response::builder()
                        .header("Content-Type", epub::mime_for(&path))
                        .body(bytes),
                    Err(e) => tauri::http::Response::builder()
                        .status(404)
                        .body(e.into_bytes()),
                };
                match response {
                    Ok(r) => responder.respond(r),
                    Err(e) => responder.respond(
                        tauri::http::Response::builder()
                            .status(500)
                            .body(e.to_string().into_bytes())
                            .expect("static response"),
                    ),
                }
            });
        })
        .setup(|app| {
            let (w, h) = state::read_window_size(app.handle()).unwrap_or((800.0, 600.0));
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("RSVP Reader")
                    .inner_size(w, h);
            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            epub::open_epub,
            epub::get_chapter_html,
            epub::get_image_sizes,
            epub::resolve_chapter_link,
            state::save_state,
            state::load_state,
            state::load_settings,
            state::save_settings,
            state::save_window_size,
            state::log_debug,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
