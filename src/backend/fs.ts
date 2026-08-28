import { gitBadgeColor, type ThemeName } from "../theme/tokens";
import { fsMock } from "./fsMock";

export type GitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "conflicted";

export type FileKind =
  | "text"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "document"
  | "archive"
  | "binary";

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
  git: GitStatus | null;
  gitFromChildren: boolean;
}

export interface FsListing {
  dir: string;
  parent: string | null;
  entries: FsEntry[];
  repoRoot: string | null;
  branch: string | null;
}

export interface CertInfo {
  kind: "certificate" | "csr";
  subjectCn: string;
  subject: string;
  issuer: string;
  sans: string[];
  /** Unix seconds; 0 for CSRs, which carry no validity window. */
  notBefore: number;
  notAfter: number;
  serial: string;
  sigAlg: string;
  keyAlg: string;
  sha256: string;
  isCa: boolean;
}

export interface ExecArch {
  /** CPU name: "arm64", "x86_64", "arm64e", ... */
  arch: string;
  /** Address width in bits. */
  bits: number;
  /** The file's role where the format states one; absent otherwise. */
  fileType: string | null;
}

/** Structured deep-dive into a file the plain reader can't show. */
export type Inspection =
  | { type: "certificates"; items: CertInfo[]; privateKey: string | null }
  | {
      type: "archive";
      entries: { path: string; size: number; dir: boolean }[];
      total: number;
      truncated: boolean;
    }
  | { type: "plist"; text: string }
  | {
      type: "sqlite";
      tables: { name: string; rows: number; columns: string[] }[];
    }
  | {
      type: "font";
      family: string;
      style: string;
      glyphCount: number;
      variable: boolean;
    }
  | { type: "image"; width: number; height: number }
  | {
      type: "executable";
      format: "mach-o" | "elf" | "pe" | "script";
      archs: ExecArch[];
      interpreter: string | null;
      executableBit: boolean;
      /** Mach-O: an LC_CODE_SIGNATURE segment exists (fact, not verdict). */
      hasCodeSignature: boolean | null;
      hasEntryPoint: boolean | null;
      dylibCount: number | null;
      dylibs: string[] | null;
    }
  | { type: "unsupported" };

export interface FileMeta {
  path: string;
  name: string;
  size: number;
  kind: FileKind;
  mime: string;
  text: string | null;
  truncated: boolean;
  /** Set when writing back would destroy data we never read. */
  readOnlyReason: string | null;
  headText: string | null;
  git: GitStatus | null;
  /** Seconds since the epoch. A restored draft compares against this: an
   *  unchanged mtime means the file is untouched and the draft may come
   *  back, a changed one means someone else edited it since. */
  modified: number | null;
}


/** One content match: 1-based line/col so a hit hands straight to "open at line". */
export interface SearchHit {
  rel: string;
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface GrepOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeHidden: boolean;
  include: string | null;
  /** Matching files are skipped — by search AND replace alike. */
  exclude: string | null;
}

export interface GrepResult {
  hits: SearchHit[];
  filesMatched: number;
  filesScanned: number;
  /** The cap was reached and results are missing. Never silent. */
  truncated: boolean;
}


export interface PreviewLine {
  /** 1-based. */
  line: number;
  text: string;
}

export interface PreviewSite {
  /** 1-based. */
  line: number;
  /** 1-based start of the matched span, in chars. */
  col: number;
  beforeLen: number;
  afterLen: number;
  /** The hit line plus one neighbor each side, where they exist. */
  context: PreviewLine[];
}

export interface PreviewFile {
  rel: string;
  path: string;
  /** Whole seconds; the execution rechecks it. */
  modified: number | null;
  /** The whole current text — the diff's original side. */
  before: string;
  sites: PreviewSite[];
}

export interface ReplacePreview {
  files: PreviewFile[];
  replacements: number;
  filesMatched: number;
}

/** What the execution step was told by the preview: stamps to recheck and
 *  sites to leave alone (the unchecked boxes). */
export interface ReplaceStamp {
  path: string;
  modified: number | null;
}

export interface SkipSite {
  rel: string;
  line: number;
  col: number;
}

export interface ReplacePlan {
  stamps: ReplaceStamp[] | null;
  skip: SkipSite[] | null;
}

export interface ReplaceResult {
  filesChanged: number;
  replacements: number;
  /** Files whose write failed — reported, never swallowed. */
  failed: { rel: string; error: string }[];
}

export interface WalkResult {
  paths: string[];
  truncated: boolean;
}

/** The fs_walk cap, mirrored from the command layer (src-tauri) so the
 *  panel can name the number when it says "there are more". */
export const WALK_CAP = 5000;


/** The section's two leaves, as config_get answers them (snake_case, the
 *  file's own spelling — the values object serializes the Rust struct
 *  verbatim). Both missing = the defaults: no user globs, no gitignore. */
export interface FilesWalkConfig {
  exclude: string[];
  respect_gitignore: boolean;
}

const DEFAULT_FILES_CONFIG: FilesWalkConfig = {
  exclude: [],
  respect_gitignore: false,
};

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// The API modules resolve once and are memoized: ESM already caches them,
// so this only skips the repeated dynamic-import lookups — every fsApi
// call used to pay one, and a files tab's mount path (session load, root
// listing, the watcher arming) makes a dozen of them in one burst.
let coreModule: Promise<typeof import("@tauri-apps/api/core")> | null = null;
function core() {
  if (!coreModule) coreModule = import("@tauri-apps/api/core");
  return coreModule;
}

let eventModule: Promise<typeof import("@tauri-apps/api/event")> | null = null;
function events() {
  if (!eventModule) eventModule = import("@tauri-apps/api/event");
  return eventModule;
}

const tauriFs = {
  available: true,

  async list(dir: string): Promise<FsListing> {
    const { invoke } = await core();
    return invoke<FsListing>("fs_list", { dir });
  },

  async read(path: string): Promise<FileMeta> {
    const { invoke } = await core();
    return invoke<FileMeta>("fs_read", { path });
  },

  /** Parses archives, certificates and plists into structured data. */
  async inspect(path: string): Promise<Inspection> {
    const { invoke } = await core();
    return invoke<Inspection>("fs_inspect", { path });
  },

  /**
   * One window of raw bytes, for viewers that must never load a whole file
   * (log tail, hex dump). The server caps len at 1 MiB; total is the file
   * size at read time, so callers can notice growth.
   */
  async readRange(
    path: string,
    offset: number,
    len: number
  ): Promise<{ b64: string; total: number }> {
    const { invoke } = await core();
    return invoke("fs_read_range", { path, offset, len });
  },

  /** One page of a SQLite table, read-only. BLOBs arrive as placeholders. */
  async sqliteRows(
    path: string,
    table: string,
    limit: number,
    offset: number
  ): Promise<{ columns: string[]; rows: string[][]; total: number }> {
    const { invoke } = await core();
    return invoke("fs_sqlite_rows", { path, table, limit, offset });
  },

  async write(path: string, content: string): Promise<void> {
    const { invoke } = await core();
    await invoke("fs_write", { path, content });
  },

  async reveal(path: string): Promise<void> {
    const { invoke } = await core();
    await invoke("fs_reveal", { path });
  },

  async walk(
    dir: string,
    includeHidden: boolean,
    name?: string
  ): Promise<WalkResult> {
    const { invoke } = await core();
    return invoke<WalkResult>("fs_walk", {
      dir,
      includeHidden,
      name: name ?? null,
    });
  },

  async grep(
    root: string,
    query: string,
    options: GrepOptions,
    maxHits: number
  ): Promise<GrepResult> {
    const { invoke } = await core();
    return invoke<GrepResult>("fs_grep", { root, query, options, maxHits });
  },

  async replace(
    root: string,
    query: string,
    replacement: string,
    options: GrepOptions,
    only: string[] | null,
    plan?: ReplacePlan | null
  ): Promise<ReplaceResult> {
    const { invoke } = await core();
    return invoke("fs_replace", {
      root,
      query,
      replacement,
      options,
      only,
      plan: plan ?? null,
    });
  },

  async replacePreview(
    root: string,
    query: string,
    replacement: string,
    options: GrepOptions,
    only: string[] | null
  ): Promise<ReplacePreview> {
    const { invoke } = await core();
    return invoke("fs_replace_preview", {
      root,
      query,
      replacement,
      options,
      only,
    });
  },

  async create(path: string, dir: boolean): Promise<void> {    const { invoke } = await core();
    await invoke("fs_create", { path, dir });
  },

  async rename(from: string, to: string): Promise<void> {
    const { invoke } = await core();
    await invoke("fs_rename", { from, to });
  },

  async transfer(
    from: string,
    intoDir: string,
    cut: boolean,
    overwrite = false
  ): Promise<string> {
    const { invoke } = await core();
    return await invoke<string>("fs_transfer", { from, intoDir, cut, overwrite });
  },

  /** System trash, never a hard delete. */
  async trash(path: string): Promise<void> {
    const { invoke } = await core();
    await invoke("fs_trash", { path });
  },

  async compress(
    entries: string[],
    destDir: string,
    format: "zip" | "tgz"
  ): Promise<string> {
    const { invoke } = await core();
    return await invoke<string>("fs_archive_create", { entries, dest: destDir, format });
  },

  async extract(
    archive: string,
    destDir: string
  ): Promise<{ dir: string; files: string[] }> {
    const { invoke } = await core();
    return await invoke<{ dir: string; files: string[] }>("fs_archive_extract", {
      archive,
      destDir,
    });
  },

  async clipboardWriteFiles(paths: string[]): Promise<void> {
    const { invoke } = await core();
    await invoke("clipboard_write_files", { paths });
  },

  async home(): Promise<string> {
    const { invoke } = await core();
    return invoke<string>("home_dir");
  },

  async watchTab(tabId: string, root: string): Promise<void> {
    const { invoke } = await core();
    await invoke("fs_watch_start", { tabId, root });
  },

  /** Release the tab's watcher — closed or dormant, no tree to refresh. */
  async unwatchTab(tabId: string): Promise<void> {
    const { invoke } = await core();
    await invoke("fs_watch_stop", { tabId });
  },

  /** URL that streams a local file through the app's own protocol handler. */
  url(path: string): string {
    const encoded = path
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `tabverse-file://localhost${encoded.startsWith("/") ? "" : "/"}${encoded}`;
  },

  async filesConfig(): Promise<FilesWalkConfig> {
    const { invoke } = await core();
    const snap = await invoke<{
      values: { files?: Partial<FilesWalkConfig> };
    }>("config_get");
    return {
      exclude: snap.values.files?.exclude ?? [],
      respect_gitignore: snap.values.files?.respect_gitignore ?? false,
    };
  },

  async setFilesConfig(config: FilesWalkConfig): Promise<void> {
    const { invoke } = await core();
    await invoke("config_files_set", {
      exclude: config.exclude,
      respectGitignore: config.respect_gitignore,
    });
  },
};

/** Desktop: real filesystem. Browser: in-memory demo tree (same shapes). */
export const fsApi: typeof tauriFs = isTauri
  ? tauriFs
  : {
      available: true,
      ...fsMock,
      // The demo tree holds nothing an inspector could take apart.
      async inspect(): Promise<Inspection> {
        return { type: "unsupported" };
      },
      // The demo tree is read-only in this direction; saying so beats
      // pretending a paste happened.
      async transfer(): Promise<string> {
        throw new Error("no filesystem in the browser demo");
      },
      async compress(): Promise<string> {
        throw new Error("no filesystem in the browser demo");
      },
      async extract(): Promise<{ dir: string; files: string[] }> {
        throw new Error("no filesystem in the browser demo");
      },
      // No seekable byte store behind the demo tree, so windows come back
      // empty and the windowed viewers show their empty-file state.
      async readRange(): Promise<{ b64: string; total: number }> {
        return { b64: "", total: 0 };
      },
      // Unreachable in practice: the mock inspector never reports a SQLite
      // file, so no table is ever offered for paging.
      async sqliteRows(): Promise<{
        columns: string[];
        rows: string[][];
        total: number;
      }> {
        return { columns: [], rows: [], total: 0 };
      },
      // The demo tree's paths point at nothing on this machine: putting
      // them on the real system clipboard would hand other apps URLs to
      // files that do not exist. Accepted, and nothing is written.
      async clipboardWriteFiles(): Promise<void> {},
      // The demo has no config file behind it; the defaults ARE the demo
      // tree's behavior (built-ins only, gitignore off), so reading hands
      // those back rather than an error a panel would have to explain.
      async filesConfig(): Promise<FilesWalkConfig> {
        return { ...DEFAULT_FILES_CONFIG };
      },
      // Writing is refused outright — accepting it would flash a saved
      // state that nothing on this machine persists or applies.
      async setFilesConfig(): Promise<void> {
        throw new Error("no configuration file in the browser demo");
      },
    };

export function onFsChanged(handler: (tabId: string) => void): () => void {
  if (!isTauri) return () => {};
  let off: (() => void) | null = null;
  let closed = false;
  void events().then(({ listen }) =>
    listen<{ tabId: string }>("fs-changed", (e) => handler(e.payload.tabId)).then(
      (unlisten) => {
        // Unsubscribed before the subscription landed: close it now, or
        // the handler would stay registered with nobody left to remove it.
        if (closed) {
          unlisten();
          return;
        }
        off = unlisten;
      }
    )
  );
  return () => {
    closed = true;
    off?.();
    off = null;
  };
}

/** Human-readable size, matching Finder's decimal convention. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const GIT_BADGE_META: Record<GitStatus, { letter: string; label: string }> = {
  modified: { letter: "M", label: "modified" },
  added: { letter: "A", label: "added (staged)" },
  deleted: { letter: "D", label: "deleted" },
  renamed: { letter: "R", label: "renamed" },
  untracked: { letter: "U", label: "untracked" },
  ignored: { letter: "I", label: "ignored" },
  conflicted: { letter: "C", label: "conflicted" },
};

export function gitBadge(
  s: GitStatus,
  t: ThemeName
): { letter: string; color: string; label: string } {
  return { ...GIT_BADGE_META[s], color: gitBadgeColor(s, t) };
}
