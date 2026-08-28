export type FileGitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "conflicted";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
  git: FileGitStatus | null;
  gitFromChildren: boolean;
}

export interface FileListing {
  dir: string;
  parent: string | null;
  entries: FileEntry[];
  repoRoot: string | null;
  branch: string | null;
}
