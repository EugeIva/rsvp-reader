use rbook::epub::rewrite::{EpubRewriteOptions, PathRewrite};
use rbook::Epub;
use serde::Serialize;
use std::sync::Mutex;

pub struct AppState {
    pub epub: Mutex<Option<Epub>>,
}

#[derive(Serialize)]
pub struct BookMetadata {
    /// Content id (see `content_id`); saved reading state is keyed by it.
    pub id: String,
    pub title: String,
    pub author: String,
    pub spine_count: usize,
}

#[derive(Serialize)]
pub struct ResolvedLink {
    pub chapter_index: usize,
    pub anchor: Option<String>,
}

/// Stable id for a book's content: FNV-1a (64-bit) of the file's bytes, in
/// hex. Unlike the path, it survives moving or renaming the file.
pub fn content_id(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

// Commands are async so they run off the main thread; a plain (sync) Tauri
// command runs on the main thread and blocks the UI while it works.

#[tauri::command]
pub async fn open_epub(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<BookMetadata, String> {
    let epub = Epub::open(&path).map_err(|e| format!("Failed to open EPUB: {e}"))?;
    let id = content_id(&std::fs::read(&path).map_err(|e| format!("Failed to read EPUB: {e}"))?);

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
        id,
        title,
        author,
        spine_count: epub.spine().len(),
    };

    let mut guard = state.epub.lock().map_err(|e| e.to_string())?;
    *guard = Some(epub);

    Ok(metadata)
}

/// A chapter's XHTML. Book-relative paths in it (`img src`, `a href`, SVG
/// image `href`) are rewritten to absolute book paths such as
/// `/OEBPS/Images/1.png`, so the frontend can load images and follow links
/// without knowing where the chapter file sits. `#fragment` links and URLs
/// with a scheme are left alone. Chapters that aren't well-formed XML can't
/// be rewritten and are returned unchanged.
#[tauri::command]
pub async fn get_chapter_html(
    index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;
    let rewrite = EpubRewriteOptions::new().rewrite_paths(PathRewrite::root_relative());
    if let Ok(content) = epub.reader_builder().rewrite(rewrite).create().get(index) {
        return Ok(content.into_string());
    }
    let content = epub
        .reader()
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
pub async fn get_image_sizes(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Option<[usize; 2]>>, String> {
    Ok(paths
        .iter()
        .map(|p| {
            let bytes = read_resource(&state, p).ok()?;
            let size = imagesize::blob_size(&bytes).ok()?;
            (size.width > 0 && size.height > 0).then_some([size.width, size.height])
        })
        .collect())
}

/// Resolve a link `href` (percent-encoded, relative or absolute, optionally
/// with `#fragment` or `?query`) found in the chapter at absolute book path
/// `base`. Returns the percent-decoded, normalized absolute path and the
/// decoded fragment. The path is empty for a fragment-only link.
pub fn resolve_link(base: &str, href: &str) -> (String, Option<String>) {
    let decode = |s: &str| {
        percent_encoding::percent_decode_str(s)
            .decode_utf8_lossy()
            .into_owned()
    };
    let (rest, fragment) = match href.split_once('#') {
        Some((p, f)) => (p, Some(decode(f))),
        None => (href, None),
    };
    let path = decode(rest.split('?').next().unwrap_or(""));
    if path.is_empty() {
        return (String::new(), fragment);
    }
    let joined = if path.starts_with('/') {
        path
    } else {
        let dir = base.rfind('/').map_or("", |i| &base[..i]);
        format!("{}/{path}", decode(dir))
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    (format!("/{}", parts.join("/")), fragment)
}

/// Index of the chapter whose (decoded, absolute) path is exactly `path`.
pub fn find_chapter(chapter_paths: &[String], path: &str) -> Option<usize> {
    chapter_paths.iter().position(|p| p == path)
}

/// Resolve a link clicked in chapter `from` to the chapter it points at.
#[tauri::command]
pub async fn resolve_chapter_link(
    href: String,
    from: usize,
    state: tauri::State<'_, AppState>,
) -> Result<ResolvedLink, String> {
    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;

    let spine = epub.spine();
    let chapter_paths: Vec<String> = (0..spine.len())
        .map(|i| {
            spine
                .get(i)
                .and_then(|entry| entry.manifest_entry())
                .map(|m| resolve_link("", m.href().as_str()).0)
                .unwrap_or_default()
        })
        .collect();

    let base = epub
        .spine()
        .get(from)
        .and_then(|entry| entry.manifest_entry())
        .map(|m| m.href().as_str().to_string())
        .unwrap_or_default();
    let (path, anchor) = resolve_link(&base, &href);
    if path.is_empty() {
        return Err("Anchor-only link; no chapter to resolve".into());
    }

    find_chapter(&chapter_paths, &path)
        .map(|chapter_index| ResolvedLink {
            chapter_index,
            anchor,
        })
        .ok_or_else(|| format!("No chapter found for link '{href}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_id_is_stable_and_content_based() {
        assert_eq!(content_id(b"same bytes"), content_id(b"same bytes"));
        assert_ne!(content_id(b"book one"), content_id(b"book two"));
        // Known FNV-1a 64 value, so the id can't change between versions.
        assert_eq!(content_id(b""), "cbf29ce484222325");
        assert_eq!(content_id(b"a"), "af63dc4c8601ec8c");
        assert!(content_id(b"x").chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_resolve_link_relative_to_chapter() {
        let base = "/OEBPS/Text/ch1.xhtml";
        assert_eq!(
            resolve_link(base, "ch2.xhtml"),
            ("/OEBPS/Text/ch2.xhtml".into(), None)
        );
        assert_eq!(
            resolve_link(base, "./ch2.xhtml#n1"),
            ("/OEBPS/Text/ch2.xhtml".into(), Some("n1".into()))
        );
        assert_eq!(
            resolve_link(base, "../Notes/notes.xhtml#fn3"),
            ("/OEBPS/Notes/notes.xhtml".into(), Some("fn3".into()))
        );
        assert_eq!(
            resolve_link(base, "/OEBPS/Text/ch9.xhtml"),
            ("/OEBPS/Text/ch9.xhtml".into(), None)
        );
    }

    #[test]
    fn test_resolve_link_decodes_and_strips_query() {
        let base = "/OEBPS/My%20Book/ch1.xhtml";
        assert_eq!(
            resolve_link(base, "Part%202.xhtml?x=1#sec%201"),
            ("/OEBPS/My Book/Part 2.xhtml".into(), Some("sec 1".into()))
        );
    }

    #[test]
    fn test_resolve_link_fragment_only() {
        assert_eq!(
            resolve_link("/OEBPS/ch1.xhtml", "#fn2"),
            (String::new(), Some("fn2".into()))
        );
    }

    #[test]
    fn test_find_chapter_is_exact() {
        let chapters: Vec<String> = [
            "/OEBPS/ch1.xhtml",
            "/OEBPS/ch11.xhtml",
            "/OEBPS/text/1.xhtml",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(find_chapter(&chapters, "/OEBPS/ch11.xhtml"), Some(1));
        // The old suffix matching sent "1.xhtml" to "ch11.xhtml" (or ch1.xhtml).
        assert_eq!(find_chapter(&chapters, "/OEBPS/1.xhtml"), None);
        assert_eq!(find_chapter(&chapters, "/OEBPS/text/1.xhtml"), Some(2));
    }
}
