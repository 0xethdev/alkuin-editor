export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_markdown: boolean;
  modified_at: number;
  /** Creation time in seconds; falls back to `modified_at` where the filesystem has none. */
  created_at: number;
  title: string | null;
}

export interface FileContent {
  path: string;
  content: string;
  modified_at: number;
}

export interface WriteResult {
  path: string;
  modified_at: number;
  /** The save found the file changed on disk. That version is in this file, beside it.
   *  The newest one, when the file changed again while it was copied. */
  other_copy?: string;
  /** Every copy this save made, oldest first. */
  other_copies?: string[];
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  file_count: number;
  epoch: number;
}

export interface SearchResult {
  path: string;
  filename: string;
  relative_path: string;
  score: number;
  match_indices: number[];
}

export interface ContentSearchResult {
  path: string;
  line_number: number;
  line_content: string;
  match_ranges: [number, number][];
}

export interface IndexStats {
  file_count: number;
  duration_ms: number;
}
