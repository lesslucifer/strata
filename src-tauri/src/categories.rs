// File-type categories used by the live type-mix bar during scan.
// Keep in sync with src/colors.ts CATEGORIES — the IDs and ext lists must
// match so the frontend can color the bar segments using its existing palette.

#[allow(dead_code)]
pub const CATEGORY_IDS: &[&str] = &[
    "image",
    "video",
    "audio",
    "code",
    "markup",
    "data",
    "doc",
    "archive",
    "binary",
    "lockfile",
    "font",
];

pub const NUM_CATEGORIES: usize = 11;
/// Index into the per-progress `category_bytes` array reserved for files
/// that don't match any known category (and for files with no extension).
pub const OTHER_INDEX: usize = NUM_CATEGORIES;
pub const SLOT_COUNT: usize = NUM_CATEGORIES + 1;

const EXTS: &[(&str, usize)] = &[
    // image (0)
    ("jpg", 0), ("jpeg", 0), ("png", 0), ("gif", 0), ("webp", 0),
    ("bmp", 0), ("tiff", 0), ("tif", 0), ("ico", 0), ("svg", 0),
    ("heic", 0), ("heif", 0), ("avif", 0), ("raw", 0), ("psd", 0),
    // video (1)
    ("mp4", 1), ("mov", 1), ("mkv", 1), ("avi", 1), ("webm", 1),
    ("flv", 1), ("wmv", 1), ("m4v", 1), ("mpg", 1), ("mpeg", 1), ("3gp", 1),
    // audio (2)
    ("mp3", 2), ("wav", 2), ("flac", 2), ("aac", 2), ("ogg", 2),
    ("m4a", 2), ("wma", 2), ("opus", 2), ("aiff", 2),
    // code (3)
    ("ts", 3), ("tsx", 3), ("js", 3), ("jsx", 3), ("mjs", 3), ("cjs", 3),
    ("rs", 3), ("go", 3), ("py", 3), ("rb", 3), ("java", 3), ("kt", 3),
    ("swift", 3), ("c", 3), ("cc", 3), ("cpp", 3), ("h", 3), ("hpp", 3),
    ("cs", 3), ("php", 3), ("lua", 3), ("sh", 3), ("bash", 3), ("zsh", 3),
    ("fish", 3), ("ps1", 3), ("scala", 3), ("clj", 3), ("ex", 3), ("exs", 3),
    ("erl", 3), ("hs", 3), ("ml", 3), ("fs", 3),
    ("vue", 3), ("svelte", 3), ("astro", 3),
    // markup (4)
    ("html", 4), ("htm", 4), ("xml", 4), ("css", 4), ("scss", 4),
    ("sass", 4), ("less", 4), ("styl", 4),
    // data (5)
    ("json", 5), ("yaml", 5), ("yml", 5), ("toml", 5), ("ini", 5),
    ("env", 5), ("conf", 5), ("cfg", 5), ("csv", 5), ("tsv", 5),
    ("ndjson", 5), ("parquet", 5), ("avro", 5),
    // doc (6)
    ("pdf", 6), ("doc", 6), ("docx", 6), ("odt", 6), ("rtf", 6),
    ("txt", 6), ("md", 6), ("markdown", 6), ("rst", 6), ("tex", 6),
    ("epub", 6), ("mobi", 6), ("pages", 6), ("key", 6), ("ppt", 6),
    ("pptx", 6), ("xls", 6), ("xlsx", 6), ("ods", 6), ("numbers", 6),
    // archive (7)
    ("zip", 7), ("tar", 7), ("gz", 7), ("tgz", 7), ("bz2", 7),
    ("xz", 7), ("7z", 7), ("rar", 7), ("zst", 7), ("lz", 7),
    ("lzma", 7), ("iso", 7), ("dmg", 7), ("pkg", 7),
    // binary (8)
    ("exe", 8), ("dll", 8), ("so", 8), ("dylib", 8), ("a", 8),
    ("lib", 8), ("o", 8), ("obj", 8), ("class", 8), ("jar", 8),
    ("wasm", 8), ("app", 8), ("bin", 8),
    // lockfile (9)
    ("lock", 9), ("lockfile", 9), ("sum", 9),
    // font (10)
    ("ttf", 10), ("otf", 10), ("woff", 10), ("woff2", 10), ("eot", 10),
];

/// Returns the category slot for a file path. Mirrors the JS `extOf` rules:
/// no extension or hidden-file (".gitignore", "foo.") → OTHER_INDEX.
/// Hot path during scan — keep allocation-free.
pub fn slot_for_name(name: &str) -> usize {
    let Some(idx) = name.rfind('.') else {
        return OTHER_INDEX;
    };
    if idx == 0 || idx == name.len() - 1 {
        return OTHER_INDEX;
    }
    let raw = &name[idx + 1..];
    // ASCII-lowercase comparison without allocating: most extensions are
    // already lowercase, so `eq_ignore_ascii_case` is cheap.
    for (ext, slot) in EXTS {
        if raw.eq_ignore_ascii_case(ext) {
            return *slot;
        }
    }
    OTHER_INDEX
}
