import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";
import type { Node } from "./types";
import { colorFor } from "./colors";
import { formatBytes } from "./util";

export interface NodeRef {
  node: Node;
  relPath: string[]; // path segments from the current root to this node
}

interface Props {
  root: Node;
  selected: NodeRef | null;
  onSelect: (ref: NodeRef) => void;
  onDrillDown: (path: string[]) => void;
  onContext: (ref: NodeRef, x: number, y: number) => void;
}

interface LaidOutRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  node: HierarchyRectangularNode<Node>;
}

const PADDING = 1;
const MIN_DRAW_PX = 2;

export function Treemap({ root, selected, onSelect, onDrillDown, onContext }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number; rect: LaidOutRect } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rects = useMemo<LaidOutRect[]>(() => {
    if (size.w < 10 || size.h < 10) return [];
    const h = hierarchy<Node>(root, (d) => d.children)
      .sum((d) => (d.children && d.children.length > 0 ? 0 : d.size))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    treemap<Node>()
      .size([size.w, size.h])
      .paddingInner(PADDING)
      .tile(treemapSquarify)(h);

    const out: LaidOutRect[] = [];
    h.each((n) => {
      const r = n as HierarchyRectangularNode<Node>;
      if (!n.children && r.x1 - r.x0 >= MIN_DRAW_PX && r.y1 - r.y0 >= MIN_DRAW_PX) {
        out.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, node: r });
      }
    });
    return out;
  }, [root, size]);

  const selectedKey = selected ? selected.relPath.join("/") : null;

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

    for (const r of rects) {
      ctx.fillStyle = colorFor(r.node.data.name, r.node.data.is_dir);
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      if (w > 6 && h > 6) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(r.x0, r.y0, w, 1);
        ctx.fillRect(r.x0, r.y0, 1, h);
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fillRect(r.x0, r.y1 - 1, w, 1);
        ctx.fillRect(r.x1 - 1, r.y0, 1, h);
      }
      if (selectedKey && pathKey(r.node) === selectedKey) {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x0 + 1, r.y0 + 1, w - 2, h - 2);
      }
    }
  }, [rects, size, selectedKey]);

  function rectAt(px: number, py: number): LaidOutRect | null {
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) return r;
    }
    return null;
  }

  function refOf(r: LaidOutRect): NodeRef {
    return { node: r.node.data, relPath: pathOf(r.node) };
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        onMouseMove={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const r = rectAt(x, y);
          setHover(r ? { x: e.clientX, y: e.clientY, rect: r } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const r = rectAt(e.clientX - rect.left, e.clientY - rect.top);
          if (!r) return;
          onSelect(refOf(r));
        }}
        onDoubleClick={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const r = rectAt(e.clientX - rect.left, e.clientY - rect.top);
          if (!r) return;
          const p = pathOf(r.node);
          if (r.node.data.is_dir) onDrillDown(p);
          else if (p.length > 0) onDrillDown(p.slice(0, -1));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const rect = canvasRef.current!.getBoundingClientRect();
          const r = rectAt(e.clientX - rect.left, e.clientY - rect.top);
          if (!r) return;
          const ref = refOf(r);
          onSelect(ref);
          onContext(ref, e.clientX, e.clientY);
        }}
      />
      {hover && (
        <div
          className="pointer-events-none fixed z-10 rounded border border-zinc-700 bg-zinc-900/95 px-2 py-1 text-xs shadow-lg"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-mono">{hover.rect.node.data.name}</div>
          <div className="text-zinc-400">{formatBytes(hover.rect.node.data.size)}</div>
          <div className="text-zinc-500">{pathOf(hover.rect.node).join(" / ")}</div>
        </div>
      )}
    </div>
  );
}

function pathOf(n: HierarchyRectangularNode<Node>): string[] {
  const parts: string[] = [];
  let cur: HierarchyRectangularNode<Node> | null = n;
  while (cur && cur.parent) {
    parts.unshift(cur.data.name);
    cur = cur.parent as HierarchyRectangularNode<Node> | null;
  }
  return parts;
}

function pathKey(n: HierarchyRectangularNode<Node>): string {
  return pathOf(n).join("/");
}
