import { memo, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TypeStat } from "./types";
import { colorFor } from "./colors";
import { formatBytes } from "./util";

type SortKey = "size" | "count";

interface Props {
  scanEpoch: number;
  extFilter: string | null;
  onFilter: (ext: string | null) => void;
}

// Cap the visible list. Real-world scans can produce thousands of distinct
// extensions (random temp suffixes, hash-named cache files, etc.). Rendering
// every one as a DOM row destroys tab-switch perf. The long tail is also
// uninteresting — almost always single-occurrence noise.
const TOP_N = 50;

function TypesTabImpl({ scanEpoch, extFilter, onFilter }: Props) {
  const [stats, setStats] = useState<TypeStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("size");

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setError(null);
    invoke<TypeStat[]>("compute_type_stats")
      .then((res) => {
        if (!cancelled) setStats(res);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [scanEpoch]);

  const { rows, tail, maxSize } = useMemo(() => {
    if (!stats) return { rows: null, tail: null, maxSize: 0 };
    const sorted = stats.slice();
    if (sort === "count") {
      sorted.sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
    } else {
      sorted.sort((a, b) => b.size - a.size || a.ext.localeCompare(b.ext));
    }
    const head = sorted.slice(0, TOP_N);
    const rest = sorted.slice(TOP_N);
    let tailRow: { count: number; size: number; types: number } | null = null;
    if (rest.length > 0) {
      let s = 0;
      let c = 0;
      for (const r of rest) {
        s += r.size;
        c += r.count;
      }
      tailRow = { size: s, count: c, types: rest.length };
    }
    const max = sorted.reduce((m, s) => (s.size > m ? s.size : m), 0);
    return { rows: head, tail: tailRow, maxSize: max };
  }, [stats, sort]);

  if (error) {
    return <div className="p-4 text-red-400">Error: {error}</div>;
  }
  if (!rows) {
    return <div className="p-4 text-zinc-500">Computing types…</div>;
  }
  if (rows.length === 0) {
    return <div className="p-4 text-zinc-500">No files.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
        <span className="flex-1">Type</span>
        <SortHeader active={sort === "size"} onClick={() => setSort("size")}>
          Size
        </SortHeader>
        <SortHeader active={sort === "count"} onClick={() => setSort("count")}>
          Count
        </SortHeader>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.map((s) => (
          <TypeRow
            key={s.ext}
            stat={s}
            active={extFilter === s.ext}
            maxSize={maxSize}
            onFilter={onFilter}
          />
        ))}
        {tail && (
          <div
            className="flex w-full items-center gap-2 px-3 py-1.5 text-zinc-500"
            title={`${tail.types.toLocaleString()} other types not shown`}
          >
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-black/30 bg-zinc-700" />
            <span className="min-w-0 flex-1 truncate font-mono italic">
              + {tail.types.toLocaleString()} more types
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums">{formatBytes(tail.size)}</span>
            <span className="w-12 shrink-0 text-right tabular-nums">
              {tail.count.toLocaleString()}
            </span>
            <span className="w-12 shrink-0" />
          </div>
        )}
      </div>
    </div>
  );
}

// Memoized so unrelated App state changes (rect selection, hover, etc.)
// don't reconcile this component. Stats only change on new scan; sort/filter
// are local.
export const TypesTab = memo(TypesTabImpl);

interface RowProps {
  stat: TypeStat;
  active: boolean;
  maxSize: number;
  onFilter: (ext: string | null) => void;
}

const TypeRow = memo(function TypeRow({ stat, active, maxSize, onFilter }: RowProps) {
  const label = stat.ext === "" ? "(no ext)" : `.${stat.ext}`;
  const swatch = colorFor(stat.ext === "" ? "x" : `x.${stat.ext}`, false);
  const pct = maxSize > 0 ? (stat.size / maxSize) * 100 : 0;
  return (
    <button
      onClick={() => onFilter(active ? null : stat.ext)}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
        active ? "bg-blue-900/40 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/60"
      }`}
      title={`${label} — ${stat.count.toLocaleString()} file${stat.count === 1 ? "" : "s"}`}
    >
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-black/30"
        style={{ background: swatch }}
      />
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      <span className="w-14 shrink-0 text-right tabular-nums text-zinc-300">
        {formatBytes(stat.size)}
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums text-zinc-500">
        {stat.count.toLocaleString()}
      </span>
      <span className="relative h-1.5 w-12 shrink-0 overflow-hidden rounded bg-zinc-800">
        <span
          className="absolute inset-y-0 left-0"
          style={{ width: `${pct}%`, background: swatch }}
        />
      </span>
    </button>
  );
});

function SortHeader({
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
      className={`shrink-0 px-1 ${active ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {children}
      {active ? " ↓" : ""}
    </button>
  );
}
