use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;
use serde::Serialize;
use tauri::State;

use crate::tree::{Node, TreeStore};

#[derive(Debug, Serialize, Clone)]
pub struct TypeStat {
    /// Lowercased extension without the leading dot. Empty string for files
    /// with no extension.
    pub ext: String,
    pub size: u64,
    pub count: u64,
}

#[tauri::command]
pub async fn compute_type_stats(
    store: State<'_, TreeStore>,
) -> Result<Vec<TypeStat>, String> {
    // Fast path: scan completion populated the cache, return a clone instantly.
    if let Some(cached) = store.type_stats() {
        return Ok(cached);
    }
    // Cold path: compute now. Should be rare — only if the cache wasn't
    // populated for some reason. Run on a blocking pool so we don't stall
    // the IPC worker.
    let snapshot = store.with_subtree(&[], |root| compute(root));
    let stats = snapshot.ok_or_else(|| "no scan loaded".to_string())?;
    store.set_type_stats(stats.clone());
    Ok(stats)
}

/// Walks the tree in parallel and aggregates file sizes/counts by lowercased ext.
pub fn compute(root: &Node) -> Vec<TypeStat> {
    let never = AtomicBool::new(false);
    compute_cancellable(root, &never).expect("non-cancellable compute returned None")
}

/// Cancellable variant: returns `None` if `cancel` flips during the walk so the
/// caller can bail immediately instead of paying for a full traversal.
pub fn compute_cancellable(root: &Node, cancel: &AtomicBool) -> Option<Vec<TypeStat>> {
    let acc = walk_par(root, cancel);
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let mut out: Vec<TypeStat> = acc
        .into_iter()
        .map(|(ext, (size, count))| TypeStat { ext, size, count })
        .collect();
    out.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.ext.cmp(&b.ext)));
    Some(out)
}

fn walk_par(root: &Node, cancel: &AtomicBool) -> HashMap<String, (u64, u64)> {
    // Parallelize across top-level children. Each thread builds a local map;
    // we then merge. For balanced trees this is near-linear scaling.
    if root.is_dir && !root.children.is_empty() {
        root.children
            .par_iter()
            .map(|c| {
                let mut local = HashMap::new();
                walk_into(c, &mut local, cancel);
                local
            })
            .reduce(HashMap::new, merge)
    } else {
        let mut local = HashMap::new();
        walk_into(root, &mut local, cancel);
        local
    }
}

fn merge(
    mut a: HashMap<String, (u64, u64)>,
    b: HashMap<String, (u64, u64)>,
) -> HashMap<String, (u64, u64)> {
    if a.len() < b.len() {
        return merge(b, a);
    }
    for (k, (s, c)) in b {
        let e = a.entry(k).or_insert((0, 0));
        e.0 += s;
        e.1 += c;
    }
    a
}

fn walk_into(node: &Node, acc: &mut HashMap<String, (u64, u64)>, cancel: &AtomicBool) {
    if !node.is_dir {
        let ext = ext_of(&node.name);
        let entry = acc.entry(ext).or_insert((0, 0));
        entry.0 += node.size;
        entry.1 += 1;
        return;
    }
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    for c in &node.children {
        walk_into(c, acc, cancel);
    }
}

/// Match the JS `extOf`: ignore leading-dot files (".gitignore" -> no ext)
/// and trailing-dot names ("foo." -> no ext). Avoids allocating a new
/// String when the extension is already lowercase ASCII.
fn ext_of(name: &str) -> String {
    let Some(idx) = name.rfind('.') else {
        return String::new();
    };
    if idx == 0 || idx == name.len() - 1 {
        return String::new();
    }
    let raw = &name[idx + 1..];
    if raw.bytes().all(|b| !b.is_ascii_uppercase()) {
        // Already lowercase (or non-ASCII passthrough) — one allocation total.
        raw.to_string()
    } else {
        raw.to_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, size: u64) -> Node {
        Node {
            name: name.into(),
            size,
            is_dir: false,
            modified_ms: None,
            children: vec![],
            deleted: false,
            total_files: 1,
        }
    }
    fn dir(name: &str, children: Vec<Node>) -> Node {
        let size = children.iter().map(|c| c.size).sum();
        let total_files = children.iter().map(|c| c.total_files).sum();
        Node {
            name: name.into(),
            size,
            is_dir: true,
            modified_ms: None,
            children,
            deleted: false,
            total_files,
        }
    }

    #[test]
    fn aggregates_by_ext_case_insensitive() {
        let root = dir(
            "root",
            vec![
                file("a.JPG", 100),
                file("b.jpg", 50),
                file("c.txt", 10),
                dir("sub", vec![file("d.JPG", 1), file("e", 7)]),
                file(".gitignore", 3),
                file("foo.", 5),
            ],
        );
        let stats = compute(&root);
        let map: HashMap<_, _> = stats
            .into_iter()
            .map(|s| (s.ext, (s.size, s.count)))
            .collect();
        assert_eq!(map.get("jpg"), Some(&(151, 3)));
        assert_eq!(map.get("txt"), Some(&(10, 1)));
        // .gitignore, foo., and "e" all bucket as no-ext.
        assert_eq!(map.get(""), Some(&(15, 3)));
    }
}
