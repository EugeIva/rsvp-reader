use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn state_path(app: &tauri::AppHandle, book_path: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    let hash = simple_hash(book_path);
    Ok(dir.join(format!("state_{hash}.json")))
}

pub fn window_size_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    Ok(dir.join("win_size.json"))
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

pub fn write_state_json(path: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("serialize: {e}"))?;
    fs::write(path, &json).map_err(|e| format!("write: {e}"))
}

pub fn read_state_json(path: &std::path::Path) -> Result<Option<serde_json::Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&data).map(Some).or(Ok(None))
}

#[tauri::command]
pub fn save_state(
    app: tauri::AppHandle,
    book_path: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let path = state_path(&app, &book_path)?;
    write_state_json(&path, &data)?;
    println!("save_state: wrote {} bytes to {:?}", fs::metadata(&path).map(|m| m.len()).unwrap_or(0), path);

    let last_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("last_book.txt");
    fs::write(&last_path, &book_path).ok();
    Ok(())
}

#[tauri::command]
pub fn load_state(
    app: tauri::AppHandle,
    book_path: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = match state_path(&app, &book_path) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    println!("load_state: checking {:?}", path);
    read_state_json(&path)
}

#[tauri::command]
pub fn get_last_book_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("last_book.txt");
    println!("get_last_book_path: checking {:?}", path);
    match fs::read_to_string(&path) {
        Ok(s) => {
            let trimmed = s.trim().to_string();
            let found = if trimmed.is_empty() { None } else { Some(trimmed) };
            println!("get_last_book_path: {}", if found.is_some() { "found" } else { "empty" });
            Ok(found)
        }
        Err(_) => {
            println!("get_last_book_path: not found");
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn get_window_size(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = window_size_path(&app)?;
    println!("get_window_size: checking {:?}", path);
    let result = read_state_json(&path)?;
    if let Some(ref v) = result {
        println!("get_window_size: found {:?}", v);
    } else {
        println!("get_window_size: file not found or empty");
    }
    Ok(result)
}

#[tauri::command]
pub fn save_window_size(app: tauri::AppHandle, w: f64, h: f64) -> Result<(), String> {
    let path = window_size_path(&app)?;
    let data = serde_json::json!({ "w": w, "h": h });
    let json = serde_json::to_string(&data).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("write: {e}"))?;
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
}