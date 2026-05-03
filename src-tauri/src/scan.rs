use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use jwalk::WalkDir;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::cancel::CancelFlag;

#[derive(Debug, Serialize)]
pub struct Node {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified_ms: Option<u64>,
    pub children: Vec<Node>,
}

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub path: String,
    pub root: Node,
    pub file_count: u64,
    pub dir_count: u64,
    pub elapsed_ms: u128,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScanProgress {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub current_path: String,
}

const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);

#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    cancel: State<'_, CancelFlag>,
    path: String,
) -> Result<ScanResult, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("path is not a directory: {path}"));
    }

    cancel.reset();
    let cancel_handle = cancel.handle();

    let app_for_blocking = app.clone();
    let scan_path = p.clone();
    let entries = tauri::async_runtime::spawn_blocking(move || {
        walk(&scan_path, &app_for_blocking, &cancel_handle)
    })
    .await
    .map_err(|e| format!("scan task panicked: {e}"))?;

    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }

    let started = Instant::now();
    let mut file_count = 0u64;
    let mut dir_count = 0u64;
    for e in &entries {
        if e.is_dir {
            dir_count += 1;
        } else {
            file_count += 1;
        }
    }

    let root = build_tree(&p, entries);

    Ok(ScanResult {
        path: p.to_string_lossy().to_string(),
        root,
        file_count,
        dir_count,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

struct EntryInfo {
    path: PathBuf,
    is_dir: bool,
    size: u64,
    modified_ms: Option<u64>,
}

fn walk(root: &Path, app: &AppHandle, cancel: &AtomicBool) -> Vec<EntryInfo> {
    let files = AtomicU64::new(0);
    let dirs = AtomicU64::new(0);
    let bytes = AtomicU64::new(0);
    let last_emit = Mutex::new(Instant::now() - PROGRESS_INTERVAL);

    let entries: Vec<EntryInfo> = WalkDir::new(root)
        .skip_hidden(false)
        .follow_links(false)
        .into_iter()
        .take_while(|_| !cancel.load(Ordering::Relaxed))
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().is_dir();
            let meta = e.metadata().ok();
            let size = if is_dir {
                0
            } else {
                meta.as_ref().map(|m| m.len()).unwrap_or(0)
            };
            let modified_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);

            if is_dir {
                dirs.fetch_add(1, Ordering::Relaxed);
            } else {
                files.fetch_add(1, Ordering::Relaxed);
                bytes.fetch_add(size, Ordering::Relaxed);
            }

            let path = e.path();
            maybe_emit(app, &last_emit, &files, &dirs, &bytes, &path);

            EntryInfo {
                path,
                is_dir,
                size,
                modified_ms,
            }
        })
        .collect();

    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: files.load(Ordering::Relaxed),
            dirs: dirs.load(Ordering::Relaxed),
            bytes: bytes.load(Ordering::Relaxed),
            current_path: String::new(),
        },
    );

    entries
}

fn maybe_emit(
    app: &AppHandle,
    last_emit: &Mutex<Instant>,
    files: &AtomicU64,
    dirs: &AtomicU64,
    bytes: &AtomicU64,
    current: &Path,
) {
    let Ok(mut last) = last_emit.try_lock() else {
        return;
    };
    let now = Instant::now();
    if now.duration_since(*last) < PROGRESS_INTERVAL {
        return;
    }
    *last = now;
    drop(last);

    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: files.load(Ordering::Relaxed),
            dirs: dirs.load(Ordering::Relaxed),
            bytes: bytes.load(Ordering::Relaxed),
            current_path: current.to_string_lossy().into_owned(),
        },
    );
}

fn build_tree(root_path: &Path, entries: Vec<EntryInfo>) -> Node {
    let mut by_parent: HashMap<PathBuf, Vec<EntryInfo>> = HashMap::new();
    let mut root_modified: Option<u64> = None;
    for e in entries {
        if e.path == root_path {
            root_modified = e.modified_ms;
            continue;
        }
        if let Some(parent) = e.path.parent() {
            by_parent.entry(parent.to_path_buf()).or_default().push(e);
        }
    }
    build_node(root_path, root_modified, &mut by_parent, true)
}

fn build_node(
    path: &Path,
    modified_ms: Option<u64>,
    by_parent: &mut HashMap<PathBuf, Vec<EntryInfo>>,
    is_dir: bool,
) -> Node {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    if !is_dir {
        return Node {
            name,
            size: 0,
            is_dir: false,
            modified_ms,
            children: Vec::new(),
        };
    }

    let mut children = Vec::new();
    let mut total: u64 = 0;
    if let Some(child_entries) = by_parent.remove(path) {
        for ce in child_entries {
            let child_node = if ce.is_dir {
                build_node(&ce.path, ce.modified_ms, by_parent, true)
            } else {
                Node {
                    name: ce
                        .path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    size: ce.size,
                    is_dir: false,
                    modified_ms: ce.modified_ms,
                    children: Vec::new(),
                }
            };
            total += child_node.size;
            children.push(child_node);
        }
    }

    Node {
        name,
        size: total,
        is_dir: true,
        modified_ms,
        children,
    }
}
