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
  App.tsx             # Shell: folder picker + result view
  types.ts            # Mirror of Rust ScanResult / Node
  util.ts             # formatBytes etc.
src-tauri/
  src/
    main.rs           # Entry — defers to lib::run()
    lib.rs            # Tauri Builder + invoke handlers
    scan.rs           # Filesystem walk + tree build
  tauri.conf.json     # App config (window size, identifier, bundle)
  capabilities/       # Tauri v2 permissions (folder picker, etc.)
PRD.md                # Product spec — read first
```

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

- **IPC types must stay in sync.** Any change to `ScanResult` / `Node` in [src-tauri/src/scan.rs](src-tauri/src/scan.rs) must be mirrored in [src/types.ts](src/types.ts). Field names use `snake_case` on both sides (we don't run serde renaming).
- **Errors to JS are strings.** `#[tauri::command]` returns `Result<T, String>`. Format via `format!`, don't introduce `thiserror` until we have multiple variants worth distinguishing.
- **No blocking work on the Tauri main thread.** All scan commands are `async`. Heavy CPU work goes inside `tokio::task::spawn_blocking` or rayon — not directly in the async fn.
- **Permissions are explicit.** New plugins (e.g. `tauri-plugin-fs`) require both `.plugin(...)` registration in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) and a permission entry in [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json).

## Performance gotchas

- `jwalk` defaults to a Rayon thread pool — already parallel. Don't wrap it in another `par_iter`.
- macOS: `Metadata::len()` returns logical size. APFS clones report the same bytes for both copies (we double-count). Document this when we add a real metric column; don't try to fix it until v0.3.
- Sending the entire tree across IPC is fine up to ~500k files. Past that, add a `get_children(path)` command and lazy-expand in the UI. Don't preoptimize.
- Treemap rendering: use Canvas, not SVG. Above ~5k rectangles SVG falls over.

## What not to do

- Don't add Electron/Wails/whatever — this is Tauri.
- Don't add a state management lib (Redux/Zustand) until we actually have shared state worth abstracting. `useState` is fine right now.
- Don't add tests for the scan logic until the data model is stable (currently churning).
- Don't bump Tauri to v3 betas. Stay on v2.x.
- Don't introduce a Rust async runtime besides Tauri's bundled tokio.

## Open questions for the human

Tracked in [PRD.md](PRD.md) under "Open questions". Bring them up if a task forces a decision.
