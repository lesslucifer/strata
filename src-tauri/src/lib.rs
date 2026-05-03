mod actions;
mod cancel;
mod layout;
mod scan;
mod tree;

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
            get_node_meta,
            actions::reveal_in_finder,
            actions::open_path,
            actions::move_to_trash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
