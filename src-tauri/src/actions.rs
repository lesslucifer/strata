use std::path::PathBuf;

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    opener::reveal(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    opener::open(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_to_trash(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    trash::delete(&p).map_err(|e| e.to_string())
}

/// Hard-delete: bypasses the trash. The frontend MUST confirm with the user
/// before invoking this — it's irreversible. Symlinks are removed, not followed.
#[tauri::command]
pub fn delete_permanent(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::symlink_metadata(&p)
        .map_err(|e| format!("Path does not exist: {path} ({e})"))?;
    if meta.file_type().is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn mark_path_deleted(
    store: tauri::State<'_, crate::tree::TreeStore>,
    rel_path: Vec<String>,
) -> Result<(), String> {
    if store.mark_deleted(&rel_path) {
        Ok(())
    } else {
        Err("No scan is currently loaded, or the path could not be found.".into())
    }
}
