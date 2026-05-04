use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::groups::{GroupMatcher, GroupSettingsStore};
use crate::tree::{Node, TreeStore};

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum RectKind {
    File,
    Dir,
    /// A folder treated as an atomic blob (node_modules, .git, *.app, …).
    /// Painted as a single rect; double-click still drills in if the user
    /// wants. Carries `total_files` for the label.
    Group,
    Other, // aggregated bucket
}

#[derive(Debug, Serialize)]
pub struct RenderRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub name: String,
    pub size: u64,
    pub kind: RectKind,
    /// Path segments from the layout root to this rect's owning node.
    /// Empty for `Other` aggregations (they don't represent a single node).
    pub rel_path: Vec<String>,
    /// For `Other` rects, how many siblings were merged.
    pub other_count: u32,
    /// True if the underlying node was deleted/trashed during this session.
    pub deleted: bool,
    /// For `Group` rects: total file descendants of the grouped folder.
    /// 0 for non-group rects.
    #[serde(default)]
    pub total_files: u64,
    /// For `Group` rects: the category id that matched (e.g. "code_packages",
    /// "vcs", "custom", "forced"). Empty for non-group rects.
    #[serde(default)]
    pub group_category: String,
}

const MIN_AREA: f32 = 16.0; // px²; smaller than this and we aggregate

#[tauri::command]
pub async fn compute_layout(
    app: AppHandle,
    rel_path: Vec<String>,
    width: f32,
    height: f32,
    max_rects: u32,
) -> Result<Vec<RenderRect>, String> {
    if width < 1.0 || height < 1.0 {
        return Ok(Vec::new());
    }
    let max_rects = max_rects.max(100).min(200_000) as usize;

    // Squarify can take seconds for huge subtrees; run on the blocking pool
    // so the IPC worker stays free to dispatch other commands (cancel,
    // get_node_meta) and the UI keeps painting.
    tauri::async_runtime::spawn_blocking(move || {
        let tree_store = app.state::<TreeStore>();
        let group_store = app.state::<GroupSettingsStore>();
        let matcher = group_store.matcher();
        tree_store
            .with_subtree_and_root(&rel_path, |root, root_path| {
                let mut out: Vec<RenderRect> = Vec::with_capacity(2048);
                // Build the ancestor list down to (but not including) the
                // current focus, plus the focus's absolute path. NameUnder
                // rules need ancestors all the way to the system root, but
                // we only have segments from the scan root. That's still
                // useful (e.g. "Library/Application Support/X" focus will
                // include Library + Application Support as ancestors).
                let mut ancestor_names: Vec<String> = Vec::with_capacity(rel_path.len() + 8);
                // Walk up from scan root through the OS — Library / Caches
                // are usually system folders well above the scan, so include
                // those parent components too.
                if let Some(parent) = root_path.parent() {
                    for c in parent.components() {
                        if let std::path::Component::Normal(s) = c {
                            ancestor_names.push(s.to_string_lossy().into_owned());
                        }
                    }
                }
                if let Some(name) = root_path.file_name() {
                    ancestor_names.push(name.to_string_lossy().into_owned());
                }
                ancestor_names.extend_from_slice(&rel_path);
                let abs = abs_path_for(root_path, &rel_path);
                layout_node(
                    root,
                    &rel_path,
                    &ancestor_names,
                    &abs,
                    0.0,
                    0.0,
                    width,
                    height,
                    &mut out,
                    max_rects,
                    &matcher,
                );
                out
            })
            .ok_or_else(|| "no scan loaded or path not found".into())
    })
    .await
    .map_err(|e| format!("layout task panicked: {e}"))?
}

fn abs_path_for(root: &Path, rel: &[String]) -> PathBuf {
    let mut p = root.to_path_buf();
    for s in rel {
        p.push(s);
    }
    p
}

/// Recursive layout. For a given node, squarify its children inside (x,y,w,h).
/// If a child is a directory and large enough, recurse into it; otherwise emit a leaf rect.
/// Children below MIN_AREA are merged into a synthetic Other bucket.
#[allow(clippy::too_many_arguments)]
fn layout_node(
    node: &Node,
    base_path: &[String],
    ancestor_names: &[String],
    abs_path: &Path,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    out: &mut Vec<RenderRect>,
    budget: usize,
    matcher: &GroupMatcher,
) {
    if w * h < MIN_AREA || out.len() >= budget {
        return;
    }
    if node.children.is_empty() {
        // A leaf at the layout root — paint it as a single rect.
        if base_path.is_empty() {
            // no rel_path because this is the root itself
            out.push(RenderRect {
                x,
                y,
                w,
                h,
                name: node.name.clone(),
                size: node.size,
                kind: if node.is_dir { RectKind::Dir } else { RectKind::File },
                rel_path: Vec::new(),
                other_count: 0,
                deleted: node.deleted,
                total_files: node.total_files,
                group_category: String::new(),
            });
        }
        return;
    }

    let total_area = (w * h) as f64;
    let total_size = node.size.max(1) as f64;

    // Partition children into "big enough to draw individually" and "merge into Other".
    // Children are already sorted descending by size.
    let mut keep: Vec<&Node> = Vec::with_capacity(node.children.len());
    let mut other_size: u64 = 0;
    let mut other_count: u32 = 0;
    for c in &node.children {
        let area = (c.size as f64 / total_size) * total_area;
        if area as f32 >= MIN_AREA {
            keep.push(c);
        } else {
            other_size += c.size;
            other_count += 1;
        }
    }
    // Cap the number of individually-drawn children so a single huge directory
    // (e.g. node_modules with 50k peers) doesn't blow the budget at depth 1.
    let remaining_budget = budget.saturating_sub(out.len());
    if keep.len() > remaining_budget && remaining_budget > 1 {
        let cut = remaining_budget - 1; // leave room for the Other bucket
        for c in &keep[cut..] {
            other_size += c.size;
            other_count += 1;
        }
        keep.truncate(cut);
    }

    // Build the ordered list of areas for squarify (in render space).
    let mut areas: Vec<f32> = keep
        .iter()
        .map(|c| ((c.size as f64 / total_size) * total_area) as f32)
        .collect();
    let mut other_rect_area: Option<f32> = None;
    if other_count > 0 {
        let a = ((other_size as f64 / total_size) * total_area) as f32;
        if a >= MIN_AREA {
            areas.push(a);
            other_rect_area = Some(a);
        }
    }

    if areas.is_empty() {
        return;
    }

    let rects = squarify(x, y, w, h, &areas);

    for (i, r) in rects.iter().enumerate() {
        if out.len() >= budget {
            break;
        }
        let is_other = other_rect_area.is_some() && i == rects.len() - 1;
        if is_other {
            out.push(RenderRect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
                name: format!("({} other items)", other_count),
                size: other_size,
                kind: RectKind::Other,
                rel_path: Vec::new(),
                other_count,
                deleted: false,
                total_files: 0,
                group_category: String::new(),
            });
            continue;
        }
        let child = keep[i];
        let mut child_path: Vec<String> = base_path.to_vec();
        child_path.push(child.name.clone());

        // Group check: when a directory matches an active rule (or is forced
        // by the user), paint it as a single atomic rect. Don't recurse —
        // the whole point is to hide its internals.
        let child_abs = abs_path.join(&child.name);
        let group_cat = if child.is_dir {
            matcher.match_category(child, &child_abs, ancestor_names).map(String::from)
        } else {
            None
        };

        if let Some(cat) = group_cat {
            out.push(RenderRect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
                name: child.name.clone(),
                size: child.size,
                kind: RectKind::Group,
                rel_path: child_path,
                other_count: 0,
                deleted: child.deleted,
                total_files: child.total_files,
                group_category: cat,
            });
            continue;
        }

        if child.is_dir && !child.children.is_empty() && r.w * r.h >= MIN_AREA * 4.0 {
            // Recurse — paint this directory's interior with its children.
            let mut child_ancestors: Vec<String> =
                Vec::with_capacity(ancestor_names.len() + 1);
            child_ancestors.extend_from_slice(ancestor_names);
            child_ancestors.push(child.name.clone());
            layout_node(
                child,
                &child_path,
                &child_ancestors,
                &child_abs,
                r.x,
                r.y,
                r.w,
                r.h,
                out,
                budget,
                matcher,
            );
        } else {
            out.push(RenderRect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
                name: child.name.clone(),
                size: child.size,
                kind: if child.is_dir { RectKind::Dir } else { RectKind::File },
                rel_path: child_path,
                other_count: 0,
                deleted: child.deleted,
                total_files: child.total_files,
                group_category: String::new(),
            });
        }
    }
}

#[derive(Clone, Copy)]
struct Rect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

/// Squarified treemap (Bruls/Huijing/van Wijk 2000), simplified.
/// `areas` must already be sorted descending and sum to <= w*h.
fn squarify(x: f32, y: f32, w: f32, h: f32, areas: &[f32]) -> Vec<Rect> {
    let mut out = Vec::with_capacity(areas.len());
    if areas.is_empty() {
        return out;
    }

    let mut cx = x;
    let mut cy = y;
    let mut cw = w;
    let mut ch = h;
    let mut i = 0;

    while i < areas.len() {
        let short = cw.min(ch);
        if short <= 0.0 {
            break;
        }
        // Greedily grow the current row while aspect ratio improves.
        let mut row_end = i + 1;
        let mut row_sum = areas[i];
        let mut best_ratio = worst_ratio(&areas[i..row_end], short, row_sum);
        while row_end < areas.len() {
            let new_sum = row_sum + areas[row_end];
            let new_ratio = worst_ratio(&areas[i..row_end + 1], short, new_sum);
            if new_ratio > best_ratio {
                break;
            }
            best_ratio = new_ratio;
            row_sum = new_sum;
            row_end += 1;
        }

        // Row sits along the short side; thickness is row_sum / short.
        let row_long = row_sum / short;
        let mut off = 0.0;
        for &a in &areas[i..row_end] {
            let len_along_short = a / row_long;
            let r = if cw <= ch {
                Rect { x: cx + off, y: cy, w: len_along_short, h: row_long }
            } else {
                Rect { x: cx, y: cy + off, w: row_long, h: len_along_short }
            };
            out.push(r);
            off += len_along_short;
        }

        // Shrink the remaining container.
        if cw <= ch {
            cy += row_long;
            ch -= row_long;
        } else {
            cx += row_long;
            cw -= row_long;
        }
        i = row_end;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.5
    }

    #[test]
    fn squarify_fills_container() {
        let areas = vec![6.0, 6.0, 4.0, 3.0, 2.0, 2.0, 1.0];
        let total: f32 = areas.iter().sum();
        let w = 6.0_f32;
        let h = total / w; // 4.0
        let rects = squarify(0.0, 0.0, w, h, &areas);
        assert_eq!(rects.len(), areas.len());
        let area_sum: f32 = rects.iter().map(|r| r.w * r.h).sum();
        assert!(approx(area_sum, w * h), "got {} expected {}", area_sum, w * h);
        // Stay within bounds
        for r in &rects {
            assert!(r.x >= -0.01 && r.y >= -0.01);
            assert!(r.x + r.w <= w + 0.01);
            assert!(r.y + r.h <= h + 0.01);
        }
    }

    #[test]
    fn squarify_single_rect() {
        let rects = squarify(0.0, 0.0, 100.0, 50.0, &[5000.0]);
        assert_eq!(rects.len(), 1);
        assert!(approx(rects[0].w * rects[0].h, 5000.0));
    }
}

fn worst_ratio(row: &[f32], short: f32, sum: f32) -> f32 {
    if sum <= 0.0 || short <= 0.0 {
        return f32::INFINITY;
    }
    let s2 = short * short;
    let sum2 = sum * sum;
    let mut max = 0.0_f32;
    let mut min = f32::INFINITY;
    for &a in row {
        if a > max {
            max = a;
        }
        if a < min {
            min = a;
        }
    }
    let r1 = (s2 * max) / sum2;
    let r2 = sum2 / (s2 * min.max(f32::EPSILON));
    r1.max(r2)
}
