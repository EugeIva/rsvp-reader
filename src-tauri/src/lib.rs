mod book;
mod epub;
mod fb2;
mod state;
mod txt;

use book::AppState;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// A book macOS asked the app to open (double-click or "Open With" in
/// Finder) that the frontend hasn't taken yet. At launch the request can
/// arrive before the frontend is listening, so it's kept here until the
/// frontend asks for it.
#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

/// The first book (.epub, .fb2, .fb2.zip, .txt) among the opened URLs, as a file path.
fn book_path_from_urls(urls: &[tauri::Url]) -> Option<String> {
    urls.iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .find(|p| book::is_book_path(p))
}

/// Take (and clear) the book waiting to be opened, if any.
#[tauri::command]
fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().ok()?.take()
}

fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
        if let Some(path) = book_path_from_urls(&urls) {
            if let Ok(mut pending) = app.state::<PendingOpen>().0.lock() {
                *pending = Some(path);
            }
            // A running frontend takes it right away.
            let _ = app.emit("open-file-pending", ());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            book: Mutex::new(None),
        })
        .manage(PendingOpen::default())
        // Book images are served as book://localhost/<resource path> (built
        // with convertFileSrc on the frontend), so the webview loads and
        // caches them itself instead of receiving base64 over IPC.
        .register_asynchronous_uri_scheme_protocol("book", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let raw = request.uri().path().trim_start_matches('/');
                let path = percent_encoding::percent_decode_str(raw)
                    .decode_utf8_lossy()
                    .into_owned();
                let response = match book::read_resource(&app.state::<AppState>(), &path) {
                    Ok((bytes, mime)) => tauri::http::Response::builder()
                        .header("Content-Type", mime)
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
            book::open_book,
            book::get_chapter_html,
            book::get_image_sizes,
            book::resolve_chapter_link,
            state::save_state,
            state::load_state,
            state::load_settings,
            state::save_settings,
            state::save_window_size,
            state::log_debug,
            take_pending_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_book_path_from_urls() {
        let urls: Vec<tauri::Url> = [
            "file:///Users/me/Books/cover.jpg",
            "file:///Users/me/Books/%D0%9F%D1%80%D0%B0%D0%B6%D1%81%D0%BA%D0%BE%D0%B5%20%D0%BA%D0%BB%D0%B0%D0%B4%D0%B1%D0%B8%D1%89%D0%B5.EPUB",
            "file:///Users/me/Books/other.epub",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        assert_eq!(
            book_path_from_urls(&urls).as_deref(),
            Some("/Users/me/Books/Пражское кладбище.EPUB")
        );
        let none: Vec<tauri::Url> = vec![
            "file:///a/notes.md".parse().unwrap(),
            "https://example.com/b.epub".parse().unwrap(),
        ];
        assert_eq!(book_path_from_urls(&none), None);
    }
}
