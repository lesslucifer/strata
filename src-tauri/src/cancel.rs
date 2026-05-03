use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

#[derive(Default)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.0)
    }

    pub fn reset(&self) {
        self.0.store(false, Ordering::Relaxed);
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[tauri::command]
pub fn cancel_scan(cancel: State<'_, CancelFlag>) {
    cancel.cancel();
}
