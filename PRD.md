# Strata — Product Requirements

> A fast, native disk usage analyzer for macOS (and eventually Windows/Linux), built in Rust with a Tauri-based GUI. Inspired by WinDirStat and Disk Inventory X.

## 1. Problem

When a disk fills up, finding the offenders takes minutes of `du -sh */ | sort -h` and guesswork. The classic GUI tools (WinDirStat, Disk Inventory X) solve this with a treemap visualization but are unmaintained, slow on modern multi-TB drives, or platform-locked. Strata is a modern, fast, cross-platform replacement.

## 2. Goals (v1)

1. Scan a chosen folder or entire volume and produce a sized tree.
2. Visualize that tree as a **treemap** where rectangle area is proportional to file/folder size.
3. Browse the tree (drill into a folder, go back up) and inspect file metadata.
4. Reveal a file in Finder / open it / move it to Trash.
5. Be **fast**: cold scan of `~/Documents` (~50 GB, ~500k files) in under 15 seconds on a M-series Mac.

## 3. Non-goals (v1)

- Cloud storage scanning (iCloud Drive ghost files, OneDrive placeholders).
- Block-level / sector-level analysis.
- Duplicate file detection.
- Deletion of system-protected files (we never `sudo`).
- Network share crawling beyond what the OS exposes as a normal folder.
- Mobile.

## 4. Target users

- Power users and developers on macOS (Windows/Linux next).
- People comfortable opening a "where did my disk space go?" tool but not comfortable in a terminal.

## 5. Stack & key decisions

| Concern                | Choice                                | Why                                                                |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| Language (core)        | Rust 2021                             | Speed, safety, single binary.                                      |
| GUI shell              | Tauri v2                              | Native webview, ~10 MB binary, real Rust backend.                  |
| Frontend               | React + TypeScript + Vite             | Best supported Tauri template; the team knows it.                  |
| Styling                | Tailwind CSS                          | Fast iteration on chrome (sidebar / toolbar / dialogs).            |
| Treemap layout         | `d3-hierarchy` (`treemap()`)          | Battle-tested squarified algorithm; we don't need to write it.     |
| Treemap render         | HTML Canvas                           | SVG dies past ~5k rects; we need 100k+.                            |
| FS walk                | `jwalk`                               | Parallel walker, ~5–10× faster than `walkdir`.                     |
| IPC payload            | JSON via `#[tauri::command]`          | Simple; revisit if scans exceed ~500k nodes.                       |
| Folder picker          | `tauri-plugin-dialog`                 | Native dialog, no custom UI.                                       |
| Package manager        | `pnpm`                                | Already installed; deterministic.                                  |

## 6. Scope by milestone

### v0.1 — Skeleton (current)
- [x] Tauri v2 + React + TS + Tailwind scaffolding.
- [x] `scan_directory(path)` Rust command using `jwalk`.
- [x] Folder picker → scan → flat list of top 50 children, sorted by size.
- [ ] Verified `pnpm tauri dev` builds and runs.

### v0.2 — Treemap
- [ ] Canvas-based squarified treemap of the scanned tree.
- [ ] Click a rectangle to drill in; breadcrumb to climb back out.
- [ ] Color rects by file extension (consistent palette).
- [ ] Hover → tooltip with name, size, child count.

### v0.3 — Inspect & act
- [ ] Right pane: selected node's full path, size, item count, type, modified date.
- [ ] Right-click menu: Reveal in Finder, Open, Move to Trash (with confirm).
- [ ] Sidebar tree (collapsible) as an alternate view next to the treemap.

### v0.4 — Performance & polish
- [ ] Streaming progress: scan emits `scan-progress` events; UI shows live count + bytes.
- [ ] Cancel an in-flight scan.
- [ ] Cache the last scan in memory; rescan-changed-only via mtime check.
- [ ] Persist last-opened folder.

### v0.5 — Cross-platform pass
- [ ] Test/fix on Windows.
- [ ] Test/fix on Linux (GTK webview).
- [ ] CI bundles for all three.

### Future (post-v1)
- APFS clone-aware sizing (logical vs physical) on macOS.
- Hard link detection (don't double count).
- Filter by extension / size / age.
- Compare two scans (what grew?).

## 7. UX sketch (v0.2 target)

```
┌──────────────────────────────────────────────────────────────────┐
│ Strata    [📁 Choose folder]   /Users/me/Projects   42.3 GB      │
├────────────────┬─────────────────────────────────────────────────┤
│ ▾ Projects     │  ┌───────────────┐ ┌──────┐ ┌──────────┐       │
│   ▸ node_mod.. │  │               │ │      │ │          │       │
│   ▸ build      │  │  treemap      │ │      │ │          │       │
│   ▸ assets     │  │  rendered     │ │      │ │          │       │
│   ▸ ...        │  │  to canvas    │ │      │ │          │       │
│                │  │               │ │      │ │          │       │
│                │  └───────────────┘ └──────┘ └──────────┘       │
├────────────────┴─────────────────────────────────────────────────┤
│ Selected: node_modules  •  18.2 GB  •  214,332 items             │
└──────────────────────────────────────────────────────────────────┘
```

## 8. Performance budget

| Scenario                            | Target               |
| ----------------------------------- | -------------------- |
| Scan `~/Documents` (50 GB, 500k)    | < 15 s on M-series   |
| Scan `~` (300 GB, 2M files)         | < 90 s               |
| Treemap render of 10k visible rects | < 100 ms             |
| Drill-down (already-scanned subtree)| < 50 ms              |
| App cold start to window visible    | < 1 s                |
| Release binary size (macOS .app)    | < 20 MB              |

## 9. Risks

- **APFS clones / hardlinks:** counting bytes naively over-reports. Acceptable for v1 with a docs note; revisit in v0.3+.
- **Permission errors mid-scan:** `~/Library` and SIP-protected paths will partially fail. Skip silently, surface a "N items skipped" footer.
- **Webview ↔ Rust IPC bandwidth:** 2M-node tree as JSON is ~100 MB. Mitigation in v0.4 via streaming + lazy children.
- **Tauri v2 maturity:** v2 stable shipped fairly recently. If we hit a blocker we can pin to a known-good patch version, but we don't fall back to v1.

## 10. Open questions

1. Should we count **logical** or **allocated on disk** size by default? (Disk Inventory X uses allocated.) — *leaning logical for v1, allocated as a toggle later.*
2. Color treemap by **extension** or by **age** (heatmap of "old garbage")? — *extension first; age as v0.4 toggle.*
3. Single-window or multi-window (one per scan)? — *single, with tabs eventually.*
4. Do we ship as **notarized + signed** for macOS in v1 or only post-v1? — *unsigned dev build only for v0.x; signing as a v1.0 release blocker.*

## 11. Out of scope forever

- Scanning network volumes for security/compliance purposes.
- Acting as a backup tool.
- Any kind of telemetry. Strata is local-only and never makes a network request.
