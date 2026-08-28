use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::{canonical_dir, expand_path, free_name, ui_path, FsBackend};

/// Refuse to extract more entries than this. Chosen so an ordinary project
/// archive (tens of thousands of files is already unusual) passes while a
/// garbage generator is stopped in the central directory, before it writes.
pub const MAX_EXTRACT_ENTRIES: usize = 10_000;

/// Refuse to extract past this many *declared* uncompressed bytes: 2 GiB
/// covers every archive a person would open here and stops a bomb before
/// the first entry inflates.
pub const MAX_EXTRACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// What `fs_archive_extract` hands back: where the fresh folder landed and
/// every file written into it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractOutcome {
    pub dir: String,
    pub files: Vec<String>,
}

impl FsBackend {
    pub fn archive_create(
        &self,
        entries: &[String],
        dest_dir: &str,
        format: &str,
    ) -> Result<String> {
        if entries.is_empty() {
            bail!("nothing selected to compress");
        }
        let sources: Vec<PathBuf> = entries.iter().map(|e| expand_path(e)).collect();
        let dest = expand_path(dest_dir);
        if !dest.is_dir() {
            bail!("{} is not a folder", dest.display());
        }
        for s in &sources {
            if !s.exists() {
                bail!("{} is no longer there", s.display());
            }
        }
        let archive_name = match format {
            "zip" => format!("{}.zip", archive_base_name(&sources)),
            "tgz" => format!("{}.tgz", archive_base_name(&sources)),
            other => bail!("unsupported archive format {other:?}"),
        };
        let target = free_name(&dest, &archive_name);
        match format {
            "zip" => create_zip(&sources, &target)?,
            "tgz" => create_tgz(&sources, &target)?,
            _ => unreachable!("checked above"),
        }
        self.cache.lock().unwrap().clear();
        Ok(ui_path(&target))
    }

    pub fn archive_extract(&self, archive: &str, dest_dir: &str) -> Result<ExtractOutcome> {
        let arc = expand_path(archive);
        let dest = expand_dir(dest_dir)?;
        if !arc.is_file() {
            bail!("{} is not an archive file", arc.display());
        }
        let folder = free_name(&dest, &archive_stem(&arc));
        std::fs::create_dir_all(&folder).with_context(|| format!("create {}", folder.display()))?;
        let root = canonical_dir(&folder);
        // A refused archive leaves nothing behind: the fresh folder goes too,
        // so "fail without writing" holds for the whole operation, not per entry.
        let files = match extract_into(&arc, &root) {
            Ok(files) => files,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&folder);
                return Err(e);
            }
        };
        self.cache.lock().unwrap().clear();
        Ok(ExtractOutcome {
            dir: ui_path(&folder),
            files,
        })
    }
}

/// The directory an extraction lands in must exist and be a directory.
fn expand_dir(dir: &str) -> Result<PathBuf> {
    let p = expand_path(dir);
    if !p.is_dir() {
        bail!("{} is not a folder", p.display());
    }
    Ok(p)
}

/// Archive base name from the first entry (Finder's rule for a multi-item
/// Compress): a file contributes its stem — the last extension dropped,
/// dotfiles keep their whole name — and a folder contributes its name.
fn archive_base_name(entries: &[PathBuf]) -> String {
    let first = &entries[0];
    let name = first
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if first.is_dir() {
        return name;
    }
    match name.rsplit_once('.') {
        // A dotfile is all stem: ".gitignore" has no extension to drop.
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name,
    }
}

/// "bundle.zip" -> "bundle", "pack.tar.gz" -> "pack", ".secret.tgz" ->
/// ".secret" — the folder an extraction creates is named after the archive
/// itself, extension(s) removed.
fn archive_stem(path: &Path) -> String {
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    for suffix in [".tar.gz", ".tar.bz2", ".zip", ".tgz", ".tar", ".gz"] {
        if name.len() > suffix.len()
            && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
        {
            name.truncate(name.len() - suffix.len());
            return name;
        }
    }
    name
}

// ---------------------------------------------------------------------------
// Create

/// One zip: every source under its own name (a folder keeps its name as the
/// prefix for everything inside it), deflate-compressed, deterministic
/// (children walked in name order).
fn create_zip(sources: &[PathBuf], target: &Path) -> Result<()> {
    let file =
        std::fs::File::create(target).with_context(|| format!("create {}", target.display()))?;
    let mut w = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for src in sources {
        let prefix = top_name(src);
        add_tree_zip(&mut w, src, &prefix, opts)?;
    }
    w.finish()
        .with_context(|| format!("finish {}", target.display()))?;
    Ok(())
}

fn add_tree_zip(
    w: &mut zip::ZipWriter<std::fs::File>,
    disk: &Path,
    arc: &str,
    opts: zip::write::SimpleFileOptions,
) -> Result<()> {
    let meta = std::fs::symlink_metadata(disk)?;
    if meta.file_type().is_symlink() {
        // Followed would archive whatever it points at, possibly outside
        // the selection; skipped is the file-manager behavior (copy_tree).
        return Ok(());
    }
    if meta.is_dir() {
        w.add_directory(format!("{arc}/"), opts)
            .with_context(|| format!("zip {arc}/"))?;
        for child in sorted_children(disk)? {
            add_tree_zip(
                w,
                &child,
                &format!("{arc}/{}", child.file_name().unwrap().to_string_lossy()),
                opts,
            )?;
        }
    } else {
        w.start_file(arc, opts)
            .with_context(|| format!("zip {arc}"))?;
        let mut f = std::fs::File::open(disk)?;
        std::io::copy(&mut f, w)?;
    }
    Ok(())
}

/// One tar.gz over the same walk.
fn create_tgz(sources: &[PathBuf], target: &Path) -> Result<()> {
    let file =
        std::fs::File::create(target).with_context(|| format!("create {}", target.display()))?;
    let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut b = tar::Builder::new(enc);
    for src in sources {
        add_tree_tar(&mut b, src, &top_name(src))?;
    }
    b.into_inner()
        .and_then(|e| e.finish())
        .with_context(|| format!("finish {}", target.display()))?;
    Ok(())
}

fn add_tree_tar<W: Write>(b: &mut tar::Builder<W>, disk: &Path, arc: &str) -> Result<()> {
    let meta = std::fs::symlink_metadata(disk)?;
    if meta.file_type().is_symlink() {
        return Ok(()); // same rule as the zip walk
    }
    if meta.is_dir() {
        b.append_dir(arc, disk)
            .with_context(|| format!("tar {arc}"))?;
        for child in sorted_children(disk)? {
            add_tree_tar(
                b,
                &child,
                &format!("{arc}/{}", child.file_name().unwrap().to_string_lossy()),
            )?;
        }
    } else {
        b.append_path_with_name(disk, arc)
            .with_context(|| format!("tar {arc}"))?;
    }
    Ok(())
}

/// The archive member name of a top-level source: its own file name.
fn top_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn sorted_children(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("read {}", dir.display()))?
        .flatten()
        .map(|d| d.path())
        .collect();
    out.sort();
    Ok(out)
}

// ---------------------------------------------------------------------------
// Extract

/// Route by content (the same sniff the listing uses): zip central
/// directory, tar magic in the first block, gzip header with a tar payload
/// inside, or a lone gzip member.
fn extract_into(arc: &Path, root: &Path) -> Result<Vec<String>> {
    let mut head = [0u8; 262];
    let n = std::fs::File::open(arc)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    let head = &head[..n];
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        return extract_zip(arc, root);
    }
    if n >= 262 && &head[257..262] == b"ustar" {
        return extract_tar(std::fs::File::open(arc)?, root);
    }
    if head.starts_with(b"\x1f\x8b") {
        // Sniff for a tar payload by decompressing only the first block,
        // exactly like the listing does (inspect_gz).
        use flate2::read::GzDecoder;
        let mut block = [0u8; 512];
        let mut m = 0;
        let mut dec = GzDecoder::new(std::fs::File::open(arc)?);
        loop {
            match dec.read(&mut block[m..]) {
                Ok(0) => break,
                Ok(k) => {
                    m += k;
                    if m == block.len() {
                        break;
                    }
                }
                Err(_) => bail!("{} is not a valid gzip", arc.display()),
            }
        }
        if m == 512 && &block[257..262] == b"ustar" {
            return extract_tar(GzDecoder::new(std::fs::File::open(arc)?), root);
        }
        return extract_gz_single(arc, root);
    }
    bail!("{} is not an archive this build extracts", arc.display());
}

fn extract_zip(arc: &Path, root: &Path) -> Result<Vec<String>> {
    let file = std::fs::File::open(arc)?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("{} is not a valid zip", arc.display()))?;
    if archive.len() > MAX_EXTRACT_ENTRIES {
        bail!(
            "{} holds {} entries — more than the {} this build extracts",
            arc.display(),
            archive.len(),
            MAX_EXTRACT_ENTRIES
        );
    }
    let mut files = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if is_symlink_mode(entry.unix_mode()) {
            continue; // never create links (module comment)
        }
        // Zip separators are '/' by spec; some writers on Windows use '\'.
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() {
            let dir = safe_target(root, &name)?;
            std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
            continue;
        }
        let declared = entry.size();
        total += declared;
        if declared > MAX_EXTRACT_BYTES || total > MAX_EXTRACT_BYTES {
            bail!(
                "{} declares more than {} bytes of content — refused",
                arc.display(),
                MAX_EXTRACT_BYTES
            );
        }
        let target = safe_target(root, &name)?;
        let mut out = std::fs::File::create(&target)
            .with_context(|| format!("create {}", target.display()))?;
        std::io::copy(&mut entry, &mut out)?;
        files.push(ui_path(&target));
    }
    Ok(files)
}

fn extract_tar<R: Read>(reader: R, root: &Path) -> Result<Vec<String>> {
    let mut archive = tar::Archive::new(reader);
    let mut files = Vec::new();
    let mut count = 0usize;
    let mut total: u64 = 0;
    for res in archive.entries().context("cannot read tar stream")? {
        let mut entry = res.context("cannot read tar entry")?;
        count += 1;
        if count > MAX_EXTRACT_ENTRIES {
            bail!("more than {} entries — refused", MAX_EXTRACT_ENTRIES);
        }
        let etype = entry.header().entry_type();
        let name = entry.path()?.to_string_lossy().into_owned();
        match etype {
            tar::EntryType::Directory => {
                let dir = safe_target(root, &name)?;
                std::fs::create_dir_all(&dir)
                    .with_context(|| format!("create {}", dir.display()))?;
            }
            tar::EntryType::Regular => {
                let declared = entry.header().size()?;
                total += declared;
                if declared > MAX_EXTRACT_BYTES || total > MAX_EXTRACT_BYTES {
                    bail!("more than {} bytes of content — refused", MAX_EXTRACT_BYTES);
                }
                let target = safe_target(root, &name)?;
                let mut out = std::fs::File::create(&target)
                    .with_context(|| format!("create {}", target.display()))?;
                std::io::copy(&mut entry, &mut out)?;
                files.push(ui_path(&target));
            }
            // Links, fifos, devices: skipped, never created.
            _ => continue,
        }
    }
    Ok(files)
}

/// A lone .gz: one file, named from the gzip header or the file name minus
/// ".gz". The byte gate here counts what actually inflates, because a gzip
/// stream declares no size.
fn extract_gz_single(arc: &Path, root: &Path) -> Result<Vec<String>> {
    use flate2::read::GzDecoder;
    let dec = GzDecoder::new(std::fs::File::open(arc)?);
    let name = dec
        .header()
        .and_then(|h| h.filename())
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_inner_name(arc));
    let target = safe_target(root, &name)?;
    let mut out =
        std::fs::File::create(&target).with_context(|| format!("create {}", target.display()))?;
    // take(cap+1): if more than the cap inflates, the copy sees the excess
    // and the write is refused (and the partial file removed).
    let mut probe = dec.take(MAX_EXTRACT_BYTES + 1);
    let written = std::io::copy(&mut probe, &mut out).unwrap_or(0);
    if written > MAX_EXTRACT_BYTES {
        drop(out);
        let _ = std::fs::remove_file(&target);
        bail!("more than {} bytes inflated — refused", MAX_EXTRACT_BYTES);
    }
    Ok(vec![ui_path(&target)])
}

/// The zip-slip guard itself. An entry name is reduced to plain components
/// and joined under `root`; the target's parent is created and
/// canonicalized, and the canonical parent must still be inside `root`.
/// Refusal happens before any entry bytes are written.
fn safe_target(root: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty() {
        bail!("empty entry name");
    }
    let mut cleaned = PathBuf::new();
    for c in Path::new(name).components() {
        match c {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            // "..", leading "/", Windows drive prefixes: all escape routes.
            _ => bail!("entry {name:?} escapes the extraction folder"),
        }
    }
    if cleaned.as_os_str().is_empty() {
        bail!("entry {name:?} names nothing to write");
    }
    let target = root.join(&cleaned);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        // Belt and braces: whatever the name said, the real directory the
        // file would land in must canonicalize back inside the extraction
        // folder.
        let canon_parent = canonical_dir(parent);
        if !canon_parent.starts_with(root) {
            bail!("entry {name:?} escapes the extraction folder");
        }
    }
    Ok(target)
}

/// Zip symlink entries: the mode's file-type bits say S_IFLNK.
fn is_symlink_mode(mode: Option<u32>) -> bool {
    const S_IFMT: u32 = 0o170000;
    const S_IFLNK: u32 = 0o120000;
    matches!(mode, Some(m) if m & S_IFMT == S_IFLNK)
}

/// Same rule as the listing's default_inner_name, for a lone gz extracted
/// rather than listed.
fn default_inner_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let b = name.as_bytes();
    if b.len() > 3 && b[b.len() - 3..].eq_ignore_ascii_case(b".gz") {
        return name[..name.len() - 3].to_string();
    }
    if b.len() > 4 && b[b.len() - 4..].eq_ignore_ascii_case(b".tgz") {
        return format!("{}.tar", &name[..name.len() - 4]);
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FsBackend;
    use std::fs::File;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cal-compress-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A small tree: a folder with a nested file plus a loose file beside it.
    fn sample_tree(dir: &Path) {
        std::fs::create_dir_all(dir.join("docs/deep")).unwrap();
        std::fs::write(dir.join("docs/deep/notes.txt"), b"nested notes").unwrap();
        std::fs::write(dir.join("docs/readme.md"), b"read me").unwrap();
        std::fs::write(dir.join("loose.txt"), b"loose file").unwrap();
    }

    /// A minimal stored-method zip built byte by byte. The zip crate's writer
    /// sanitizes names, so hostile fixtures (a `../` member, a lying size)
    /// have to come from raw bytes — which is also what a real hostile zip
    /// looks like.
    fn raw_zip(name: &str, data: &[u8], declared_size: Option<u64>) -> Vec<u8> {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let crc = crc.sum();
        let usize_decl = declared_size.unwrap_or(data.len() as u64);

        let mut local = Vec::new();
        local.extend_from_slice(b"PK\x03\x04");
        local.extend_from_slice(&20u16.to_le_bytes()); // version needed
        local.extend_from_slice(&0u16.to_le_bytes()); // flags
        local.extend_from_slice(&0u16.to_le_bytes()); // method: stored
        local.extend_from_slice(&0u16.to_le_bytes()); // mod time
        local.extend_from_slice(&0u16.to_le_bytes()); // mod date
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes()); // csize: honest
        local.extend_from_slice(&(usize_decl as u32).to_le_bytes()); // usize: as asked
        local.extend_from_slice(&(name.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes()); // extra len
        local.extend_from_slice(name.as_bytes());
        local.extend_from_slice(data);

        let mut central = Vec::new();
        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&0u16.to_le_bytes()); // method: stored
        central.extend_from_slice(&0u16.to_le_bytes()); // time
        central.extend_from_slice(&0u16.to_le_bytes()); // date
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(usize_decl as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk start
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // local header offset
        central.extend_from_slice(name.as_bytes());

        let mut out = local;
        let cd_offset = out.len() as u32;
        let cd_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
        out.extend_from_slice(&1u16.to_le_bytes()); // entries this disk
        out.extend_from_slice(&1u16.to_le_bytes()); // entries total
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // comment len
        out
    }

    /// A minimal single-entry ustar archive as raw bytes. The tar crate's
    /// builder refuses `..` member names (as does the zip writer), so a
    /// hostile fixture is written byte by byte — header fields are fixed
    /// octal ASCII at fixed offsets, POSIX magic, checksum recomputed after
    /// the name lands in the header.
    fn raw_tar(name: &str, data: &[u8]) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..108].copy_from_slice(b"0000644\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        h[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[156] = b'0'; // typeflag: regular file
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        // Checksum: the sum of every header byte with the checksum field
        // read as spaces, written back as six octal digits + NUL + space.
        for b in &mut h[148..156] {
            *b = b' ';
        }
        let sum: u32 = h.iter().map(|&b| b as u32).sum();
        h[148..156].copy_from_slice(format!("{:06o}\0 ", sum).as_bytes());
        let mut out = h;
        out.extend_from_slice(data);
        while !out.len().is_multiple_of(512) {
            out.push(0);
        }
        out.extend(std::iter::repeat_n(0u8, 1024)); // end-of-archive blocks
        out
    }

    /// Round trip both formats, prove the folder structure survives, the
    /// archive yields by number when its name is taken, and the listing the
    /// preview shows matches what extraction actually produces.
    #[test]
    fn create_and_extract_roundtrip_both_formats() {
        let dir = scratch("roundtrip");
        sample_tree(&dir);
        let fs = FsBackend::new();

        for fmt in ["zip", "tgz"] {
            // One landing folder per format: the yield numbering below counts
            // from a clean slate either way.
            let into = dir.join(format!("into-{fmt}"));
            std::fs::create_dir_all(&into).unwrap();
            // Both entries selected: archive named after the first ("docs").
            let landed = fs
                .archive_create(
                    &[
                        dir.join("docs").to_str().unwrap().into(),
                        dir.join("loose.txt").to_str().unwrap().into(),
                    ],
                    into.to_str().unwrap(),
                    fmt,
                )
                .unwrap();
            assert!(landed.ends_with(&format!("docs.{fmt}")), "{landed}");

            // The listing (what the preview shows) and the extraction agree.
            let insp = fs.inspect(&landed).unwrap();
            let crate::Inspection::Archive { entries, .. } = insp else {
                panic!("expected an archive listing");
            };
            let out = fs.archive_extract(&landed, into.to_str().unwrap()).unwrap();
            let folder = PathBuf::from(&out.dir);
            assert_eq!(
                folder.file_name().unwrap(),
                "docs",
                "fresh same-named folder: {}",
                out.dir
            );
            let listed_files: Vec<&str> = entries
                .iter()
                .filter(|e| !e.dir)
                .map(|e| e.path.as_str())
                .collect();
            for rel in &listed_files {
                let extracted = folder.join(rel);
                assert!(extracted.is_file(), "{fmt}: {rel} listed but not extracted");
            }
            assert_eq!(
                std::fs::read(folder.join("docs/deep/notes.txt")).unwrap(),
                b"nested notes",
                "{fmt}: nested content must survive"
            );
            assert_eq!(
                std::fs::read(folder.join("loose.txt")).unwrap(),
                b"loose file",
                "{fmt}: the second selection is in the archive too"
            );

            // Compressing the same thing again lands on a yielded name.
            let again = fs
                .archive_create(
                    &[dir.join("docs").to_str().unwrap().into()],
                    into.to_str().unwrap(),
                    fmt,
                )
                .unwrap();
            assert!(
                again.ends_with(&format!("docs 2.{fmt}"))
                    || (fmt == "tgz" && again.ends_with("docs 2.tgz")),
                "yielded name: {again}"
            );

            // Extracting the same archive again yields the FOLDER name.
            let out2 = fs.archive_extract(&landed, into.to_str().unwrap()).unwrap();
            assert!(
                out2.dir.ends_with("docs 2"),
                "folder must yield too: {}",
                out2.dir
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A zip member named `../evil.txt` must be refused before anything is
    /// written — neither the escape file nor a half-extracted folder may
    /// appear. The same for a tar member (built with the tar crate, which
    /// unlike the zip writer does not sanitize names).
    #[test]
    fn zip_slip_and_tar_slip_are_refused() {
        let dir = scratch("slip");
        let fs = FsBackend::new();

        let evil_zip = dir.join("evil.zip");
        std::fs::write(&evil_zip, raw_zip("../evil.txt", b"stolen", None)).unwrap();
        let err = fs
            .archive_extract(evil_zip.to_str().unwrap(), dir.to_str().unwrap())
            .unwrap_err();
        assert!(err.to_string().contains("escapes"), "{err}");
        assert!(!dir.join("evil.txt").exists(), "nothing may land outside");
        assert!(
            !dir.join("evil").exists(),
            "a refused extraction leaves no folder behind"
        );

        // Same escape in a tar. Both archive writers sanitize member names,
        // so the hostile tar is raw bytes too: a hand-built ustar header
        // whose name field says "../escaped.txt".
        let evil_tar = dir.join("evil.tar");
        std::fs::write(&evil_tar, raw_tar("../escaped.txt", b"tar slip")).unwrap();
        let err = fs
            .archive_extract(evil_tar.to_str().unwrap(), dir.to_str().unwrap())
            .unwrap_err();
        assert!(err.to_string().contains("escapes"), "{err}");
        assert!(!dir.join("escaped.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The two extraction gates: too many entries, and a member declaring
    /// more uncompressed bytes than the cap — the latter refused before any
    /// byte inflates.
    #[test]
    fn extraction_gates_refuse_bombs() {
        let dir = scratch("gates");
        let fs = FsBackend::new();

        // Entry-count gate: MAX+1 tiny members. (The craft helper writes
        // one member per central-directory record, so this is a loop of
        // whole zips concatenated is NOT valid — build with the writer,
        // Stored method for speed; its names are all innocent.)
        let many = dir.join("many.zip");
        let mut w = zip::ZipWriter::new(File::create(&many).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for i in 0..=MAX_EXTRACT_ENTRIES {
            w.start_file(format!("f{i}.txt"), opts).unwrap();
            w.write_all(b"x").unwrap();
        }
        w.finish().unwrap();
        let err = fs
            .archive_extract(many.to_str().unwrap(), dir.to_str().unwrap())
            .unwrap_err();
        assert!(
            err.to_string().contains("entries"),
            "entry-count gate: {err}"
        );

        // Byte gate: a member declaring 2 GiB+ of content.
        let bomb = dir.join("bomb.zip");
        std::fs::write(
            &bomb,
            raw_zip("innocent.txt", b"small", Some(MAX_EXTRACT_BYTES + 1)),
        )
        .unwrap();
        let err = fs
            .archive_extract(bomb.to_str().unwrap(), dir.to_str().unwrap())
            .unwrap_err();
        assert!(
            err.to_string().contains("declares"),
            "byte gate must trip on the declared size: {err}"
        );
        assert!(
            !dir.join("bomb/innocent.txt").exists(),
            "nothing may be written past a refusal"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A lone .gz extracts to its inner name inside the fresh folder, and
    /// the outcome reports the file it wrote.
    #[test]
    fn lone_gz_extracts_one_file() {
        let dir = scratch("gz");
        let fs = FsBackend::new();
        let gz = dir.join("note.txt.gz");
        let mut enc = flate2::write::GzEncoder::new(
            File::create(&gz).unwrap(),
            flate2::Compression::default(),
        );
        enc.write_all(b"gz payload").unwrap();
        enc.finish().unwrap();

        let out = fs
            .archive_extract(gz.to_str().unwrap(), dir.to_str().unwrap())
            .unwrap();
        assert!(out.dir.ends_with("note.txt"), "{}", out.dir);
        assert_eq!(out.files.len(), 1);
        assert_eq!(
            std::fs::read(PathBuf::from(&out.files[0])).unwrap(),
            b"gz payload"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
