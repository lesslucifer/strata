import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChildEntry, NodeMeta, ScanProgress, ScanSummary } from "./types";
import { formatBytes, formatDate, joinPath, truncatePath } from "./util";
import { colorFor, extOf } from "./colors";
import { Treemap, type SelectedRect } from "./Treemap";
import { TypesTab } from "./TypesTab";

type Tab = "details" | "tree" | "types";

// SOH is illegal in POSIX/Windows filenames, so it's a safe map key separator.
const PATH_SEP = "";
function pathKey(p: string[]): string {
  return p.join(PATH_SEP);
}

interface ContextMenuState {
  x: number;
  y: number;
  absPath: string;
  isDir: boolean;
  /// Path from the scan root, used to mark the in-memory tree as deleted.
  relFromRoot: string[];
  deleted: boolean;
}

type ConfirmKind = "trash" | "delete";

interface ConfirmState {
  kind: ConfirmKind;
  absPath: string;
  isDir: boolean;
  relFromRoot: string[];
}

export default function App() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanEpoch, setScanEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  // Logical selection: absolute path from scan root. Set by tree clicks AND by
  // rect clicks on file/dir. The treemap derives its outline by matching this
  // against `[...focus, ...rect.rel_path]`.
  const [selectedAbsPath, setSelectedAbsPath] = useState<string[] | null>(null);
  // Separate slot for `other` aggregation rects (no path; can't be tree-selected).
  const [selectedOther, setSelectedOther] = useState<SelectedRect | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<NodeMeta | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [tab, setTab] = useState<Tab>("details");
  // Type filter is mutually exclusive with `focus`: setting one clears the other.
  const [extFilter, setExtFilter] = useState<string | null>(null);

  function clearSelection() {
    setSelectedAbsPath(null);
    setSelectedOther(null);
    setSelectedMeta(null);
  }

  async function runDelete(req: ConfirmState) {
    try {
      if (req.kind === "trash") {
        await invoke("move_to_trash", { path: req.absPath });
      } else {
        await invoke("delete_permanent", { path: req.absPath });
      }
      await invoke("mark_path_deleted", { relPath: req.relFromRoot }).catch(() => {});
      setScanEpoch((n) => n + 1);
      setSelectedOther(null);
      setSelectedAbsPath(req.relFromRoot);
    } catch (e) {
      setError(String(e));
    }
  }

  function requestDelete(req: ConfirmState) {
    setMenu(null);
    if (req.kind === "trash") {
      // Trash is reversible — no confirmation needed.
      void runDelete(req);
      return;
    }
    setConfirm(req);
  }

  async function performDelete() {
    if (!confirm) return;
    const req = confirm;
    setConfirm(null);
    await runDelete(req);
  }

  function applyFocus(next: string[]) {
    setFocus(next);
    setSelectedOther(null);
    if (next.length > 0 && extFilter !== null) setExtFilter(null);
  }

  // Stable identity so memo'd children (TypesTab) don't re-render on every
  // unrelated App state change (selection, hover, etc.).
  const applyExtFilter = useCallback((ext: string | null) => {
    setExtFilter(ext);
    if (ext !== null) {
      setFocus((f) => (f.length > 0 ? [] : f));
      setSelectedOther(null);
    }
  }, []);

  async function pickAndScan() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    setScanning(true);
    setFocus([]);
    setExtFilter(null);
    clearSelection();
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

  // Fetch full metadata for the logically selected node.
  useEffect(() => {
    if (!selectedAbsPath || !summary) {
      setSelectedMeta(null);
      return;
    }
    let cancelled = false;
    invoke<NodeMeta>("get_node_meta", { relPath: selectedAbsPath })
      .then((m) => {
        if (!cancelled) setSelectedMeta(m);
      })
      .catch(() => {
        if (!cancelled) setSelectedMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAbsPath, summary, scanEpoch]);

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

  // Derive the rect-relative selection (relative to current focus) from the
  // absolute path. Returns null if the selection isn't under the current focus.
  const selectedRelPath = useMemo<string[] | null>(() => {
    if (!selectedAbsPath) return null;
    if (selectedAbsPath.length < focus.length) return null;
    for (let i = 0; i < focus.length; i++) {
      if (selectedAbsPath[i] !== focus[i]) return null;
    }
    return selectedAbsPath.slice(focus.length);
  }, [selectedAbsPath, focus]);

  // Open the context menu for a given path (used by treemap rect right-click and
  // tree-row right-click). `deleted` skips destructive options.
  const openContextMenu = useCallback(
    (args: {
      relFromRoot: string[];
      isDir: boolean;
      deleted: boolean;
      x: number;
      y: number;
    }) => {
      if (!summary) return;
      const absPath = joinPath(summary.path, args.relFromRoot);
      setMenu({
        x: args.x,
        y: args.y,
        absPath,
        isDir: args.isDir,
        deleted: args.deleted,
        relFromRoot: args.relFromRoot,
      });
    },
    [summary],
  );

  // Treemap → App: rect was clicked.
  function onRectSelect(sel: SelectedRect) {
    if (sel.rect.kind === "other") {
      setSelectedOther(sel);
      setSelectedAbsPath(null);
      setTab("details");
      return;
    }
    setSelectedOther(null);
    setSelectedAbsPath([...focus, ...sel.rect.rel_path]);
  }

  const showEmptyState = !scanning && !summary && !error;

  return (
    <div className="flex h-full flex-col">
      {scanning && (
        <header className="grid grid-cols-[auto_auto_1fr] items-center gap-4 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
          <button
            onClick={cancelScan}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium hover:bg-red-500"
          >
            Cancel
          </button>
          <span className="whitespace-nowrap text-xs text-zinc-400">
            {progress ? (
              <>
                {progress.files.toLocaleString()} files ·{" "}
                {progress.dirs.toLocaleString()} dirs · {formatBytes(progress.bytes)}
              </>
            ) : (
              "Starting…"
            )}
          </span>
          <span
            className="min-w-0 truncate text-right font-mono text-xs text-zinc-600"
            title={progress?.current_path ?? ""}
          >
            {truncatePath(progress?.current_path ?? "")}
          </span>
        </header>
      )}
      {!scanning && summary && (
        <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
          <h1 className="text-sm font-semibold tracking-wide">Strata</h1>
          <button
            onClick={pickAndScan}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium hover:bg-blue-500"
          >
            Choose folder
          </button>
          <Breadcrumb
            rootName={summary.root_name}
            focus={focus}
            onJump={(i) => applyFocus(focus.slice(0, i))}
          />
          {extFilter !== null && (
            <FilterChip
              label={extFilter === "" ? "(no ext)" : `.${extFilter}`}
              onClear={() => setExtFilter(null)}
            />
          )}
          <span className="ml-auto text-xs text-zinc-400">
            {formatBytes(summary.root_size)} · scanned in {summary.elapsed_ms} ms ·{" "}
            {summary.file_count.toLocaleString()} files
          </span>
        </header>
      )}
      <main className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {error && <div className="p-4 text-sm text-red-400">Error: {error}</div>}
          {showEmptyState && (
            <div className="grid h-full place-items-center">
              <div className="flex flex-col items-center gap-4">
                <h1 className="text-2xl font-semibold tracking-wide">Strata</h1>
                <p className="text-sm text-zinc-500">Pick a folder to analyze its disk usage.</p>
                <button
                  onClick={pickAndScan}
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
                >
                  Choose folder
                </button>
              </div>
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
              selectedRelPath={selectedRelPath}
              selectedOther={selectedOther}
              extFilter={extFilter}
              onSelect={onRectSelect}
              onDrillDown={(relPath) => applyFocus([...focus, ...relPath])}
              onContext={(sel, x, y) => {
                openContextMenu({
                  relFromRoot: [...focus, ...sel.rect.rel_path],
                  isDir: sel.rect.kind === "dir",
                  deleted: sel.rect.deleted,
                  x,
                  y,
                });
              }}
            />
          )}
        </div>
        {summary && (
          <SidePanel
            tab={tab}
            onTab={setTab}
            scanEpoch={scanEpoch}
            scanRootName={summary.root_name}
            scanRootPath={summary.path}
            selectedAbsPath={selectedAbsPath}
            selectedOther={selectedOther}
            selectedMeta={selectedMeta}
            extFilter={extFilter}
            onExtFilter={applyExtFilter}
            onTreeSelect={(absPath) => {
              setSelectedOther(null);
              setSelectedAbsPath(absPath);
            }}
            onTreeContext={openContextMenu}
            onRequestDelete={requestDelete}
            onClose={clearSelection}
          />
        )}
      </main>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.absPath}
          isDir={menu.isDir}
          deleted={menu.deleted}
          relFromRoot={menu.relFromRoot}
          onClose={() => setMenu(null)}
          onError={setError}
          onRequestDelete={requestDelete}
        />
      )}
      {confirm && (
        <ConfirmDeleteDialog
          state={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={performDelete}
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

function SidePanel({
  tab,
  onTab,
  scanEpoch,
  scanRootName,
  scanRootPath,
  selectedAbsPath,
  selectedOther,
  selectedMeta,
  extFilter,
  onExtFilter,
  onTreeSelect,
  onTreeContext,
  onRequestDelete,
  onClose,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  scanEpoch: number;
  scanRootName: string;
  scanRootPath: string;
  selectedAbsPath: string[] | null;
  selectedOther: SelectedRect | null;
  selectedMeta: NodeMeta | null;
  extFilter: string | null;
  onExtFilter: (ext: string | null) => void;
  onTreeSelect: (absPath: string[]) => void;
  onTreeContext: (args: {
    relFromRoot: string[];
    isDir: boolean;
    deleted: boolean;
    x: number;
    y: number;
  }) => void;
  onRequestDelete: (req: ConfirmState) => void;
  onClose: () => void;
}) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/50 text-xs">
      <div className="flex shrink-0 border-b border-zinc-800">
        <TabButton active={tab === "details"} onClick={() => onTab("details")}>
          Details
        </TabButton>
        <TabButton active={tab === "tree"} onClick={() => onTab("tree")}>
          Tree
        </TabButton>
        <TabButton active={tab === "types"} onClick={() => onTab("types")}>
          Types
        </TabButton>
      </div>
      {/* Keep all tab panels mounted so their internal state (fetched stats,
          tree expansion, scroll) survives tab switches. Hide inactive ones
          via display:none so they don't paint or take layout space. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabPanel active={tab === "details"}>
          <DetailsTab
            selectedAbsPath={selectedAbsPath}
            selectedOther={selectedOther}
            meta={selectedMeta}
            scanRootPath={scanRootPath}
            onRequestDelete={onRequestDelete}
            onClose={onClose}
          />
        </TabPanel>
        <TabPanel active={tab === "tree"}>
          <TreeTab
            scanEpoch={scanEpoch}
            scanRootName={scanRootName}
            selectedAbsPath={selectedAbsPath}
            onSelect={onTreeSelect}
            onContext={onTreeContext}
          />
        </TabPanel>
        <TabPanel active={tab === "types"}>
          <TypesTab scanEpoch={scanEpoch} extFilter={extFilter} onFilter={onExtFilter} />
        </TabPanel>
      </div>
    </aside>
  );
}

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className="h-full" style={{ display: active ? undefined : "none" }}>
      {children}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-blue-700 bg-blue-900/40 px-2 py-0.5 text-xs text-blue-100">
      <span className="text-blue-300">Type:</span>
      <span className="font-mono">{label}</span>
      <button
        onClick={onClear}
        className="ml-1 text-blue-300 hover:text-white"
        aria-label="Clear type filter"
      >
        ✕
      </button>
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-medium ${
        active
          ? "bg-zinc-900 text-zinc-100"
          : "text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function DetailsTab({
  selectedAbsPath,
  selectedOther,
  meta,
  scanRootPath,
  onRequestDelete,
  onClose,
}: {
  selectedAbsPath: string[] | null;
  selectedOther: SelectedRect | null;
  meta: NodeMeta | null;
  scanRootPath: string;
  onRequestDelete: (req: ConfirmState) => void;
  onClose: () => void;
}) {
  if (selectedOther) {
    const r = selectedOther.rect;
    return (
      <div className="h-full overflow-auto p-4">
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
      </div>
    );
  }
  if (!selectedAbsPath) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-zinc-500">
        <p>Select a rectangle or a tree row to see details.</p>
      </div>
    );
  }
  const name = selectedAbsPath[selectedAbsPath.length - 1] ?? "";
  const ext = extOf(name);
  const isDir = meta?.is_dir ?? false;
  const type = isDir ? "Folder" : ext ? `.${ext} file` : "File";
  const absPath = joinPath(scanRootPath, selectedAbsPath);
  const isDeleted = meta?.deleted ?? false;
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-4">
        <Header title={name} onClose={onClose} />
        {isDeleted && (
          <div className="mb-3 rounded border border-red-800/60 bg-red-950/40 px-2 py-1 text-[11px] font-medium text-red-300">
            {isDir ? "Folder deleted" : "File deleted"}
          </div>
        )}
        <dl className="space-y-2">
          <Row label="Type" value={type} />
          <Row label="Size" value={formatBytes(meta ? meta.size : 0)} />
          <Row
            label={isDir ? "Direct children" : "Items"}
            value={(meta ? meta.child_count : 1).toLocaleString()}
          />
          <Row label="Modified" value={formatDate(meta ? meta.modified_ms : null)} />
          <Row label="Path" value={absPath} mono />
        </dl>
      </div>
      {!isDeleted && selectedAbsPath.length > 0 && (
        <div className="flex shrink-0 gap-2 border-t border-zinc-800 bg-zinc-900/60 p-2">
          <button
            onClick={() =>
              onRequestDelete({
                kind: "trash",
                absPath,
                isDir,
                relFromRoot: selectedAbsPath,
              })
            }
            className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            Move to Trash…
          </button>
          <button
            onClick={() =>
              onRequestDelete({
                kind: "delete",
                absPath,
                isDir,
                relFromRoot: selectedAbsPath,
              })
            }
            className="flex-1 rounded border border-red-800 bg-red-950/60 px-2 py-1 text-xs text-red-300 hover:bg-red-900/70"
          >
            Delete permanently…
          </button>
        </div>
      )}
    </div>
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

// --- Tree explorer ---

function TreeTab({
  scanEpoch,
  scanRootName,
  selectedAbsPath,
  onSelect,
  onContext,
}: {
  scanEpoch: number;
  scanRootName: string;
  selectedAbsPath: string[] | null;
  onSelect: (absPath: string[]) => void;
  onContext: (args: {
    relFromRoot: string[];
    isDir: boolean;
    deleted: boolean;
    x: number;
    y: number;
  }) => void;
}) {
  // Cache: pathKey -> children list. Survives tab switches; cleared on new scan.
  const [cache, setCache] = useState<Map<string, ChildEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingFetches, setPendingFetches] = useState<Set<string>>(new Set());
  const inflightRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);

  // Reset on new scan.
  useEffect(() => {
    setCache(new Map());
    setExpanded(new Set());
    setPendingFetches(new Set());
    inflightRef.current = new Set();
  }, [scanEpoch]);

  const fetchChildren = useCallback(
    async (path: string[]): Promise<ChildEntry[] | null> => {
      const key = pathKey(path);
      if (inflightRef.current.has(key)) return null;
      inflightRef.current.add(key);
      setPendingFetches((s) => {
        const n = new Set(s);
        n.add(key);
        return n;
      });
      try {
        const res = await invoke<ChildEntry[]>("list_children", { relPath: path });
        setCache((c) => {
          const n = new Map(c);
          n.set(key, res);
          return n;
        });
        return res;
      } catch {
        return null;
      } finally {
        inflightRef.current.delete(key);
        setPendingFetches((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [],
  );

  // Auto-fetch root on first mount / new scan.
  useEffect(() => {
    if (!cache.has(pathKey([]))) {
      void fetchChildren([]);
    }
  }, [cache, fetchChildren]);

  const toggle = useCallback(
    async (path: string[]) => {
      const key = pathKey(path);
      const isOpen = expanded.has(key);
      if (isOpen) {
        setExpanded((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
        return;
      }
      if (!cache.has(key)) await fetchChildren(path);
      setExpanded((s) => {
        const n = new Set(s);
        n.add(key);
        return n;
      });
    },
    [expanded, cache, fetchChildren],
  );

  // When the rect-side selection changes, ensure all ancestors are expanded
  // (and their children fetched), then scroll the row into view.
  useEffect(() => {
    if (!selectedAbsPath || selectedAbsPath.length === 0) return;
    let cancelled = false;
    (async () => {
      const ancestors: string[][] = [];
      for (let i = 0; i < selectedAbsPath.length; i++) {
        ancestors.push(selectedAbsPath.slice(0, i));
      }
      const toExpand: string[] = [];
      for (const a of ancestors) {
        const k = pathKey(a);
        if (!cache.has(k)) {
          await fetchChildren(a);
          if (cancelled) return;
        }
        toExpand.push(k);
      }
      setExpanded((s) => {
        const n = new Set(s);
        for (const k of toExpand) n.add(k);
        return n;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAbsPath, cache, fetchChildren]);

  // Scroll selection into view after the row mounts.
  useEffect(() => {
    if (rowEl) rowEl.scrollIntoView({ block: "nearest" });
  }, [rowEl, selectedAbsPath]);

  const rootChildren = cache.get(pathKey([]));
  const rootKey = pathKey([]);
  const rootSelected = selectedAbsPath !== null && selectedAbsPath.length === 0;
  return (
    <div ref={scrollRef} className="h-full overflow-auto py-1 font-mono text-xs">
      <TreeRow
        depth={0}
        name={scanRootName}
        size={null}
        isDir
        hasChildren={(rootChildren?.length ?? 0) > 0}
        deleted={false}
        isOpen={expanded.has(rootKey)}
        loading={pendingFetches.has(rootKey)}
        selected={rootSelected}
        onToggle={() => toggle([])}
        onSelect={() => onSelect([])}
        onContext={(x, y) => onContext({ relFromRoot: [], isDir: true, deleted: false, x, y })}
        registerEl={rootSelected ? setRowEl : undefined}
      />
      {expanded.has(rootKey) && rootChildren && (
        <TreeChildren
          parentPath={[]}
          children={rootChildren}
          depth={1}
          cache={cache}
          expanded={expanded}
          pending={pendingFetches}
          selectedAbsPath={selectedAbsPath}
          registerSelectedEl={setRowEl}
          onToggle={toggle}
          onSelect={onSelect}
          onContext={onContext}
        />
      )}
    </div>
  );
}

function TreeChildren({
  parentPath,
  children,
  depth,
  cache,
  expanded,
  pending,
  selectedAbsPath,
  registerSelectedEl,
  onToggle,
  onSelect,
  onContext,
}: {
  parentPath: string[];
  children: ChildEntry[];
  depth: number;
  cache: Map<string, ChildEntry[]>;
  expanded: Set<string>;
  pending: Set<string>;
  selectedAbsPath: string[] | null;
  registerSelectedEl: (el: HTMLDivElement | null) => void;
  onToggle: (path: string[]) => void;
  onSelect: (path: string[]) => void;
  onContext: (args: {
    relFromRoot: string[];
    isDir: boolean;
    deleted: boolean;
    x: number;
    y: number;
  }) => void;
}) {
  return (
    <>
      {children.map((c) => {
        const path = [...parentPath, c.name];
        const key = pathKey(path);
        const isOpen = expanded.has(key);
        const grandChildren = cache.get(key);
        const isSelected =
          selectedAbsPath !== null &&
          selectedAbsPath.length === path.length &&
          path.every((s, i) => selectedAbsPath[i] === s);
        return (
          <div key={c.name}>
            <TreeRow
              depth={depth}
              name={c.name}
              size={c.size}
              isDir={c.is_dir}
              hasChildren={c.has_children}
              deleted={c.deleted}
              isOpen={isOpen}
              loading={pending.has(key)}
              selected={isSelected}
              onToggle={() => onToggle(path)}
              onSelect={() => onSelect(path)}
              onContext={(x, y) =>
                onContext({ relFromRoot: path, isDir: c.is_dir, deleted: c.deleted, x, y })
              }
              registerEl={isSelected ? registerSelectedEl : undefined}
            />
            {isOpen && grandChildren && (
              <TreeChildren
                parentPath={path}
                children={grandChildren}
                depth={depth + 1}
                cache={cache}
                expanded={expanded}
                pending={pending}
                selectedAbsPath={selectedAbsPath}
                registerSelectedEl={registerSelectedEl}
                onToggle={onToggle}
                onSelect={onSelect}
                onContext={onContext}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function TreeRow({
  depth,
  name,
  size,
  isDir,
  hasChildren,
  deleted,
  isOpen,
  loading,
  selected,
  onToggle,
  onSelect,
  onContext,
  registerEl,
}: {
  depth: number;
  name: string;
  size: number | null;
  isDir: boolean;
  hasChildren: boolean;
  deleted: boolean;
  isOpen: boolean;
  loading: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onContext: (x: number, y: number) => void;
  registerEl?: (el: HTMLDivElement | null) => void;
}) {
  const swatch = colorFor(name, isDir);
  return (
    <div
      ref={registerEl}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        onContext(e.clientX, e.clientY);
      }}
      className={`flex items-center gap-1 pr-2 ${
        selected ? "bg-blue-900/40 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/60"
      } ${deleted ? "text-red-400/70 line-through decoration-red-500/70" : ""}`}
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      <button
        onClick={onToggle}
        className="grid h-4 w-4 shrink-0 place-items-center text-zinc-500 hover:text-zinc-200"
        aria-label={isOpen ? "Collapse" : "Expand"}
        disabled={!isDir || !hasChildren}
      >
        {isDir && hasChildren ? (loading ? "…" : isOpen ? "▾" : "▸") : ""}
      </button>
      <span
        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-black/30 ${
          deleted ? "opacity-30" : ""
        }`}
        style={{ background: swatch }}
      />
      <button
        onClick={onSelect}
        onDoubleClick={() => {
          if (isDir && hasChildren) onToggle();
        }}
        className="min-w-0 flex-1 truncate text-left"
        title={name}
      >
        {name}
      </button>
      {size !== null && (
        <span className="shrink-0 text-[10px] text-zinc-500">{formatBytes(size)}</span>
      )}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  path,
  isDir,
  deleted,
  relFromRoot,
  onClose,
  onError,
  onRequestDelete,
}: {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  deleted: boolean;
  relFromRoot: string[];
  onClose: () => void;
  onError: (msg: string) => void;
  onRequestDelete: (req: ConfirmState) => void;
}) {
  async function run(cmd: string) {
    try {
      if (cmd === "trash" || cmd === "delete") {
        onRequestDelete({ kind: cmd, absPath: path, isDir, relFromRoot });
        return; // dialog closes the menu
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
      {deleted ? (
        <div className="px-3 py-1 text-zinc-500 italic">{isDir ? "Folder" : "File"} deleted</div>
      ) : (
        <>
          <MenuItem label="Reveal in Finder" onClick={() => run("reveal")} />
          <MenuItem label={isDir ? "Open in Finder" : "Open"} onClick={() => run("open")} />
          <div className="my-1 border-t border-zinc-800" />
          <MenuItem label="Move to Trash…" danger onClick={() => run("trash")} />
          <MenuItem label="Delete permanently…" danger onClick={() => run("delete")} />
        </>
      )}
    </div>
  );
}

function ConfirmDeleteDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const noun = state.isDir ? "folder" : "file";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/60"
      onMouseDown={onCancel}
    >
      <div
        className="w-[28rem] max-w-[90vw] rounded-lg border border-red-700/70 bg-zinc-900 p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-red-400">
          Permanently delete this {noun}?
        </h2>
        <p className="mt-2 break-all font-mono text-xs text-zinc-400">{state.absPath}</p>
        <p className="mt-3 text-xs text-red-300">
          This bypasses the Trash and cannot be undone.
          {state.isDir && " The entire folder and all its contents will be removed."}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
          >
            Delete permanently
          </button>
        </div>
      </div>
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

