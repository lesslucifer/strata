// Folder grouping: treat certain auto-generated folders as a single atomic
// rect in the treemap (e.g. node_modules, .git, *.app bundles, browser caches).
//
// Matching happens at layout time, not scan time, so toggling a category is
// instant — no rescan needed. Rules are organized into categories; each
// category can be toggled on/off, and the user can add custom rules and
// per-folder overrides ("never group this specific folder").

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::tree::Node;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    /// Exact directory name match (e.g. "node_modules").
    Name,
    /// Directory whose name ends with this extension (e.g. ".app" → "MyApp.app").
    /// The pattern stores the extension WITH the leading dot.
    DirExt,
    /// Exact name match, but only if the folder lives under any segment in
    /// `under` (e.g. name="Cache" under "Library" or "Application Support").
    /// `under` is matched against any ancestor segment, case-sensitive.
    NameUnder,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupRule {
    pub kind: MatchKind,
    /// For Name / NameUnder: the directory name. For DirExt: ".app" (with dot).
    pub pattern: String,
    /// Only used by NameUnder.
    #[serde(default)]
    pub under: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupCategory {
    pub id: String,
    pub label: String,
    pub description: String,
    pub enabled: bool,
    pub rules: Vec<GroupRule>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GroupSettings {
    pub categories: Vec<GroupCategory>,
    /// User-defined rules; behave like a single always-on category.
    #[serde(default)]
    pub custom_rules: Vec<GroupRule>,
    /// Absolute paths the user explicitly excluded ("never group this folder").
    #[serde(default)]
    pub excluded_paths: Vec<String>,
    /// Absolute paths the user explicitly forced to be grouped.
    #[serde(default)]
    pub forced_paths: Vec<String>,
}

impl GroupSettings {
    pub fn defaults() -> Self {
        GroupSettings {
            categories: default_categories(),
            custom_rules: Vec::new(),
            excluded_paths: Vec::new(),
            forced_paths: Vec::new(),
        }
    }
}

fn name(p: &str) -> GroupRule {
    GroupRule { kind: MatchKind::Name, pattern: p.into(), under: Vec::new() }
}
fn dir_ext(p: &str) -> GroupRule {
    GroupRule { kind: MatchKind::DirExt, pattern: p.into(), under: Vec::new() }
}
#[cfg(test)]
fn name_under(p: &str, under: &[&str]) -> GroupRule {
    GroupRule {
        kind: MatchKind::NameUnder,
        pattern: p.into(),
        under: under.iter().map(|s| s.to_string()).collect(),
    }
}

fn default_categories() -> Vec<GroupCategory> {
    vec![
        GroupCategory {
            id: "code_packages".into(),
            label: "Code packages".into(),
            description: "Dependency directories that get reinstalled, never hand-edited.".into(),
            enabled: true,
            rules: vec![
                name("node_modules"), name("bower_components"),
                name(".venv"), name("venv"), name("__pycache__"),
                name(".tox"), name(".mypy_cache"), name(".pytest_cache"), name(".ruff_cache"),
                name("vendor"), name("Pods"), name("Carthage"),
                name(".gradle"), name(".m2"),
                name(".dart_tool"), name(".pub-cache"),
                name(".cargo"),
            ],
        },
        GroupCategory {
            id: "build_output".into(),
            label: "Build output".into(),
            description: "Generated build artifacts that can be re-produced from source.".into(),
            enabled: false,
            rules: vec![
                name("build"), name("dist"), name("out"),
                name(".next"), name(".nuxt"), name(".parcel-cache"), name(".turbo"),
                name(".cache"), name(".svelte-kit"),
                name("coverage"), name("playwright-report"),
                name(".build"), name("DerivedData"),
            ],
        },
        GroupCategory {
            id: "vcs".into(),
            label: "Version control internals".into(),
            description: ".git, .svn, .hg — managed by the VCS, not by you.".into(),
            enabled: true,
            rules: vec![name(".git"), name(".svn"), name(".hg")],
        },
        GroupCategory {
            id: "macos_bundles".into(),
            label: "macOS bundles".into(),
            description: "Apps, frameworks, and libraries Finder treats as single items.".into(),
            enabled: false,
            rules: vec![
                dir_ext(".app"), dir_ext(".framework"), dir_ext(".bundle"),
                dir_ext(".photoslibrary"), dir_ext(".musiclibrary"), dir_ext(".tvlibrary"),
                dir_ext(".imovielibrary"), dir_ext(".fcpbundle"), dir_ext(".logicx"),
                dir_ext(".sparseimage"), dir_ext(".sparsebundle"),
                dir_ext(".dSYM"), dir_ext(".xcarchive"),
                dir_ext(".kext"), dir_ext(".plugin"), dir_ext(".component"),
            ],
        },
        GroupCategory {
            id: "system_metadata".into(),
            label: "System metadata".into(),
            description: "OS-managed metadata stores. Don't poke these.".into(),
            enabled: false,
            rules: vec![
                name(".Trash"), name(".Trashes"), name(".fseventsd"),
                name(".TemporaryItems"),
            ],
        },
    ]
}

/// Sentinel category ids for matches that aren't tied to a built-in category.
pub const CATEGORY_FORCED: &str = "forced";
pub const CATEGORY_CUSTOM: &str = "custom";

/// Fast-lookup form of GroupSettings, built once per layout call.
pub struct GroupMatcher {
    /// Active name patterns → originating category id.
    names: std::collections::HashMap<String, String>,
    /// Active directory-ext patterns (lowercased, with leading dot) → category id.
    dir_exts: Vec<(String, String)>,
    /// Active "name under" patterns → category id.
    name_under: Vec<(String, Vec<String>, String)>,
    /// Excluded absolute paths, normalized.
    excluded: std::collections::HashSet<PathBuf>,
    /// Forced absolute paths, normalized.
    forced: std::collections::HashSet<PathBuf>,
}

impl GroupMatcher {
    pub fn from_settings(s: &GroupSettings) -> Self {
        let mut names: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut dir_exts: Vec<(String, String)> = Vec::new();
        let mut name_under: Vec<(String, Vec<String>, String)> = Vec::new();

        let mut push_rule = |r: &GroupRule, cat_id: &str| match r.kind {
            MatchKind::Name => {
                names.insert(r.pattern.clone(), cat_id.to_string());
            }
            MatchKind::DirExt => {
                let mut p = r.pattern.to_lowercase();
                if !p.starts_with('.') {
                    p = format!(".{p}");
                }
                dir_exts.push((p, cat_id.to_string()));
            }
            MatchKind::NameUnder => {
                name_under.push((r.pattern.clone(), r.under.clone(), cat_id.to_string()));
            }
        };

        for cat in &s.categories {
            if !cat.enabled {
                continue;
            }
            for r in &cat.rules {
                push_rule(r, &cat.id);
            }
        }
        for r in &s.custom_rules {
            push_rule(r, CATEGORY_CUSTOM);
        }

        let excluded = s.excluded_paths.iter().map(PathBuf::from).collect();
        let forced = s.forced_paths.iter().map(PathBuf::from).collect();

        GroupMatcher { names, dir_exts, name_under, excluded, forced }
    }

    /// Decide whether a directory at `abs_path` should be grouped, and if so
    /// which category id matched. Returns None when the dir should not be grouped.
    pub fn match_category(
        &self,
        node: &Node,
        abs_path: &Path,
        ancestor_names: &[String],
    ) -> Option<&str> {
        if !node.is_dir {
            return None;
        }
        if self.excluded.contains(abs_path) {
            return None;
        }
        if self.forced.contains(abs_path) {
            return Some(CATEGORY_FORCED);
        }
        let name = &node.name;
        if let Some(cat) = self.names.get(name) {
            return Some(cat.as_str());
        }
        let lower = name.to_lowercase();
        for (ext, cat) in &self.dir_exts {
            if lower.ends_with(ext) && lower.len() > ext.len() {
                return Some(cat.as_str());
            }
        }
        for (n, under, cat) in &self.name_under {
            if n != name {
                continue;
            }
            if under.is_empty() || ancestor_names.iter().any(|a| under.iter().any(|u| u == a)) {
                return Some(cat.as_str());
            }
        }
        None
    }

    pub fn matches(&self, node: &Node, abs_path: &Path, ancestor_names: &[String]) -> bool {
        self.match_category(node, abs_path, ancestor_names).is_some()
    }
}

// -- Settings store ---------------------------------------------------------

pub struct GroupSettingsStore {
    inner: Mutex<GroupSettings>,
    file_path: Mutex<Option<PathBuf>>,
}

impl Default for GroupSettingsStore {
    fn default() -> Self {
        GroupSettingsStore {
            inner: Mutex::new(GroupSettings::defaults()),
            file_path: Mutex::new(None),
        }
    }
}

impl GroupSettingsStore {
    pub fn init(&self, file_path: PathBuf) {
        // Try loading from disk; fall back to defaults if missing/corrupt.
        if let Ok(bytes) = std::fs::read(&file_path) {
            if let Ok(loaded) = serde_json::from_slice::<GroupSettings>(&bytes) {
                let merged = merge_with_defaults(loaded);
                *self.inner.lock().unwrap() = merged;
            }
        }
        *self.file_path.lock().unwrap() = Some(file_path);
    }

    pub fn get(&self) -> GroupSettings {
        self.inner.lock().unwrap().clone()
    }

    pub fn set(&self, s: GroupSettings) {
        let merged = merge_with_defaults(s);
        *self.inner.lock().unwrap() = merged.clone();
        // Best-effort persist; ignore I/O errors.
        if let Some(p) = self.file_path.lock().unwrap().clone() {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_vec_pretty(&merged) {
                let _ = std::fs::write(&p, json);
            }
        }
    }

    pub fn matcher(&self) -> GroupMatcher {
        GroupMatcher::from_settings(&self.inner.lock().unwrap())
    }
}

/// When we load from disk, the user's saved categories may be missing newer
/// built-in ones (after an upgrade). Merge: keep the user's enabled flag &
/// rule list per category, append any new built-in categories at the end.
fn merge_with_defaults(loaded: GroupSettings) -> GroupSettings {
    let defaults = default_categories();
    let mut by_id: std::collections::HashMap<String, GroupCategory> =
        loaded.categories.into_iter().map(|c| (c.id.clone(), c)).collect();
    let mut categories = Vec::with_capacity(defaults.len());
    for d in defaults {
        if let Some(existing) = by_id.remove(&d.id) {
            categories.push(GroupCategory {
                id: d.id,
                label: d.label,
                description: d.description,
                enabled: existing.enabled,
                rules: existing.rules,
            });
        } else {
            categories.push(d);
        }
    }
    // Drop any categories the user had that aren't built-in (we don't support
    // user-named extra categories yet — those go in custom_rules).
    GroupSettings {
        categories,
        custom_rules: loaded.custom_rules,
        excluded_paths: loaded.excluded_paths,
        forced_paths: loaded.forced_paths,
    }
}

// -- Tauri commands ---------------------------------------------------------

#[tauri::command]
pub fn get_group_settings(
    store: tauri::State<'_, GroupSettingsStore>,
) -> Result<GroupSettings, String> {
    Ok(store.get())
}

#[tauri::command]
pub fn set_group_settings(
    store: tauri::State<'_, GroupSettingsStore>,
    settings: GroupSettings,
) -> Result<(), String> {
    store.set(settings);
    Ok(())
}

#[tauri::command]
pub fn reset_group_settings(
    store: tauri::State<'_, GroupSettingsStore>,
) -> Result<GroupSettings, String> {
    store.set(GroupSettings::defaults());
    Ok(store.get())
}

#[tauri::command]
pub fn add_path_override(
    store: tauri::State<'_, GroupSettingsStore>,
    path: String,
    force: bool,
) -> Result<GroupSettings, String> {
    let mut s = store.get();
    s.excluded_paths.retain(|p| p != &path);
    s.forced_paths.retain(|p| p != &path);
    if force {
        s.forced_paths.push(path);
    } else {
        s.excluded_paths.push(path);
    }
    store.set(s);
    Ok(store.get())
}

#[tauri::command]
pub fn clear_path_override(
    store: tauri::State<'_, GroupSettingsStore>,
    path: String,
) -> Result<GroupSettings, String> {
    let mut s = store.get();
    s.excluded_paths.retain(|p| p != &path);
    s.forced_paths.retain(|p| p != &path);
    store.set(s);
    Ok(store.get())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> Node {
        Node {
            name: name.into(),
            size: 0,
            is_dir: true,
            modified_ms: None,
            children: vec![],
            deleted: false,
            total_files: 0,
        }
    }

    #[test]
    fn matches_name_rule() {
        let s = GroupSettings::defaults();
        let m = GroupMatcher::from_settings(&s);
        assert!(m.matches(&dir("node_modules"), Path::new("/x/node_modules"), &[]));
        assert!(m.matches(&dir(".git"), Path::new("/x/.git"), &[]));
        assert!(!m.matches(&dir("src"), Path::new("/x/src"), &[]));
    }

    #[test]
    fn matches_dir_ext_rule() {
        let s = GroupSettings::defaults();
        let m = GroupMatcher::from_settings(&s);
        assert!(m.matches(&dir("Calendar.app"), Path::new("/Applications/Calendar.app"), &[]));
        assert!(m.matches(&dir("My Photos.photoslibrary"), Path::new("/p/My Photos.photoslibrary"), &[]));
        assert!(!m.matches(&dir(".app"), Path::new("/x/.app"), &[]));
    }

    #[test]
    fn matches_name_under_rule() {
        // NameUnder is no longer a default rule; use a custom one.
        let mut s = GroupSettings::defaults();
        s.custom_rules.push(name_under("Cache", &["Library", "Application Support"]));
        let m = GroupMatcher::from_settings(&s);
        let ancestors: Vec<String> = vec!["macbook".into(), "Library".into(), "Application Support".into(), "Slack".into()];
        assert!(m.matches(&dir("Cache"), Path::new("/x/Cache"), &ancestors));
        // Without the right ancestor, "Cache" does not match.
        assert!(!m.matches(&dir("Cache"), Path::new("/x/Cache"), &["proj".into()]));
    }

    #[test]
    fn excluded_path_overrides_match() {
        let mut s = GroupSettings::defaults();
        s.excluded_paths.push("/x/node_modules".into());
        let m = GroupMatcher::from_settings(&s);
        assert!(!m.matches(&dir("node_modules"), Path::new("/x/node_modules"), &[]));
    }

    #[test]
    fn forced_path_groups_unmatched_dir() {
        let mut s = GroupSettings::defaults();
        s.forced_paths.push("/x/random_folder".into());
        let m = GroupMatcher::from_settings(&s);
        assert!(m.matches(&dir("random_folder"), Path::new("/x/random_folder"), &[]));
    }

    #[test]
    fn disabled_category_skips_rules() {
        let mut s = GroupSettings::defaults();
        for c in &mut s.categories {
            if c.id == "vcs" {
                c.enabled = false;
            }
        }
        let m = GroupMatcher::from_settings(&s);
        assert!(!m.matches(&dir(".git"), Path::new("/x/.git"), &[]));
    }
}
