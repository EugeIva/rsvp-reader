use rbook::Epub;
use serde::Serialize;
use std::sync::Mutex;

pub struct AppState {
    pub epub: Mutex<Option<Epub>>,
}

#[derive(Serialize)]
pub struct BookMetadata {
    pub title: String,
    pub author: String,
    pub spine_count: usize,
}

#[derive(Serialize)]
pub struct ResolvedLink {
    pub chapter_index: usize,
    pub anchor: Option<String>,
}

// Commands are async so they run off the main thread; a plain (sync) Tauri
// command runs on the main thread and blocks the UI while it works.

#[tauri::command]
pub async fn open_epub(path: String, state: tauri::State<'_, AppState>) -> Result<BookMetadata, String> {
    let epub = Epub::open(&path).map_err(|e| format!("Failed to open EPUB: {e}"))?;

    let title = epub
        .metadata()
        .title()
        .map(|t| t.value().to_string())
        .unwrap_or_default();

    let author = epub
        .metadata()
        .creators()
        .next()
        .map(|c| c.value().to_string())
        .unwrap_or_default();

    let metadata = BookMetadata {
        title,
        author,
        spine_count: epub.spine().len(),
    };

    let mut guard = state.epub.lock().map_err(|e| e.to_string())?;
    *guard = Some(epub);

    Ok(metadata)
}

#[tauri::command]
pub async fn get_chapter_html(index: usize, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;
    let reader = epub.reader();
    let content = reader
        .get(index)
        .map_err(|e| format!("Failed to read chapter {index}: {e}"))?;
    Ok(content.into_string())
}

/// Raw bytes of a resource in the open book (used by the `epub://` scheme).
pub fn read_resource(state: &AppState, path: &str) -> Result<Vec<u8>, String> {
    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;
    epub.read_resource_bytes(path)
        .map_err(|e| format!("Failed to read resource '{path}': {e}"))
}

/// Content type for a resource served over the `epub://` scheme.
pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// Pixel size of each image, read from its header, so pages can be laid out
/// without loading the images. `None` where the size can't be determined
/// (missing resource, or a format such as SVG).
#[tauri::command]
pub async fn get_image_sizes(paths: Vec<String>, state: tauri::State<'_, AppState>) -> Result<Vec<Option<[usize; 2]>>, String> {
    Ok(paths
        .iter()
        .map(|p| {
            let bytes = read_resource(&state, p).ok()?;
            let size = imagesize::blob_size(&bytes).ok()?;
            (size.width > 0 && size.height > 0).then_some([size.width, size.height])
        })
        .collect())
}

#[tauri::command]
pub async fn resolve_chapter_link(href: String, state: tauri::State<'_, AppState>) -> Result<ResolvedLink, String> {
    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;

    let fragment_pos = href.find('#');
    let (path, fragment) = match fragment_pos {
        Some(pos) => (&href[..pos], Some(&href[pos + 1..])),
        None => (href.as_str(), None),
    };

    if path.is_empty() {
        return Err("Anchor-only link; no chapter to resolve".into());
    }

    let spine = epub.spine();
    for i in 0..spine.len() {
        let entry = spine.get(i).ok_or("spine item missing")?;
        if let Some(manifest_entry) = entry.manifest_entry() {
            let entry_href = manifest_entry.href().to_string();
            if entry_href == path || entry_href.ends_with(path) || path.ends_with(&entry_href) {
                return Ok(ResolvedLink {
                    chapter_index: i,
                    anchor: fragment.map(|s| s.to_string()),
                });
            }
        }
    }

    Err(format!("No chapter found for link '{href}'"))
}
