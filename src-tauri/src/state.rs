use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    Ok(dir)
}

/// State file for a book, keyed by its content id (see `epub::content_id`),
/// so progress survives moving or renaming the file.
fn state_path(app: &tauri::AppHandle, book_id: &str) -> Result<PathBuf, String> {
    // The id becomes part of a file name; accept only what content_id produces.
    if book_id.is_empty() || !book_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Invalid book id '{book_id}'"));
    }
    Ok(data_dir(app)?.join(format!("book_{book_id}.json")))
}

/// State file used by earlier versions, keyed by a hash of the book's path.
fn legacy_state_path(app: &tauri::AppHandle, book_path: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(format!("state_{}.json", simple_hash(book_path))))
}

pub fn window_size_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("win_size.json"))
}

pub fn read_window_size(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let path = window_size_path(app).ok()?;
    if !path.exists() {
        println!("read_window_size: win_size.json not found, using defaults");
        return None;
    }
    let data = fs::read_to_string(path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&data).ok()?;
    let w = val.get("w")?.as_f64()?;
    let h = val.get("h")?.as_f64()?;
    if w > 100.0 && h > 100.0 {
        println!("read_window_size: {w:.0}x{h:.0}");
        Some((w, h))
    } else {
        println!("read_window_size: values too small ({w:.0}x{h:.0}), ignoring");
        None
    }
}

pub fn simple_hash(s: &str) -> String {
    let mut h: u64 = 0;
    for b in s.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u64);
    }
    format!("{:x}", h)
}

/// Write `contents` to `path` atomically: write a temporary file next to it,
/// then rename it over the target, so a crash mid-write never leaves a
/// half-written file.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|e| format!("write: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })
}

pub fn write_state_json(path: &Path, data: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("serialize: {e}"))?;
    write_atomic(path, json.as_bytes())
}

/// Reads a state file. A missing file is `None`; so is a corrupt one, which
/// is logged rather than failing the open.
pub fn read_state_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    match serde_json::from_str(&data) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            eprintln!("read_state_json: ignoring corrupt {:?}: {e}", path);
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn save_state(
    app: tauri::AppHandle,
    book_id: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let path = state_path(&app, &book_id)?;
    write_state_json(&path, &data)?;
    println!("save_state: wrote {} bytes to {:?}", fs::metadata(&path).map(|m| m.len()).unwrap_or(0), path);
    Ok(())
}

/// Load a book's state by content id, falling back to the file earlier
/// versions saved under a hash of the book's path. The next save writes the
/// id-keyed file, which takes precedence from then on.
#[tauri::command]
pub fn load_state(
    app: tauri::AppHandle,
    book_id: String,
    book_path: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = state_path(&app, &book_id)?;
    println!("load_state: checking {:?}", path);
    if let Some(state) = read_state_json(&path)? {
        return Ok(Some(state));
    }
    match legacy_state_path(&app, &book_path) {
        Ok(legacy) => read_state_json(&legacy),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn save_window_size(app: tauri::AppHandle, w: f64, h: f64) -> Result<(), String> {
    let path = window_size_path(&app)?;
    let data = serde_json::json!({ "w": w, "h": h });
    let json = serde_json::to_string(&data).map_err(|e| format!("serialize: {e}"))?;
    write_atomic(&path, json.as_bytes())?;
    println!("save_window_size: saved {w:.0}x{h:.0} to {:?}", path);
    Ok(())
}

#[tauri::command]
pub fn log_debug(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("debug.log");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", msg).map_err(|e| e.to_string())?;
    println!("[debug] {}", msg);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_simple_hash_deterministic() {
        let h1 = simple_hash("/path/to/book.epub");
        let h2 = simple_hash("/path/to/book.epub");
        assert_eq!(h1, h2, "hash must be deterministic");
    }

    #[test]
    fn test_simple_hash_different_inputs() {
        let h1 = simple_hash("/path/to/book1.epub");
        let h2 = simple_hash("/path/to/book2.epub");
        assert_ne!(h1, h2, "different paths must produce different hashes");
    }

    #[test]
    fn test_simple_hash_empty() {
        let h = simple_hash("");
        assert!(!h.is_empty(), "empty input should still produce a hash");
    }

    #[test]
    fn test_write_read_json_roundtrip() {
        let dir = std::env::temp_dir().join("rsvp_test_state");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test_state.json");

        let original = serde_json::json!({
            "page": 42,
            "windowWidth": 1024,
            "windowHeight": 768,
            "fontSize": 1.5,
            "wpm": 450,
            "longWordDelay": true,
            "punctuationPause": false,
            "complexityWeight": 0.3,
            "rsvpWordOffset": 7,
        });

        write_state_json(&path, &original).unwrap();
        assert!(path.exists(), "file must exist after write");

        let loaded = read_state_json(&path).unwrap().expect("must return Some");
        assert_eq!(loaded, original, "round-trip must preserve all values");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_state_json_missing_file() {
        let dir = std::env::temp_dir().join("rsvp_test_missing");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nonexistent.json");

        let result = read_state_json(&path).unwrap();
        assert!(result.is_none(), "missing file must return None");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_read_json_handles_corrupt() {
        let dir = std::env::temp_dir().join("rsvp_test_corrupt");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("corrupt.json");

        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"not validjson{broken").unwrap();
        drop(file);

        let result = read_state_json(&path).unwrap();
        assert!(result.is_none(), "corrupt file should return None");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_atomic_replaces_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join("rsvp_test_atomic");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");

        write_atomic(&path, b"{\"a\":1}").unwrap();
        write_atomic(&path, b"{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        assert!(!dir.join("state.json.tmp").exists(), "temp file must be renamed away");

        let _ = fs::remove_dir_all(&dir);
    }
}
