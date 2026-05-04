use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::tree::{Node, TreeStore};

#[derive(Debug, Serialize)]
pub struct TypeStat {
    /// Lowercased extension without the leading dot. Empty string for files
    /// with no extension.
    pub ext: String,
    pub size: u64,
    pub count: u64,
}

#[tauri::command]
pub fn compute_type_stats(store: State<'_, TreeStore>) -> Result<Vec<TypeStat>, String> {
    store
        .with_subtree(&[], |root| {
            let mut acc: HashMap<String, (u64, u64)> = HashMap::new();
            walk(root, &mut acc);
            let mut out: Vec<TypeStat> = acc
                .into_iter()
                .map(|(ext, (size, count))| TypeStat { ext, size, count })
                .collect();
            out.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.ext.cmp(&b.ext)));
            out
        })
        .ok_or_else(|| "no scan loaded".into())
}

fn walk(node: &Node, acc: &mut HashMap<String, (u64, u64)>) {
    if !node.is_dir {
        let ext = ext_of(&node.name);
        let entry = acc.entry(ext).or_insert((0, 0));
        entry.0 += node.size;
        entry.1 += 1;
        return;
    }
    for c in &node.children {
        walk(c, acc);
    }
}

fn ext_of(name: &str) -> String {
    let bytes = name.as_bytes();
    // Match the JS extOf: ignore leading-dot files (".gitignore" -> no ext)
    // and trailing-dot names ("foo." -> no ext).
    let Some(idx) = name.rfind('.') else {
        return String::new();
    };
    if idx == 0 || idx == bytes.len() - 1 {
        return String::new();
    }
    name[idx + 1..].to_lowercase()
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
        }
    }
    fn dir(name: &str, children: Vec<Node>) -> Node {
        let size = children.iter().map(|c| c.size).sum();
        Node {
            name: name.into(),
            size,
            is_dir: true,
            modified_ms: None,
            children,
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
        let mut acc = HashMap::new();
        walk(&root, &mut acc);
        assert_eq!(acc.get("jpg"), Some(&(151, 3)));
        assert_eq!(acc.get("txt"), Some(&(10, 1)));
        // .gitignore, foo., and "e" all bucket as no-ext.
        assert_eq!(acc.get(""), Some(&(15, 3)));
    }
}
