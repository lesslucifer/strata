// Stable HSL color per file extension. Same ext → same color across renders.
const PALETTE_SIZE = 24;

const SPECIAL: Record<string, string> = {
  __dir__: "hsl(220, 12%, 28%)",
  __unknown__: "hsl(0, 0%, 35%)",
};

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

export function colorFor(name: string, isDir: boolean): string {
  if (isDir) return SPECIAL.__dir__;
  const ext = extOf(name);
  if (!ext) return SPECIAL.__unknown__;
  const bucket = hashStr(ext) % PALETTE_SIZE;
  const hue = Math.round((bucket * 360) / PALETTE_SIZE);
  return `hsl(${hue}, 55%, 48%)`;
}
