export interface ScanSummary {
  path: string;
  root_name: string;
  root_size: number;
  file_count: number;
  dir_count: number;
  elapsed_ms: number;
}

export type ScanPhase = "walking" | "building" | "indexing";

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  current_path: string;
  phase: ScanPhase;
  /// Per-category accumulated bytes; slot order matches CATEGORIES in
  /// colors.ts, with a trailing "other / unknown" bucket.
  category_bytes: number[];
}

export type RectKind = "file" | "dir" | "other" | "group";

export interface RenderRect {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  size: number;
  kind: RectKind;
  rel_path: string[];
  other_count: number;
  deleted: boolean;
  /// For "group" rects, the recursive file count of the grouped folder.
  total_files: number;
  /// For "group" rects, the matching category id (e.g. "code_packages").
  group_category: string;
}

export interface NodeMeta {
  name: string;
  size: number;
  is_dir: boolean;
  modified_ms: number | null;
  child_count: number;
  deleted: boolean;
  total_files: number;
  grouped: boolean;
  group_category: string;
}

export type GroupMatchKind = "name" | "dir_ext" | "name_under";

export interface GroupRule {
  kind: GroupMatchKind;
  pattern: string;
  under: string[];
}

export interface GroupCategory {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  rules: GroupRule[];
}

export interface GroupSettings {
  categories: GroupCategory[];
  custom_rules: GroupRule[];
  excluded_paths: string[];
  forced_paths: string[];
}

export interface ChildEntry {
  name: string;
  size: number;
  is_dir: boolean;
  has_children: boolean;
  deleted: boolean;
  grouped: boolean;
}

export interface TypeStat {
  ext: string;
  size: number;
  count: number;
}
