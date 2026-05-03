// Color strategy: well-known extensions get a semantic family color (images=warm,
// code=cool, archives=red, etc.). Everything else is hashed into a wider 64-hue
// palette so collisions are rare. Same extension → same color across renders.

const FALLBACK_PALETTE_SIZE = 64;

export interface Category {
  id: string;
  label: string;
  color: string;
  exts: string[];
}

// Order matters only for the legend; lookup is via the map below.
export const CATEGORIES: Category[] = [
  {
    id: "image",
    label: "Images",
    color: "hsl(28, 75%, 55%)", // warm orange
    exts: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "ico", "svg", "heic", "heif", "avif", "raw", "psd"],
  },
  {
    id: "video",
    label: "Video",
    color: "hsl(345, 65%, 55%)", // pink-red
    exts: ["mp4", "mov", "mkv", "avi", "webm", "flv", "wmv", "m4v", "mpg", "mpeg", "3gp"],
  },
  {
    id: "audio",
    label: "Audio",
    color: "hsl(280, 55%, 60%)", // purple
    exts: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff"],
  },
  {
    id: "code",
    label: "Code",
    color: "hsl(210, 70%, 55%)", // bright blue
    exts: [
      "ts", "tsx", "js", "jsx", "mjs", "cjs",
      "rs", "go", "py", "rb", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
      "cs", "php", "lua", "sh", "bash", "zsh", "fish", "ps1",
      "scala", "clj", "ex", "exs", "erl", "hs", "ml", "fs",
      "vue", "svelte", "astro",
    ],
  },
  {
    id: "markup",
    label: "Markup / styles",
    color: "hsl(190, 60%, 50%)", // teal-cyan
    exts: ["html", "htm", "xml", "css", "scss", "sass", "less", "styl"],
  },
  {
    id: "data",
    label: "Data / config",
    color: "hsl(160, 50%, 45%)", // green-teal
    exts: ["json", "yaml", "yml", "toml", "ini", "env", "conf", "cfg", "csv", "tsv", "ndjson", "parquet", "avro"],
  },
  {
    id: "doc",
    label: "Documents",
    color: "hsl(45, 70%, 55%)", // gold
    exts: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "rst", "tex", "epub", "mobi", "pages", "key", "ppt", "pptx", "xls", "xlsx", "ods", "numbers"],
  },
  {
    id: "archive",
    label: "Archives",
    color: "hsl(0, 65%, 50%)", // red
    exts: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst", "lz", "lzma", "iso", "dmg", "pkg"],
  },
  {
    id: "binary",
    label: "Binaries",
    color: "hsl(240, 25%, 50%)", // muted indigo
    exts: ["exe", "dll", "so", "dylib", "a", "lib", "o", "obj", "class", "jar", "wasm", "app", "bin"],
  },
  {
    id: "lockfile",
    label: "Lockfiles / deps",
    color: "hsl(85, 35%, 45%)", // olive
    exts: ["lock", "lockfile", "sum"],
  },
  {
    id: "font",
    label: "Fonts",
    color: "hsl(310, 40%, 55%)", // magenta
    exts: ["ttf", "otf", "woff", "woff2", "eot"],
  },
];

const EXT_TO_CATEGORY: Map<string, Category> = (() => {
  const m = new Map<string, Category>();
  for (const c of CATEGORIES) {
    for (const ext of c.exts) m.set(ext, c);
  }
  return m;
})();

const SPECIAL = {
  dir: "hsl(220, 12%, 28%)",
  unknown: "hsl(0, 0%, 35%)",
};

export const LEGEND_SPECIALS = [
  { id: "__dir__", label: "Folders", color: SPECIAL.dir },
  { id: "__other__", label: "Other / unknown", color: SPECIAL.unknown },
];

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

export function categoryFor(name: string, isDir: boolean): Category | null {
  if (isDir) return null;
  const ext = extOf(name);
  if (!ext) return null;
  return EXT_TO_CATEGORY.get(ext) ?? null;
}

export function colorFor(name: string, isDir: boolean): string {
  if (isDir) return SPECIAL.dir;
  const ext = extOf(name);
  if (!ext) return SPECIAL.unknown;
  const cat = EXT_TO_CATEGORY.get(ext);
  if (cat) return cat.color;
  // Fallback: stable hue from hash, wider palette to reduce collisions.
  const bucket = hashStr(ext) % FALLBACK_PALETTE_SIZE;
  const hue = Math.round((bucket * 360) / FALLBACK_PALETTE_SIZE);
  return `hsl(${hue}, 55%, 48%)`;
}
