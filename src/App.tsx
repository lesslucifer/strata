import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ScanResult } from "./types";
import { formatBytes } from "./util";

export default function App() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickAndScan() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    setScanning(true);
    try {
      const res = await invoke<ScanResult>("scan_directory", { path: picked });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide">Strata</h1>
        <button
          onClick={pickAndScan}
          disabled={scanning}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium hover:bg-blue-500 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Choose folder"}
        </button>
        {result && (
          <span className="text-xs text-zinc-400">
            {result.path} — {formatBytes(result.root.size)} ·{" "}
            {result.file_count.toLocaleString()} files in{" "}
            {result.elapsed_ms} ms
          </span>
        )}
      </header>
      <main className="flex-1 overflow-auto p-4">
        {error && <div className="text-sm text-red-400">Error: {error}</div>}
        {!result && !error && (
          <div className="grid h-full place-items-center text-sm text-zinc-500">
            Pick a folder to scan.
          </div>
        )}
        {result && <TreeView root={result.root} />}
      </main>
    </div>
  );
}

function TreeView({ root }: { root: ScanResult["root"] }) {
  const top = [...root.children]
    .sort((a, b) => b.size - a.size)
    .slice(0, 50);
  return (
    <ul className="space-y-1 text-xs font-mono">
      {top.map((c) => (
        <li key={c.name} className="flex justify-between border-b border-zinc-900 py-1">
          <span className="truncate">
            {c.is_dir ? "📁" : "📄"} {c.name}
          </span>
          <span className="text-zinc-400">{formatBytes(c.size)}</span>
        </li>
      ))}
    </ul>
  );
}
