//! The filesystem and process surface tools are allowed to touch.
//!
//! Tools never call `std::fs` directly. Everything goes through this trait for
//! two reasons that matter later: a permission layer can wrap an env and refuse
//! individual operations without every tool growing its own checks, and tests
//! can drive the whole tool set against a temporary directory without spawning
//! anything real.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Filesystem and working-directory access for tool execution.
pub trait ExecutionEnv: Send + Sync {
    /// Directory relative paths resolve against.
    fn cwd(&self) -> &Path;

    /// Resolve a (possibly relative) path to an absolute one. Does not require
    /// the path to exist — callers that need existence check it themselves.
    fn absolute_path(&self, path: &str) -> Result<PathBuf> {
        let candidate = Path::new(path);
        if candidate.is_absolute() {
            Ok(candidate.to_path_buf())
        } else {
            Ok(self.cwd().join(candidate))
        }
    }

    fn exists(&self, path: &Path) -> bool;

    fn read_file(&self, path: &Path) -> Result<Vec<u8>>;

    /// Write `content`, creating parent directories as needed. Overwrites.
    fn write_file(&self, path: &Path, content: &str) -> Result<()>;
}

/// The ordinary implementation: the real filesystem, rooted at a working directory.
pub struct LocalEnv {
    cwd: PathBuf,
}

impl LocalEnv {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}

impl ExecutionEnv for LocalEnv {
    fn cwd(&self) -> &Path {
        &self.cwd
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn read_file(&self, path: &Path) -> Result<Vec<u8>> {
        std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))
    }

    fn write_file(&self, path: &Path, content: &str) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        std::fs::write(path, content).with_context(|| format!("failed to write {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_resolve_against_cwd() {
        let env = LocalEnv::new("/tmp/example");
        assert_eq!(
            env.absolute_path("notes.txt").unwrap(),
            PathBuf::from("/tmp/example/notes.txt")
        );
    }

    #[test]
    fn absolute_paths_pass_through() {
        let env = LocalEnv::new("/tmp/example");
        assert_eq!(
            env.absolute_path("/etc/hosts").unwrap(),
            PathBuf::from("/etc/hosts")
        );
    }

    #[test]
    fn write_creates_missing_parents() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let target = dir.path().join("a/b/c.txt");
        env.write_file(&target, "hi").unwrap();
        assert_eq!(env.read_file(&target).unwrap(), b"hi");
    }
}
