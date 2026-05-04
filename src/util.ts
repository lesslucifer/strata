const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${UNITS[i]}`;
}

export function joinPath(base: string, segments: string[]): string {
  if (segments.length === 0) return base;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const trimmed = base.endsWith(sep) ? base.slice(0, -1) : base;
  return trimmed + sep + segments.join(sep);
}

/// Shorten a path like "/a/b/c/d/e/f.txt" into "/a/.../f.txt" once it has more
/// than `keep` segments. Keeps the very first and very last segments intact.
export function truncatePath(path: string, keep: number = 3): string {
  if (!path) return "";
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const leading = path.startsWith(sep) ? sep : "";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= keep) return path;
  return `${leading}${parts[0]}${sep}…${sep}${parts[parts.length - 1]}`;
}

export function formatDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes} min ${remSeconds} s`;
}
