use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

mod compress;
mod inspect;
pub mod search;
pub use compress::{ExtractOutcome, MAX_EXTRACT_BYTES, MAX_EXTRACT_ENTRIES};
pub use inspect::{
    ArchiveEntry, CertInfo, ExecArch, Inspection, SqliteRows, SqliteTable, MAX_ARCHIVE_ENTRIES,
};
pub mod session_migration;
pub mod state;

/// Change kind for one path, mapped from git's status flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitStatus {
    /// Staged or unstaged content change.
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflicted,
}

impl GitStatus {
    /// Which status wins when a directory aggregates its children.
    fn severity(self) -> u8 {
        match self {
            GitStatus::Conflicted => 6,
            GitStatus::Deleted => 5,
            GitStatus::Renamed => 4,
            GitStatus::Modified => 3,
            GitStatus::Added => 2,
            GitStatus::Untracked => 1,
            GitStatus::Ignored => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Seconds since the Unix epoch; None when unavailable.
    pub modified: Option<u64>,
    /// Own status for files; aggregated worst-of-descendants for directories.
    pub git: Option<GitStatus>,
    /// True when a directory's status came from its children rather than itself.
    pub git_from_children: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub dir: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    /// Repo root, when the directory is inside a git work tree.
    pub repo_root: Option<String>,
    pub branch: Option<String>,
}

/// Per-repo status cache: statusing a large repo takes tens of milliseconds,
/// and one expand click must not pay for it repeatedly.
struct RepoStatus {
    /// Absolute path -> status, for files only.
    files: HashMap<PathBuf, GitStatus>,
    branch: Option<String>,
    taken: Instant,
}

#[derive(Default)]
pub struct FsBackend {
    cache: Mutex<HashMap<PathBuf, RepoStatus>>,
}

const STATUS_TTL: Duration = Duration::from_secs(2);

fn map_status(s: git2::Status) -> Option<GitStatus> {
    use git2::Status as S;
    if s.is_conflicted() {
        return Some(GitStatus::Conflicted);
    }
    if s.intersects(S::INDEX_DELETED | S::WT_DELETED) {
        return Some(GitStatus::Deleted);
    }
    if s.intersects(S::INDEX_RENAMED | S::WT_RENAMED) {
        return Some(GitStatus::Renamed);
    }
    if s.intersects(S::INDEX_MODIFIED | S::WT_MODIFIED | S::INDEX_TYPECHANGE | S::WT_TYPECHANGE) {
        return Some(GitStatus::Modified);
    }
    if s.contains(S::INDEX_NEW) {
        return Some(GitStatus::Added);
    }
    if s.contains(S::WT_NEW) {
        return Some(GitStatus::Untracked);
    }
    if s.is_ignored() {
        return Some(GitStatus::Ignored);
    }
    None
}

impl FsBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn repo_status(
        &self,
        dir: &Path,
    ) -> Option<(PathBuf, Option<String>, HashMap<PathBuf, GitStatus>)> {
        let repo = git2::Repository::discover(dir).ok()?;
        let workdir = canonical_dir(repo.workdir()?);

        {
            let cache = self.cache.lock().unwrap();
            if let Some(entry) = cache.get(&workdir) {
                if entry.taken.elapsed() < STATUS_TTL {
                    return Some((workdir, entry.branch.clone(), entry.files.clone()));
                }
            }
        }

        let branch = repo
            .head()
            .ok()
            .and_then(|h| {
                if h.is_branch() {
                    h.shorthand().ok().map(|s| s.to_string())
                } else {
                    // Detached HEAD: show the short commit instead of nothing.
                    h.target().map(|oid| format!("{:.7}", oid))
                }
            })
            .or_else(|| Some("(unborn)".to_string()));

        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);
        let statuses = repo.statuses(Some(&mut opts)).ok()?;

        let mut files = HashMap::new();
        for st in statuses.iter() {
            let Ok(rel) = st.path() else { continue };
            if let Some(mapped) = map_status(st.status()) {
                files.insert(workdir.join(rel), mapped);
            }
        }

        self.cache.lock().unwrap().insert(
            workdir.clone(),
            RepoStatus {
                files: files.clone(),
                branch: branch.clone(),
                taken: Instant::now(),
            },
        );
        Some((workdir, branch, files))
    }

    /// Worst status among files under `dir` (recursive), from the status map.
    fn dir_status(dir: &Path, files: &HashMap<PathBuf, GitStatus>) -> Option<GitStatus> {
        let mut worst: Option<GitStatus> = None;
        for (path, st) in files {
            if path.starts_with(dir) && worst.is_none_or(|w| st.severity() > w.severity()) {
                worst = Some(*st);
            }
        }
        worst
    }

    pub fn list_dir(&self, dir: &str) -> Result<Listing> {
        // Canonicalize the *directory* (not its entries): git reports paths
        // through resolved symlinks, and on macOS common roots are symlinks
        // (/tmp -> /private/tmp), so uncanonicalized keys never match and every
        // file would look clean. Entry symlinks stay unresolved on purpose.
        let dir_path = canonical_dir(&expand_path(dir));
        let meta = std::fs::metadata(&dir_path)
            .with_context(|| format!("cannot stat {}", dir_path.display()))?;
        if !meta.is_dir() {
            return Err(anyhow!("{} is not a directory", dir_path.display()));
        }

        let git = self.repo_status(&dir_path);
        let (repo_root, branch, files) = match &git {
            Some((root, branch, files)) => (Some(root.clone()), branch.clone(), Some(files)),
            None => (None, None, None),
        };

        let mut entries = Vec::new();
        for dent in std::fs::read_dir(&dir_path)
            .with_context(|| format!("cannot read {}", dir_path.display()))?
        {
            let Ok(dent) = dent else { continue };
            let path = dent.path();
            let name = dent.file_name().to_string_lossy().to_string();
            // Dotfiles stay visible — people edit them. These two are pure
            // noise: the git object store and Finder's metadata turds.
            if name == ".git" || name == ".DS_Store" {
                continue;
            }
            // Symlink-aware: don't follow, a broken link must still list.
            let lmeta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_symlink = lmeta.file_type().is_symlink();
            let target_meta = if is_symlink {
                std::fs::metadata(&path).ok()
            } else {
                Some(lmeta.clone())
            };
            let is_dir = target_meta.as_ref().is_some_and(|m| m.is_dir());
            let size = target_meta.as_ref().map_or(0, |m| m.len());
            let modified = target_meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());

            let (git_status, from_children) = match files {
                Some(files) => {
                    if is_dir {
                        (Self::dir_status(&path, files), true)
                    } else {
                        (files.get(&path).copied(), false)
                    }
                }
                None => (None, false),
            };

            entries.push(Entry {
                name,
                path: ui_path(&path),
                is_dir,
                is_symlink,
                size,
                modified,
                git: git_status,
                git_from_children: git_status.is_some() && from_children,
            });
        }

        // Finder-like ordering: directories first, then case-insensitive name.
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(Listing {
            dir: ui_path(&dir_path),
            parent: dir_path.parent().map(ui_path),
            entries,
            repo_root: repo_root.as_deref().map(ui_path),
            branch,
        })
    }

    /// The committed (HEAD) content of a file, for inline diffs.
    /// Returns None when the file is untracked or has no HEAD version.
    pub fn head_content(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let raw = expand_path(path);
        // Same symlink concern as list_dir, applied to the containing dir.
        let p = match (raw.parent(), raw.file_name()) {
            (Some(parent), Some(name)) => canonical_dir(parent).join(name),
            _ => raw,
        };
        let repo = match git2::Repository::discover(&p) {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        let workdir = canonical_dir(repo.workdir().ok_or_else(|| anyhow!("bare repo"))?);
        let rel = p
            .strip_prefix(&workdir)
            .map_err(|_| anyhow!("path outside repo"))?;
        let head = match repo.head() {
            Ok(h) => h,
            Err(_) => return Ok(None), // unborn branch
        };
        let tree = head.peel_to_tree()?;
        let entry = match tree.get_path(rel) {
            Ok(e) => e,
            Err(_) => return Ok(None), // untracked / newly added
        };
        let blob = repo.find_blob(entry.id())?;
        Ok(Some(blob.content().to_vec()))
    }
}

/// How a file should be presented, decided by extension plus content sniffing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Text,
    Image,
    Pdf,
    Audio,
    Video,
    /// Office/OpenDocument container we can convert for viewing.
    Document,
    Archive,
    Binary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: Option<u64>,
    pub kind: FileKind,
    pub mime: String,
    /// Text only: UTF-8 content, absent when truncated or non-text.
    pub text: Option<String>,
    /// True when the file was too large to load in full.
    pub truncated: bool,
    /// Why saving is refused, when it is. Writing back a partial read, or a
    /// lossy decode of non-UTF-8 bytes, destroys the parts we never had.
    pub read_only_reason: Option<String>,
    /// Text only: HEAD version, present when it differs from the working copy.
    pub head_text: Option<String>,
    pub git: Option<GitStatus>,
}

/// Text files above this are opened truncated: a webview editor becomes
/// unusable well before the read itself hurts.
pub const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

/// Hard server-side ceiling for one `read_range` window. The UI pages in far
/// smaller steps; this exists so no frontend bug can turn one IPC call into
/// a gigabyte allocation.
pub const MAX_RANGE_BYTES: u32 = 1024 * 1024;

/// One base64-encoded window of a file, plus the file's real size so the
/// viewer can lay out its scrollbar and clamp further requests.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRange {
    pub b64: String,
    pub total: u64,
}

pub fn kind_for(path: &Path, head: &[u8]) -> (FileKind, String) {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let by_ext: Option<(FileKind, &str)> = match ext.as_str() {
        "png" => Some((FileKind::Image, "image/png")),
        "jpg" | "jpeg" => Some((FileKind::Image, "image/jpeg")),
        "gif" => Some((FileKind::Image, "image/gif")),
        "webp" => Some((FileKind::Image, "image/webp")),
        "bmp" => Some((FileKind::Image, "image/bmp")),
        "ico" => Some((FileKind::Image, "image/x-icon")),
        "svg" => Some((FileKind::Image, "image/svg+xml")),
        "avif" => Some((FileKind::Image, "image/avif")),
        "heic" => Some((FileKind::Image, "image/heic")),
        "pdf" => Some((FileKind::Pdf, "application/pdf")),
        "mp3" => Some((FileKind::Audio, "audio/mpeg")),
        "wav" => Some((FileKind::Audio, "audio/wav")),
        "m4a" | "aac" => Some((FileKind::Audio, "audio/mp4")),
        "flac" => Some((FileKind::Audio, "audio/flac")),
        "ogg" | "opus" => Some((FileKind::Audio, "audio/ogg")),
        "mp4" | "m4v" => Some((FileKind::Video, "video/mp4")),
        "mov" => Some((FileKind::Video, "video/quicktime")),
        "webm" => Some((FileKind::Video, "video/webm")),
        "docx" => Some((
            FileKind::Document,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )),
        "xlsx" | "xlsm" => Some((
            FileKind::Document,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )),
        "pptx" => Some((
            FileKind::Document,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )),
        "doc" => Some((FileKind::Document, "application/msword")),
        "xls" => Some((FileKind::Document, "application/vnd.ms-excel")),
        "zip" => Some((FileKind::Archive, "application/zip")),
        "tar" => Some((FileKind::Archive, "application/x-tar")),
        "gz" | "tgz" => Some((FileKind::Archive, "application/gzip")),
        "bz2" | "xz" | "zst" | "7z" | "rar" => {
            Some((FileKind::Archive, "application/octet-stream"))
        }
        // Binary kinds the frontend routes to the inspection pane by mime, so
        // it never has to sniff bytes itself.
        "db" | "sqlite" | "sqlite3" | "db3" => Some((FileKind::Binary, "application/vnd.sqlite3")),
        "ttf" => Some((FileKind::Binary, "font/ttf")),
        "otf" => Some((FileKind::Binary, "font/otf")),
        "woff" => Some((FileKind::Binary, "font/woff")),
        "woff2" => Some((FileKind::Binary, "font/woff2")),
        _ => None,
    };
    if let Some((kind, mime)) = by_ext {
        return (kind, mime.to_string());
    }
    // SQLite databases often wear app-specific extensions (.vscdb, .anki2)
    // or none at all; the header magic identifies them regardless.
    if head.starts_with(inspect::SQLITE_MAGIC) {
        return (FileKind::Binary, "application/vnd.sqlite3".to_string());
    }
    match inspect::sniff_exec_format(head) {
        Some(inspect::ExecFormat::Macho | inspect::ExecFormat::Elf | inspect::ExecFormat::Pe) => {
            return (FileKind::Binary, "application/x-executable".to_string());
        }
        // A shebang script is still text — it opens in the editor; the mime
        // only tells the toolbar a "Details" card exists for it.
        Some(inspect::ExecFormat::Script) => {
            return (FileKind::Text, "text/x-shellscript".to_string());
        }
        None => {}
    }
    // No decisive extension: a NUL byte in the head means it isn't text.
    if head.contains(&0) {
        (FileKind::Binary, "application/octet-stream".to_string())
    } else {
        (FileKind::Text, "text/plain".to_string())
    }
}

impl FsBackend {
    /// Metadata plus content for text files, ready for the editor pane.
    pub fn read_file(&self, path: &str) -> Result<FileMeta> {
        let raw = expand_path(path);
        let p = match (raw.parent(), raw.file_name()) {
            (Some(parent), Some(name)) => canonical_dir(parent).join(name),
            _ => raw,
        };
        let meta = std::fs::metadata(&p).with_context(|| format!("cannot stat {}", p.display()))?;
        if meta.is_dir() {
            return Err(anyhow!("{} is a directory", p.display()));
        }
        let size = meta.len();

        let mut head = vec![0u8; 4096.min(size.max(1) as usize)];
        {
            use std::io::Read as _;
            let mut f = std::fs::File::open(&p)?;
            let n = f.read(&mut head).unwrap_or(0);
            head.truncate(n);
        }
        let (kind, mime) = kind_for(&p, &head);

        let mut truncated = false;
        let mut text = None;
        let mut read_only_reason = None;
        if kind == FileKind::Text {
            let to_read = size.min(MAX_TEXT_BYTES);
            truncated = size > MAX_TEXT_BYTES;
            let bytes = if truncated {
                use std::io::Read as _;
                let mut buf = vec![0u8; to_read as usize];
                let mut f = std::fs::File::open(&p)?;
                let n = f.read(&mut buf)?;
                buf.truncate(n);
                buf
            } else {
                std::fs::read(&p)?
            };
            // A lossy decode turns every undecodable byte into U+FFFD, and
            // saving that back would rewrite the file with the damage baked in.
            match String::from_utf8(bytes) {
                Ok(t) => text = Some(t),
                Err(e) => {
                    text = Some(String::from_utf8_lossy(e.as_bytes()).to_string());
                    read_only_reason = Some(
                        "this file is not valid UTF-8, so saving would replace \
                         the undecodable bytes"
                            .to_string(),
                    );
                }
            }
            if truncated && read_only_reason.is_none() {
                read_only_reason = Some(format!(
                    "only the first {} MB are loaded, so saving would discard the rest",
                    MAX_TEXT_BYTES / 1024 / 1024
                ));
            }
        }

        // Git status for this one file, reusing the repo-level cache.
        let git = p
            .parent()
            .and_then(|dir| self.repo_status(dir))
            .and_then(|(_, _, files)| files.get(&p).copied());

        // Only bother with the HEAD version when git says it changed.
        let head_text = match (kind, git) {
            (FileKind::Text, Some(GitStatus::Modified))
            | (FileKind::Text, Some(GitStatus::Renamed)) => self
                .head_content(p.to_str().unwrap_or_default())?
                .map(|b| String::from_utf8_lossy(&b).to_string()),
            _ => None,
        };

        // Deliberately from the stat taken BEFORE the content was read: if an
        // external edit lands in between, the stale timestamp makes the draft
        // conflict check fire (a false alarm at worst). Re-statting here would
        // pair the NEW timestamp with the OLD content, and a later draft save
        // would overwrite that external edit without a word.
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        Ok(FileMeta {
            path: ui_path(&p),
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            size,
            kind,
            mime,
            text,
            truncated,
            read_only_reason,
            head_text,
            git,
            modified,
        })
    }

    /// One window of raw bytes from a file, for viewers that page through
    /// content instead of loading it (log
    /// and hex views must open arbitrarily large files).
    ///
    /// `offset` past the end is not an error — the caller learns the real
    /// size from `total` and an empty window, which is exactly what a
    /// jump-to-tail needs. `len` is capped at MAX_RANGE_BYTES so a frontend
    /// bug can never demand the whole of a huge file in one call.
    pub fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<ReadRange> {
        let raw = expand_path(path);
        let p = match (raw.parent(), raw.file_name()) {
            (Some(parent), Some(name)) => canonical_dir(parent).join(name),
            _ => raw,
        };
        let meta = std::fs::metadata(&p).with_context(|| format!("cannot stat {}", p.display()))?;
        if meta.is_dir() {
            return Err(anyhow!("{} is a directory", p.display()));
        }
        // Only regular files have a size to window into; opening a named
        // pipe would block forever waiting for a writer. Checked on the
        // metadata BEFORE any open, so the pipe is never touched.
        if !meta.is_file() {
            return Err(anyhow!("{} is not a regular file", p.display()));
        }
        let total = meta.len();
        let want = u64::from(len.min(MAX_RANGE_BYTES)).min(total.saturating_sub(offset));
        let mut buf = Vec::with_capacity(want as usize);
        if want > 0 {
            use std::io::{Read as _, Seek as _, SeekFrom};
            let mut f = std::fs::File::open(&p)?;
            f.seek(SeekFrom::Start(offset))?;
            // take() tolerates a file that shrank between stat and read:
            // the window just comes back short instead of erroring.
            f.take(want).read_to_end(&mut buf)?;
        }
        Ok(ReadRange {
            b64: base64::engine::general_purpose::STANDARD.encode(&buf),
            total,
        })
    }

    /// Write text atomically (temp file + rename) so a crash mid-write cannot
    /// leave a half-written source file behind.
    pub fn write_text(&self, path: &str, content: &str) -> Result<()> {
        let raw = expand_path(path);
        let p = match (raw.parent(), raw.file_name()) {
            (Some(parent), Some(name)) => canonical_dir(parent).join(name),
            _ => raw,
        };
        // Follow a symlinked file to its target. Renaming over the link would
        // replace it with a regular file — a dotfiles repo would silently stop
        // receiving edits made here.
        let p = dunce::canonicalize(&p).unwrap_or(p);
        let dir = p
            .parent()
            .ok_or_else(|| anyhow!("no parent dir for {}", p.display()))?;
        let tmp = dir.join(format!(
            ".{}.tabverse-tmp",
            p.file_name().unwrap_or_default().to_string_lossy()
        ));
        std::fs::write(&tmp, content.as_bytes())
            .with_context(|| format!("cannot write {}", tmp.display()))?;
        // Preserve the original mode; a fresh temp file would be 0644.
        if let Ok(meta) = std::fs::metadata(&p) {
            let _ = std::fs::set_permissions(&tmp, meta.permissions());
        }
        std::fs::rename(&tmp, &p).with_context(|| format!("cannot replace {}", p.display()))?;
        // The working copy changed, so the cached status is stale.
        self.cache.lock().unwrap().clear();
        Ok(())
    }
}

/// One file the repository considers changed.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub rel: String,
    pub path: String,
    pub status: GitStatus,
}

/// What the change panel shows. `repo` absent means "not in a repository",
/// which is a different answer from "nothing changed".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeList {
    pub repo: Option<String>,
    pub files: Vec<ChangedFile>,
}

/// A name in `dir` that nothing else is using yet.
///
/// The number goes before the extension, so "report.md" becomes
/// "report 2.md" rather than "report.md 2" — the second is not a markdown
/// file to anything that looks at names.
pub(crate) fn free_name(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        // A dotfile is all stem: ".gitignore" has no extension to keep.
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 2..10_000 {
        let next = dir.join(format!("{stem} {n}{ext}"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem} copy{ext}"))
}

/// Copy a directory and everything under it.
fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst).with_context(|| format!("create {}", dst.display()))?;
    for entry in std::fs::read_dir(src).with_context(|| format!("read {}", src.display()))? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&from)?;
        if meta.file_type().is_symlink() {
            // Followed would duplicate whatever it points at, possibly
            // outside the tree being copied; skipped is the smaller lie and
            // is what a file manager does.
            continue;
        }
        if meta.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).with_context(|| format!("copy {}", from.display()))?;
        }
    }
    Ok(())
}

pub const WALK_EXCLUDE: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "dist-web",
    ".cache",
    ".venv",
    "__pycache__",
    ".next",
    ".gradle",
    "Pods",
    "DerivedData",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalkRules {
    /// Globs over a directory's OWN name — the same thing [`WALK_EXCLUDE`]
    /// holds, opened to the user. One pattern per entry; a directory whose
    /// name matches is not descended into by search or quick-open, and the
    /// watcher drops its events. `build-*` covers a family; the patterns
    /// never see a path, only the name, so an entry containing a separator
    /// matches nothing (and is easier to spot that way than half-working).
    pub exclude: Vec<String>,
    pub respect_gitignore: bool,
}

#[derive(Clone)]
pub struct Exclusions {
    custom: Vec<globset::GlobMatcher>,
    /// Carried alongside so the walks know whether to carry an
    /// [`IgnoreStack`] at all — reading it straight off `rules` would be
    /// the same thing one indirection cheaper and one fact more stale.
    pub respect_gitignore: bool,
}

impl Exclusions {
    /// Compile the user's globs. Every entry must parse; a typo is an
    /// error naming the pattern, not a search that quietly ignores half
    /// the tree the user meant to hide.
    pub fn compile(rules: &WalkRules) -> Result<Self> {
        let mut custom = Vec::with_capacity(rules.exclude.len());
        for raw in &rules.exclude {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let matcher = globset::GlobBuilder::new(trimmed)
                // A directory name has no separators in it, so this only
                // rules out the separator-crossing forms that could never
                // match anyway — and keeps a name glob a name glob.
                .literal_separator(true)
                .build()
                .map_err(|e| anyhow!("invalid exclude glob {trimmed:?}: {e}"))?
                .compile_matcher();
            custom.push(matcher);
        }
        Ok(Exclusions {
            custom,
            respect_gitignore: rules.respect_gitignore,
        })
    }

    /// The first layer of the walk, for one directory's own name: the
    /// built-in noise list, then the user's globs beside it. Both halves
    /// are name matches, which is what keeps them one list in behavior
    /// and not just in prose.
    pub fn dir_admitted(&self, name: &str) -> bool {
        !(WALK_EXCLUDE.contains(&name) || self.custom.iter().any(|m| m.is_match(name)))
    }
}

pub(crate) struct IgnoreStack {
    /// (directory whose .gitignore this is, that file compiled). Only
    /// directories that actually carry a `.gitignore` appear, so the
    /// stack stays as small as the tree is honest.
    layers: Vec<(PathBuf, ignore::gitignore::Gitignore)>,
}

impl IgnoreStack {
    /// The stack a walk starts with: the root's own `.gitignore`, if any.
    pub(crate) fn at_root(root: &Path) -> Self {
        let mut stack = IgnoreStack { layers: Vec::new() };
        stack.add_layer_for(root);
        stack
    }

    /// The stack a descent into `dir` carries: this one, plus `dir`'s own
    /// `.gitignore` when it has one. The stacks clone cheaply — the
    /// layers vector holds one entry per `.gitignore` met, not per
    /// directory walked.
    pub(crate) fn descending(&self, dir: &Path) -> Self {
        let mut next = IgnoreStack {
            layers: self.layers.clone(),
        };
        next.add_layer_for(dir);
        next
    }

    fn add_layer_for(&mut self, dir: &Path) {
        let file = dir.join(".gitignore");
        if !file.is_file() {
            return;
        }
        let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);
        // The error is Option<Error> — None means the file was read but a
        // pattern would not parse, Some means the file could not be read
        // at all. Either way the layer is skipped and the rest keep
        // working; a vanished or broken .gitignore must not cost the
        // search its results.
        let _ = builder.add(&file);
        if let Ok(compiled) = builder.build() {
            self.layers.push((dir.to_path_buf(), compiled));
        }
    }

    /// Whether the gitignore layers say this candidate stays out. A
    /// whitelist (`!pattern`) answers false the moment it matches, the
    /// same precedence git gives: the deepest file that says anything is
    /// the one that decides.
    pub(crate) fn ignored(&self, path: &Path, is_dir: bool) -> bool {
        for (dir, matcher) in self.layers.iter().rev() {
            let Some(rel) = path.strip_prefix(dir).ok() else {
                continue;
            };
            match matcher.matched(rel, is_dir) {
                ignore::Match::None => continue,
                ignore::Match::Ignore(_) => return true,
                ignore::Match::Whitelist(_) => return false,
            }
        }
        false
    }
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WalkResult {
    pub paths: Vec<String>,
    /// The cap was reached and entries are missing. Never silent — the
    /// same rule grep's truncated flag holds.
    pub truncated: bool,
}

pub fn walk(
    root: &str,
    max: usize,
    include_hidden: bool,
    name: Option<&str>,
    rules: &WalkRules,
) -> Result<WalkResult> {
    let root_path = canonical_dir(&expand_path(root));
    let excl = Exclusions::compile(rules)?;
    let name_filter = match name {
        None => None,
        Some(p) if p.trim().is_empty() => None,
        Some(p) => Some(
            globset::GlobBuilder::new(p)
                // Same rule as search.rs's PathFilter, for the same
                // reason: a bare pattern is a top-level pattern.
                .literal_separator(true)
                .build()
                .map_err(|e| anyhow!("invalid name glob {p:?}: {e}"))?
                .compile_matcher(),
        ),
    };
    let mut out = Vec::new();
    let mut truncated = false;
    let root_ignores = IgnoreStack::at_root(&root_path);
    let mut stack = vec![(root_path.clone(), root_ignores)];
    'outer: while let Some((dir, ignores)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut subdirs = Vec::new();
        for dent in rd.flatten() {
            // The cap refuses the NEXT entry the moment the list is
            // full — and refusing to enumerate is stopping early, so
            // the flag goes up right here.
            if out.len() >= max {
                truncated = true;
                break 'outer;
            }
            let name = dent.file_name().to_string_lossy().to_string();
            let path = dent.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue; // avoid cycles; quick-open lists real files
            }
            let hidden = name.starts_with('.');
            if meta.is_dir() {
                if !excl.dir_admitted(&name) {
                    continue;
                }
                if excl.respect_gitignore && ignores.ignored(&path, true) {
                    // Git itself refuses to re-include under an ignored
                    // directory, so the descent stops here rather than
                    // looking for whitelists git would not honor.
                    continue;
                }
                if hidden && !include_hidden {
                    continue;
                }
                let child_ignores = ignores.descending(&path);
                subdirs.push((path, child_ignores));
            } else if !hidden || include_hidden || name == ".env" {
                if excl.respect_gitignore && ignores.ignored(&path, false) {
                    continue;
                }
                if let Ok(rel) = path.strip_prefix(&root_path) {
                    if let Some(f) = &name_filter {
                        if !f.is_match(rel) {
                            continue;
                        }
                    }
                    out.push(ui_path(rel));
                }
            }
        }
        // Depth-first but stable enough for a picker.
        stack.extend(subdirs);
    }
    out.sort();
    Ok(WalkResult {
        paths: out,
        truncated,
    })
}

impl FsBackend {
    pub fn changes(&self, root: &str) -> ChangeList {
        let root_path = canonical_dir(&expand_path(root));
        let Some((workdir, _branch, files)) = self.repo_status(&root_path) else {
            return ChangeList {
                repo: None,
                files: Vec::new(),
            };
        };
        let mut out: Vec<ChangedFile> = files
            .into_iter()
            .filter(|(p, st)| *st != GitStatus::Ignored && p.starts_with(&root_path))
            .map(|(p, status)| ChangedFile {
                rel: ui_path(p.strip_prefix(&root_path).unwrap_or(&p)),
                path: ui_path(&p),
                status,
            })
            .collect();
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        ChangeList {
            repo: Some(ui_path(&workdir)),
            files: out,
        }
    }

    /// Flat file listing under `root` for fuzzy quick-open and the search
    /// panel's Name mode, capped so a huge tree degrades to "first N
    /// files" instead of an unbounded crawl. See [`walk`] — the free
    /// function — for the walk's own rules; this method is the seam the
    /// backend's own tests grew up on and nothing more than a delegate.
    pub fn walk(
        &self,
        root: &str,
        max: usize,
        include_hidden: bool,
        name: Option<&str>,
        rules: &WalkRules,
    ) -> Result<WalkResult> {
        walk(root, max, include_hidden, name, rules)
    }

    /// Create an empty file (parents included).
    pub fn create_file(&self, path: &str) -> Result<()> {
        let p = expand_path(path);
        if p.exists() {
            return Err(anyhow!("{} already exists", p.display()));
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&p, b"")?;
        self.cache.lock().unwrap().clear();
        Ok(())
    }

    pub fn create_dir(&self, path: &str) -> Result<()> {
        let p = expand_path(path);
        if p.exists() {
            return Err(anyhow!("{} already exists", p.display()));
        }
        std::fs::create_dir_all(&p)?;
        Ok(())
    }

    pub fn copy_into(&self, from: &str, into_dir: &str, overwrite: bool) -> Result<String> {
        let src = expand_path(from);
        let dir = expand_path(into_dir);
        if !src.exists() {
            return Err(anyhow!("{} is no longer there", src.display()));
        }
        if !dir.is_dir() {
            return Err(anyhow!("{} is not a folder", dir.display()));
        }
        // Copying a folder into itself, or into its own child, would run
        // until the disk filled.
        if src.is_dir() && dir.starts_with(&src) {
            return Err(anyhow!("a folder cannot be copied into itself"));
        }
        let name = src
            .file_name()
            .ok_or_else(|| anyhow!("{} has no name", src.display()))?
            .to_string_lossy()
            .to_string();
        let target = self.make_room(&dir, &name, overwrite)?;
        if src.is_dir() {
            copy_tree(&src, &target)?;
        } else {
            std::fs::copy(&src, &target).with_context(|| format!("copy {}", src.display()))?;
        }
        self.cache.lock().unwrap().clear();
        Ok(target.to_string_lossy().to_string())
    }

    pub fn move_into(&self, from: &str, into_dir: &str, overwrite: bool) -> Result<String> {
        let src = expand_path(from);
        let dir = expand_path(into_dir);
        if !src.exists() {
            return Err(anyhow!("{} is no longer there", src.display()));
        }
        if !dir.is_dir() {
            return Err(anyhow!("{} is not a folder", dir.display()));
        }
        if src.is_dir() && dir.starts_with(&src) {
            return Err(anyhow!("a folder cannot be moved into itself"));
        }
        let name = src
            .file_name()
            .ok_or_else(|| anyhow!("{} has no name", src.display()))?
            .to_string_lossy()
            .to_string();
        let target = self.make_room(&dir, &name, overwrite)?;
        if std::fs::rename(&src, &target).is_err() {
            if src.is_dir() {
                copy_tree(&src, &target)?;
                std::fs::remove_dir_all(&src)
                    .with_context(|| format!("remove {}", src.display()))?;
            } else {
                std::fs::copy(&src, &target).with_context(|| format!("copy {}", src.display()))?;
                std::fs::remove_file(&src).with_context(|| format!("remove {}", src.display()))?;
            }
        }
        self.cache.lock().unwrap().clear();
        Ok(target.to_string_lossy().to_string())
    }

    /// Where a transfer lands under `dir`: the numbered yield when the
    /// name is taken and `overwrite` was not chosen, or — when it was —
    /// the exact name, with whoever held it moved to the system Trash so
    /// the landing does not destroy anything quietly.
    fn make_room(&self, dir: &Path, name: &str, overwrite: bool) -> Result<PathBuf> {
        if !overwrite {
            return Ok(free_name(dir, name));
        }
        let incumbent = dir.join(name);
        if !incumbent.exists() {
            return Ok(incumbent);
        }
        trash::delete(&incumbent).map_err(|e| anyhow!("replacing {}: {e}", incumbent.display()))?;
        Ok(incumbent)
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let f = expand_path(from);
        let t = expand_path(to);
        if t.exists() {
            return Err(anyhow!("{} already exists", t.display()));
        }
        std::fs::rename(&f, &t).with_context(|| format!("rename {}", f.display()))?;
        self.cache.lock().unwrap().clear();
        Ok(())
    }

    /// Move to the system trash — recoverable, unlike a delete.
    pub fn trash(&self, path: &str) -> Result<()> {
        let p = expand_path(path);
        trash::delete(&p).map_err(|e| anyhow!("trash {}: {e}", p.display()))?;
        self.cache.lock().unwrap().clear();
        Ok(())
    }
}

/// A path in the form the UI consumes: separators are always `/`.
///
/// The frontend splits and joins paths as text in a dozen places, every one of
/// them written against `/`. A native Windows `\` made each of those return
/// the whole path where a file name was meant — editor titles, tab names and
/// the breadcrumb all showed `C:\a\b\c.ts` instead of `c.ts`. Normalizing here,
/// at the single point where a path becomes a string bound for the UI, keeps
/// that seam in one file rather than in every consumer that will ever be
/// added. Windows accepts `/` throughout its file APIs, so a path that makes
/// this round trip and comes back still opens.
pub fn ui_path(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s
    }
}

/// Resolve symlinks in a directory path, keeping the input on failure
/// (a path that cannot be canonicalized is still worth reporting as-is).
///
/// `dunce` rather than `std`: on Windows std hands back a verbatim path
/// (`\\?\C:\...`). That prefix is legal in a path but not in a `file:` URI —
/// percent-encoding turned it into an authority of `%3F` and every sqlite
/// preview failed — and it is not something to put in front of a user either.
pub fn canonical_dir(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The user's home directory, empty if the environment names none.
///
/// `HOME` is a Unix variable. Windows leaves it unset and puts the profile
/// path in `USERPROFILE`, so reading only `HOME` there expanded `~` to nothing
/// and quietly turned `~/Documents` into a *relative* path resolved against
/// the process's working directory. `HOME` is still tried first: when it is
/// set on Windows it was set deliberately and should win.
fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// Expand a leading `~` and normalize to an absolute path.
pub fn expand_path(p: &str) -> PathBuf {
    let raw = if let Some(rest) = p.strip_prefix("~") {
        let home = home_dir();
        // `~\Documents` is as ordinary on Windows as `~/Documents` is
        // elsewhere, and leaving that backslash in place is worse than
        // cosmetic — `join` discards the path it is called on whenever its
        // argument is rooted, so the home directory would vanish entirely.
        // Only on Windows: a backslash is a legal byte in a Unix filename, so
        // stripping it there would rewrite paths the user meant literally.
        let rest = if cfg!(windows) {
            rest.trim_start_matches(['/', '\\'])
        } else {
            rest.trim_start_matches('/')
        };
        if rest.is_empty() {
            PathBuf::from(home)
        } else {
            Path::new(&home).join(rest)
        }
    } else {
        PathBuf::from(p)
    };
    if raw.is_absolute() {
        raw
    } else {
        std::env::current_dir().unwrap_or_default().join(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A real repo with real changes: file statuses must be exact, and a
    /// directory must surface the worst status of anything inside it — that
    /// aggregation is the whole point of showing git state on the tree.
    #[test]
    fn git_status_on_files_and_aggregated_on_dirs() {
        let tmp = std::env::temp_dir().join(format!("tabverse-fs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("deep/nested")).unwrap();
        std::fs::write(tmp.join("kept.txt"), "one\n").unwrap();
        std::fs::write(tmp.join("changed.txt"), "before\n").unwrap();
        std::fs::write(tmp.join("deep/nested/leaf.txt"), "leaf\n").unwrap();

        run(&tmp, &["init", "-q", "-b", "main"]);
        run(&tmp, &["config", "user.email", "t@example.com"]);
        run(&tmp, &["config", "user.name", "test"]);
        run(&tmp, &["add", "."]);
        run(&tmp, &["commit", "-qm", "init"]);

        // Now make changes of three different kinds.
        std::fs::write(tmp.join("changed.txt"), "after\n").unwrap();
        std::fs::write(tmp.join("brand-new.txt"), "new\n").unwrap();
        std::fs::write(tmp.join("deep/nested/leaf.txt"), "leaf edited\n").unwrap();

        let fs = FsBackend::new();
        let listing = fs.list_dir(tmp.to_str().unwrap()).expect("listing");
        let by_name: HashMap<&str, &Entry> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e))
            .collect();

        assert_eq!(listing.branch.as_deref(), Some("main"));
        assert_eq!(by_name["changed.txt"].git, Some(GitStatus::Modified));
        assert_eq!(by_name["brand-new.txt"].git, Some(GitStatus::Untracked));
        assert_eq!(
            by_name["kept.txt"].git, None,
            "unchanged file must be clean"
        );

        let deep = by_name["deep"];
        assert!(deep.is_dir);
        assert_eq!(
            deep.git,
            Some(GitStatus::Modified),
            "directory must aggregate the modified file two levels down"
        );
        assert!(deep.git_from_children);

        // Directories come first, names sorted case-insensitively, and the
        // git object store is not browsable clutter.
        let order: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!order.contains(&".git"), "got {order:?}");
        assert_eq!(order[0], "deep");

        // HEAD content backs the inline diff.
        let head = fs
            .head_content(tmp.join("changed.txt").to_str().unwrap())
            .unwrap();
        assert_eq!(head.as_deref(), Some(&b"before\n"[..]));
        let untracked_head = fs
            .head_content(tmp.join("brand-new.txt").to_str().unwrap())
            .unwrap();
        assert!(
            untracked_head.is_none(),
            "untracked file has no HEAD version"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Reading and saving must be honest about kind, size limits and diffs,
    /// and a save must never leave a partial file.
    #[test]
    fn read_write_kinds_and_atomic_save() {
        let tmp = std::env::temp_dir().join(format!("tabverse-fs-rw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let fs = FsBackend::new();

        // Text with a HEAD version -> diff material.
        std::fs::write(tmp.join("a.txt"), "v1\n").unwrap();
        run(&tmp, &["init", "-q", "-b", "main"]);
        run(&tmp, &["config", "user.email", "t@example.com"]);
        run(&tmp, &["config", "user.name", "test"]);
        run(&tmp, &["add", "."]);
        run(&tmp, &["commit", "-qm", "init"]);
        std::fs::write(tmp.join("a.txt"), "v2\n").unwrap();

        let m = fs.read_file(tmp.join("a.txt").to_str().unwrap()).unwrap();
        assert_eq!(m.kind, FileKind::Text);
        assert_eq!(m.text.as_deref(), Some("v2\n"));
        assert_eq!(m.head_text.as_deref(), Some("v1\n"), "diff needs HEAD text");
        assert_eq!(m.git, Some(GitStatus::Modified));
        assert!(!m.truncated);
        // The drafts feature keeps this as the base version for external-edit
        // detection, so it must be exactly what the filesystem reports.
        let disk_mtime = std::fs::metadata(tmp.join("a.txt"))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(
            m.modified,
            Some(disk_mtime),
            "modified must be the file's mtime"
        );

        // Binary content without a known extension must not be offered as text.
        std::fs::write(tmp.join("blob.bin"), [0x00, 0x01, 0x02, 0xff]).unwrap();
        let b = fs
            .read_file(tmp.join("blob.bin").to_str().unwrap())
            .unwrap();
        assert_eq!(b.kind, FileKind::Binary);
        assert!(b.text.is_none());

        // Extension decides for media even when bytes look textual.
        std::fs::write(tmp.join("pic.svg"), "<svg/>").unwrap();
        let s = fs.read_file(tmp.join("pic.svg").to_str().unwrap()).unwrap();
        assert_eq!(s.kind, FileKind::Image);
        assert_eq!(s.mime, "image/svg+xml");

        // Save keeps the executable bit and lands atomically. Windows has no
        // executable permission bit to set or to preserve, so only the
        // permission half is gated — the atomic-save half below is what this
        // test is really for, and it applies on every platform.
        let script = tmp.join("run.sh");
        std::fs::write(&script, "echo old\n").unwrap();
        run(&tmp, &["update-index", "--add", "--chmod=+x", "run.sh"]);
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        fs.write_text(script.to_str().unwrap(), "echo new\n")
            .unwrap();
        assert_eq!(std::fs::read_to_string(&script).unwrap(), "echo new\n");
        #[cfg(unix)]
        {
            let mode = std::os::unix::fs::PermissionsExt::mode(
                &std::fs::metadata(&script).unwrap().permissions(),
            );
            assert_eq!(mode & 0o111, 0o111, "executable bit must survive a save");
        }
        // No temp turds left behind.
        let leftovers: Vec<String> = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("tabverse-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left temp files: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Saving must never be offered when it would destroy what we never read.
    #[test]
    fn unsafe_saves_are_refused_and_symlinks_are_followed() {
        let tmp = std::env::temp_dir().join(format!("tabverse-fs-safe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let fs = FsBackend::new();

        // Non-UTF-8 content: readable, but not safely writable.
        let latin = tmp.join("latin1.txt");
        std::fs::write(&latin, b"caf\xe9 not utf8\n").unwrap();
        let m = fs.read_file(latin.to_str().unwrap()).unwrap();
        assert_eq!(m.kind, FileKind::Text);
        assert!(
            m.read_only_reason.is_some(),
            "a lossy decode must not be offered as editable"
        );

        // Oversized text: only partially loaded, so equally unsafe to write.
        let big = tmp.join("big.log");
        let chunk = "x".repeat(1024);
        let mut data = String::new();
        while data.len() as u64 <= MAX_TEXT_BYTES + 1024 {
            data.push_str(&chunk);
            data.push('\n');
        }
        std::fs::write(&big, &data).unwrap();
        let m = fs.read_file(big.to_str().unwrap()).unwrap();
        assert!(m.truncated);
        assert!(
            m.read_only_reason.is_some(),
            "truncated file must be read-only"
        );

        // A symlinked file must still be a symlink after saving.
        //
        // Unix only, for an environmental reason rather than a behavioural
        // one: Windows can create symlinks, but only with elevation or
        // Developer Mode enabled, so an ordinary test run there would report
        // the machine's configuration instead of this code's behaviour. The
        // save path is the same on both, and it stays unverified on Windows.
        #[cfg(unix)]
        {
            let target = tmp.join("real.txt");
            std::fs::write(&target, "before\n").unwrap();
            let link = tmp.join("link.txt");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            fs.write_text(link.to_str().unwrap(), "after\n").unwrap();
            assert!(
                std::fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink(),
                "saving replaced the symlink with a regular file"
            );
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "after\n");
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn walk_names_and_truncation() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp =
            std::env::temp_dir().join(format!("tabverse-fs-name-{}-{stamp}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src")).unwrap();
        std::fs::write(tmp.join("src/alpha.rs"), "a").unwrap();
        std::fs::write(tmp.join("src/beta.ts"), "b").unwrap();
        std::fs::write(tmp.join("top.rs"), "t").unwrap();
        std::fs::write(tmp.join("top.log"), "l").unwrap();
        let fs = FsBackend::new();
        let root = tmp.to_str().unwrap();

        // The double star crosses directories; the bare pattern does not.
        let rs = fs
            .walk(root, 1000, false, Some("**/*.rs"), &WalkRules::default())
            .unwrap();
        assert_eq!(rs.paths, vec!["src/alpha.rs", "top.rs"]);
        assert!(!rs.truncated);
        let top_only = fs
            .walk(root, 1000, false, Some("*.rs"), &WalkRules::default())
            .unwrap();
        assert_eq!(top_only.paths, vec!["top.rs"]);

        // A pattern nothing matches is an honest empty list, not an error.
        let none = fs
            .walk(root, 1000, false, Some("**/*.md"), &WalkRules::default())
            .unwrap();
        assert!(none.paths.is_empty());
        // A broken pattern is an error, not a silent empty list.
        assert!(fs
            .walk(root, 1000, false, Some("["), &WalkRules::default())
            .is_err());

        // The cap reports itself: 3 real files under a max of 2 stops early
        // and says so. A silently shortened list would read as "that's all
        // of them" — the one answer a search must never give by accident.
        let cut = fs
            .walk(root, 2, false, None, &WalkRules::default())
            .unwrap();
        assert_eq!(cut.paths.len(), 2);
        assert!(cut.truncated, "the cap must say so");
        // And a tree that fits reports whole.
        let whole = fs
            .walk(root, 10, false, None, &WalkRules::default())
            .unwrap();
        assert_eq!(whole.paths.len(), 4);
        assert!(!whole.truncated);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// File operations must be real and safe: create rejects clobbering,
    /// rename moves, trash removes but is recoverable (we just check the file
    /// is gone), and walk lists files while skipping the noise directories.
    #[test]
    fn file_ops_and_walk() {
        let tmp = std::env::temp_dir().join(format!("tabverse-fs-ops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(tmp.join("src")).unwrap();
        std::fs::write(tmp.join("src/a.ts"), "a").unwrap();
        std::fs::write(tmp.join("node_modules/pkg/index.js"), "x").unwrap();
        let fs = FsBackend::new();

        // walk lists real files, skips node_modules.
        let listed = fs
            .walk(
                tmp.to_str().unwrap(),
                1000,
                false,
                None,
                &WalkRules::default(),
            )
            .unwrap();
        assert!(
            listed.paths.iter().any(|p| p == "src/a.ts"),
            "got {listed:?}"
        );
        assert!(
            !listed.paths.iter().any(|p| p.contains("node_modules")),
            "walk must skip node_modules; got {listed:?}"
        );
        assert!(!listed.truncated, "a tree well under the cap is whole");

        // create makes a new file, and refuses to overwrite.
        fs.create_file(tmp.join("src/new.ts").to_str().unwrap())
            .unwrap();
        assert!(tmp.join("src/new.ts").exists());
        assert!(
            fs.create_file(tmp.join("src/new.ts").to_str().unwrap())
                .is_err(),
            "create must not clobber an existing file"
        );

        // rename moves; the old path is gone, the new one holds the content.
        fs.rename(
            tmp.join("src/a.ts").to_str().unwrap(),
            tmp.join("src/renamed.ts").to_str().unwrap(),
        )
        .unwrap();
        assert!(!tmp.join("src/a.ts").exists());
        assert_eq!(
            std::fs::read_to_string(tmp.join("src/renamed.ts")).unwrap(),
            "a"
        );

        // trash removes the file from its location.
        fs.trash(tmp.join("src/renamed.ts").to_str().unwrap())
            .unwrap();
        assert!(!tmp.join("src/renamed.ts").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The windowed read behind the log/hex viewers: any offset must come
    /// back exact, the end of file must truncate rather than error, an
    /// offset past the end must yield an empty window (with the real total),
    /// and no request may exceed the server-side cap.
    #[test]
    fn read_range_windows_never_load_the_whole_file() {
        let tmp = std::env::temp_dir().join(format!("tabverse-fs-range-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let fs = FsBackend::new();

        // 3 MiB of position-dependent bytes: any window read from the wrong
        // offset fails the content comparison, not just the length one.
        let size: usize = 3 * 1024 * 1024;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let big = tmp.join("big.bin");
        std::fs::write(&big, &data).unwrap();
        let path = big.to_str().unwrap();

        let decode = |r: &ReadRange| {
            base64::engine::general_purpose::STANDARD
                .decode(&r.b64)
                .expect("b64 field must be valid base64")
        };

        // Head window.
        let r = fs.read_range(path, 0, 4096).unwrap();
        assert_eq!(r.total, size as u64);
        assert_eq!(decode(&r), &data[..4096]);

        // Middle window at an odd offset.
        let mid = 1_234_567u64;
        let r = fs.read_range(path, mid, 4096).unwrap();
        assert_eq!(decode(&r), &data[mid as usize..mid as usize + 4096]);

        // Tail window: shorter than asked, never an error.
        let r = fs.read_range(path, size as u64 - 100, 4096).unwrap();
        assert_eq!(decode(&r), &data[size - 100..]);
        assert_eq!(r.total, size as u64);

        // Past EOF: empty window, total still reported.
        let r = fs.read_range(path, size as u64 + 10, 4096).unwrap();
        assert_eq!(r.b64, "");
        assert_eq!(r.total, size as u64);

        // The cap: asking for 2 MiB yields exactly MAX_RANGE_BYTES.
        let r = fs.read_range(path, 0, 2 * 1024 * 1024).unwrap();
        let bytes = decode(&r);
        assert_eq!(bytes.len(), MAX_RANGE_BYTES as usize);
        assert_eq!(bytes, &data[..MAX_RANGE_BYTES as usize]);

        // The wire shape the viewer depends on.
        let json = serde_json::to_string(&fs.read_range(path, 0, 4).unwrap()).unwrap();
        assert!(
            json.contains("\"b64\"") && json.contains("\"total\""),
            "{json}"
        );

        // A directory is not byte-addressable content.
        assert!(fs.read_range(tmp.to_str().unwrap(), 0, 16).is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tilde_expansion() {
        // Through home_dir, not HOME directly: Windows leaves HOME unset and
        // names the home in USERPROFILE, so a test reading only HOME fails
        // there for its own reasons rather than the code's.
        let home = home_dir();
        assert_eq!(expand_path("~"), PathBuf::from(&home));
        assert_eq!(expand_path("~/x/y"), Path::new(&home).join("x/y"));
        // A rooted remainder must not swallow the home directory — but only
        // where a backslash separates; elsewhere it is part of the name.
        #[cfg(windows)]
        assert_eq!(expand_path("~\\x"), Path::new(&home).join("x"));
        #[cfg(not(windows))]
        {
            let mut expected = PathBuf::from(&home);
            expected.push("\\x");
            assert_eq!(expand_path("~\\x"), expected);
        }
    }
}

#[cfg(test)]
mod copy_tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cal-copy-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_taken_name_gets_a_number_before_the_extension() {
        let dir = scratch("name");
        std::fs::write(dir.join("report.md"), "one").unwrap();
        let taken = free_name(&dir, "report.md");
        assert_eq!(taken.file_name().unwrap(), "report 2.md");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_dotfile_keeps_its_whole_name() {
        let dir = scratch("dot");
        std::fs::write(dir.join(".gitignore"), "x").unwrap();
        let taken = free_name(&dir, ".gitignore");
        assert_eq!(taken.file_name().unwrap(), ".gitignore 2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copying_never_overwrites_what_is_already_there() {
        let dir = scratch("keep");
        let src = dir.join("a.txt");
        std::fs::write(&src, "original").unwrap();
        let into = dir.join("into");
        std::fs::create_dir_all(&into).unwrap();
        std::fs::write(into.join("a.txt"), "do not lose me").unwrap();
        let fs = FsBackend::new();
        let landed = fs
            .copy_into(src.to_str().unwrap(), into.to_str().unwrap(), false)
            .unwrap();
        assert!(landed.ends_with("a 2.txt"), "{landed}");
        assert_eq!(
            std::fs::read_to_string(into.join("a.txt")).unwrap(),
            "do not lose me"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_explicit_overwrite_lands_the_exact_name_and_trashes_the_incumbent() {
        let dir = scratch("replace");
        let src = dir.join("a.txt");
        std::fs::write(&src, "the new one").unwrap();
        let into = dir.join("into");
        std::fs::create_dir_all(&into).unwrap();
        std::fs::write(into.join("a.txt"), "the old one").unwrap();
        let fs = FsBackend::new();
        let landed = fs
            .copy_into(src.to_str().unwrap(), into.to_str().unwrap(), true)
            .unwrap();
        assert!(landed.ends_with("a.txt"), "{landed}");
        assert_eq!(
            std::fs::read_to_string(into.join("a.txt")).unwrap(),
            "the new one"
        );
        // And the same shape holds for a move.
        let src2 = dir.join("b.txt");
        std::fs::write(&src2, "moved over").unwrap();
        std::fs::write(into.join("b.txt"), "moved under").unwrap();
        let landed2 = fs
            .move_into(src2.to_str().unwrap(), into.to_str().unwrap(), true)
            .unwrap();
        assert!(landed2.ends_with("b.txt"), "{landed2}");
        assert_eq!(
            std::fs::read_to_string(into.join("b.txt")).unwrap(),
            "moved over"
        );
        assert!(!src2.exists(), "a move takes the source away");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_overwrite_of_a_free_name_is_an_ordinary_landing() {
        // overwrite:true with nobody holding the name: same outcome as
        // the default, no error, no Trash step.
        let dir = scratch("free");
        let src = dir.join("solo.txt");
        std::fs::write(&src, "solo").unwrap();
        let into = dir.join("into");
        std::fs::create_dir_all(&into).unwrap();
        let fs = FsBackend::new();
        let landed = fs
            .copy_into(src.to_str().unwrap(), into.to_str().unwrap(), true)
            .unwrap();
        assert!(landed.ends_with("solo.txt"), "{landed}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_cannot_be_copied_inside_itself() {
        let dir = scratch("self");
        let outer = dir.join("outer");
        let inner = outer.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let fs = FsBackend::new();
        assert!(fs
            .copy_into(outer.to_str().unwrap(), inner.to_str().unwrap(), false)
            .is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_arrives_with_everything_under_it() {
        let dir = scratch("tree");
        let src = dir.join("src");
        std::fs::create_dir_all(src.join("deep")).unwrap();
        std::fs::write(src.join("deep/leaf.txt"), "leaf").unwrap();
        let into = dir.join("into");
        std::fs::create_dir_all(&into).unwrap();
        let fs = FsBackend::new();
        let landed = fs
            .copy_into(src.to_str().unwrap(), into.to_str().unwrap(), false)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(PathBuf::from(&landed).join("deep/leaf.txt")).unwrap(),
            "leaf"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn moving_a_file_that_vanished_says_so() {
        let dir = scratch("gone");
        let fs = FsBackend::new();
        let err = fs
            .move_into(
                dir.join("never-existed.txt").to_str().unwrap(),
                dir.to_str().unwrap(),
                false,
            )
            .unwrap_err();
        assert!(err.to_string().contains("no longer there"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn walk_rules_tree() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("tabverse-rules-{}-{stamp}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("vendor/lib")).unwrap();
        std::fs::create_dir_all(dir.join("pkgbuild-out")).unwrap();
        std::fs::write(dir.join("vendor/lib/a.c"), "needle\n").unwrap();
        std::fs::write(dir.join("pkgbuild-out/artifact.txt"), "needle\n").unwrap();
        std::fs::write(dir.join("readme.md"), "needle\n").unwrap();
        // The gitignore half: an ignored directory, and a hidden file the
        // same file whitelists — the pair that separates "gitignore" from
        // "hidden", which the overlay order has to keep apart.
        std::fs::write(dir.join(".gitignore"), "pkgbuild-out/\n!secret-notes\n").unwrap();
        std::fs::write(dir.join(".secret-notes"), "needle\n").unwrap();
        dir
    }

    fn walk_paths(root: &Path, rules: &WalkRules) -> Vec<String> {
        walk(root.to_str().unwrap(), 1000, false, None, rules)
            .unwrap()
            .paths
    }

    #[test]
    fn default_rules_keep_todays_walk_untouched() {
        let dir = walk_rules_tree();
        let paths = walk_paths(&dir, &WalkRules::default());
        assert!(paths.contains(&"pkgbuild-out/artifact.txt".to_string()));
        assert!(paths.contains(&"readme.md".to_string()));
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "the built-in list applies without any configuration"
        );
        // Hidden files stay hidden under the default toggle.
        assert!(!paths.contains(&".secret-notes".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_user_glob_hides_its_directories_from_the_walk() {
        let dir = walk_rules_tree();
        let rules = WalkRules {
            exclude: vec!["vendor".into(), "pkgbuild-*".into()],
            respect_gitignore: false,
        };
        let paths = walk_paths(&dir, &rules);
        assert!(
            !paths.iter().any(|p| p.contains("vendor")),
            "the literal entry removed vendor: {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.contains("pkgbuild")),
            "the glob entry removed the family: {paths:?}"
        );
        assert!(paths.contains(&"readme.md".to_string()), "the rest stands");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_gitignore_switch_removes_and_restores_the_ignored() {
        let dir = walk_rules_tree();
        let on = WalkRules {
            exclude: vec![],
            respect_gitignore: true,
        };
        let paths = walk_paths(&dir, &on);
        assert!(
            !paths.iter().any(|p| p.contains("pkgbuild-out")),
            "gitignore on must remove the ignored output: {paths:?}"
        );
        assert!(paths.contains(&"readme.md".to_string()));
        // And off — the default fixture above already proved the return
        // half; this is the same switch thrown back, not a new list.
        let paths = walk_paths(&dir, &WalkRules::default());
        assert!(paths.contains(&"pkgbuild-out/artifact.txt".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gitignore_whitelists_only_outvote_gitignore() {
        let dir = walk_rules_tree();
        let on = WalkRules {
            exclude: vec![],
            respect_gitignore: true,
        };
        // Hidden stays hidden even though the .gitignore whitelists it.
        let paths = walk_paths(&dir, &on);
        assert!(!paths.contains(&".secret-notes".to_string()));
        // With hidden shown, the whitelist does its one job: the file the
        // ignore line would take is back.
        let shown = walk(dir.to_str().unwrap(), 1000, true, None, &on)
            .unwrap()
            .paths;
        assert!(shown.contains(&".secret-notes".to_string()));
        // An ignored file matches no include glob strongly enough to
        // return: the glob layer sits AFTER gitignore in the order.
        let grep_hits = search::grep(
            dir.to_str().unwrap(),
            "needle",
            search::GrepOptions {
                case_sensitive: true,
                whole_word: false,
                regex: false,
                include_hidden: false,
                include: Some("**/*.txt".into()),
                exclude: None,
            },
            100,
            &on,
        )
        .unwrap();
        assert!(
            !grep_hits
                .hits
                .iter()
                .any(|h| h.rel.contains("pkgbuild-out")),
            "an include glob cannot outrank gitignore: {:?}",
            grep_hits.hits.iter().map(|h| &h.rel).collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A broken user glob is an error, not a search that quietly pretends
    /// the list was empty — the panel says it, the way it says a broken
    /// include glob.
    #[test]
    fn a_broken_user_glob_is_an_error() {
        let dir = walk_rules_tree();
        let rules = WalkRules {
            exclude: vec!["[vendor".into()],
            respect_gitignore: false,
        };
        assert!(walk(dir.to_str().unwrap(), 1000, false, None, &rules).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A .gitignore one directory down applies to what is under it, and a
    /// deeper file outranks a shallower one — the stack the descent
    /// carries, exercised where its precedence can actually disagree.
    #[test]
    fn a_nested_gitignore_is_honoured_with_its_own_precedence() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tabverse-ign-{}-{stamp}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/keep.log"), "needle\n").unwrap();
        std::fs::write(dir.join("top.log"), "needle\n").unwrap();
        // The root ignores *.log; sub re-includes its own.
        std::fs::write(dir.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(dir.join("sub/.gitignore"), "!*.log\n").unwrap();
        let on = WalkRules {
            exclude: vec![],
            respect_gitignore: true,
        };
        let paths = walk_paths(&dir, &on);
        assert!(
            !paths.contains(&"top.log".to_string()),
            "the root's ignore applies: {paths:?}"
        );
        assert!(
            paths.contains(&"sub/keep.log".to_string()),
            "the deeper file outranks the shallower: {paths:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
