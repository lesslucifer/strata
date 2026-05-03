use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use jwalk::WalkDir;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Node {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
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

#[tauri::command]
pub async fn scan_directory(path: String) -> Result<ScanResult, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("path is not a directory: {path}"));
    }

    let started = Instant::now();
    let file_count = AtomicU64::new(0);
    let dir_count = AtomicU64::new(0);

    // Map: directory path -> (own_size, children entries collected during walk)
    // We do a flat walk, then build the tree in one pass at the end.
    let entries: Vec<EntryInfo> = WalkDir::new(&p)
        .skip_hidden(false)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().is_dir();
            let size = if is_dir {
                0
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            };
            if is_dir {
                dir_count.fetch_add(1, Ordering::Relaxed);
            } else {
                file_count.fetch_add(1, Ordering::Relaxed);
            }
            EntryInfo {
                path: e.path(),
                is_dir,
                size,
            }
        })
        .collect();

    let root = build_tree(&p, entries);

    Ok(ScanResult {
        path: p.to_string_lossy().to_string(),
        root,
        file_count: file_count.load(Ordering::Relaxed),
        dir_count: dir_count.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

struct EntryInfo {
    path: PathBuf,
    is_dir: bool,
    size: u64,
}

fn build_tree(root_path: &Path, entries: Vec<EntryInfo>) -> Node {
    // Group children by parent path. Skip the root entry itself.
    let mut by_parent: HashMap<PathBuf, Vec<EntryInfo>> = HashMap::new();
    for e in entries {
        if e.path == root_path {
            continue;
        }
        if let Some(parent) = e.path.parent() {
            by_parent.entry(parent.to_path_buf()).or_default().push(e);
        }
    }
    build_node(root_path, &mut by_parent, true)
}

fn build_node(
    path: &Path,
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
            children: Vec::new(),
        };
    }

    let mut children = Vec::new();
    let mut total: u64 = 0;
    if let Some(child_entries) = by_parent.remove(path) {
        for ce in child_entries {
            let child_node = if ce.is_dir {
                build_node(&ce.path, by_parent, true)
            } else {
                Node {
                    name: ce
                        .path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    size: ce.size,
                    is_dir: false,
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
        children,
    }
}
