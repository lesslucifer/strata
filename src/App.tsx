import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { NodeMeta, ScanProgress, ScanSummary } from "./types";
import { formatBytes, formatDate, joinPath } from "./util";
import { extOf } from "./colors";
import { Treemap, type SelectedRect } from "./Treemap";

interface ContextMenuState {
  x: number;
  y: number;
  absPath: string;
  isDir: boolean;
}

export default function App() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanEpoch, setScanEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  const [selected, setSelected] = useState<SelectedRect | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<NodeMeta | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  async function pickAndScan() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    setScanning(true);
    setFocus([]);
    setSelected(null);
    setSelectedMeta(null);
    setProgress(null);
    setSummary(null);

    const unlisten = await listen<ScanProgress>("scan-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const res = await invoke<ScanSummary>("scan_directory", { path: picked });
      setSummary(res);
      setScanEpoch((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setScanning(false);
      setProgress(null);
    }
  }

  async function cancelScan() {
    try {
      await invoke("cancel_scan");
    } catch {
      // ignore
    }
  }

  // Fetch full metadata for the selected rect (Treemap only has the visible bits).
  useEffect(() => {
    if (!selected || !summary) {
      setSelectedMeta(null);
      return;
    }
    if (selected.rect.kind === "other") {
      setSelectedMeta(null);
      return;
    }
    const relFromRoot = [...focus, ...selected.rect.rel_path];
    let cancelled = false;
    invoke<NodeMeta>("get_node_meta", { relPath: relFromRoot })
      .then((m) => {
        if (!cancelled) setSelectedMeta(m);
      })
      .catch(() => {
        if (!cancelled) setSelectedMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, focus, summary]);

  // Dismiss context menu
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide">Strata</h1>
        {!scanning && (
          <button
            onClick={pickAndScan}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium hover:bg-blue-500"
          >
            Choose folder
          </button>
        )}
        {scanning && (
          <button
            onClick={cancelScan}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium hover:bg-red-500"
          >
            Cancel
          </button>
        )}
        {summary && !scanning && (
          <Breadcrumb
            rootName={summary.root_name}
            focus={focus}
            onJump={(i) => {
              setFocus(focus.slice(0, i));
              setSelected(null);
            }}
          />
        )}
        {scanning && progress && (
          <span className="ml-auto truncate text-xs text-zinc-400">
            {progress.files.toLocaleString()} files ·{" "}
            {progress.dirs.toLocaleString()} dirs ·{" "}
            {formatBytes(progress.bytes)}
            {progress.current_path && (
              <span className="ml-2 text-zinc-600">{progress.current_path}</span>
            )}
          </span>
        )}
        {!scanning && summary && (
          <span className="ml-auto text-xs text-zinc-400">
            {formatBytes(summary.root_size)} · scanned in {summary.elapsed_ms} ms ·{" "}
            {summary.file_count.toLocaleString()} files
          </span>
        )}
      </header>
      <main className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {error && <div className="p-4 text-sm text-red-400">Error: {error}</div>}
          {!summary && !error && !scanning && (
            <div className="grid h-full place-items-center text-sm text-zinc-500">
              Pick a folder to scan.
            </div>
          )}
          {scanning && !summary && (
            <div className="grid h-full place-items-center text-sm text-zinc-500">
              Scanning…
            </div>
          )}
          {summary && (
            <Treemap
              focusPath={focus}
              scanEpoch={scanEpoch}
              selected={selected}
              onSelect={setSelected}
              onDrillDown={(relPath) => {
                setFocus([...focus, ...relPath]);
                setSelected(null);
              }}
              onContext={(sel, x, y) => {
                if (!summary) return;
                const absPath = joinPath(summary.path, [...focus, ...sel.rect.rel_path]);
                setMenu({ x, y, absPath, isDir: sel.rect.kind === "dir" });
              }}
            />
          )}
        </div>
        {selected && summary && (
          <DetailsPane
            selected={selected}
            meta={selectedMeta}
            absPath={
              selected.rect.kind === "other"
                ? ""
                : joinPath(summary.path, [...focus, ...selected.rect.rel_path])
            }
            onClose={() => setSelected(null)}
          />
        )}
      </main>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.absPath}
          isDir={menu.isDir}
          onClose={() => setMenu(null)}
          onError={setError}
        />
      )}
    </div>
  );
}

function Breadcrumb({
  rootName,
  focus,
  onJump,
}: {
  rootName: string;
  focus: string[];
  onJump: (depth: number) => void;
}) {
  const segments = [rootName, ...focus];
  return (
    <nav className="flex items-center gap-1 text-xs text-zinc-300">
      {segments.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          <button
            onClick={() => onJump(i)}
            className="rounded px-1 hover:bg-zinc-800 hover:text-white"
            disabled={i === segments.length - 1}
          >
            {s}
          </button>
          {i < segments.length - 1 && <span className="text-zinc-600">/</span>}
        </span>
      ))}
    </nav>
  );
}

function DetailsPane({
  selected,
  meta,
  absPath,
  onClose,
}: {
  selected: SelectedRect;
  meta: NodeMeta | null;
  absPath: string;
  onClose: () => void;
}) {
  const r = selected.rect;
  if (r.kind === "other") {
    return (
      <aside className="w-72 shrink-0 border-l border-zinc-800 bg-zinc-900/50 p-4 text-xs">
        <Header title={r.name} onClose={onClose} />
        <dl className="space-y-2">
          <Row label="Type" value="Aggregated bucket" />
          <Row label="Size" value={formatBytes(r.size)} />
          <Row label="Items" value={r.other_count.toLocaleString()} />
          <Row
            label="Note"
            value="These items were too small to draw individually. Drill down to see them."
          />
        </dl>
      </aside>
    );
  }
  const ext = extOf(r.name);
  const type = r.kind === "dir" ? "Folder" : ext ? `.${ext} file` : "File";
  return (
    <aside className="w-72 shrink-0 border-l border-zinc-800 bg-zinc-900/50 p-4 text-xs">
      <Header title={r.name} onClose={onClose} />
      <dl className="space-y-2">
        <Row label="Type" value={type} />
        <Row label="Size" value={formatBytes(meta ? meta.size : r.size)} />
        <Row
          label={meta && meta.is_dir ? "Direct children" : "Items"}
          value={(meta ? meta.child_count : 1).toLocaleString()}
        />
        <Row label="Modified" value={formatDate(meta ? meta.modified_ms : null)} />
        <Row label="Path" value={absPath} mono />
      </dl>
    </aside>
  );
}

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <div className="truncate font-mono text-sm font-medium">{title}</div>
      <button
        onClick={onClose}
        className="text-zinc-500 hover:text-zinc-200"
        aria-label="Close details"
      >
        ✕
      </button>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`break-all text-zinc-200 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function ContextMenu({
  x,
  y,
  path,
  isDir,
  onClose,
  onError,
}: {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  async function run(cmd: string) {
    try {
      if (cmd === "trash") {
        const ok = window.confirm(`Move to Trash?\n\n${path}`);
        if (!ok) return;
        await invoke("move_to_trash", { path });
      } else if (cmd === "reveal") {
        await invoke("reveal_in_finder", { path });
      } else if (cmd === "open") {
        await invoke("open_path", { path });
      }
    } catch (e) {
      onError(String(e));
    } finally {
      onClose();
    }
  }
  return (
    <div
      className="fixed z-20 min-w-[10rem] rounded border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItem label="Reveal in Finder" onClick={() => run("reveal")} />
      <MenuItem label={isDir ? "Open in Finder" : "Open"} onClick={() => run("open")} />
      <div className="my-1 border-t border-zinc-800" />
      <MenuItem label="Move to Trash…" danger onClick={() => run("trash")} />
    </div>
  );
}

function MenuItem({
  label,
  danger,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1 text-left hover:bg-zinc-800 ${
        danger ? "text-red-400 hover:text-red-300" : "text-zinc-200"
      }`}
    >
      {label}
    </button>
  );
}
