use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use jwalk::WalkDir;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::cancel::CancelFlag;
use crate::categories::{SLOT_COUNT, slot_for_name};
use crate::tree::{Node, TreeStore};

#[derive(Debug, Serialize)]
pub struct ScanSummary {
    pub path: String,
    pub root_name: String,
    pub root_size: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub elapsed_ms: u128,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScanProgress {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub current_path: String,
    /// "prescan" while we enumerate checkpoints, "walking" while jwalk runs,
    /// "building" while we assemble the tree, "indexing" while we precompute
    /// type stats. The frontend uses this to keep the user informed during
    /// the silent post-walk phases.
    pub phase: String,
    /// Per-category accumulated bytes (slot order matches categories.rs and
    /// src/colors.ts CATEGORIES; trailing entry is the "other/unknown" bucket).
    pub category_bytes: Vec<u64>,
    /// Fraction of work completed in [0.0, 1.0] during the "walking" phase.
    /// Derived from a shallow prescan that weights each top-level subdir by
    /// the number of entries it contains a few levels deep. 0.0 during
    /// prescan, 1.0 during building/indexing.
    pub progress: f32,
    /// Total checkpoints (top-level subdirs of the scan root) discovered by
    /// the prescan. Useful for showing "X of N folders".
    pub checkpoints_total: u32,
    /// Approximate number of checkpoints whose subtree has been fully
    /// traversed during the walk.
    pub checkpoints_done: u32,
}

const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
/// Depth at which the prescan stops counting entries. Deep enough to
/// distinguish "shallow but heavy" subtrees from "deep and big" ones; shallow
/// enough to finish in well under a second on typical home directories.
const PRESCAN_DEPTH: usize = 3;

#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    cancel: State<'_, CancelFlag>,
    store: State<'_, TreeStore>,
    path: String,
) -> Result<ScanSummary, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    cancel.reset();
    let cancel_handle = cancel.handle();

    let app_for_blocking = app.clone();
    let scan_path = p.clone();
    let started = Instant::now();
    // Walk + tree-build + type-stats all run on the blocking pool so the IPC
    // worker stays free. The type-stat precompute means the Types tab is
    // instant on first open.
    let cancel_for_blocking = Arc::clone(&cancel_handle);
    let result = tauri::async_runtime::spawn_blocking(move || -> Option<_> {
        let plan = prescan(&scan_path, &app_for_blocking, &cancel_for_blocking);
        if cancel_for_blocking.load(Ordering::Relaxed) {
            return None;
        }
        let (entries, totals) = walk(&scan_path, &plan, &app_for_blocking, &cancel_for_blocking);
        if cancel_for_blocking.load(Ordering::Relaxed) {
            return None;
        }
        let mut files = 0u64;
        let mut dirs = 0u64;
        for e in &entries {
            if e.is_dir {
                dirs += 1;
            } else {
                files += 1;
            }
        }
        // Phase: building tree. Frontend uses this to switch the label
        // and freeze the live type-mix bar at its final values.
        emit_phase(&app_for_blocking, "building", &totals);
        let root = build_tree(&scan_path, entries, &cancel_for_blocking)?;
        if cancel_for_blocking.load(Ordering::Relaxed) {
            return None;
        }
        emit_phase(&app_for_blocking, "indexing", &totals);
        let stats = crate::types_stats::compute_cancellable(&root, &cancel_for_blocking)?;
        Some((root, stats, files, dirs))
    })
    .await
    .map_err(|e| format!("Scan task failed unexpectedly: {e}"))?;

    if cancel.is_cancelled() || result.is_none() {
        return Err("cancelled".into());
    }
    let (root, type_stats, file_count, dir_count) = result.unwrap();

    let summary = ScanSummary {
        path: p.to_string_lossy().to_string(),
        root_name: root.name.clone(),
        root_size: root.size,
        file_count,
        dir_count,
        elapsed_ms: started.elapsed().as_millis(),
    };
    store.set(p, root, type_stats);
    Ok(summary)
}

pub struct EntryInfo {
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

/// Final counters from the walk, used to keep emitting consistent values
/// during the post-walk phases (tree build, type indexing).
pub struct WalkTotals {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub category_bytes: Vec<u64>,
}

/// Output of the shallow prescan: an ordered list of top-level subdirs of the
/// scan root with a relative weight (entries observed up to PRESCAN_DEPTH).
/// The walk uses these as "checkpoints" to estimate progress.
pub struct ScanPlan {
    /// Top-level subdir paths (depth 1 children of the scan root).
    pub checkpoints: Vec<PathBuf>,
    /// Per-checkpoint weight, parallel to `checkpoints`. Always >= 1 so we
    /// can divide without guarding.
    pub weights: Vec<u64>,
    /// Sum of `weights`. Always >= 1.
    pub total_weight: u64,
    /// Direct entries (files + first-level dirs that we don't recurse into,
    /// like symlinks the user picked) that aren't under any checkpoint.
    /// Counted as a single synthetic checkpoint with weight 1.
    pub root_extra_weight: u64,
}

fn prescan(root: &Path, app: &AppHandle, cancel: &AtomicBool) -> ScanPlan {
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: 0,
            dirs: 0,
            bytes: 0,
            current_path: String::new(),
            phase: "prescan".into(),
            category_bytes: vec![0; SLOT_COUNT],
            progress: 0.0,
            checkpoints_total: 0,
            checkpoints_done: 0,
        },
    );

    let mut checkpoints: Vec<PathBuf> = Vec::new();
    let mut weights: Vec<u64> = Vec::new();
    let mut root_extra: u64 = 0;

    // Direct children of root.
    let Ok(rd) = std::fs::read_dir(root) else {
        return ScanPlan {
            checkpoints,
            weights,
            total_weight: 1,
            root_extra_weight: 1,
        };
    };
    for entry in rd.flatten() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            root_extra += 1;
            continue;
        }
        // Count entries up to PRESCAN_DEPTH (relative to this subdir, so we
        // pass max_depth = PRESCAN_DEPTH). No metadata fetches — just dir
        // entry enumeration.
        let mut count: u64 = 1;
        for e in WalkDir::new(&path)
            .skip_hidden(false)
            .follow_links(false)
            .max_depth(PRESCAN_DEPTH)
            .into_iter()
            .take_while(|_| !cancel.load(Ordering::Relaxed))
            .flatten()
        {
            // Skip the root entry itself (depth 0 is the dir we passed in).
            if e.depth == 0 {
                continue;
            }
            count += 1;
        }
        checkpoints.push(path);
        weights.push(count);
    }

    let total_weight = weights.iter().sum::<u64>() + root_extra.max(1);
    ScanPlan {
        checkpoints,
        weights,
        total_weight: total_weight.max(1),
        root_extra_weight: root_extra.max(1),
    }
}

fn walk(
    root: &Path,
    plan: &ScanPlan,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> (Vec<EntryInfo>, WalkTotals) {
    let files = AtomicU64::new(0);
    let dirs = AtomicU64::new(0);
    let bytes = AtomicU64::new(0);
    // One atomic per category slot. Updated on every file entry; read by the
    // throttled emitter without locking. Cheap relative to the metadata calls.
    let category_bytes: Vec<AtomicU64> = (0..SLOT_COUNT).map(|_| AtomicU64::new(0)).collect();
    // Per-checkpoint observed entry counts, parallel to plan.checkpoints.
    // Each entry's depth-1 ancestor (under root) maps to a checkpoint index;
    // walk results outside any checkpoint contribute to `seen_root_extra`.
    let seen_per_ck: Vec<AtomicU64> =
        (0..plan.checkpoints.len()).map(|_| AtomicU64::new(0)).collect();
    let seen_root_extra = AtomicU64::new(0);
    let last_emit = Mutex::new(Instant::now() - PROGRESS_INTERVAL);

    // Map from depth-1 child name -> checkpoint index. Faster than a path
    // comparison in the hot loop.
    let ck_index: HashMap<std::ffi::OsString, usize> = plan
        .checkpoints
        .iter()
        .enumerate()
        .filter_map(|(i, p)| p.file_name().map(|n| (n.to_os_string(), i)))
        .collect();

    let entries: Vec<EntryInfo> = WalkDir::new(root)
        .skip_hidden(false)
        .follow_links(false)
        .into_iter()
        .take_while(|_| !cancel.load(Ordering::Relaxed))
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().is_dir();
            let meta = e.metadata().ok();
            let size = if is_dir {
                0
            } else {
                meta.as_ref().map(|m| m.len()).unwrap_or(0)
            };
            let modified_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);

            if is_dir {
                dirs.fetch_add(1, Ordering::Relaxed);
            } else {
                files.fetch_add(1, Ordering::Relaxed);
                bytes.fetch_add(size, Ordering::Relaxed);
                let name = e.file_name().to_string_lossy();
                let slot = slot_for_name(&name);
                category_bytes[slot].fetch_add(size, Ordering::Relaxed);
            }

            let path = e.path();
            // Bucket this entry into a checkpoint by its depth-1 ancestor.
            // jwalk's `e.depth` is 0 for the scan root; depth-1 entries are
            // direct children. For deeper entries, walk parents up to find
            // the depth-1 ancestor.
            if e.depth == 0 {
                // The scan root itself; doesn't contribute to progress.
            } else if e.depth == 1 {
                if let Some(name) = path.file_name() {
                    if let Some(&idx) = ck_index.get(name) {
                        seen_per_ck[idx].fetch_add(1, Ordering::Relaxed);
                    } else {
                        seen_root_extra.fetch_add(1, Ordering::Relaxed);
                    }
                }
            } else {
                // depth >= 2: the depth-1 ancestor is the (depth-1)th
                // component after root. Cheaper than re-stringifying paths.
                let depth1 = path
                    .strip_prefix(root)
                    .ok()
                    .and_then(|rel| rel.components().next())
                    .map(|c| c.as_os_str().to_os_string());
                if let Some(name) = depth1 {
                    if let Some(&idx) = ck_index.get(&name) {
                        seen_per_ck[idx].fetch_add(1, Ordering::Relaxed);
                    } else {
                        seen_root_extra.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }

            maybe_emit(
                app,
                &last_emit,
                &files,
                &dirs,
                &bytes,
                &category_bytes,
                &path,
                plan,
                &seen_per_ck,
                &seen_root_extra,
            );

            EntryInfo {
                path,
                is_dir,
                size,
                modified_ms,
            }
        })
        .collect();

    let totals = WalkTotals {
        files: files.load(Ordering::Relaxed),
        dirs: dirs.load(Ordering::Relaxed),
        bytes: bytes.load(Ordering::Relaxed),
        category_bytes: category_bytes.iter().map(|a| a.load(Ordering::Relaxed)).collect(),
    };

    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: totals.files,
            dirs: totals.dirs,
            bytes: totals.bytes,
            current_path: String::new(),
            phase: "walking".into(),
            category_bytes: totals.category_bytes.clone(),
            progress: 1.0,
            checkpoints_total: plan.checkpoints.len() as u32,
            checkpoints_done: plan.checkpoints.len() as u32,
        },
    );

    (entries, totals)
}

/// Combine per-checkpoint observed counts vs. prescan weights into a single
/// progress fraction. Each checkpoint contributes `s / (s + w)` (a smooth
/// asymptotic curve) instead of `min(s/w, 1)` — the prescan weights are
/// shallow estimates so they vastly under-count deep subtrees; capping there
/// causes the bar to saturate per-checkpoint and visibly jump as each new
/// checkpoint starts. The asymptotic form yields a continuous, monotonic
/// curve that approaches 1 as scanning continues.
fn compute_progress(
    plan: &ScanPlan,
    seen_per_ck: &[AtomicU64],
    seen_root_extra: &AtomicU64,
) -> (f32, u32) {
    let mut weighted: f64 = 0.0;
    let mut done: u32 = 0;
    for (i, w_raw) in plan.weights.iter().enumerate() {
        let s = seen_per_ck[i].load(Ordering::Relaxed) as f64;
        let w = (*w_raw as f64).max(1.0);
        // Asymptotic: 0 → 0, ∞ → 1, halfway when s == w.
        let contrib = s / (s + w);
        weighted += contrib * w;
        if s >= w * 4.0 {
            // Heuristic: subtree is "done" once we're well past the prescan
            // estimate. Mostly used for the "X / N folders" fallback label.
            done += 1;
        }
    }
    let s_extra = seen_root_extra.load(Ordering::Relaxed) as f64;
    let w_extra = plan.root_extra_weight as f64;
    weighted += (s_extra / (s_extra + w_extra)) * w_extra;
    let frac = (weighted / plan.total_weight as f64).min(1.0) as f32;
    (frac, done)
}

fn maybe_emit(
    app: &AppHandle,
    last_emit: &Mutex<Instant>,
    files: &AtomicU64,
    dirs: &AtomicU64,
    bytes: &AtomicU64,
    category_bytes: &[AtomicU64],
    current: &Path,
    plan: &ScanPlan,
    seen_per_ck: &[AtomicU64],
    seen_root_extra: &AtomicU64,
) {
    let Ok(mut last) = last_emit.try_lock() else {
        return;
    };
    let now = Instant::now();
    if now.duration_since(*last) < PROGRESS_INTERVAL {
        return;
    }
    *last = now;
    drop(last);

    let cats: Vec<u64> = category_bytes.iter().map(|a| a.load(Ordering::Relaxed)).collect();
    let (progress, done) = compute_progress(plan, seen_per_ck, seen_root_extra);
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: files.load(Ordering::Relaxed),
            dirs: dirs.load(Ordering::Relaxed),
            bytes: bytes.load(Ordering::Relaxed),
            current_path: current.to_string_lossy().into_owned(),
            phase: "walking".into(),
            category_bytes: cats,
            progress,
            checkpoints_total: plan.checkpoints.len() as u32,
            checkpoints_done: done,
        },
    );
}

/// Emit a final-values progress event with the given phase tag. Used to mark
/// post-walk phases ("building", "indexing") so the frontend can update its
/// label without the live counters jumping around.
fn emit_phase(app: &AppHandle, phase: &str, totals: &WalkTotals) {
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            files: totals.files,
            dirs: totals.dirs,
            bytes: totals.bytes,
            current_path: String::new(),
            phase: phase.into(),
            category_bytes: totals.category_bytes.clone(),
            progress: 1.0,
            checkpoints_total: 0,
            checkpoints_done: 0,
        },
    );
}

fn build_tree(root_path: &Path, entries: Vec<EntryInfo>, cancel: &AtomicBool) -> Option<Node> {
    let mut by_parent: HashMap<PathBuf, Vec<EntryInfo>> = HashMap::new();
    let mut root_modified: Option<u64> = None;
    for e in entries {
        if e.path == root_path {
            root_modified = e.modified_ms;
            continue;
        }
        if let Some(parent) = e.path.parent() {
            by_parent.entry(parent.to_path_buf()).or_default().push(e);
        }
    }
    build_node(root_path, root_modified, &mut by_parent, true, cancel)
}

fn build_node(
    path: &Path,
    modified_ms: Option<u64>,
    by_parent: &mut HashMap<PathBuf, Vec<EntryInfo>>,
    is_dir: bool,
    cancel: &AtomicBool,
) -> Option<Node> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    if !is_dir {
        return Some(Node {
            name,
            size: 0,
            is_dir: false,
            modified_ms,
            children: Vec::new(),
            deleted: false,
            total_files: 1,
        });
    }

    let mut children = Vec::new();
    let mut total: u64 = 0;
    let mut total_files: u64 = 0;
    if let Some(child_entries) = by_parent.remove(path) {
        // Check cancel periodically to bail out of large directory trees fast.
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        for ce in child_entries {
            let child_node = if ce.is_dir {
                build_node(&ce.path, ce.modified_ms, by_parent, true, cancel)?
            } else {
                Node {
                    name: ce
                        .path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    size: ce.size,
                    is_dir: false,
                    modified_ms: ce.modified_ms,
                    children: Vec::new(),
                    deleted: false,
                    total_files: 1,
                }
            };
            total += child_node.size;
            total_files += child_node.total_files;
            children.push(child_node);
        }
    }
    // Sort once at build time so the layout step doesn't re-sort.
    children.sort_unstable_by(|a, b| b.size.cmp(&a.size));

    Some(Node {
        name,
        size: total,
        is_dir: true,
        modified_ms,
        children,
        deleted: false,
        total_files,
    })
}
