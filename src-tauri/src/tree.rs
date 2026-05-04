use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use crate::types_stats::TypeStat;

#[derive(Debug, Serialize, Clone)]
pub struct Node {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified_ms: Option<u64>,
    pub children: Vec<Node>,
}

impl Node {
    pub fn descend<'a>(&'a self, segments: &[String]) -> Option<&'a Node> {
        let mut cur = self;
        for s in segments {
            cur = cur.children.iter().find(|c| &c.name == s)?;
        }
        Some(cur)
    }
}

#[derive(Default)]
pub struct TreeStore {
    inner: Mutex<Option<StoredTree>>,
}

struct StoredTree {
    root: Node,
    /// Computed once when the tree is set; whole-scan aggregate.
    type_stats: Vec<TypeStat>,
}

impl TreeStore {
    /// Stores the tree along with its precomputed type-stat cache.
    /// Compute the stats on the caller's thread (typically inside the scan's
    /// spawn_blocking task) so we don't hold the store mutex during the walk.
    pub fn set(&self, _root_path: PathBuf, root: Node, type_stats: Vec<TypeStat>) {
        let mut g = self.inner.lock().unwrap();
        *g = Some(StoredTree { root, type_stats });
    }

    pub fn with_subtree<R>(
        &self,
        segments: &[String],
        f: impl FnOnce(&Node) -> R,
    ) -> Option<R> {
        let g = self.inner.lock().unwrap();
        let stored = g.as_ref()?;
        let n = stored.root.descend(segments)?;
        Some(f(n))
    }

    pub fn type_stats(&self) -> Option<Vec<TypeStat>> {
        let g = self.inner.lock().unwrap();
        g.as_ref().map(|s| s.type_stats.clone())
    }

    pub fn set_type_stats(&self, stats: Vec<TypeStat>) {
        let mut g = self.inner.lock().unwrap();
        if let Some(s) = g.as_mut() {
            s.type_stats = stats;
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NodeMeta {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified_ms: Option<u64>,
    pub child_count: u64,
}

#[derive(Debug, Serialize)]
pub struct ChildEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub has_children: bool,
}
