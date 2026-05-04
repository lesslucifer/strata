import { CATEGORIES } from "./colors";

interface Segment {
  color: string;
  bytes: number;
}

interface Props {
  /// Per-segment byte share to color cells proportionally. If null or all
  /// zero, a representative slice of the category palette is used instead.
  segments?: Segment[] | null;
  totalBytes?: number;
}

// Static placeholder rectangles shown when there's no real treemap to draw
// yet — used during the post-walk phases of a scan and during the first
// compute_layout call. Animated with a shimmer so it doesn't look frozen.
export function SkeletonTreemap({ segments, totalBytes }: Props) {
  const cells: Array<{ x: number; y: number; w: number; h: number }> = [
    { x: 0, y: 0, w: 58, h: 62 },
    { x: 58, y: 0, w: 42, h: 32 },
    { x: 0, y: 62, w: 30, h: 38 },
    { x: 58, y: 32, w: 26, h: 30 },
    { x: 58, y: 62, w: 22, h: 38 },
    { x: 30, y: 62, w: 28, h: 22 },
    { x: 84, y: 32, w: 16, h: 30 },
    { x: 30, y: 84, w: 28, h: 16 },
    { x: 80, y: 62, w: 20, h: 22 },
    { x: 80, y: 84, w: 20, h: 16 },
  ];
  const colors = pickColors(segments ?? null, totalBytes ?? 0, cells.length);
  return (
    <div className="pointer-events-none absolute inset-0 animate-pulse">
      {cells.map((c, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: `${c.x}%`,
            top: `${c.y}%`,
            width: `${c.w}%`,
            height: `${c.h}%`,
            outline: "1px solid rgb(20, 20, 22)",
            background: colors[i],
          }}
        />
      ))}
    </div>
  );
}

// Indices into CATEGORIES that look pleasing together when we have no real
// data — diverse hues, dominant categories first.
const FALLBACK_ORDER = [3, 1, 0, 6, 5, 4, 7, 2, 8, 10];

function pickColors(
  segments: Segment[] | null,
  totalBytes: number,
  cellCount: number,
): string[] {
  if (segments && totalBytes > 0) {
    const sorted = segments.filter((s) => s.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    if (sorted.length > 0) {
      const out: string[] = [];
      for (const s of sorted) {
        const slots = Math.max(1, Math.round((s.bytes / totalBytes) * cellCount));
        for (let i = 0; i < slots && out.length < cellCount; i++) {
          out.push(s.color);
        }
        if (out.length >= cellCount) break;
      }
      while (out.length < cellCount) out.push(sorted[0].color);
      return out;
    }
  }
  // No data — use a stable pleasing slice of the category palette.
  return Array.from({ length: cellCount }, (_, i) => {
    const idx = FALLBACK_ORDER[i % FALLBACK_ORDER.length];
    return CATEGORIES[idx]?.color ?? "hsl(220, 8%, 28%)";
  });
}
