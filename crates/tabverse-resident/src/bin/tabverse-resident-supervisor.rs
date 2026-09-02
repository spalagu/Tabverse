use anyhow::{bail, Context, Result};
use std::{env, fs, path::PathBuf, sync::Arc, thread, time::Duration};
use tabverse_resident::{
    ArtifactVerifier, AuthToken, Ed25519SignatureVerifier, ProcessWorkerFactory, ResidentServer,
    Supervisor, TrustedKeySet,
};
use zeroize::Zeroizing;

fn main() {
    if let Err(error) = run() {
        eprintln!("Tabverse Resident Supervisor failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let root = parse_root(env::args_os().skip(1))?;
    let token = read_token(&root.join("auth-token"))?;
    let keys = TrustedKeySet::read(&root.join("trusted-keys.json"))?;
    let verifier = Ed25519SignatureVerifier::new(keys)?;
    let supervisor = Arc::new(Supervisor::open(
        &root,
        ArtifactVerifier::new(Arc::new(verifier)),
        Arc::new(ProcessWorkerFactory::default()),
    )?);
    let _server = ResidentServer::start(
        &root,
        AuthToken::new(*token),
        env!("CARGO_PKG_VERSION"),
        supervisor,
    )?;
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn parse_root(mut args: impl Iterator<Item = std::ffi::OsString>) -> Result<PathBuf> {
    let mut root = None;
    while let Some(argument) = args.next() {
        if argument == "--resident-supervisor" {
            continue;
        }
        if argument == "--resident-root" {
            root = args.next().map(PathBuf::from);
            continue;
        }
        bail!("unsupported resident supervisor argument")
    }
    root.ok_or_else(|| anyhow::anyhow!("--resident-root is required"))
}

fn read_token(path: &std::path::Path) -> Result<Zeroizing<[u8; 32]>> {
    owner_only(path)?;
    let bytes = Zeroizing::new(
        fs::read(path).with_context(|| format!("read resident token {}", path.display()))?,
    );
    let token: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("resident token must contain exactly 32 bytes"))?;
    Ok(Zeroizing::new(token))
}

#[cfg(unix)]
fn owner_only(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!("resident token permissions are not owner-only")
    }
    Ok(())
}

#[cfg(not(unix))]
fn owner_only(path: &std::path::Path) -> Result<()> {
    let _ = fs::metadata(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_require_an_explicit_external_root() {
        assert_eq!(
            parse_root(["--resident-supervisor".into()].into_iter())
                .unwrap_err()
                .to_string(),
            "--resident-root is required"
        );
        assert_eq!(
            parse_root(
                [
                    "--resident-supervisor",
                    "--resident-root",
                    "/outside-app/resident",
                ]
                .into_iter()
                .map(Into::into),
            )
            .unwrap(),
            PathBuf::from("/outside-app/resident")
        );
        assert!(parse_root(["--unknown".into()].into_iter()).is_err());
    }

    #[test]
    fn token_is_exact_length_and_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        fs::write(&path, [7u8; 32]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(*read_token(&path).unwrap(), [7u8; 32]);
        fs::write(&path, [7u8; 31]).unwrap();
        assert!(read_token(&path).is_err());
    }
}
