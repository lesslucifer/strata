export interface ScanSummary {
  path: string;
  root_name: string;
  root_size: number;
  file_count: number;
  dir_count: number;
  elapsed_ms: number;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  current_path: string;
}

export type RectKind = "file" | "dir" | "other";

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
}

export interface NodeMeta {
  name: string;
  size: number;
  is_dir: boolean;
  modified_ms: number | null;
  child_count: number;
  deleted: boolean;
}

export interface ChildEntry {
  name: string;
  size: number;
  is_dir: boolean;
  has_children: boolean;
}

export interface TypeStat {
  ext: string;
  size: number;
  count: number;
}
