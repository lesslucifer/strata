import { useEffect, useRef, useState } from "react";
import { CATEGORIES, LEGEND_SPECIALS } from "./colors";
import { SkeletonTreemap } from "./SkeletonTreemap";
import type { ScanProgress } from "./types";
import { formatBytes } from "./util";

interface Props {
  progress: ScanProgress | null;
  onCancel: () => void;
}

const PHASE_LABEL: Record<string, string> = {
  prescan: "Preparing…",
  walking: "Scanning files…",
  building: "Building directory tree…",
  indexing: "Indexing file types…",
};

const OTHER_COLOR = LEGEND_SPECIALS[1].color;

interface Segment {
  id: string;
  label: string;
  color: string;
  bytes: number;
}

export function ScanProgressView({ progress, onCancel }: Props) {
  const phase = progress?.phase ?? "prescan";
  const totalBytes = progress?.bytes ?? 0;
  const segments = buildSegments(progress?.category_bytes ?? []);
  const visible = segments.filter((s) => s.bytes > 0);
  const isWalking = phase === "walking";
  const isPrescan = phase === "prescan";
  const rawProgress = progress?.progress ?? 0;
  // Animate the visible progress toward the latest target with a fixed-rate
  // tween. Backend events arrive every ~50ms but in bursts; rAF interpolation
  // makes the bar move continuously instead of in steps.
  const smoothProgress = useSmoothProgress(isWalking ? rawProgress : phase === "prescan" ? 0 : 1);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {!isWalking && !isPrescan && (
        <SkeletonTreemap segments={segments} totalBytes={totalBytes} />
      )}
      <div className="relative grid h-full place-items-center p-8">
        <div className="flex w-full max-w-4xl flex-col items-center gap-7 rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-7 shadow-xl backdrop-blur-md">
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  isWalking ? "animate-pulse bg-blue-400" : "animate-pulse bg-amber-400"
                }`}
              />
              <span className="text-sm font-medium tracking-wide text-zinc-200">
                {PHASE_LABEL[phase] ?? "Working…"}
              </span>
            </div>
            <button
              onClick={onCancel}
              className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
            >
              Cancel
            </button>
          </div>

          <ProgressBar phase={phase} progress={smoothProgress} />

          {progress?.current_path && isWalking && (
            <div className="w-full" title={progress.current_path}>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                Currently scanning
              </div>
              <div className="mt-1 truncate font-mono text-xs text-zinc-300">
                {progress.current_path}
              </div>
            </div>
          )}

          <div className="grid w-full grid-cols-3 gap-4 text-center">
            <Stat label="Files" value={(progress?.files ?? 0).toLocaleString()} />
            <Stat label="Folders" value={(progress?.dirs ?? 0).toLocaleString()} />
            <Stat label="Total Size" value={formatBytes(totalBytes)} />
          </div>

          <div className="w-full">
            <div className="mb-2 flex items-baseline justify-between text-[11px] uppercase tracking-wider text-zinc-500">
              <span>Distribution by File Type</span>
              {!isWalking && !isPrescan && <span className="text-zinc-600">Complete</span>}
            </div>
            <TypeMixBar segments={segments} totalBytes={totalBytes} pulsing={isWalking} />
            <Legend segments={visible} totalBytes={totalBytes} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ phase, progress }: { phase: string; progress: number }) {
  const isPrescan = phase === "prescan";
  const displayPct = isPrescan ? 0 : Math.round(progress * 100);
  const widthPct = isPrescan ? 100 : progress * 100;
  return (
    <div className="w-full">
      <div className="mb-1 text-[11px] tabular-nums font-medium text-zinc-300">
        {isPrescan ? "—" : `${displayPct}%`}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full border border-zinc-800 bg-zinc-900">
        <div
          className={`h-full rounded-full bg-blue-500 ${
            isPrescan ? "animate-pulse opacity-50" : ""
          }`}
          style={{
            width: `${widthPct}%`,
            background: isPrescan
              ? "linear-gradient(90deg, transparent, rgb(96 165 250 / 0.6), transparent)"
              : undefined,
          }}
        />
      </div>
    </div>
  );
}

/// rAF-driven tween toward `target`. Backend events arrive every ~50ms in
/// bursts; this interpolates between them so the bar slides continuously.
/// Speed is proportional to remaining distance, with a floor so we always
/// make visible progress.
function useSmoothProgress(target: number): number {
  const [shown, setShown] = useState(target);
  const targetRef = useRef(target);
  const shownRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  targetRef.current = target;

  useEffect(() => {
    function tick(now: number) {
      const last = lastTickRef.current ?? now;
      const dt = Math.min(now - last, 100); // ms; cap to avoid jumps after a tab-out
      lastTickRef.current = now;
      const t = targetRef.current;
      const s = shownRef.current;
      const diff = t - s;
      let next: number;
      if (Math.abs(diff) < 0.0005) {
        next = t;
      } else if (diff < 0) {
        // Snap backwards (rare; e.g. resets between scans).
        next = t;
      } else {
        // Move ~25% of remaining distance per second, with a small floor so
        // we keep moving even when target is barely ahead.
        const rate = Math.max(diff * 0.25, 0.0008);
        next = Math.min(s + (rate * dt) / 1000, t);
      }
      if (next !== s) {
        shownRef.current = next;
        setShown(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTickRef.current = null;
    };
  }, []);

  return shown;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums text-zinc-100">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}

function TypeMixBar({
  segments,
  totalBytes,
  pulsing,
}: {
  segments: Segment[];
  totalBytes: number;
  pulsing: boolean;
}) {
  if (totalBytes === 0) {
    return (
      <div className="h-6 w-full overflow-hidden rounded border border-zinc-800 bg-zinc-900">
        <div
          className={`h-full w-full bg-zinc-800 ${pulsing ? "animate-pulse" : ""}`}
          style={{ opacity: 0.5 }}
        />
      </div>
    );
  }
  return (
    <div className="flex h-6 w-full overflow-hidden rounded border border-zinc-800 bg-zinc-900">
      {segments.map((s) => {
        const pct = (s.bytes / totalBytes) * 100;
        if (pct < 0.001) return null;
        return (
          <div
            key={s.id}
            className="h-full transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%`, background: s.color }}
            title={`${s.label} · ${formatBytes(s.bytes)} · ${pct.toFixed(1)}%`}
          />
        );
      })}
    </div>
  );
}

function Legend({ segments, totalBytes }: { segments: Segment[]; totalBytes: number }) {
  if (segments.length === 0) return null;
  const sorted = [...segments].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  return (
    <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-zinc-400 sm:grid-cols-4">
      {sorted.map((s) => {
        const pct = totalBytes > 0 ? (s.bytes / totalBytes) * 100 : 0;
        return (
          <li key={s.id} className="flex min-w-0 items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="truncate text-zinc-300">{s.label}</span>
            <span className="ml-auto shrink-0 tabular-nums text-zinc-500">{pct.toFixed(0)}%</span>
          </li>
        );
      })}
    </ul>
  );
}

function buildSegments(categoryBytes: number[]): Segment[] {
  const segs: Segment[] = CATEGORIES.map((c, i) => ({
    id: c.id,
    label: c.label,
    color: c.color,
    bytes: categoryBytes[i] ?? 0,
  }));
  segs.push({
    id: "__other__",
    label: "Other",
    color: OTHER_COLOR,
    bytes: categoryBytes[CATEGORIES.length] ?? 0,
  });
  return segs;
}

