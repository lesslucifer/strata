use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use jwalk::WalkDir;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::cancel::CancelFlag;
use crate::categories::{SLOT_COUNT, slot_for_name};
use crate::tree::{Node, TreeStore};

#[derive(Debug, Serialize)]
pub struct ScanSummary {
    pub path: String,
    pub root_name: String,
    pub root_size: u64,
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
    /// "walking" while jwalk runs, "building" while we assemble the tree,
    /// "indexing" while we precompute type stats. The frontend uses this to
    /// keep the user informed during the silent post-walk phases.
    pub phase: String,
    /// Per-category accumulated bytes (slot order matches categories.rs and
    /// src/colors.ts CATEGORIES; trailing entry is the "other/unknown" bucket).
    pub category_bytes: Vec<u64>,
}

const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);

#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    cancel: State<'_, CancelFlag>,
    store: State<'_, TreeStore>,
    path: String,
) -> Result<ScanSummary, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    cancel.reset();
    let cancel_handle = cancel.handle();

    let app_for_blocking = app.clone();
    let scan_path = p.clone();
    let started = Instant::now();
    // Walk + tree-build + type-stats all run on the blocking pool so the IPC
    // worker stays free. The type-stat precompute means the Types tab is
    // instant on first open.
    let cancel_for_blocking = Arc::clone(&cancel_handle);
    let result = tauri::async_runtime::spawn_blocking(move || -> Option<_> {
        let (entries, totals) = walk(&scan_path, &app_for_blocking, &cancel_for_blocking);
        if cancel_for_blocking.load(Ordering::Relaxed) {
            return None;
        }
        let mut files = 0u64;
        let mut dirs = 0u64;
        for e in &entries {
            if e.is_dir {
                dirs += 1;
            } else {
                files += 1;
            }
        }
        // Phase: building tree. Frontend uses this to switch the label
        // and freeze the live type-mix bar at its final values.
        emit_phase(&app_for_blocking, "building", &totals);
        let root = build_tree(&scan_path, entries, &cancel_for_blocking)?;
        if cancel_for_blocking.load(Ordering::Relaxed) {
            return None;
        }
        emit_phase(&app_for_blocking, "indexing", &totals);
        let stats = crate::types_stats::compute_cancellable(&root, &cancel_for_blocking)?;
        Some((root, stats, files, dirs))
    })
    .await
    .map_err(|e| format!("Scan task failed unexpectedly: {e}"))?;

    if cancel.is_cancelled() || result.is_none() {
        return Err("cancelled".into());
    }
    let (root, type_stats, file_count, dir_count) = result.unwrap();

    let summary = ScanSummary {
        path: p.to_string_lossy().to_string(),
        root_name: root.name.clone(),
        root_size: root.size,
        file_count,
        dir_count,
        elapsed_ms: started.elapsed().as_millis(),
    };
    store.set(p, root, type_stats);
    Ok(summary)
}

pub struct EntryInfo {
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

/// Final counters from the walk, used to keep emitting consistent values
/// during the post-walk phases (tree build, type indexing).
pub struct WalkTotals {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub category_bytes: Vec<u64>,
}

fn walk(root: &Path, app: &AppHandle, cancel: &AtomicBool) -> (Vec<EntryInfo>, WalkTotals) {
    let files = AtomicU64::new(0);
    let dirs = AtomicU64::new(0);
    let bytes = AtomicU64::new(0);
    // One atomic per category slot. Updated on every file entry; read by the
    // throttled emitter without locking. Cheap relative to the metadata calls.
    let category_bytes: Vec<AtomicU64> = (0..SLOT_COUNT).map(|_| AtomicU64::new(0)).collect();
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
                let name = e.file_name().to_string_lossy();
                let slot = slot_for_name(&name);
                category_bytes[slot].fetch_add(size, Ordering::Relaxed);
            }

            let path = e.path();
            maybe_emit(app, &last_emit, &files, &dirs, &bytes, &category_bytes, &path);

            EntryInfo {
                path,
                is_dir,
                size,
                modified_ms,
            }
        })
        .collect();

    let totals = WalkTotals {
        files: files.load(Ordering::Relaxed),
        dirs: dirs.load(Ordering::Relaxed),
        bytes: bytes.load(Ordering::Relaxed),
        category_bytes: category_bytes.iter().map(|a| a.load(Ordering::Relaxed)).collect(),
    };

    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: totals.files,
            dirs: totals.dirs,
            bytes: totals.bytes,
            current_path: String::new(),
            phase: "walking".into(),
            category_bytes: totals.category_bytes.clone(),
        },
    );

    (entries, totals)
}

fn maybe_emit(
    app: &AppHandle,
    last_emit: &Mutex<Instant>,
    files: &AtomicU64,
    dirs: &AtomicU64,
    bytes: &AtomicU64,
    category_bytes: &[AtomicU64],
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

    let cats: Vec<u64> = category_bytes.iter().map(|a| a.load(Ordering::Relaxed)).collect();
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: files.load(Ordering::Relaxed),
            dirs: dirs.load(Ordering::Relaxed),
            bytes: bytes.load(Ordering::Relaxed),
            current_path: current.to_string_lossy().into_owned(),
            phase: "walking".into(),
            category_bytes: cats,
        },
    );
}

/// Emit a final-values progress event with the given phase tag. Used to mark
/// post-walk phases ("building", "indexing") so the frontend can update its
/// label without the live counters jumping around.
fn emit_phase(app: &AppHandle, phase: &str, totals: &WalkTotals) {
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: totals.files,
            dirs: totals.dirs,
            bytes: totals.bytes,
            current_path: String::new(),
            phase: phase.into(),
            category_bytes: totals.category_bytes.clone(),
        },
    );
}

fn build_tree(root_path: &Path, entries: Vec<EntryInfo>, cancel: &AtomicBool) -> Option<Node> {
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
    build_node(root_path, root_modified, &mut by_parent, true, cancel)
}

fn build_node(
    path: &Path,
    modified_ms: Option<u64>,
    by_parent: &mut HashMap<PathBuf, Vec<EntryInfo>>,
    is_dir: bool,
    cancel: &AtomicBool,
) -> Option<Node> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    if !is_dir {
        return Some(Node {
            name,
            size: 0,
            is_dir: false,
            modified_ms,
            children: Vec::new(),
            deleted: false,
        });
    }

    let mut children = Vec::new();
    let mut total: u64 = 0;
    if let Some(child_entries) = by_parent.remove(path) {
        // Check cancel periodically to bail out of large directory trees fast.
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        for ce in child_entries {
            let child_node = if ce.is_dir {
                build_node(&ce.path, ce.modified_ms, by_parent, true, cancel)?
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
                    deleted: false,
                }
            };
            total += child_node.size;
            children.push(child_node);
        }
    }
    // Sort once at build time so the layout step doesn't re-sort.
    children.sort_unstable_by(|a, b| b.size.cmp(&a.size));

    Some(Node {
        name,
        size: total,
        is_dir: true,
        modified_ms,
        children,
        deleted: false,
    })
}
