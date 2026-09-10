//! Metadata inspection for the explorer's preview pane.
//!
//! The files handled here are unreadable as bytes — their value is the
//! metadata they carry. Three rules bind
//! every branch:
//!   1. **Read-only.** Nothing is written to disk and nothing is executed;
//!      inspection is a pure function of the file's bytes.
//!   2. **Never expose private key material.** A key block is reported by its
//!      PEM label only; its body is never parsed, decoded, or copied out in
//!      any form — previewing a private key would copy the secret onto the
//!      screen (and into logs, screenshots, remote-control frames...).
//!   3. **Decompress only what listing needs.** Archives are listed from
//!      entry headers; entry contents stay compressed.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

use x509_parser::asn1_rs::{oid, Oid};
use x509_parser::certification_request::X509CertificationRequest;
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::prelude::{FromDer, X509Certificate, X509Name};
use x509_parser::public_key::PublicKey;
use x509_parser::x509::SubjectPublicKeyInfo;

use crate::{canonical_dir, expand_path, FsBackend};

/// What the preview pane renders, keyed by the `type` tag.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inspection {
    #[serde(rename_all = "camelCase")]
    Certificates {
        items: Vec<CertInfo>,
        /// PEM label of a private-key block found in the file (e.g.
        /// "RSA PRIVATE KEY"). The label is all we ever report — see rule 2
        /// in the module comment.
        private_key: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Archive {
        entries: Vec<ArchiveEntry>,
        /// Real entry count, so a capped listing can say "2000 of N".
        total: usize,
        truncated: bool,
    },
    Plist {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Sqlite {
        tables: Vec<SqliteTable>,
    },
    #[serde(rename_all = "camelCase")]
    Font {
        family: String,
        style: String,
        glyph_count: u32,
        variable: bool,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        width: u32,
        height: u32,
    },
    #[serde(rename_all = "camelCase")]
    Executable {
        /// "mach-o" | "elf" | "pe" | "script".
        format: String,
        /// One per architecture; fat/universal binaries report every slice.
        archs: Vec<ExecArch>,
        /// Scripts: the interpreter named after "#!" (the whole line, as
        /// written — arguments included).
        interpreter: Option<String>,
        /// Unix: any execute bit set on the file mode. Always false on
        /// Windows, which has no such bit (the system_open precedent).
        executable_bit: bool,
        /// Mach-O: an LC_CODE_SIGNATURE load command exists. A byte-level
        /// fact only — validity is never verified and codesign is never
        /// run (module rules: pure function of the bytes).
        has_code_signature: Option<bool>,
        /// Mach-O: an LC_MAIN load command exists (the entry the loader
        /// jumps to).
        has_entry_point: Option<bool>,
        /// Mach-O: LC_LOAD_DYLIB count. Fat binaries report the FIRST
        /// slice's — per-slice dependency lists would be a wall, and the
        /// first slice is the one the loader tries first.
        dylib_count: Option<usize>,
        /// Mach-O: the first five linked library names (same first-slice
        /// boundary as dylib_count).
        dylibs: Option<Vec<String>>,
    },
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecArch {
    /// CPU name: "arm64", "x86_64", "arm64e", ... Unknown values fall back
    /// to the raw number rather than a guess.
    pub arch: String,
    /// Address width in bits (32/64).
    pub bits: u32,
    /// The file's role where the format states one: "executable",
    /// "dylib", "shared object", ...
    pub file_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// "certificate" or "csr".
    pub kind: String,
    pub subject_cn: String,
    pub subject: String,
    pub issuer: String,
    pub sans: Vec<String>,
    /// Unix seconds; 0 for a CSR, which has no validity yet.
    pub not_before: i64,
    pub not_after: i64,
    /// Colon-separated hex, empty for a CSR (no serial until issuance).
    pub serial: String,
    pub sig_alg: String,
    /// Key algorithm with bit size / curve where knowable ("RSA 2048",
    /// "ECDSA P-256", "Ed25519").
    pub key_alg: String,
    /// Colon-separated hex SHA-256 fingerprint of the DER bytes.
    pub sha256: String,
    pub is_ca: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteTable {
    pub name: String,
    pub rows: i64,
    pub columns: Vec<String>,
}

/// One page of a table, everything already rendered to display text — the
/// frontend shows cells, it does not interpret sqlite types.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// Full row count of the table, so the pager can say "50 of N".
    pub total: i64,
}

/// Archive listings stop here; `total` still reports the real count.
pub const MAX_ARCHIVE_ENTRIES: usize = 2000;

/// A real certificate bundle is a few KB. A multi-megabyte file wearing a
/// cert extension is mislabeled, and slurping it whole buys nothing.
const MAX_CERT_BYTES: u64 = 10 * 1024 * 1024;

impl FsBackend {
    pub fn inspect(&self, path: &str) -> Result<Inspection> {
        let raw = expand_path(path);
        // Same symlink normalization as read_file: canonicalize the
        // containing directory, keep the file name as given.
        let p = match (raw.parent(), raw.file_name()) {
            (Some(parent), Some(name)) => canonical_dir(parent).join(name),
            _ => raw,
        };
        let meta = std::fs::metadata(&p).with_context(|| format!("cannot stat {}", p.display()))?;
        if meta.is_dir() {
            return Err(anyhow!("{} is a directory", p.display()));
        }
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        // SQLite routes on content, not extension: the header magic is
        // authoritative whatever the file is called, and a db-ish extension
        // without it is a mislabeled file that must never reach the sqlite
        // parser.
        if has_sqlite_magic(&p) {
            return inspect_sqlite(&p);
        }
        if let Some(insp) = inspect_executable(&p) {
            return Ok(insp);
        }
        match ext.as_str() {
            "pem" | "crt" | "cer" | "der" | "csr" | "key" => {
                if meta.len() > MAX_CERT_BYTES {
                    return Err(anyhow!(
                        "{} is {} bytes — too large to be certificate material",
                        p.display(),
                        meta.len()
                    ));
                }
                inspect_certificates(&p, &ext)
            }
            "zip" => inspect_zip(&p),
            "tar" => inspect_tar(std::fs::File::open(&p)?),
            // ".tar.gz" arrives here as "gz"; inspect_gz sniffs the tar case.
            "gz" | "tgz" => inspect_gz(&p, meta.len()),
            "plist" => inspect_plist(&p),
            // The extension claimed sqlite but the magic (checked above) did
            // not match — treat as opaque rather than feed it to the parser.
            "db" | "sqlite" | "sqlite3" | "db3" => Ok(Inspection::Unsupported),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "heic" => {
                Ok(inspect_image(&p))
            }
            "ttf" | "otf" => inspect_font(&p),
            // woff/woff2 metadata needs a decompression stack, and ttc a
            // collection walk, for data the frontend can live without: it
            // renders a specimen with no metadata for these.
            "woff" | "woff2" | "ttc" => Ok(Inspection::Unsupported),
            _ => Ok(Inspection::Unsupported),
        }
    }

    /// One page of table rows from a SQLite database, read with the same
    /// zero-side-effect open as `inspect` (see `open_sqlite_readonly`).
    pub fn sqlite_rows(
        &self,
        path: &str,
        table: &str,
        limit: u32,
        offset: u32,
    ) -> Result<SqliteRows> {
        let raw = expand_path(path);
        let p = match (raw.parent(), raw.file_name()) {
            (Some(parent), Some(name)) => canonical_dir(parent).join(name),
            _ => raw,
        };
        if !has_sqlite_magic(&p) {
            return Err(anyhow!("{} is not a SQLite database", p.display()));
        }
        let conn = open_sqlite_readonly(&p)?;
        // The table name is file content — an attacker names tables, we
        // don't. Only a name that the database itself lists may proceed, and
        // even then it is quoted as an identifier, never spliced in raw.
        if !sqlite_table_names(&conn)?.iter().any(|t| t == table) {
            return Err(anyhow!("no table named {table:?} in {}", p.display()));
        }
        let quoted = quote_ident(table);
        let total: i64 =
            conn.query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |r| r.get(0))?;
        let mut stmt = conn.prepare(&format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2"))?;
        let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let ncols = columns.len();
        let mut out = Vec::new();
        let mut rows = stmt.query(rusqlite::params![limit, offset])?;
        while let Some(row) = rows.next()? {
            let mut cells = Vec::with_capacity(ncols);
            for i in 0..ncols {
                cells.push(cell_text(row.get_ref(i)?));
            }
            out.push(cells);
        }
        Ok(SqliteRows {
            columns,
            rows: out,
            total,
        })
    }
}

// ---------------------------------------------------------------------------
// Certificates

fn inspect_certificates(path: &Path, ext: &str) -> Result<Inspection> {
    let bytes = std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;

    let blocks = pem_block_starts(&bytes);
    if blocks.is_empty() {
        return inspect_cert_der(&bytes, ext, path);
    }

    let mut items = Vec::new();
    let mut private_key: Option<String> = None;
    let mut first_err: Option<anyhow::Error> = None;
    for (label, offset) in blocks {
        // Refusing to show key material is the point: a key block's body is
        // never parsed, decoded, or copied out — only its label is reported.
        // This covers "RSA/EC/ENCRYPTED/OPENSSH/plain PRIVATE KEY" alike.
        if label.contains("PRIVATE KEY") {
            private_key.get_or_insert(label);
            continue;
        }
        let parsed =
            match label.as_str() {
                "CERTIFICATE" | "TRUSTED CERTIFICATE" => decode_pem_block(&bytes[offset..])
                    .and_then(|der| {
                        let (_, cert) = X509Certificate::from_der(&der)
                            .map_err(|e| anyhow!("bad certificate block: {e}"))?;
                        Ok(cert_info(&cert, &der))
                    }),
                l if l.ends_with("CERTIFICATE REQUEST") => decode_pem_block(&bytes[offset..])
                    .and_then(|der| {
                        let (_, csr) = X509CertificationRequest::from_der(&der)
                            .map_err(|e| anyhow!("bad certificate request block: {e}"))?;
                        Ok(csr_info(&csr, &der))
                    }),
                // Other labels (DH PARAMETERS, PUBLIC KEY, ...) carry nothing the
                // preview shows; skip them rather than fail the whole file.
                _ => continue,
            };
        match parsed {
            Ok(info) => items.push(info),
            // One broken block must not hide the rest of a chain.
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    if items.is_empty() && private_key.is_none() {
        return Err(
            first_err.unwrap_or_else(|| anyhow!("no certificate material in {}", path.display()))
        );
    }
    Ok(Inspection::Certificates { items, private_key })
}

/// Non-PEM bytes with a certificate extension: raw DER.
fn inspect_cert_der(bytes: &[u8], ext: &str, path: &Path) -> Result<Inspection> {
    if let Ok((_, cert)) = X509Certificate::from_der(bytes) {
        return Ok(Inspection::Certificates {
            items: vec![cert_info(&cert, bytes)],
            private_key: None,
        });
    }
    if ext == "csr" {
        if let Ok((_, csr)) = X509CertificationRequest::from_der(bytes) {
            return Ok(Inspection::Certificates {
                items: vec![csr_info(&csr, bytes)],
                private_key: None,
            });
        }
    }
    if ext == "key" {
        // An opaque .key that isn't PEM is still a key (likely DER PKCS#8).
        // Report the type only; the bytes are never decoded (rule 2).
        return Ok(Inspection::Certificates {
            items: vec![],
            private_key: Some("PRIVATE KEY".to_string()),
        });
    }
    Err(anyhow!(
        "{} is neither PEM nor a DER certificate",
        path.display()
    ))
}

/// Byte offsets of every `-----BEGIN <LABEL>-----` marker, with the label.
///
/// This is a scanner, not a parser: block bodies are NOT decoded here, so a
/// private-key body is never touched. Decoding happens in the caller and only
/// for certificate-bearing labels.
fn pem_block_starts(bytes: &[u8]) -> Vec<(String, usize)> {
    const BEGIN: &[u8] = b"-----BEGIN ";
    const DASHES: &[u8] = b"-----";
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(pos) = find(&bytes[i..], BEGIN) {
        let start = i + pos;
        let label_start = start + BEGIN.len();
        match find(&bytes[label_start..], DASHES) {
            Some(end) => {
                let label = String::from_utf8_lossy(&bytes[label_start..label_start + end])
                    .trim()
                    .to_string();
                out.push((label, start));
                i = label_start + end + DASHES.len();
            }
            None => break, // unterminated BEGIN line: nothing more to find
        }
    }
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Decode one PEM block (slice starts at its BEGIN marker) to DER.
fn decode_pem_block(from_begin: &[u8]) -> Result<Vec<u8>> {
    let (_, pem) =
        x509_parser::pem::parse_x509_pem(from_begin).map_err(|e| anyhow!("bad PEM block: {e}"))?;
    Ok(pem.contents)
}

fn cert_info(cert: &X509Certificate, der: &[u8]) -> CertInfo {
    let tbs = &cert.tbs_certificate;
    let sans = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|ext| {
            ext.value
                .general_names
                .iter()
                .map(general_name_string)
                .collect()
        })
        .unwrap_or_default();
    CertInfo {
        kind: "certificate".to_string(),
        subject_cn: first_cn(&tbs.subject),
        subject: tbs.subject.to_string(),
        issuer: tbs.issuer.to_string(),
        sans,
        not_before: tbs.validity.not_before.timestamp(),
        not_after: tbs.validity.not_after.timestamp(),
        serial: tbs.raw_serial_as_string(),
        sig_alg: sig_alg_name(&cert.signature_algorithm.algorithm),
        key_alg: key_alg_name(&tbs.subject_pki),
        sha256: sha256_fingerprint(der),
        is_ca: cert.is_ca(),
    }
}

fn csr_info(csr: &X509CertificationRequest, der: &[u8]) -> CertInfo {
    let info = &csr.certification_request_info;
    let mut sans = Vec::new();
    if let Some(exts) = csr.requested_extensions() {
        for ext in exts {
            if let ParsedExtension::SubjectAlternativeName(san) = ext {
                sans.extend(san.general_names.iter().map(general_name_string));
            }
        }
    }
    CertInfo {
        kind: "csr".to_string(),
        subject_cn: first_cn(&info.subject),
        subject: info.subject.to_string(),
        // A CSR is a request, not a grant: no issuer, validity, or serial yet.
        issuer: String::new(),
        sans,
        not_before: 0,
        not_after: 0,
        serial: String::new(),
        sig_alg: sig_alg_name(&csr.signature_algorithm.algorithm),
        key_alg: key_alg_name(&info.subject_pki),
        sha256: sha256_fingerprint(der),
        is_ca: false,
    }
}

fn first_cn(name: &X509Name) -> String {
    name.iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn general_name_string(gn: &GeneralName) -> String {
    match gn {
        GeneralName::DNSName(d) => d.to_string(),
        GeneralName::RFC822Name(m) => m.to_string(),
        GeneralName::URI(u) => u.to_string(),
        GeneralName::IPAddress(b) => match b.len() {
            4 => std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string(),
            16 => {
                let mut o = [0u8; 16];
                o.copy_from_slice(b);
                std::net::Ipv6Addr::from(o).to_string()
            }
            _ => format!("{gn:?}"), // malformed address: show the raw form
        },
        GeneralName::DirectoryName(n) => n.to_string(),
        other => format!("{other:?}"),
    }
}

/// The signature algorithms that occur in practice, by OID; anything else
/// falls back to the dotted OID rather than guessing a name.
fn sig_alg_name(alg: &Oid) -> String {
    let name = if *alg == oid!(1.2.840 .113549 .1 .1 .11) {
        "SHA-256 with RSA"
    } else if *alg == oid!(1.2.840 .113549 .1 .1 .12) {
        "SHA-384 with RSA"
    } else if *alg == oid!(1.2.840 .113549 .1 .1 .13) {
        "SHA-512 with RSA"
    } else if *alg == oid!(1.2.840 .113549 .1 .1 .5) {
        "SHA-1 with RSA"
    } else if *alg == oid!(1.2.840 .113549 .1 .1 .10) {
        "RSASSA-PSS"
    } else if *alg == oid!(1.2.840 .10045 .4 .3 .2) {
        "ECDSA with SHA-256"
    } else if *alg == oid!(1.2.840 .10045 .4 .3 .3) {
        "ECDSA with SHA-384"
    } else if *alg == oid!(1.2.840 .10045 .4 .3 .4) {
        "ECDSA with SHA-512"
    } else if *alg == oid!(1.3.101 .112) {
        "Ed25519"
    } else if *alg == oid!(1.3.101 .113) {
        "Ed448"
    } else {
        return alg.to_id_string();
    };
    name.to_string()
}

fn key_alg_name(spki: &SubjectPublicKeyInfo) -> String {
    let alg = &spki.algorithm.algorithm;
    // Ed keys carry the algorithm in the OID alone; parsed() has no variant.
    if *alg == oid!(1.3.101 .112) {
        return "Ed25519".to_string();
    }
    if *alg == oid!(1.3.101 .113) {
        return "Ed448".to_string();
    }
    match spki.parsed() {
        Ok(PublicKey::RSA(rsa)) => {
            // A DER integer may carry a leading zero octet; that is sign
            // padding, not key size — skip it or 2048-bit keys read as 2056.
            let bits = rsa.modulus.iter().skip_while(|b| **b == 0).count() * 8;
            format!("RSA {bits}")
        }
        Ok(PublicKey::EC(_)) => {
            let curve = spki
                .algorithm
                .parameters
                .as_ref()
                .and_then(|p| p.clone().oid().ok())
                .and_then(|o| curve_name(&o));
            match curve {
                Some(c) => format!("ECDSA {c}"),
                None => "ECDSA".to_string(),
            }
        }
        Ok(PublicKey::DSA(_)) => "DSA".to_string(),
        _ => alg.to_id_string(),
    }
}

fn curve_name(o: &Oid) -> Option<&'static str> {
    if *o == oid!(1.2.840 .10045 .3 .1 .7) {
        Some("P-256")
    } else if *o == oid!(1.3.132 .0 .34) {
        Some("P-384")
    } else if *o == oid!(1.3.132 .0 .35) {
        Some("P-521")
    } else if *o == oid!(1.3.132 .0 .10) {
        Some("secp256k1")
    } else {
        None
    }
}

/// OpenSSL-style fingerprint: uppercase hex, colon-separated.
fn sha256_fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

// ---------------------------------------------------------------------------
// Archives

fn inspect_zip(path: &Path) -> Result<Inspection> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("{} is not a valid zip", path.display()))?;
    let total = archive.len();
    let listed = total.min(MAX_ARCHIVE_ENTRIES);
    let mut entries = Vec::with_capacity(listed);
    for i in 0..listed {
        // by_index_raw reads the entry header only: contents are never
        // decompressed (rule 3), which also sidesteps every codec.
        let f = archive.by_index_raw(i)?;
        entries.push(ArchiveEntry {
            path: f.name().to_string(),
            size: f.size(),
            dir: f.is_dir(),
        });
    }
    Ok(Inspection::Archive {
        entries,
        total,
        truncated: total > MAX_ARCHIVE_ENTRIES,
    })
}

fn inspect_tar<R: Read>(reader: R) -> Result<Inspection> {
    let mut archive = tar::Archive::new(reader);
    let mut entries = Vec::new();
    let mut total = 0usize;
    for res in archive.entries().context("cannot read tar stream")? {
        let entry = match res {
            Ok(e) => e,
            // A corrupt or truncated tail must not hide the entries already
            // listed; a stream that breaks immediately is still an error.
            Err(e) => {
                if total > 0 {
                    break;
                }
                return Err(e).context("cannot read tar entries");
            }
        };
        total += 1;
        if entries.len() < MAX_ARCHIVE_ENTRIES {
            entries.push(ArchiveEntry {
                path: entry.path()?.to_string_lossy().to_string(),
                size: entry.size(),
                dir: entry.header().entry_type().is_dir(),
            });
        }
        // Past the cap we keep walking headers only, so `total` stays honest.
    }
    Ok(Inspection::Archive {
        truncated: total > entries.len(),
        total,
        entries,
    })
}

fn inspect_gz(path: &Path, compressed_len: u64) -> Result<Inspection> {
    use flate2::read::GzDecoder;
    // Sniff for a tar stream by decompressing only the first 512-byte header
    // block and checking the ustar magic — the file name alone ("foo.gz")
    // cannot tell a tarball from a lone compressed file.
    let mut dec = GzDecoder::new(std::fs::File::open(path)?);
    let mut head = [0u8; 512];
    let mut n = 0usize;
    loop {
        match dec.read(&mut head[n..]) {
            Ok(0) => break,
            Ok(m) => {
                n += m;
                if n == head.len() {
                    break;
                }
            }
            Err(e) => return Err(anyhow!("{} is not a valid gzip: {e}", path.display())),
        }
    }
    if n == 512 && &head[257..262] == b"ustar" {
        // Restart the stream: the tar reader needs the header block too.
        return inspect_tar(GzDecoder::new(std::fs::File::open(path)?));
    }

    // A lone compressed file: one logical entry. Prefer the original name
    // recorded in the gzip header; fall back to the file name minus ".gz".
    let name = dec
        .header()
        .and_then(|h| h.filename())
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_inner_name(path));

    let size = if n < head.len() {
        // The whole payload fit inside the sniff buffer: that count is exact,
        // and nothing beyond it was ever decompressed.
        n as u64
    } else {
        // ISIZE trailer (last 4 bytes, little-endian): exact below 4 GiB and
        // free to read, unlike decompressing the stream to measure it.
        read_gz_isize(path).unwrap_or(compressed_len)
    };
    Ok(Inspection::Archive {
        entries: vec![ArchiveEntry {
            path: name,
            size,
            dir: false,
        }],
        total: 1,
        truncated: false,
    })
}

fn read_gz_isize(path: &Path) -> Option<u64> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    // A gzip member is at least a 10-byte header plus an 8-byte trailer;
    // anything shorter has no trailer to read.
    if f.metadata().ok()?.len() < 18 {
        return None;
    }
    f.seek(SeekFrom::End(-4)).ok()?;
    let mut b = [0u8; 4];
    f.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b) as u64)
}

fn default_inner_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let b = name.as_bytes();
    // ASCII suffixes, so the byte split below always lands on a char boundary.
    if b.len() > 3 && b[b.len() - 3..].eq_ignore_ascii_case(b".gz") {
        return name[..name.len() - 3].to_string();
    }
    if b.len() > 4 && b[b.len() - 4..].eq_ignore_ascii_case(b".tgz") {
        return format!("{}.tar", &name[..name.len() - 4]);
    }
    name
}

// ---------------------------------------------------------------------------
// SQLite

/// First 16 bytes of every SQLite 3 database file.
pub(crate) const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

fn has_sqlite_magic(path: &Path) -> bool {
    let mut head = [0u8; 16];
    let read_ok = std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok();
    read_ok && &head == SQLITE_MAGIC
}

/// Open a database with zero side effects on the filesystem.
///
/// READ_ONLY alone is not enough: a plain read-only open of a WAL-mode
/// database still creates the -shm coordination file (and can recover into
/// -wal) next to the user's data, and a preview must write NOTHING there.
/// `immutable=1` tells sqlite the file cannot change underneath it, so it
/// skips locking, shared memory, and journal recovery entirely. The flag only
/// exists in URI form, hence SQLITE_OPEN_URI plus the percent-encoded path.
fn open_sqlite_readonly(path: &Path) -> Result<rusqlite::Connection> {
    use rusqlite::OpenFlags;
    let uri = format!("file:{}?immutable=1", percent_encode_path(path));
    rusqlite::Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("cannot open {} as sqlite", path.display()))
}

/// Percent-encode a path for a `file:` URI: everything outside the URI
/// "unreserved" set plus '/' is escaped, so '?', '#', or '%' in a file name
/// cannot be misread as URI syntax (and non-ASCII survives byte-exact).
fn percent_encode_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    // sqlite accepts forward slashes in Windows file: URIs; backslashes
    // would need escaping and buy nothing.
    #[cfg(windows)]
    let s = s.replace('\\', "/");
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Quote as a double-quoted SQL identifier. Table names come out of the file
/// being previewed, i.e. they are untrusted input; quoting (with embedded
/// quotes doubled) is what keeps them data instead of SQL.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// User tables, in sqlite_master order. `sqlite_`-prefixed names are the
/// engine's own bookkeeping (sqlite_sequence, stat tables) — noise here.
fn sqlite_table_names(conn: &rusqlite::Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master \
         WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names)
}

fn inspect_sqlite(path: &Path) -> Result<Inspection> {
    let conn = open_sqlite_readonly(path)?;
    let mut tables = Vec::new();
    for name in sqlite_table_names(&conn)? {
        let quoted = quote_ident(&name);
        let rows: i64 =
            conn.query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |r| r.get(0))?;
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({quoted})"))?;
        let columns = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        tables.push(SqliteTable {
            name,
            rows,
            columns,
        });
    }
    Ok(Inspection::Sqlite { tables })
}

/// A cell never becomes megabytes of text: 500 chars is more than a preview
/// row can show, and blobs are described, never dumped — a blob may be an
/// image, a key, or anything else that has no business as text on screen.
const MAX_CELL_CHARS: usize = 500;

fn cell_text(v: rusqlite::types::ValueRef) -> String {
    use rusqlite::types::ValueRef;
    let s = match v {
        ValueRef::Null => "NULL".to_string(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => format!("<blob {} B>", b.len()),
    };
    match s.char_indices().nth(MAX_CELL_CHARS) {
        // Cut on a char boundary, not a byte one — cell 500 may be CJK.
        Some((byte_idx, _)) => format!("{}…", &s[..byte_idx]),
        None => s,
    }
}

// ---------------------------------------------------------------------------
// Images

/// Dimensions from the image header. `imagesize` reads only the few bytes
/// that carry width/height and never decodes pixel data, so this stays cheap
/// on any file size. Parse failures and formats the crate cannot read both
/// degrade to Unsupported — the frontend simply omits the dimensions line.
fn inspect_image(path: &Path) -> Inspection {
    match imagesize::size(path) {
        Ok(dim) => Inspection::Image {
            width: u32::try_from(dim.width).unwrap_or(u32::MAX),
            height: u32::try_from(dim.height).unwrap_or(u32::MAX),
        },
        Err(_) => Inspection::Unsupported,
    }
}

// ---------------------------------------------------------------------------
// Fonts

fn inspect_font(path: &Path) -> Result<Inspection> {
    use skrifa::{string::StringId, FontRef, MetadataProvider};

    let bytes = std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    let face = FontRef::from_index(&bytes, 0)
        .map_err(|e| anyhow!("cannot parse {} as a font: {e}", path.display()))?;
    // Prefer the typographic pair (ids 16/17): the legacy family (id 1) bakes
    // every non-RIBBI style into the family name, so "Light" weights read as
    // separate families. Most fonts only fill the legacy pair; fall back.
    let family = font_name(&face, StringId::TYPOGRAPHIC_FAMILY_NAME)
        .or_else(|| font_name(&face, StringId::FAMILY_NAME))
        .unwrap_or_default();
    let style = font_name(&face, StringId::TYPOGRAPHIC_SUBFAMILY_NAME)
        .or_else(|| font_name(&face, StringId::SUBFAMILY_NAME))
        .unwrap_or_default();
    Ok(Inspection::Font {
        family,
        style,
        glyph_count: face.glyph_names().num_glyphs(),
        variable: !face.axes().is_empty(),
    })
}

/// First non-empty localized name-table entry with this id. Skrifa applies
/// the table's platform encoding before yielding the text.
fn font_name(face: &skrifa::FontRef<'_>, id: skrifa::string::StringId) -> Option<String> {
    use skrifa::MetadataProvider;

    face.localized_strings(id).find_map(|name| {
        let value = name.to_string();
        (!value.is_empty()).then_some(value)
    })
}

// ---------------------------------------------------------------------------
// Plist

fn inspect_plist(path: &Path) -> Result<Inspection> {
    // plist::Value::from_file autodetects binary vs XML input.
    let value = plist::Value::from_file(path)
        .with_context(|| format!("cannot parse {} as a plist", path.display()))?;
    let mut buf = Vec::new();
    value
        .to_writer_xml(&mut buf)
        .context("cannot render plist as XML")?;
    let text = String::from_utf8(buf).context("plist XML is not UTF-8")?;
    Ok(Inspection::Plist { text })
}

/// Which executable family a file's first bytes claim. Shared by inspect()
/// (full parse) and kind_for (routing), so the two can never disagree about
/// what a file is. Magic only — the name of the file is never consulted,
/// because the main case is a CLI tool with no extension at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecFormat {
    Macho,
    Elf,
    Pe,
    Script,
}

pub(crate) fn sniff_exec_format(head: &[u8]) -> Option<ExecFormat> {
    if head.starts_with(b"#!") {
        return Some(ExecFormat::Script);
    }
    if head.starts_with(b"\x7fELF") {
        return Some(ExecFormat::Elf);
    }
    // Mach-O magics in both byte orders (0xFEEDFACE / 0xFEEDFACF as the
    // files store them); see macho_endian for which is which.
    if matches!(
        head.get(..4),
        Some(
            [0xCE, 0xFA, 0xED, 0xFE]
                | [0xCF, 0xFA, 0xED, 0xFE]
                | [0xFE, 0xED, 0xFA, 0xCE]
                | [0xFE, 0xED, 0xFA, 0xCF]
                | [0xCA, 0xFE, 0xBA, 0xBE]
                | [0xBE, 0xBA, 0xFE, 0xCA]
        )
    ) {
        return Some(ExecFormat::Macho);
    }
    if head.starts_with(b"MZ") {
        return Some(ExecFormat::Pe);
    }
    None
}

/// The full executable inspection, or None when the bytes claim no
/// executable format. Everything here reads the file's own bytes — nothing
/// is executed, and the signature answer is the presence of a load-command
/// segment, never a codesign verdict.
fn inspect_executable(path: &Path) -> Option<Inspection> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = vec![0u8; 4096];
    let n = f.by_ref().take(4096).read(&mut head).unwrap_or(0);
    head.truncate(n);
    let exec_bit = executable_bit(path);
    match sniff_exec_format(&head)? {
        ExecFormat::Script => Some(script_inspection(&head, exec_bit)),
        ExecFormat::Macho => Some(macho_inspection(&mut f, &head, exec_bit)),
        ExecFormat::Elf => Some(elf_inspection(&head, exec_bit)),
        ExecFormat::Pe => Some(pe_inspection(&head, exec_bit)),
    }
}

/// Unix: any execute bit on the file. Windows has no such bit, and saying
/// false there is the honest answer (the is_executable precedent in
/// system_open: the concept is Unix's, the port must not pretend).
fn executable_bit(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// A shebang script: the interpreter line plus the execute bit. The bytes
/// stay text — this inspection is the "Details" view, the editor remains
/// how such a file is worked on.
fn script_inspection(head: &[u8], exec_bit: bool) -> Inspection {
    let line_end = head
        .iter()
        .position(|&b| b == b'\n' || b == b'\r')
        .unwrap_or(head.len());
    let interpreter = String::from_utf8_lossy(&head[2..line_end])
        .trim()
        .to_string();
    Inspection::Executable {
        format: "script".to_string(),
        archs: Vec::new(),
        interpreter: (!interpreter.is_empty()).then_some(interpreter),
        executable_bit: exec_bit,
        has_code_signature: None,
        has_entry_point: None,
        dylib_count: None,
        dylibs: None,
    }
}

// --- Mach-O ---------------------------------------------------------------

/// (fields are little-endian) — decided from the magic's byte order. The
/// fat header is big-endian by ABI, with a swapped form for cross-endian
/// files; both are handled so a universal binary reports the same either
/// way it was written.
fn macho_endian(head: &[u8]) -> Option<bool> {
    match head.get(..4)? {
        [0xCE, 0xFA, 0xED, 0xFE] | [0xCF, 0xFA, 0xED, 0xFE] => Some(true),
        [0xFE, 0xED, 0xFA, 0xCE] | [0xFE, 0xED, 0xFA, 0xCF] => Some(false),
        _ => None,
    }
}

fn is_fat(head: &[u8]) -> bool {
    matches!(
        head.get(..4),
        Some([0xCA, 0xFE, 0xBA, 0xBE] | [0xBE, 0xBA, 0xFE, 0xCA])
    )
}

fn u32_at(b: &[u8], at: usize, le: bool) -> Option<u32> {
    let raw: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
    Some(if le {
        u32::from_le_bytes(raw)
    } else {
        u32::from_be_bytes(raw)
    })
}

fn u16_at(b: &[u8], at: usize, le: bool) -> Option<u16> {
    let raw: [u8; 2] = b.get(at..at + 2)?.try_into().ok()?;
    Some(if le {
        u16::from_le_bytes(raw)
    } else {
        u16::from_be_bytes(raw)
    })
}

/// CPU names by cputype. The ABI64 bit (0x01000000) is what distinguishes
/// x86_64/arm64 from their 32-bit halves; arm64_32 uses 0x02000000.
fn macho_arch_name(cputype: u32, cpusubtype: u32) -> String {
    match cputype {
        7 => "x86".to_string(),
        0x0100_0007 => "x86_64".to_string(),
        12 => "arm".to_string(),
        0x0100_000C => {
            // The e-variant (pointer authentication) lives in the subtype.
            if cpusubtype & 0x00FF_FFFF == 2 {
                "arm64e".to_string()
            } else {
                "arm64".to_string()
            }
        }
        0x0200_000C => "arm64_32".to_string(),
        18 => "ppc".to_string(),
        0x0100_0012 => "ppc64".to_string(),
        other => format!("cputype {other}"),
    }
}

fn macho_file_type(filetype: u32) -> Option<String> {
    let s = match filetype {
        1 => "object",
        2 => "executable",
        4 => "core",
        6 => "dylib",
        7 => "dylinker",
        8 => "bundle",
        9 => "dylib stub",
        10 => "debug symbols",
        11 => "kernel extension",
        _ => return None,
    };
    Some(s.to_string())
}

/// What one thin Mach-O slice says about itself: arch, bits, role, and the
/// three load-command facts (signature segment, entry, linked libraries).
#[derive(Default)]
struct MachoSlice {
    arch: String,
    bits: u32,
    file_type: Option<String>,
    has_code_signature: bool,
    has_entry_point: bool,
    dylib_count: usize,
    dylibs: Vec<String>,
}

/// Load commands worth reporting; the rest are skipped by cmdsize.
const LC_LOAD_DYLIB: u32 = 0x0C;
const LC_CODE_SIGNATURE: u32 = 0x1D;
const LC_MAIN: u32 = 0x8000_0028;
const MAX_DYLIB_NAMES: usize = 5;

fn parse_macho_slice(bytes: &[u8]) -> Option<MachoSlice> {
    let le = macho_endian(bytes)?;
    // The ABI64 bit rides byte 0 in little-endian files, byte 3 in
    // big-endian ones — the same 0xCE/0xCF distinction either way.
    let is64 = if le {
        bytes[0] == 0xCF
    } else {
        bytes[3] == 0xCF
    };
    let cputype = u32_at(bytes, 4, le)?;
    let cpusubtype = u32_at(bytes, 8, le)?;
    let filetype = u32_at(bytes, 12, le)?;
    let ncmds = u32_at(bytes, 16, le)? as usize;
    let mut out = MachoSlice {
        arch: macho_arch_name(cputype, cpusubtype),
        bits: if is64 { 64 } else { 32 },
        file_type: macho_file_type(filetype),
        ..Default::default()
    };
    // 32-byte header for 64-bit, 28 for 32-bit; the walk stops at the
    // buffer, so a lying ncmds cannot run past what was read.
    let mut off = if is64 { 32 } else { 28 };
    for _ in 0..ncmds {
        let cmd = u32_at(bytes, off, le)?;
        let size = u32_at(bytes, off + 4, le)? as usize;
        if size < 8 || off + size > bytes.len() {
            break;
        }
        match cmd {
            LC_CODE_SIGNATURE => out.has_code_signature = true,
            LC_MAIN => out.has_entry_point = true,
            LC_LOAD_DYLIB => {
                out.dylib_count += 1;
                if out.dylibs.len() < MAX_DYLIB_NAMES {
                    // lc_str: the offset is from the load command's start.
                    let name_off = u32_at(bytes, off + 8, le)? as usize;
                    let start = off + name_off;
                    if start < bytes.len() {
                        let end = bytes[start..]
                            .iter()
                            .position(|&b| b == 0)
                            .map(|p| start + p)
                            .unwrap_or(bytes.len())
                            .min(off + size);
                        out.dylibs
                            .push(String::from_utf8_lossy(&bytes[start..end]).into_owned());
                    }
                }
            }
            _ => {}
        }
        off += size;
    }
    Some(out)
}

/// Read up to `len` bytes at `at` for slice walks (fat binaries park their
/// slices at arbitrary offsets).
fn read_at(f: &mut std::fs::File, at: u64, len: usize) -> Vec<u8> {
    use std::io::{Seek, SeekFrom};
    let mut buf = vec![0u8; len];
    let n = f
        .seek(SeekFrom::Start(at))
        .ok()
        .and_then(|_| f.take(len as u64).read(&mut buf).ok())
        .unwrap_or(0);
    buf.truncate(n);
    buf
}

fn macho_inspection(f: &mut std::fs::File, head: &[u8], exec_bit: bool) -> Inspection {
    // A universal binary: walk the fat_arch table (both byte orders), read
    // each slice's head, and report every architecture it holds.
    if is_fat(head) {
        // The fat header's fields are big-endian by ABI; the swapped magic
        // marks a cross-endian file whose fields are little-endian.
        let fields_le = head.starts_with(&[0xBE, 0xBA, 0xFE, 0xCA]);
        let mut archs = Vec::new();
        let mut slices = Vec::new();
        if let Some(nfat) = u32_at(head, 4, fields_le) {
            for i in 0..nfat.min(32) {
                let base = 8 + i as usize * 20;
                let Some(cputype) = u32_at(head, base, fields_le) else {
                    break;
                };
                let cpusubtype = u32_at(head, base + 4, fields_le).unwrap_or(0);
                let offset = u32_at(head, base + 8, fields_le).unwrap_or(0) as u64;
                let bytes = read_at(f, offset, 64 * 1024);
                let slice = parse_macho_slice(&bytes);
                archs.push(ExecArch {
                    arch: macho_arch_name(cputype, cpusubtype),
                    bits: slice.as_ref().map_or(0, |s| s.bits),
                    file_type: slice.as_ref().and_then(|s| s.file_type.clone()),
                });
                if let Some(s) = slice {
                    slices.push(s);
                }
            }
        }
        let first = slices.first();
        return Inspection::Executable {
            format: "mach-o".to_string(),
            archs,
            interpreter: None,
            executable_bit: exec_bit,
            // Signature presence is a per-slice fact; reported as "any
            // slice carries one", because that is what "is this file
            // signed" means for a universal binary.
            has_code_signature: Some(slices.iter().any(|s| s.has_code_signature)),
            has_entry_point: Some(first.is_some_and(|s| s.has_entry_point)),
            dylib_count: first.map(|s| s.dylib_count),
            dylibs: first.map(|s| s.dylibs.clone()),
        };
    }
    // Thin: the load commands can sit past the 4096-byte head, so read a
    // fuller window once (bounded — the walk itself is buffer-limited).
    let bytes = if head.len() < 4096 {
        head.to_vec()
    } else {
        read_at(f, 0, 64 * 1024)
    };
    let s = parse_macho_slice(&bytes).unwrap_or_default();
    Inspection::Executable {
        format: "mach-o".to_string(),
        archs: vec![ExecArch {
            arch: s.arch.clone(),
            bits: s.bits,
            file_type: s.file_type.clone(),
        }],
        interpreter: None,
        executable_bit: exec_bit,
        has_code_signature: Some(s.has_code_signature),
        has_entry_point: Some(s.has_entry_point),
        dylib_count: Some(s.dylib_count),
        dylibs: Some(s.dylibs),
    }
}

// --- ELF ------------------------------------------------------------------

fn elf_arch_name(machine: u16) -> String {
    match machine {
        3 => "x86".to_string(),
        62 => "x86_64".to_string(),
        40 => "arm".to_string(),
        183 => "arm64".to_string(),
        8 => "mips".to_string(),
        20 => "ppc".to_string(),
        21 => "ppc64".to_string(),
        22 => "s390x".to_string(),
        243 => "riscv".to_string(),
        244 => "riscv64".to_string(),
        50 => "ia64".to_string(),
        other => format!("e_machine {other}"),
    }
}

fn elf_inspection(head: &[u8], exec_bit: bool) -> Inspection {
    // e_ident: class at 4 (1=32, 2=64), data at 5 (1=LE, 2=BE); e_type at
    // 16 and e_machine at 18 share both classes.
    let bits = match head.get(4) {
        Some(2) => 64,
        _ => 32,
    };
    let le = head.get(5) != Some(&2);
    let etype = u16_at(head, 16, le).unwrap_or(0);
    let machine = u16_at(head, 18, le).unwrap_or(0);
    let file_type = match etype {
        1 => Some("relocatable".to_string()),
        2 => Some("executable".to_string()),
        3 => Some("shared object".to_string()),
        4 => Some("core".to_string()),
        _ => None,
    };
    Inspection::Executable {
        format: "elf".to_string(),
        archs: vec![ExecArch {
            arch: elf_arch_name(machine),
            bits,
            file_type,
        }],
        interpreter: None,
        executable_bit: exec_bit,
        has_code_signature: None,
        has_entry_point: None,
        dylib_count: None,
        dylibs: None,
    }
}

// --- PE -------------------------------------------------------------------

fn pe_arch_name(machine: u16) -> String {
    match machine {
        0x014C => "x86".to_string(),
        0x8664 => "x86_64".to_string(),
        0xAA64 => "arm64".to_string(),
        0x01C0 => "arm".to_string(),
        0x01C4 => "armv7".to_string(),
        0x0200 => "ia64".to_string(),
        other => format!("machine 0x{other:X}"),
    }
}

fn pe_inspection(head: &[u8], exec_bit: bool) -> Inspection {
    // MZ alone is any DOS executable; the PE signature is what makes it a
    // portable executable, and it can sit anywhere e_lfanew points.
    let e_lfanew = u32_at(head, 0x3C, true).unwrap_or(0) as usize;
    let sig = head.get(e_lfanew..e_lfanew + 4);
    let pe = if let Some([b'P', b'E', 0, 0]) = sig {
        head
    } else {
        // MZ without a PE signature: not ours to describe.
        return Inspection::Unsupported;
    };
    let machine = u16_at(pe, e_lfanew + 4, true).unwrap_or(0);
    let characteristics = u16_at(pe, e_lfanew + 22, true).unwrap_or(0);
    let file_type = if characteristics & 0x2000 != 0 {
        Some("dynamic library".to_string())
    } else if characteristics & 0x0002 != 0 {
        Some("executable".to_string())
    } else {
        None
    };
    Inspection::Executable {
        format: "pe".to_string(),
        archs: vec![ExecArch {
            arch: pe_arch_name(machine),
            bits: match machine {
                0x8664 | 0xAA64 | 0x0200 => 64,
                _ => 32,
            },
            file_type,
        }],
        interpreter: None,
        executable_bit: exec_bit,
        has_code_signature: None,
        has_entry_point: None,
        dylib_count: None,
        dylibs: None,
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FsBackend;
    use std::fs::File;
    use std::io::Write;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("tabverse-fs-inspect-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A self-signed cert must yield its metadata, and appending a private
    /// key block must yield the key's *label only* — the key body must not
    /// appear anywhere in the serialized inspection. That refusal is the
    /// security property this module exists for, so it gets asserted on the
    /// actual JSON the frontend would receive.
    #[test]
    fn certificates_metadata_and_private_key_refusal() {
        let tmp = tmp_dir("cert");
        let fs = FsBackend::new();

        let mut params =
            rcgen::CertificateParams::new(vec!["preview.example.test".to_string()]).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "Omni Test Leaf");
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = params.self_signed(&key).unwrap();
        let pem_path = tmp.join("leaf.pem");
        std::fs::write(&pem_path, cert.pem()).unwrap();

        let insp = fs.inspect(pem_path.to_str().unwrap()).unwrap();
        let Inspection::Certificates { items, private_key } = insp else {
            panic!("expected certificates");
        };
        assert!(private_key.is_none());
        assert_eq!(items.len(), 1);
        let c = &items[0];
        assert_eq!(c.kind, "certificate");
        assert_eq!(c.subject_cn, "Omni Test Leaf");
        assert!(
            c.sans.contains(&"preview.example.test".to_string()),
            "sans: {:?}",
            c.sans
        );
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!(
            c.not_before <= now && now <= c.not_after,
            "now must fall inside the validity window: {} .. {}",
            c.not_before,
            c.not_after
        );
        assert!(!c.is_ca, "a plain leaf must not read as a CA");
        // 32 bytes as "AA:BB:..": 64 hex chars + 31 colons.
        assert_eq!(c.sha256.len(), 32 * 3 - 1);
        assert!(c.sha256.bytes().all(|b| b.is_ascii_hexdigit() || b == b':'));
        assert_eq!(c.key_alg, "ECDSA P-256", "rcgen default keypair is P-256");

        // Append the private key, as real "cert + key in one file" bundles do.
        let key_pem = key.serialize_pem();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&pem_path)
            .unwrap();
        f.write_all(key_pem.as_bytes()).unwrap();
        drop(f);

        let insp = fs.inspect(pem_path.to_str().unwrap()).unwrap();
        let json = serde_json::to_string(&insp).unwrap();
        let Inspection::Certificates { items, private_key } = insp else {
            panic!("expected certificates");
        };
        assert_eq!(items.len(), 1, "the cert must still be listed");
        let label = private_key.expect("the key block must be reported");
        assert!(label.contains("PRIVATE KEY"), "got label {label:?}");
        // The base64 body must not leak into the serialized result, line by
        // line — this is what actually crosses the IPC boundary.
        for line in key_pem
            .lines()
            .filter(|l| !l.starts_with("-----") && !l.is_empty())
        {
            assert!(
                !json.contains(line),
                "private key material leaked into JSON"
            );
        }
        assert!(
            json.contains("\"privateKey\""),
            "camelCase tag expected: {json}"
        );

        // A key-only file: no items, label reported, body still refused.
        let key_path = tmp.join("only.key");
        std::fs::write(&key_path, &key_pem).unwrap();
        let insp = fs.inspect(key_path.to_str().unwrap()).unwrap();
        let json = serde_json::to_string(&insp).unwrap();
        let Inspection::Certificates { items, private_key } = insp else {
            panic!("expected certificates");
        };
        assert!(items.is_empty());
        assert!(private_key.is_some());
        for line in key_pem
            .lines()
            .filter(|l| !l.starts_with("-----") && !l.is_empty())
        {
            assert!(
                !json.contains(line),
                "private key material leaked into JSON"
            );
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Archives are listed — names, sizes, dir flags, honest totals — and a
    /// bare .gz degrades to a single logical entry.
    #[test]
    fn archives_list_entries_without_extracting() {
        let tmp = tmp_dir("arch");
        let fs = FsBackend::new();

        // zip, built with the same crate that lists it.
        let zip_path = tmp.join("bundle.zip");
        let mut w = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        w.add_directory("docs/", opts).unwrap();
        w.start_file("docs/readme.md", opts).unwrap();
        // Derived, not spelled out again below: a literal length silently
        // went stale the moment the payload was edited.
        const PAYLOAD: &[u8] = b"hello tabverse";
        w.write_all(PAYLOAD).unwrap();
        w.finish().unwrap();

        let insp = fs.inspect(zip_path.to_str().unwrap()).unwrap();
        let Inspection::Archive {
            entries,
            total,
            truncated,
        } = insp
        else {
            panic!("expected archive");
        };
        assert_eq!(total, 2);
        assert!(!truncated);
        let file = entries.iter().find(|e| e.path == "docs/readme.md").unwrap();
        assert_eq!(file.size, PAYLOAD.len() as u64);
        assert!(!file.dir);
        assert!(entries.iter().any(|e| e.path == "docs/" && e.dir));

        // tar.gz with one file three dirs deep.
        let tgz_path = tmp.join("bundle.tar.gz");
        let enc = flate2::write::GzEncoder::new(
            File::create(&tgz_path).unwrap(),
            flate2::Compression::default(),
        );
        let mut b = tar::Builder::new(enc);
        let data = b"tar payload";
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, "inner/deep/notes.txt", &data[..])
            .unwrap();
        b.into_inner().unwrap().finish().unwrap();

        let insp = fs.inspect(tgz_path.to_str().unwrap()).unwrap();
        let Inspection::Archive {
            entries,
            total,
            truncated,
        } = insp
        else {
            panic!("expected archive");
        };
        assert_eq!(total, 1);
        assert!(!truncated);
        assert_eq!(entries[0].path, "inner/deep/notes.txt");
        assert_eq!(entries[0].size, data.len() as u64);
        assert!(!entries[0].dir);

        // A bare .gz that is not a tar: one entry, named after the inner
        // file, sized by the decompressed byte count.
        let gz_path = tmp.join("solo.log.gz");
        let mut enc = flate2::write::GzEncoder::new(
            File::create(&gz_path).unwrap(),
            flate2::Compression::default(),
        );
        let payload = b"line one\nline two\n";
        enc.write_all(payload).unwrap();
        enc.finish().unwrap();

        let insp = fs.inspect(gz_path.to_str().unwrap()).unwrap();
        let Inspection::Archive { entries, total, .. } = insp else {
            panic!("expected archive");
        };
        assert_eq!(total, 1);
        assert_eq!(entries[0].path, "solo.log");
        assert_eq!(entries[0].size, payload.len() as u64);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A binary plist must come back as readable XML text, and an unknown
    /// extension must be refused as Unsupported rather than guessed at.
    #[test]
    fn binary_plist_decodes_and_unknown_is_unsupported() {
        let tmp = tmp_dir("plist");
        let fs = FsBackend::new();

        let mut dict = plist::Dictionary::new();
        dict.insert(
            "CFBundleName".to_string(),
            plist::Value::String("Tabverse".to_string()),
        );
        dict.insert("BuildNumber".to_string(), plist::Value::Integer(42.into()));
        let plist_path = tmp.join("info.plist");
        plist::Value::Dictionary(dict)
            .to_file_binary(&plist_path)
            .unwrap();
        // Prove the fixture really is the binary format, not XML that would
        // be readable anyway.
        assert!(std::fs::read(&plist_path).unwrap().starts_with(b"bplist"));

        let insp = fs.inspect(plist_path.to_str().unwrap()).unwrap();
        let Inspection::Plist { text } = insp else {
            panic!("expected plist");
        };
        assert!(text.contains("CFBundleName"));
        assert!(text.contains("Tabverse"));
        assert!(text.contains("42"));

        let other = tmp.join("mystery.xyz");
        std::fs::write(&other, b"\x00\x01\x02").unwrap();
        let insp = fs.inspect(other.to_str().unwrap()).unwrap();
        assert!(matches!(insp, Inspection::Unsupported));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Build a real database, then prove the whole read path: table listing
    /// with counts and columns, row paging, NULL/blob rendering, the cell
    /// cap, and — the property the immutable open exists for — that reading
    /// a WAL-mode database leaves no -wal/-shm files next to the user's data.
    #[test]
    fn sqlite_inspection_rows_and_wal_hygiene() {
        let tmp = tmp_dir("sqlite");
        let fs = FsBackend::new();
        let db_path = tmp.join("data.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            // WAL is the worst case for read-side hygiene: a plain read-only
            // open of a WAL database creates -shm. That is exactly what the
            // immutable open must prevent, so the fixture opts into it.
            let mode: String = conn
                .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "wal", "fixture must really be WAL-mode");
            conn.execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB);
                 CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO users (id, name, avatar) VALUES (1, 'ada', x'0102030405')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO users (id, name, avatar) VALUES (2, NULL, NULL)",
                [],
            )
            .unwrap();
            for i in 0..5 {
                conn.execute(
                    "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                    rusqlite::params![i, format!("note {i}")],
                )
                .unwrap();
            }
            // One cell longer than the cap, to see it cut with an ellipsis.
            conn.execute(
                "INSERT INTO notes (id, body) VALUES (5, ?1)",
                rusqlite::params!["x".repeat(600)],
            )
            .unwrap();
        }
        // The CREATING connection legitimately made -wal/-shm; clear them so
        // any that exist after the read path can only be the read path's.
        let wal = tmp.join("data.db-wal");
        let shm = tmp.join("data.db-shm");
        let _ = std::fs::remove_file(&wal);
        let _ = std::fs::remove_file(&shm);

        let insp = fs.inspect(db_path.to_str().unwrap()).unwrap();
        let json = serde_json::to_string(&insp).unwrap();
        assert!(json.contains("\"type\":\"sqlite\""), "tag: {json}");
        assert!(json.contains("\"tables\""), "field name: {json}");
        let Inspection::Sqlite { tables } = insp else {
            panic!("expected sqlite");
        };
        assert_eq!(tables.len(), 2, "sqlite_ internal tables must be skipped");
        let users = tables.iter().find(|t| t.name == "users").unwrap();
        assert_eq!(users.rows, 2);
        assert_eq!(users.columns, vec!["id", "name", "avatar"]);
        let notes = tables.iter().find(|t| t.name == "notes").unwrap();
        assert_eq!(notes.rows, 6);
        assert_eq!(notes.columns, vec!["id", "body"]);

        // NULL and blob cells: placeholders, never the bytes.
        let page = fs
            .sqlite_rows(db_path.to_str().unwrap(), "users", 10, 0)
            .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.columns, vec!["id", "name", "avatar"]);
        assert_eq!(page.rows[0], vec!["1", "ada", "<blob 5 B>"]);
        assert_eq!(page.rows[1], vec!["2", "NULL", "NULL"]);
        let json = serde_json::to_string(&page).unwrap();
        assert!(
            json.contains("\"columns\"") && json.contains("\"total\""),
            "{json}"
        );

        // Pagination: limit+offset select the middle of the table.
        let page = fs
            .sqlite_rows(db_path.to_str().unwrap(), "notes", 2, 3)
            .unwrap();
        assert_eq!(page.total, 6);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.rows[0][1], "note 3");
        assert_eq!(page.rows[1][1], "note 4");

        // The 600-char cell arrives capped: 500 chars plus one ellipsis.
        let page = fs
            .sqlite_rows(db_path.to_str().unwrap(), "notes", 1, 5)
            .unwrap();
        let long = &page.rows[0][1];
        assert_eq!(long.chars().count(), MAX_CELL_CHARS + 1);
        assert!(long.ends_with('…'));

        // A name absent from sqlite_master must be refused outright.
        let err = fs.sqlite_rows(
            db_path.to_str().unwrap(),
            "users\"; DROP TABLE users;--",
            1,
            0,
        );
        assert!(err.is_err(), "unknown table name must be rejected");

        // The security property itself: nothing appeared next to the db.
        assert!(!wal.exists(), "read path recreated {}", wal.display());
        assert!(!shm.exists(), "read path recreated {}", shm.display());

        // Content routing: the magic wins whatever the extension says, both
        // for inspection and for kind_for's mime.
        let alias = tmp.join("state.vscdb");
        std::fs::copy(&db_path, &alias).unwrap();
        let insp = fs.inspect(alias.to_str().unwrap()).unwrap();
        assert!(matches!(insp, Inspection::Sqlite { .. }));
        let head = std::fs::read(&alias).unwrap();
        let (kind, mime) = crate::kind_for(&alias, &head[..64]);
        assert_eq!(kind, crate::FileKind::Binary);
        assert_eq!(mime, "application/vnd.sqlite3");

        // A URI-hostile file name must still open — this is what the
        // percent-encoding is for. '?' is the sharpest case and is used
        // wherever it is legal, but Windows forbids it in a file name
        // outright: asking for it there would test the OS's naming rules
        // instead of our encoding, so '%' takes its place in the set.
        #[cfg(windows)]
        let odd = tmp.join("que%ry #1.db");
        #[cfg(not(windows))]
        let odd = tmp.join("que?ry #1.db");
        std::fs::copy(&db_path, &odd).unwrap();
        let insp = fs.inspect(odd.to_str().unwrap()).unwrap();
        assert!(matches!(insp, Inspection::Sqlite { .. }));

        // A db-ish extension without the magic must not reach the parser.
        let fake = tmp.join("fake.sqlite3");
        std::fs::write(&fake, b"definitely not a database").unwrap();
        let insp = fs.inspect(fake.to_str().unwrap()).unwrap();
        assert!(matches!(insp, Inspection::Unsupported));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A complete PNG written byte-by-byte (signature, IHDR, zlib IDAT,
    /// IEND, real CRCs) must yield its pixel dimensions, and bytes that are
    /// not an image must degrade to Unsupported rather than error — the
    /// frontend then just omits the dimensions line.
    #[test]
    fn image_dimensions_from_header() {
        let tmp = tmp_dir("img");
        let fs = FsBackend::new();

        fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(kind);
            out.extend_from_slice(data);
            let mut crc = flate2::Crc::new();
            crc.update(kind);
            crc.update(data);
            out.extend_from_slice(&crc.sum().to_be_bytes());
            out
        }
        let (w, h) = (3u32, 2u32);
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        // 8-bit depth, RGB, deflate, adaptive filtering, no interlace.
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        // Scanlines: per row one filter byte, then w RGB pixels.
        let mut raw = Vec::new();
        for _ in 0..h {
            raw.push(0u8);
            raw.extend(std::iter::repeat_n(0x7fu8, w as usize * 3));
        }
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&raw).unwrap();
        let idat = enc.finish().unwrap();

        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(chunk(b"IHDR", &ihdr));
        png.extend(chunk(b"IDAT", &idat));
        png.extend(chunk(b"IEND", &[]));
        let png_path = tmp.join("tiny.png");
        std::fs::write(&png_path, &png).unwrap();

        let insp = fs.inspect(png_path.to_str().unwrap()).unwrap();
        let json = serde_json::to_string(&insp).unwrap();
        assert!(json.contains("\"type\":\"image\""), "tag: {json}");
        assert!(
            json.contains("\"width\":3") && json.contains("\"height\":2"),
            "{json}"
        );
        let Inspection::Image { width, height } = insp else {
            panic!("expected image dimensions");
        };
        assert_eq!((width, height), (3, 2));

        // Garbage wearing an image extension: no dims, no error.
        let bad = tmp.join("broken.jpg");
        std::fs::write(&bad, b"not an image at all").unwrap();
        let insp = fs.inspect(bad.to_str().unwrap()).unwrap();
        assert!(matches!(insp, Inspection::Unsupported));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Little-endian u32 appended in file order (the only byte order the
    /// fixtures need).
    fn push_u32(v: &mut Vec<u8>, x: u32) {
        v.extend_from_slice(&x.to_le_bytes());
    }

    /// One thin 64-bit Mach-O with the load commands the inspection reads:
    /// a filler segment, two LC_LOAD_DYLIBs, LC_CODE_SIGNATURE, LC_MAIN.
    fn macho_64(cputype: u32, cpusubtype: u32) -> Vec<u8> {
        let mut cmds = Vec::new();
        // LC_SEGMENT_64 filler: cmd 0x19, cmdsize 72, rest zeros.
        push_u32(&mut cmds, 0x19);
        push_u32(&mut cmds, 72);
        cmds.resize(cmds.len() + 64, 0);
        for name in ["/usr/lib/libSystem.B.dylib", "@rpath/Helper.dylib"] {
            let mut c = Vec::new();
            let total = 8 + 16 + name.len() + 1; // cmd+size, dylib struct, name, NUL
            let padded = (total + 3) & !3; // load commands are 4-byte aligned
            push_u32(&mut c, 0x0C); // LC_LOAD_DYLIB
            push_u32(&mut c, padded as u32);
            push_u32(&mut c, 24); // name offset from the command's start
            push_u32(&mut c, 0); // timestamp
            push_u32(&mut c, 0); // current version
            push_u32(&mut c, 0); // compatibility version
            c.extend_from_slice(name.as_bytes());
            c.push(0);
            c.resize(c.len() + (padded - total), 0);
            cmds.extend_from_slice(&c);
        }
        push_u32(&mut cmds, 0x1D); // LC_CODE_SIGNATURE
        push_u32(&mut cmds, 16);
        push_u32(&mut cmds, 0); // dataoff
        push_u32(&mut cmds, 0); // datasize
        push_u32(&mut cmds, 0x8000_0028); // LC_MAIN
        push_u32(&mut cmds, 24);
        push_u32(&mut cmds, 0); // entryoff
        push_u32(&mut cmds, 0); // stacksize
        cmds.extend(std::iter::repeat_n(0u8, 8));

        let mut out = Vec::new();
        push_u32(&mut out, 0xFEED_FACF); // MH_MAGIC_64, stored LE
        push_u32(&mut out, cputype);
        push_u32(&mut out, cpusubtype);
        push_u32(&mut out, 2); // MH_EXECUTE
        push_u32(&mut out, 5); // ncmds: segment + 2 dylibs + signature + main
        push_u32(&mut out, cmds.len() as u32);
        push_u32(&mut out, 0); // flags
        push_u32(&mut out, 0); // reserved
        out.extend_from_slice(&cmds);
        out
    }

    /// A universal binary: big-endian fat header + table, then each slice.
    fn macho_fat(slices: &[(u32, u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&0xCAFEBABEu32.to_be_bytes());
        out.extend_from_slice(&(slices.len() as u32).to_be_bytes());
        let table_end = 8 + slices.len() * 20;
        let mut offset = table_end;
        for (cputype, cpusubtype, bytes) in slices {
            out.extend_from_slice(&cputype.to_be_bytes());
            out.extend_from_slice(&cpusubtype.to_be_bytes());
            out.extend_from_slice(&(offset as u32).to_be_bytes());
            out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            out.extend_from_slice(&12u32.to_be_bytes()); // align
            offset += bytes.len();
        }
        for (_, _, bytes) in slices {
            out.extend_from_slice(bytes);
        }
        out
    }

    /// A thin arm64 binary's facts: arch, role, signature segment (a
    /// byte-level presence, never a codesign verdict), entry command, and
    /// the dylib count with the first five names.
    #[test]
    fn macho_thin_reports_arch_signature_and_dylibs() {
        let tmp = tmp_dir("macho");
        let fs = FsBackend::new();
        let bin = tmp.join("tool");
        std::fs::write(&bin, macho_64(0x0100_000C, 0)).unwrap();

        let insp = fs.inspect(bin.to_str().unwrap()).unwrap();
        let json = serde_json::to_string(&insp).unwrap();
        assert!(json.contains("\"type\":\"executable\""), "tag: {json}");
        assert!(json.contains("\"hasCodeSignature\""), "camelCase: {json}");
        let Inspection::Executable {
            format,
            archs,
            executable_bit,
            has_code_signature,
            has_entry_point,
            dylib_count,
            dylibs,
            ..
        } = insp
        else {
            panic!("expected an executable inspection");
        };
        assert_eq!(format, "mach-o");
        assert_eq!(archs.len(), 1);
        assert_eq!(archs[0].arch, "arm64");
        assert_eq!(archs[0].bits, 64);
        assert_eq!(archs[0].file_type.as_deref(), Some("executable"));
        assert_eq!(has_code_signature, Some(true));
        assert_eq!(has_entry_point, Some(true));
        assert_eq!(dylib_count, Some(2));
        let names = dylibs.unwrap();
        assert_eq!(names.len(), 2);
        assert_eq!(names[0], "/usr/lib/libSystem.B.dylib");
        assert_eq!(names[1], "@rpath/Helper.dylib");
        #[cfg(unix)]
        assert!(!executable_bit, "written 0644: no execute bit yet");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A universal binary reports EVERY slice, and arm64e is told apart
    /// from plain arm64 by the subtype.
    #[test]
    fn macho_fat_reports_every_slice() {
        let tmp = tmp_dir("fat");
        let fs = FsBackend::new();
        let fat = macho_fat(&[
            (0x0100_0007, 0, macho_64(0x0100_0007, 0)),
            (0x0100_000C, 2, macho_64(0x0100_000C, 2)),
        ]);
        let bin = tmp.join("universal");
        std::fs::write(&bin, fat).unwrap();

        let insp = fs.inspect(bin.to_str().unwrap()).unwrap();
        let Inspection::Executable {
            format,
            archs,
            has_code_signature,
            ..
        } = insp
        else {
            panic!("expected an executable inspection");
        };
        assert_eq!(format, "mach-o");
        let names: Vec<&str> = archs.iter().map(|a| a.arch.as_str()).collect();
        assert_eq!(names, ["x86_64", "arm64e"], "both slices, in table order");
        assert!(archs.iter().all(|a| a.bits == 64));
        assert_eq!(has_code_signature, Some(true), "a slice carries one");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn executables_route_by_magic_not_extension() {
        let tmp = tmp_dir("magic");
        let fs = FsBackend::new();

        // Mach-O, no extension at all.
        let tool = tmp.join("cli-tool");
        std::fs::write(&tool, macho_64(0x0100_000C, 0)).unwrap();
        let insp = fs.inspect(tool.to_str().unwrap()).unwrap();
        assert!(
            matches!(insp, Inspection::Executable { .. }),
            "no extension is the main case — magic must decide"
        );

        // ELF: \x7fELF, 64-bit LE, e_type 3 (shared object), e_machine 62.
        let mut elf = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0];
        elf.resize(20, 0);
        elf[16..18].copy_from_slice(&3u16.to_le_bytes());
        elf[18..20].copy_from_slice(&62u16.to_le_bytes());
        let elftool = tmp.join("elftool");
        std::fs::write(&elftool, &elf).unwrap();
        let insp = fs.inspect(elftool.to_str().unwrap()).unwrap();
        let Inspection::Executable { format, archs, .. } = insp else {
            panic!("expected elf");
        };
        assert_eq!(format, "elf");
        assert_eq!(archs[0].arch, "x86_64");
        assert_eq!(archs[0].bits, 64);
        assert_eq!(archs[0].file_type.as_deref(), Some("shared object"));

        // PE: MZ, e_lfanew pointing at PE\0\0, machine 0x8664, DLL bit.
        let mut pe = vec![b'M', b'Z'];
        pe.resize(0x98, 0);
        pe[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(&[b'P', b'E', 0, 0]);
        pe[0x84..0x86].copy_from_slice(&0x8664u16.to_le_bytes());
        pe[0x96..0x98].copy_from_slice(&0x2002u16.to_le_bytes()); // EXEC+DLL
        let petool = tmp.join("petool");
        std::fs::write(&petool, &pe).unwrap();
        let insp = fs.inspect(petool.to_str().unwrap()).unwrap();
        let Inspection::Executable { format, archs, .. } = insp else {
            panic!("expected pe");
        };
        assert_eq!(format, "pe");
        assert_eq!(archs[0].arch, "x86_64");
        assert_eq!(archs[0].file_type.as_deref(), Some("dynamic library"));

        // The mime side of the contract: same magic, whatever the name.
        for (name, head) in [
            ("cli-tool", macho_64(0x0100_000C, 0)),
            ("elftool", elf),
            ("petool", pe),
        ] {
            let (kind, mime) = crate::kind_for(Path::new(name), &head);
            assert_eq!(kind, crate::FileKind::Binary, "{name}");
            assert_eq!(mime, "application/x-executable", "{name}");
        }

        // MZ without the PE signature is a DOS fossil, not ours to claim.
        let bare = tmp.join("dos.com");
        std::fs::write(&bare, b"MZ\x90\x00\x03...").unwrap();
        let insp = fs.inspect(bare.to_str().unwrap()).unwrap();
        assert!(matches!(insp, Inspection::Unsupported));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A shebang script reports its interpreter and execute bit, and stays
    /// a TEXT file — the editor remains how it is worked on; the card is
    /// the Details view.
    #[test]
    fn script_reports_interpreter_and_execute_bit() {
        let tmp = tmp_dir("script");
        let fs = FsBackend::new();
        let sh = tmp.join("run-task");
        std::fs::write(&sh, b"#!/usr/bin/env python3 -u\nprint('hi')\n").unwrap();

        let insp = fs.inspect(sh.to_str().unwrap()).unwrap();
        let Inspection::Executable {
            format,
            interpreter,
            executable_bit,
            ..
        } = insp
        else {
            panic!("expected a script inspection");
        };
        assert_eq!(format, "script");
        assert_eq!(interpreter.as_deref(), Some("/usr/bin/env python3 -u"));
        #[cfg(unix)]
        assert!(!executable_bit, "written without +x");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&sh, PermissionsExt::from_mode(0o755)).unwrap();
            let insp = fs.inspect(sh.to_str().unwrap()).unwrap();
            let Inspection::Executable { executable_bit, .. } = insp else {
                panic!("expected a script inspection");
            };
            assert!(executable_bit, "chmod +x must be reported");
        }

        // Text routing: the editor owns scripts, the mime only flags that
        // a Details card exists.
        let (kind, mime) = crate::kind_for(
            Path::new("run-task"),
            b"#!/usr/bin/env python3 -u\nprint('hi')\n",
        );
        assert_eq!(kind, crate::FileKind::Text);
        assert_eq!(mime, "text/x-shellscript");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A real system binary, when one exists: the parser must hold up
    /// against production bytes, not just fixtures.
    #[test]
    fn system_binary_matches_the_host_format() {
        let Some(path) = ["/bin/ls", "/usr/bin/true"]
            .iter()
            .find(|p| Path::new(p).exists())
        else {
            eprintln!("no known system binary present; skipping");
            return;
        };
        let fs = FsBackend::new();
        let insp = fs.inspect(path).unwrap();
        let Inspection::Executable {
            format,
            archs,
            dylib_count,
            ..
        } = insp
        else {
            panic!("expected an executable inspection for {path}");
        };
        assert!(!archs.is_empty(), "at least one architecture");
        assert!(archs.iter().all(|a| a.bits == 64 || a.bits == 32));

        #[cfg(target_os = "macos")]
        assert_eq!(format, "mach-o");
        #[cfg(target_os = "linux")]
        assert_eq!(format, "elf");
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        assert!(matches!(format.as_str(), "mach-o" | "elf" | "pe"));

        #[cfg(target_os = "macos")]
        assert!(
            dylib_count.is_some_and(|n| n >= 1),
            "system binaries link at least libSystem"
        );
        #[cfg(target_os = "linux")]
        assert_eq!(dylib_count, None, "ELF has no Mach-O dylib metadata");
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = dylib_count;
    }

    /// Fonts: metadata from a real system font when one is present. macOS CI
    /// and dev machines carry these; elsewhere the test skips rather than
    /// fabricate a font binary.
    #[test]
    fn font_metadata_from_system_font() {
        let candidates = [
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Courier New.ttf",
            "/Library/Fonts/Arial.ttf",
        ];
        let Some(path) = candidates.iter().find(|p| Path::new(p).exists()) else {
            eprintln!("no known system font present; skipping font assertions");
            return;
        };
        let fs = FsBackend::new();
        let insp = fs.inspect(path).unwrap();
        let json = serde_json::to_string(&insp).unwrap();
        assert!(json.contains("\"type\":\"font\""), "tag: {json}");
        assert!(json.contains("\"glyphCount\""), "camelCase field: {json}");
        let Inspection::Font {
            family,
            glyph_count,
            ..
        } = insp
        else {
            panic!("expected font metadata for {path}");
        };
        assert!(!family.is_empty(), "family must come from the name table");
        assert!(glyph_count > 0);

        // The mime side of the routing contract.
        let (kind, mime) = crate::kind_for(Path::new("specimen.woff2"), b"");
        assert_eq!(kind, crate::FileKind::Binary);
        assert_eq!(mime, "font/woff2");
        let (_, mime) = crate::kind_for(Path::new("specimen.ttf"), b"");
        assert_eq!(mime, "font/ttf");
    }
}
