mod actions;
mod cancel;
mod categories;
mod groups;
mod layout;
mod scan;
mod tree;
mod types_stats;

use tauri::Manager;

#[tauri::command]
fn get_node_meta(
    tree_store: tauri::State<'_, tree::TreeStore>,
    group_store: tauri::State<'_, groups::GroupSettingsStore>,
    rel_path: Vec<String>,
) -> Result<tree::NodeMeta, String> {
    let matcher = group_store.matcher();
    tree_store
        .with_subtree_and_root(&rel_path, |n, root_path| {
            // Build ancestor name list (including any system-root parents and
            // the scan-root name) so NameUnder rules match correctly.
            let mut ancestors: Vec<String> = Vec::new();
            if let Some(parent) = root_path.parent() {
                for c in parent.components() {
                    if let std::path::Component::Normal(s) = c {
                        ancestors.push(s.to_string_lossy().into_owned());
                    }
                }
            }
            if let Some(name) = root_path.file_name() {
                ancestors.push(name.to_string_lossy().into_owned());
            }
            // rel_path's last segment is `n` itself; ancestors should not
            // include the node — exclude the last segment.
            if !rel_path.is_empty() {
                ancestors.extend_from_slice(&rel_path[..rel_path.len() - 1]);
            }
            let mut abs = root_path.to_path_buf();
            for s in &rel_path {
                abs.push(s);
            }
            let cat = matcher.match_category(n, &abs, &ancestors);
            tree::NodeMeta {
                name: n.name.clone(),
                size: n.size,
                is_dir: n.is_dir,
                modified_ms: n.modified_ms,
                child_count: n.children.len() as u64,
                deleted: n.deleted,
                total_files: n.total_files,
                grouped: cat.is_some(),
                group_category: cat.map(String::from).unwrap_or_default(),
            }
        })
        .ok_or_else(|| "No scan is currently loaded, or the path could not be found.".into())
}

#[tauri::command]
fn list_children(
    tree_store: tauri::State<'_, tree::TreeStore>,
    group_store: tauri::State<'_, groups::GroupSettingsStore>,
    rel_path: Vec<String>,
) -> Result<Vec<tree::ChildEntry>, String> {
    let matcher = group_store.matcher();
    tree_store
        .with_subtree_and_root(&rel_path, |n, root_path| {
            // Build ancestor names (system parents + scan-root + rel_path).
            let mut ancestors: Vec<String> = Vec::new();
            if let Some(parent) = root_path.parent() {
                for c in parent.components() {
                    if let std::path::Component::Normal(s) = c {
                        ancestors.push(s.to_string_lossy().into_owned());
                    }
                }
            }
            if let Some(name) = root_path.file_name() {
                ancestors.push(name.to_string_lossy().into_owned());
            }
            ancestors.extend_from_slice(&rel_path);
            let mut abs = root_path.to_path_buf();
            for s in &rel_path {
                abs.push(s);
            }
            let mut entries: Vec<tree::ChildEntry> = n
                .children
                .iter()
                .map(|c| {
                    let child_abs = abs.join(&c.name);
                    let grouped = matcher.matches(c, &child_abs, &ancestors);
                    tree::ChildEntry {
                        name: c.name.clone(),
                        size: c.size,
                        is_dir: c.is_dir,
                        has_children: !c.children.is_empty(),
                        deleted: c.deleted,
                        grouped,
                    }
                })
                .collect();
            entries.sort_by(|a, b| {
                b.size
                    .cmp(&a.size)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            entries
        })
        .ok_or_else(|| "No scan is currently loaded, or the path could not be found.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(cancel::CancelFlag::default())
        .manage(tree::TreeStore::default())
        .manage(groups::GroupSettingsStore::default())
        .setup(|app| {
            // Initialize group settings from disk (or defaults). File lives
            // alongside other app data so it survives across runs.
            if let Ok(dir) = app.path().app_config_dir() {
                let file = dir.join("groups.json");
                let store = app.state::<groups::GroupSettingsStore>();
                store.init(file);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan::scan_directory,
            cancel::cancel_scan,
            layout::compute_layout,
            types_stats::compute_type_stats,
            get_node_meta,
            list_children,
            actions::reveal_in_finder,
            actions::open_path,
            actions::move_to_trash,
            actions::delete_permanent,
            actions::mark_path_deleted,
            groups::get_group_settings,
            groups::set_group_settings,
            groups::reset_group_settings,
            groups::add_path_override,
            groups::clear_path_override,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
