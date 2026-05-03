export interface Node {
  name: string;
  size: number;
  is_dir: boolean;
  children: Node[];
}

export interface ScanResult {
  path: string;
  root: Node;
  file_count: number;
  dir_count: number;
  elapsed_ms: number;
}
