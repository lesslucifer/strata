export interface Node {
  name: string;
  size: number;
  is_dir: boolean;
  modified_ms: number | null;
  children: Node[];
}

export interface ScanResult {
  path: string;
  root: Node;
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
