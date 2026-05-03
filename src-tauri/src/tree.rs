use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

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
}

impl TreeStore {
    pub fn set(&self, _root_path: PathBuf, root: Node) {
        let mut g = self.inner.lock().unwrap();
        *g = Some(StoredTree { root });
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
}

#[derive(Debug, Serialize)]
pub struct NodeMeta {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified_ms: Option<u64>,
    pub child_count: u64,
}
