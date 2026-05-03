# Strata — Agent Notes

A Rust + Tauri disk usage analyzer (think WinDirStat / Disk Inventory X). This file is for Claude Code; humans should read [PRD.md](PRD.md) first.

## Stack at a glance

- **Backend:** Rust 2021, Tauri v2, `jwalk` (parallel walker), `rayon`, `serde`. See [src-tauri/Cargo.toml](src-tauri/Cargo.toml).
- **Frontend:** React 18 + TypeScript + Vite + Tailwind. D3 (`d3-hierarchy`) for the treemap, rendered to Canvas (not SVG) for performance.
- **Package manager:** `pnpm` (already installed). Do not switch to npm/yarn.
- **Target platforms:** macOS first; Windows/Linux are stretch goals. Avoid OS-specific code outside [src-tauri/src/scan.rs](src-tauri/src/scan.rs) without flagging it.

## Layout

```
src/                  # React frontend
  App.tsx             # Shell: folder picker + breadcrumb + details pane + context menu
  Treemap.tsx         # Canvas paint of server-supplied rects + grid hit-test
  colors.ts, util.ts  # Helpers
  types.ts            # IPC type mirrors
src-tauri/
  src/
    main.rs           # Entry — defers to lib::run()
    lib.rs            # Tauri Builder + invoke handlers
    scan.rs           # jwalk + progress events; populates TreeStore
    tree.rs           # Node + TreeStore (Mutex<Option<Tree>> in tauri::State)
    layout.rs         # Squarified treemap + sibling aggregation (Other buckets)
    cancel.rs         # Cancellation flag
    actions.rs        # Reveal/open/trash commands
  capabilities/       # Tauri v2 permissions
PRD.md                # Product spec — read first
```

## Data flow

1. `scan_directory(path)` — runs `jwalk`, builds a `Node` tree, stores it in the `TreeStore` `tauri::State`. Returns only a small `ScanSummary` (no tree). Emits `scan-progress` events while running.
2. `compute_layout(rel_path, w, h, max_rects)` — walks the cached subtree, runs squarify, aggregates sub-pixel siblings into synthetic `Other` rects, returns `Vec<RenderRect>` (typically a few thousand). The frontend re-fetches on resize, drill-down, and after a fresh scan.
3. `get_node_meta(rel_path)` — cheap lookup for the details pane.

The full tree never crosses the IPC boundary. This is deliberate; see PRD §8.

## Running

Always export PATH before running cargo (rustup is keg-only on this machine):

```sh
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
```

| Task              | Command                          |
| ----------------- | -------------------------------- |
| Install JS deps   | `pnpm install`                   |
| Dev (full app)    | `pnpm tauri dev`                 |
| Frontend only     | `pnpm dev`                       |
| Build release     | `pnpm tauri build`               |
| Rust check        | `cd src-tauri && cargo check`    |
| Rust test         | `cd src-tauri && cargo test`     |
| TS typecheck      | `pnpm build` (runs tsc -b first) |

First `pnpm tauri dev` will compile ~400 Rust crates — slow once, fast after.

## Conventions

- **IPC types must stay in sync.** Any change to a `Serialize` struct returned by a `#[tauri::command]` must be mirrored in [src/types.ts](src/types.ts). Field names use `snake_case` on both sides (we don't run serde renaming).
- **Errors to JS are strings.** `#[tauri::command]` returns `Result<T, String>`. Format via `format!`, don't introduce `thiserror` until we have multiple variants worth distinguishing.
- **No blocking work on the Tauri main thread.** Scan commands are `async`. Heavy CPU work goes inside `tauri::async_runtime::spawn_blocking` (do NOT pull in `tokio` directly — use the re-export).
- **Permissions are explicit.** New plugins require both `.plugin(...)` registration in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) and a permission entry in [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json).
- **The frontend never owns the tree.** It holds a path (`focus: string[]`) and asks Rust for layouts/metadata. Don't reintroduce a "full tree in JS" model.

## Performance gotchas

- `jwalk` defaults to a Rayon thread pool — already parallel. Don't wrap it in another `par_iter`.
- macOS: `Metadata::len()` returns logical size. APFS clones report the same bytes for both copies (we double-count). Document this when we add a real metric column; don't try to fix it until v0.3.
- Treemap rendering: Canvas only. The layout step caps visible rects (`MAX_RECTS` in [src/Treemap.tsx](src/Treemap.tsx), `max_rects` argument to `compute_layout`); sub-pixel siblings collapse into `Other` buckets in [src-tauri/src/layout.rs](src-tauri/src/layout.rs). Do not bypass this — that's how WinDirStat-class tools stay responsive at 3M+ files.
- Hit-testing uses a fixed 16×16 uniform grid in `Treemap.tsx`. Fine up to ~50k rects; revisit if we ever raise the budget.
- Resize is debounced (~80 ms) before we re-request layout — avoids hammering Rust during window drag.

## What not to do

- Don't add Electron/Wails/whatever — this is Tauri.
- Don't add a state management lib (Redux/Zustand) until we actually have shared state worth abstracting. `useState` is fine right now.
- Don't add tests for the scan logic until the data model is stable (currently churning).
- Don't bump Tauri to v3 betas. Stay on v2.x.
- Don't introduce a Rust async runtime besides Tauri's bundled tokio.

## Open questions for the human

Tracked in [PRD.md](PRD.md) under "Open questions". Bring them up if a task forces a decision.
