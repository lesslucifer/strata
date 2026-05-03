mod actions;
mod cancel;
mod scan;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(cancel::CancelFlag::default())
        .invoke_handler(tauri::generate_handler![
            scan::scan_directory,
            cancel::cancel_scan,
            actions::reveal_in_finder,
            actions::open_path,
            actions::move_to_trash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
