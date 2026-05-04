import { useEffect, useMemo, useState } from "react";
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

export function TypesTab({ scanEpoch, extFilter, onFilter }: Props) {
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

  const sorted = useMemo(() => {
    if (!stats) return null;
    const copy = stats.slice();
    if (sort === "count") {
      copy.sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
    } else {
      copy.sort((a, b) => b.size - a.size || a.ext.localeCompare(b.ext));
    }
    return copy;
  }, [stats, sort]);

  const maxSize = useMemo(() => {
    if (!stats) return 0;
    return stats.reduce((m, s) => (s.size > m ? s.size : m), 0);
  }, [stats]);

  if (error) {
    return <div className="p-4 text-red-400">Error: {error}</div>;
  }
  if (!sorted) {
    return <div className="p-4 text-zinc-500">Computing types…</div>;
  }
  if (sorted.length === 0) {
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
        {sorted.map((s) => {
          const label = s.ext === "" ? "(no ext)" : `.${s.ext}`;
          const swatch = colorFor(s.ext === "" ? "x" : `x.${s.ext}`, false);
          const active = extFilter === s.ext;
          const pct = maxSize > 0 ? (s.size / maxSize) * 100 : 0;
          return (
            <button
              key={s.ext}
              onClick={() => onFilter(active ? null : s.ext)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                active ? "bg-blue-900/40 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/60"
              }`}
              title={`${label} — ${s.count.toLocaleString()} file${s.count === 1 ? "" : "s"}`}
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-black/30"
                style={{ background: swatch }}
              />
              <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
              <span className="relative w-14 shrink-0 text-right tabular-nums text-zinc-300">
                {formatBytes(s.size)}
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-zinc-500">
                {s.count.toLocaleString()}
              </span>
              <span className="relative h-1.5 w-12 shrink-0 overflow-hidden rounded bg-zinc-800">
                <span
                  className="absolute inset-y-0 left-0"
                  style={{ width: `${pct}%`, background: swatch }}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
