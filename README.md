# Strata

A fast, native disk usage analyzer built in Rust + Tauri. Inspired by WinDirStat and Disk Inventory X.

Pick a folder, get a squarified treemap where rectangle area is proportional to file size. Drill in, inspect, reveal in Finder, or trash offenders.

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![license](https://img.shields.io/badge/license-MIT-green)

## Status

v0.2 — treemap, drill-down, details pane, file actions, cancellable scans. macOS is the primary target; Windows/Linux build via the same toolchain but receive less testing.

See [PRD.md](PRD.md) for the product spec and milestones.

## Install

Grab the latest build from the [Releases](https://github.com/lesslucifer/strata/releases) page:

- **macOS** — `Strata_<version>_aarch64.dmg` (Apple Silicon) or `Strata_<version>_x64.dmg` (Intel)
- **Windows** — `Strata_<version>_x64-setup.exe` or `.msi`
- **Linux** — `.AppImage` or `.deb`

> macOS builds are currently unsigned. On first launch, right-click the app and choose **Open** to bypass Gatekeeper, or run `xattr -dr com.apple.quarantine /Applications/Strata.app`. Code signing is a v1.0 blocker (see PRD §10.4).

## Build from source

Prereqs: Rust (stable), Node 18+, [pnpm](https://pnpm.io), and the Tauri [system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```sh
pnpm install
pnpm tauri build
```

The bundled app lands in `src-tauri/target/release/bundle/`.

## Develop

```sh
pnpm tauri dev
```

First run compiles ~400 Rust crates (slow once). See [CLAUDE.md](CLAUDE.md) for layout, conventions, and gotchas.

## License

[MIT](LICENSE)
