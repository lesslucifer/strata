import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RenderRect } from "./types";
import { colorFor, extOf } from "./colors";
import { formatBytes } from "./util";

export interface SelectedRect {
  rect: RenderRect;
}

interface Props {
  focusPath: string[]; // segments from scan root to current focus
  scanEpoch: number; // bump to force re-fetch after a new scan
  /// Relative path (from focusPath) to outline a file/dir rect, if any.
  selectedRelPath: string[] | null;
  /// Outline this exact `other` rect, if it's still in the current layout.
  selectedOther: SelectedRect | null;
  /// Lowercased ext (or "" for no-ext) to highlight; null = no filter.
  /// Non-matching file rects, all dir rects, and all `other` rects render dimmed.
  extFilter: string | null;
  onSelect: (sel: SelectedRect) => void;
  onDrillDown: (relPath: string[]) => void;
  onContext: (sel: SelectedRect, x: number, y: number) => void;
}

const MAX_RECTS = 12_000;
const HATCH_PATTERN_SIZE = 8;
const RESIZE_DEBOUNCE_MS = 80;

export function Treemap({
  focusPath,
  scanEpoch,
  selectedRelPath,
  selectedOther,
  extFilter,
  onSelect,
  onDrillDown,
  onContext,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hatchRef = useRef<CanvasPattern | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [rects, setRects] = useState<RenderRect[]>([]);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; rect: RenderRect } | null>(null);
  const fetchSeqRef = useRef(0);

  // Debounced resize observer
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let timer: number | undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setSize({ w: Math.floor(width), h: Math.floor(height) });
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // Fetch layout from Rust whenever size, focus, or scan changes.
  useEffect(() => {
    if (size.w < 10 || size.h < 10) return;
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    invoke<RenderRect[]>("compute_layout", {
      relPath: focusPath,
      width: size.w,
      height: size.h,
      maxRects: MAX_RECTS,
    })
      .then((res) => {
        if (seq !== fetchSeqRef.current) return; // stale
        setRects(res);
      })
      .catch(() => {
        if (seq !== fetchSeqRef.current) return;
        setRects([]);
      })
      .finally(() => {
        if (seq === fetchSeqRef.current) setLoading(false);
      });
  }, [size.w, size.h, focusPath, scanEpoch]);

  // Spatial index for hit-testing (uniform grid).
  const grid = useMemo(() => buildGrid(rects, size.w, size.h), [rects, size]);

  // Paint
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = size.w * dpr;
    cvs.height = size.h * dpr;
    cvs.style.width = `${size.w}px`;
    cvs.style.height = `${size.h}px`;
    const ctx = cvs.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, size.h);
    // Background — covers the few sub-pixel gaps the layout leaves.
    ctx.fillStyle = "rgb(20, 20, 22)";
    ctx.fillRect(0, 0, size.w, size.h);

    if (!hatchRef.current) hatchRef.current = makeHatchPattern(ctx);

    for (const r of rects) {
      if (r.kind === "other") {
        ctx.fillStyle = "rgb(50, 50, 55)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (hatchRef.current) {
          ctx.fillStyle = hatchRef.current;
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
      } else {
        ctx.fillStyle = colorFor(r.name, r.kind === "dir");
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      // Cushion edges
      if (r.w > 6 && r.h > 6) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(r.x, r.y, r.w, 1);
        ctx.fillRect(r.x, r.y, 1, r.h);
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
        ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
      }
      // Dim non-matching rects when a type filter is active.
      if (extFilter !== null && !rectMatchesExt(r, extFilter)) {
        ctx.fillStyle = "rgba(20, 20, 22, 0.72)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }

    const outline = findOutline(rects, selectedRelPath, selectedOther);
    if (outline) {
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        outline.x + 1,
        outline.y + 1,
        outline.w - 2,
        outline.h - 2,
      );
    }
  }, [rects, size, selectedRelPath, selectedOther, extFilter]);

  function rectAt(px: number, py: number): RenderRect | null {
    return grid.hit(px, py);
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        onMouseMove={(e) => {
          const cvs = canvasRef.current;
          if (!cvs) return;
          const b = cvs.getBoundingClientRect();
          const r = rectAt(e.clientX - b.left, e.clientY - b.top);
          setHover(r ? { x: e.clientX, y: e.clientY, rect: r } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const cvs = canvasRef.current;
          if (!cvs) return;
          const b = cvs.getBoundingClientRect();
          const r = rectAt(e.clientX - b.left, e.clientY - b.top);
          if (!r) return;
          onSelect({ rect: r });
        }}
        onDoubleClick={(e) => {
          const cvs = canvasRef.current;
          if (!cvs) return;
          const b = cvs.getBoundingClientRect();
          const r = rectAt(e.clientX - b.left, e.clientY - b.top);
          if (!r) return;
          if (r.kind === "other") return;
          if (r.kind === "dir") onDrillDown(r.rel_path);
          else if (r.rel_path.length > 0) onDrillDown(r.rel_path.slice(0, -1));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const cvs = canvasRef.current;
          if (!cvs) return;
          const b = cvs.getBoundingClientRect();
          const r = rectAt(e.clientX - b.left, e.clientY - b.top);
          if (!r || r.kind === "other") return;
          const sel = { rect: r };
          onSelect(sel);
          onContext(sel, e.clientX, e.clientY);
        }}
      />
      {hover && (
        <div
          className="pointer-events-none fixed z-10 rounded border border-zinc-700 bg-zinc-900/95 px-2 py-1 text-xs shadow-lg"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-mono">{hover.rect.name}</div>
          <div className="text-zinc-400">{formatBytes(hover.rect.size)}</div>
          {hover.rect.kind !== "other" && (
            <div className="text-zinc-500">{hover.rect.rel_path.join(" / ")}</div>
          )}
        </div>
      )}
      {loading && (
        <div className="pointer-events-none absolute right-2 top-2 rounded bg-zinc-900/80 px-2 py-1 text-xs text-zinc-400">
          Laying out…
        </div>
      )}
    </div>
  );
}

// --- helpers ---

interface OutlineBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/// Compute the outline bounding box for the current selection.
/// - `selectedOther`: outline that exact rect (reference equality).
/// - `selectedRelPath`: outline the union of every rect whose path is the
///   selection or starts with it. For a file or a leaf-painted folder this is
///   one rect; for a folder the layout recursed into, it's the bbox enclosing
///   all its descendants.
function findOutline(
  rects: RenderRect[],
  selectedRelPath: string[] | null,
  selectedOther: SelectedRect | null,
): OutlineBox | null {
  if (selectedOther) {
    for (const r of rects) {
      if (r === selectedOther.rect) {
        return { x: r.x, y: r.y, w: r.w, h: r.h };
      }
    }
    return null;
  }
  if (!selectedRelPath || selectedRelPath.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const r of rects) {
    if (r.kind === "other") continue;
    if (!pathStartsWith(r.rel_path, selectedRelPath)) continue;
    found = true;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Treemap rects are file leaves or recursed-into dirs. Dirs and `other` buckets
// never match a type filter — only file rects whose ext equals the filter do.
function rectMatchesExt(r: RenderRect, ext: string): boolean {
  if (r.kind !== "file") return false;
  return extOf(r.name) === ext;
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

function makeHatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const off = document.createElement("canvas");
  off.width = HATCH_PATTERN_SIZE;
  off.height = HATCH_PATTERN_SIZE;
  const octx = off.getContext("2d");
  if (!octx) return null;
  octx.strokeStyle = "rgba(255,255,255,0.07)";
  octx.lineWidth = 1;
  octx.beginPath();
  octx.moveTo(0, HATCH_PATTERN_SIZE);
  octx.lineTo(HATCH_PATTERN_SIZE, 0);
  octx.stroke();
  return ctx.createPattern(off, "repeat");
}

interface Grid {
  hit(x: number, y: number): RenderRect | null;
}

function buildGrid(rects: RenderRect[], w: number, h: number): Grid {
  if (rects.length === 0 || w <= 0 || h <= 0) {
    return { hit: () => null };
  }
  // ~16x16 cells, capped so very tall/wide canvases don't allocate huge grids.
  const cols = 16;
  const rows = 16;
  const cw = w / cols;
  const ch = h / rows;
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const c0 = Math.max(0, Math.floor(r.x / cw));
    const r0 = Math.max(0, Math.floor(r.y / ch));
    const c1 = Math.min(cols - 1, Math.floor((r.x + r.w) / cw));
    const r1 = Math.min(rows - 1, Math.floor((r.y + r.h) / ch));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        cells[cy * cols + cx].push(i);
      }
    }
  }
  return {
    hit(x, y) {
      const cx = Math.floor(x / cw);
      const cy = Math.floor(y / ch);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return null;
      const list = cells[cy * cols + cx];
      // Last-drawn-on-top, so iterate in reverse.
      for (let i = list.length - 1; i >= 0; i--) {
        const r = rects[list[i]];
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
      }
      return null;
    },
  };
}
