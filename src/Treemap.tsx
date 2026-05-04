import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RenderRect } from "./types";
import { colorFor, colorForGroup, extOf } from "./colors";
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
  const deletedHatchRef = useRef<CanvasPattern | null>(null);
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
    if (!deletedHatchRef.current) deletedHatchRef.current = makeDeletedPattern(ctx);

    for (const r of rects) {
      let baseColor: string;
      if (r.kind === "other") {
        baseColor = "rgb(50, 50, 55)";
        ctx.fillStyle = baseColor;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (hatchRef.current) {
          ctx.fillStyle = hatchRef.current;
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
      } else if (r.kind === "group") {
        // Per-category palette so different group types are visually distinct
        // (code packages vs. build output vs. macOS bundles, etc.).
        baseColor = colorForGroup(r.group_category);
        ctx.fillStyle = baseColor;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      } else {
        baseColor = colorFor(r.name, r.kind === "dir");
        ctx.fillStyle = baseColor;
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
      // Group rects get a thicker outline so they read as a single block.
      if (r.kind === "group" && r.w > 4 && r.h > 4) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
      }
      const dim = extFilter !== null && !rectMatchesExt(r, extFilter);
      if (dim) {
        ctx.fillStyle = "rgba(20, 20, 22, 0.72)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      if (r.deleted) {
        // Wash the rect almost out: heavy dark veil + red tint + bold red hatch.
        ctx.fillStyle = "rgba(10, 10, 12, 0.82)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "rgba(180, 30, 30, 0.22)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (deletedHatchRef.current) {
          ctx.fillStyle = deletedHatchRef.current;
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        // Red border so even small rects read as deleted.
        if (r.w > 2 && r.h > 2) {
          ctx.strokeStyle = "rgba(220, 60, 60, 0.85)";
          ctx.lineWidth = 1;
          ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        }
      }
      drawLabel(ctx, r, baseColor, dim || r.deleted);
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
          if (r.kind === "dir" || r.kind === "group") onDrillDown(r.rel_path);
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
          <div className="text-zinc-400">
            {formatBytes(hover.rect.size)}
            {hover.rect.kind === "group" && hover.rect.total_files > 0 && (
              <> · {hover.rect.total_files.toLocaleString()} items</>
            )}
          </div>
          {hover.rect.kind === "group" && (
            <div className="text-zinc-500">Grouped — double-click to drill in</div>
          )}
          {hover.rect.kind !== "other" && hover.rect.rel_path.length > 0 && (
            <div className="text-zinc-500">{hover.rect.rel_path.join(" / ")}</div>
          )}
        </div>
      )}
      {loading && (
        <div className="pointer-events-none absolute right-2 top-2 rounded bg-zinc-900/80 px-2 py-1 text-xs text-zinc-400">
          Updating layout…
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

// Inline label thresholds. Width/height below these means we skip drawing
// entirely; otherwise we show name only, or name + size if both fit.
const LABEL_MIN_W = 44;
const LABEL_MIN_H = 16;
const LABEL_SIZE_MIN_W = 60;
const LABEL_SIZE_MIN_H = 30;
const LABEL_PAD_X = 4;
const LABEL_PAD_Y = 3;

function drawLabel(
  ctx: CanvasRenderingContext2D,
  r: RenderRect,
  baseColor: string,
  dim: boolean,
) {
  if (r.w < LABEL_MIN_W || r.h < LABEL_MIN_H) return;
  const showName = r.w >= LABEL_SIZE_MIN_W && r.h >= LABEL_SIZE_MIN_H;

  // Effective fill color after the dim overlay (rgba 20,20,22 @ .72 over base).
  const eff = dim ? mixOver(baseColor, [20, 20, 22], 0.72) : parseColor(baseColor);
  const light = eff ? relativeLuminance(eff) > 0.45 : false;
  const fg = light ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.92)";
  const fgDim = light ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.65)";

  const innerW = r.w - LABEL_PAD_X * 2;
  let sz: string;
  if (r.kind === "other") {
    sz = `+${r.other_count} · ${formatBytes(r.size)}`;
  } else if (r.kind === "group") {
    sz =
      r.total_files > 0
        ? `${formatBytes(r.size)} · ${r.total_files.toLocaleString()} items`
        : formatBytes(r.size);
  } else {
    sz = formatBytes(r.size);
  }
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillStyle = fg;
  // Reserve space for the badge on grouped rects so size text doesn't overlap.
  const badgeReserve = r.kind === "group" && r.w >= LABEL_MIN_W ? 12 : 0;
  const sizeFitted = fitText(ctx, sz, innerW - badgeReserve);
  if (!sizeFitted) return;
  ctx.fillText(sizeFitted, r.x + LABEL_PAD_X, r.y + LABEL_PAD_Y);

  if (r.kind === "group" && r.w >= LABEL_MIN_W && r.h >= LABEL_MIN_H) {
    drawGroupBadge(ctx, r.x + r.w - 12, r.y + 4, fgDim);
  }

  if (showName && r.kind !== "other") {
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = fgDim;
    const nameFitted = fitText(ctx, r.name, innerW);
    if (nameFitted) {
      ctx.fillText(nameFitted, r.x + LABEL_PAD_X, r.y + LABEL_PAD_Y + 13);
    }
  }
}

/// Tiny stacked-squares glyph that signals "this folder is treated as one item".
function drawGroupBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, 6, 6);
  ctx.strokeRect(x + 2.5, y + 2.5, 6, 6);
  ctx.restore();
}

function fitText(
  ctx: CanvasRenderingContext2D,
  s: string,
  maxWidth: number,
): string | null {
  if (maxWidth <= 0) return null;
  if (ctx.measureText(s).width <= maxWidth) return s;
  const ell = "…";
  const ellW = ctx.measureText(ell).width;
  if (ellW > maxWidth) return null;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid)).width + ellW <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return null;
  return s.slice(0, lo) + ell;
}

type RGB = [number, number, number];

function parseColor(c: string): RGB | null {
  const m = c.match(/^hsl\(\s*([-\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/);
  if (m) return hslToRgb(parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
  const r = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (r) return [parseInt(r[1], 10), parseInt(r[2], 10), parseInt(r[3], 10)];
  return null;
}

function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function mixOver(base: string, over: RGB, overAlpha: number): RGB | null {
  const b = parseColor(base);
  if (!b) return null;
  return [
    Math.round(b[0] * (1 - overAlpha) + over[0] * overAlpha),
    Math.round(b[1] * (1 - overAlpha) + over[1] * overAlpha),
    Math.round(b[2] * (1 - overAlpha) + over[2] * overAlpha),
  ];
}

function relativeLuminance([r, g, b]: RGB): number {
  // Perceptual brightness (Rec. 709 weights), 0..1.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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

// Bolder, red-tinted diagonal hatch — distinct from the subtle "other" pattern
// so deleted rects read as "gone" at a glance.
function makeDeletedPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const size = 5;
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const octx = off.getContext("2d");
  if (!octx) return null;
  octx.strokeStyle = "rgba(255, 90, 90, 0.85)";
  octx.lineWidth = 2;
  octx.beginPath();
  octx.moveTo(-1, size + 1);
  octx.lineTo(size + 1, -1);
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
