import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Node, ScanProgress, ScanResult } from "./types";
import { formatBytes, formatDate, joinPath } from "./util";
import { extOf } from "./colors";
import { Treemap, type NodeRef } from "./Treemap";

interface ContextMenuState {
  x: number;
  y: number;
  ref: NodeRef;
  absPath: string;
}

export default function App() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  async function pickAndScan() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    setScanning(true);
    setFocus([]);
    setSelected(null);
    setProgress(null);
    setResult(null);

    const unlisten = await listen<ScanProgress>("scan-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const res = await invoke<ScanResult>("scan_directory", { path: picked });
      setResult(res);
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

  const focused = useMemo<Node | null>(() => {
    if (!result) return null;
    let cur: Node = result.root;
    for (const seg of focus) {
      const next = cur.children.find((c) => c.name === seg);
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }, [result, focus]);

  // Selected node's absolute path on disk.
  const selectedAbsPath = useMemo<string | null>(() => {
    if (!result || !selected) return null;
    return joinPath(result.path, [...focus, ...selected.relPath]);
  }, [result, focus, selected]);

  // Dismiss the context menu on any click elsewhere or Escape.
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
        {result && focused && !scanning && (
          <Breadcrumb
            rootName={result.root.name}
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
        {!scanning && result && focused && (
          <span className="ml-auto text-xs text-zinc-400">
            {formatBytes(focused.size)} · scanned in {result.elapsed_ms} ms ·{" "}
            {result.file_count.toLocaleString()} files
          </span>
        )}
      </header>
      <main className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {error && <div className="p-4 text-sm text-red-400">Error: {error}</div>}
          {!result && !error && !scanning && (
            <div className="grid h-full place-items-center text-sm text-zinc-500">
              Pick a folder to scan.
            </div>
          )}
          {scanning && !result && (
            <div className="grid h-full place-items-center text-sm text-zinc-500">
              Scanning…
            </div>
          )}
          {focused && (
            <Treemap
              root={focused}
              selected={selected}
              onSelect={setSelected}
              onDrillDown={(path) => {
                setFocus([...focus, ...path]);
                setSelected(null);
              }}
              onContext={(ref, x, y) => {
                if (!result) return;
                const absPath = joinPath(result.path, [...focus, ...ref.relPath]);
                setMenu({ x, y, ref, absPath });
              }}
            />
          )}
        </div>
        {selected && (
          <DetailsPane
            node={selected.node}
            absPath={selectedAbsPath ?? ""}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.absPath}
          isDir={menu.ref.node.is_dir}
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
  node,
  absPath,
  onClose,
}: {
  node: Node;
  absPath: string;
  onClose: () => void;
}) {
  const ext = extOf(node.name);
  const itemCount = node.is_dir ? countDescendants(node) : 1;
  return (
    <aside className="w-72 shrink-0 border-l border-zinc-800 bg-zinc-900/50 p-4 text-xs">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="truncate font-mono text-sm font-medium">{node.name}</div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200"
          aria-label="Close details"
        >
          ✕
        </button>
      </div>
      <dl className="space-y-2">
        <Row label="Type" value={node.is_dir ? "Folder" : ext ? `.${ext} file` : "File"} />
        <Row label="Size" value={formatBytes(node.size)} />
        <Row label="Items" value={itemCount.toLocaleString()} />
        <Row label="Modified" value={formatDate(node.modified_ms)} />
        <Row label="Path" value={absPath} mono />
      </dl>
    </aside>
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

function countDescendants(n: Node): number {
  let c = 1;
  for (const child of n.children) c += countDescendants(child);
  return c;
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
