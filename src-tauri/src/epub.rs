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
    pub chapter_word_counts: Vec<usize>,
}

#[derive(Serialize)]
pub struct ResolvedLink {
    pub chapter_index: usize,
    pub anchor: Option<String>,
}

#[tauri::command]
pub fn open_epub(path: &str, state: tauri::State<'_, AppState>) -> Result<BookMetadata, String> {
    let epub = Epub::open(path).map_err(|e| format!("Failed to open EPUB: {e}"))?;

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

    let spine_count = epub.spine().len();

    let mut chapter_word_counts = Vec::with_capacity(spine_count);
    for i in 0..spine_count {
        let reader = epub.reader();
        let text = reader
            .get(i)
            .map(|c| c.into_string())
            .unwrap_or_default();
        let stripped = strip_html_tags(&text);
        let count = stripped.split_whitespace().count();
        chapter_word_counts.push(count);
    }

    let metadata = BookMetadata {
        title,
        author,
        spine_count,
        chapter_word_counts,
    };

    let mut guard = state.epub.lock().map_err(|e| e.to_string())?;
    *guard = Some(epub);

    Ok(metadata)
}

#[tauri::command]
pub fn get_chapter_html(index: usize, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;
    let reader = epub.reader();
    let content = reader
        .get(index)
        .map_err(|e| format!("Failed to read chapter {index}: {e}"))?;
    Ok(content.into_string())
}

#[tauri::command]
pub fn get_chapter_text(index: usize, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let html = get_chapter_html(index, state)?;
    let text = strip_html_tags(&html);
    Ok(text)
}

#[tauri::command]
pub fn get_chapter_resource(path: &str, state: tauri::State<'_, AppState>) -> Result<String, String> {
    use base64::Engine;

    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;
    let bytes = epub
        .read_resource_bytes(path)
        .map_err(|e| format!("Failed to read resource '{path}': {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn resolve_chapter_link(href: &str, state: tauri::State<'_, AppState>) -> Result<ResolvedLink, String> {
    let guard = state.epub.lock().map_err(|e| e.to_string())?;
    let epub = guard.as_ref().ok_or("No book loaded")?;

    let fragment_pos = href.find('#');
    let (path, fragment) = match fragment_pos {
        Some(pos) => (&href[..pos], Some(&href[pos + 1..])),
        None => (href, None),
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

fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_entity = false;
    let mut entity_buf = String::new();

    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
            }
            '>' if in_tag => {
                in_tag = false;
                if !result.is_empty() && !result.ends_with(' ') {
                    result.push(' ');
                }
            }
            _ if !in_tag => {
                if c == '&' {
                    in_entity = true;
                    entity_buf.clear();
                } else if in_entity {
                    if c == ';' {
                        let decoded = decode_html_entity(&entity_buf);
                        result.push_str(&decoded);
                        in_entity = false;
                    } else {
                        entity_buf.push(c);
                    }
                } else {
                    result.push(c);
                }
            }
            _ => {}
        }
    }

    result
}

fn decode_html_entity(entity: &str) -> String {
    match entity {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        "nbsp" => " ".to_string(),
        "ndash" => "–".to_string(),
        "mdash" => "—".to_string(),
        "ldquo" => "\"".to_string(),
        "rdquo" => "\"".to_string(),
        "lsquo" => "'".to_string(),
        "rsquo" => "'".to_string(),
        _ if entity.starts_with('#') => {
            let num_str = &entity[1..];
            if let Ok(code) = num_str.parse::<u32>() {
                if let Some(ch) = char::from_u32(code) {
                    return ch.to_string();
                }
            }
            format!("&{entity};")
        }
        _ => format!("&{entity};"),
    }
}