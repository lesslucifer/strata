mod actions;
mod cancel;
mod categories;
mod layout;
mod scan;
mod tree;
mod types_stats;

#[tauri::command]
fn get_node_meta(
    store: tauri::State<'_, tree::TreeStore>,
    rel_path: Vec<String>,
) -> Result<tree::NodeMeta, String> {
    store
        .with_subtree(&rel_path, |n| tree::NodeMeta {
            name: n.name.clone(),
            size: n.size,
            is_dir: n.is_dir,
            modified_ms: n.modified_ms,
            child_count: n.children.len() as u64,
            deleted: n.deleted,
        })
        .ok_or_else(|| "no scan loaded or path not found".into())
}

#[tauri::command]
fn list_children(
    store: tauri::State<'_, tree::TreeStore>,
    rel_path: Vec<String>,
) -> Result<Vec<tree::ChildEntry>, String> {
    store
        .with_subtree(&rel_path, |n| {
            let mut entries: Vec<tree::ChildEntry> = n
                .children
                .iter()
                .map(|c| tree::ChildEntry {
                    name: c.name.clone(),
                    size: c.size,
                    is_dir: c.is_dir,
                    has_children: !c.children.is_empty(),
                    deleted: c.deleted,
                })
                .collect();
            entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            entries
        })
        .ok_or_else(|| "no scan loaded or path not found".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(cancel::CancelFlag::default())
        .manage(tree::TreeStore::default())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
