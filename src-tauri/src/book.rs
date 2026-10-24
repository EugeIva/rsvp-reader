//! Format-neutral access to the open book. Each format (EPUB, FB2) turns its
//! file into chapters of XHTML plus resources (images); everything after
//! that — paging, RSVP, positions — only sees chapters.

use crate::epub::EpubBook;
use crate::fb2::Fb2Book;
use crate::txt::TxtBook;
use serde::Serialize;
use std::io::{Cursor, Read};
use std::sync::Mutex;

/// A book in some format, presented as chapters.
pub trait BookSource: Send {
    fn title(&self) -> String;
    fn author(&self) -> String;
    fn chapter_count(&self) -> usize;
    /// Chapter `index` as XHTML. Links and image sources that point inside
    /// the book are absolute book paths (`/OEBPS/Images/1.png`,
    /// `/ch3.xhtml#n1`), so the frontend can load and follow them without
    /// knowing where the chapter sits.
    fn chapter_html(&self, index: usize) -> Result<String, String>;
    /// Decoded absolute path of each chapter, for resolving links.
    fn chapter_paths(&self) -> Vec<String>;
    /// Raw bytes of a resource (image) at an absolute book path.
    fn read_resource(&self, path: &str) -> Result<Vec<u8>, String>;
    /// Content type of a resource.
    fn mime_for(&self, path: &str) -> String {
        mime_from_extension(path).to_string()
    }
}

pub struct AppState {
    pub book: Mutex<Option<Box<dyn BookSource>>>,
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

/// Content type from a path's extension.
pub fn mime_from_extension(path: &str) -> &'static str {
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

/// True for file names this app opens: .epub, .fb2, .fb2.zip and .txt.
pub fn is_book_path(path: &str) -> bool {
    let p = path.to_lowercase();
    p.ends_with(".epub") || p.ends_with(".fb2") || p.ends_with(".fb2.zip") || p.ends_with(".txt")
}

/// Open a book by its contents where it has a signature: a zip with
/// META-INF/container.xml is an EPUB, a zip with an .fb2 inside is a zipped
/// FB2, FictionBook XML is FB2. Plain text has none, so it's recognised by
/// its .txt extension.
pub fn load_book(path: &str, bytes: &[u8]) -> Result<Box<dyn BookSource>, String> {
    if bytes.starts_with(b"PK") {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| format!("Failed to open archive: {e}"))?;
        if zip.by_name("META-INF/container.xml").is_ok() {
            return Ok(Box::new(EpubBook::open(path)?));
        }
        let name = zip
            .file_names()
            .find(|n| n.to_lowercase().ends_with(".fb2"))
            .map(str::to_string)
            .ok_or("Not a book: the archive has no EPUB or FB2 inside")?;
        let mut data = Vec::new();
        zip.by_name(&name)
            .map_err(|e| format!("Failed to read {name}: {e}"))?
            .read_to_end(&mut data)
            .map_err(|e| format!("Failed to read {name}: {e}"))?;
        return Ok(Box::new(Fb2Book::parse(&data)?));
    }
    match Fb2Book::parse(bytes) {
        Ok(book) => Ok(Box::new(book)),
        Err(_) if path.to_lowercase().ends_with(".txt") => {
            Ok(Box::new(TxtBook::parse(path, bytes)))
        }
        Err(e) => Err(format!("Not an EPUB, FB2 or TXT book: {e}")),
    }
}

// Commands are async so they run off the main thread; a plain (sync) Tauri
// command runs on the main thread and blocks the UI while it works.

#[tauri::command]
pub async fn open_book(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<BookMetadata, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read the file: {e}"))?;
    let book = load_book(&path, &bytes)?;
    let metadata = BookMetadata {
        id: content_id(&bytes),
        title: book.title(),
        author: book.author(),
        spine_count: book.chapter_count(),
    };
    let mut guard = state.book.lock().map_err(|e| e.to_string())?;
    *guard = Some(book);
    Ok(metadata)
}

#[tauri::command]
pub async fn get_chapter_html(
    index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.book.lock().map_err(|e| e.to_string())?;
    guard.as_ref().ok_or("No book loaded")?.chapter_html(index)
}

/// Raw bytes and content type of a resource in the open book (used by the
/// `book://` scheme).
pub fn read_resource(state: &AppState, path: &str) -> Result<(Vec<u8>, String), String> {
    let guard = state.book.lock().map_err(|e| e.to_string())?;
    let book = guard.as_ref().ok_or("No book loaded")?;
    Ok((book.read_resource(path)?, book.mime_for(path)))
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
            let (bytes, _) = read_resource(&state, p).ok()?;
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
    let guard = state.book.lock().map_err(|e| e.to_string())?;
    let book = guard.as_ref().ok_or("No book loaded")?;
    let chapter_paths = book.chapter_paths();
    let base = chapter_paths.get(from).cloned().unwrap_or_default();
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

    #[test]
    fn test_is_book_path() {
        assert!(is_book_path("/a/Book.EPUB"));
        assert!(is_book_path("/a/книга.fb2"));
        assert!(is_book_path("/a/книга.FB2.zip"));
        assert!(is_book_path("/a/рассказ.TXT"));
        assert!(!is_book_path("/a/archive.zip"));
        assert!(!is_book_path("/a/notes.md"));
    }

    #[test]
    fn test_load_book_detects_the_format_by_content() {
        let epub_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/test.epub");
        let epub = std::fs::read(epub_path).unwrap();
        assert!(load_book(epub_path, &epub).unwrap().chapter_count() > 0);

        let fb2 = crate::fb2::tests::SAMPLE.as_bytes();
        // The extension doesn't matter, only the content.
        assert_eq!(
            load_book("/x/book.txt", fb2).unwrap().title(),
            "Тестовая книга"
        );

        // Plain text is opened by its extension.
        assert_eq!(
            load_book("/x/Заметки.txt", "just some text".as_bytes())
                .unwrap()
                .title(),
            "Заметки"
        );
        assert!(load_book("/x/notes.dat", b"just some text").is_err());
    }
}
