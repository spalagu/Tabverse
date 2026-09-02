use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};
use tabverse_resident::{
    Ed25519SignatureVerifier, RuntimeDescriptor, SignatureVerifier, TrustedKeySet,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("Tabverse Resident bundle verification failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let root = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("resident resource root is required"))?;
    if env::args_os().nth(2).is_some() {
        bail!("only one resident resource root is accepted")
    }
    let keys = TrustedKeySet::read(&root.join("control/trusted-keys.json"))?;
    let verifier = Ed25519SignatureVerifier::new(keys)?;
    for kind in ["terminal", "remote", "browser-network"] {
        let directory = root.join(kind);
        let descriptor_path = directory.join("descriptor.json");
        let descriptor: RuntimeDescriptor = serde_json::from_slice(
            &fs::read(&descriptor_path).with_context(|| format!("read {} descriptor", kind))?,
        )
        .with_context(|| format!("parse {} descriptor", kind))?;
        let artifact = fs::read(directory.join(&descriptor.entrypoint))
            .with_context(|| format!("read {} worker", kind))?;
        let digest = Sha256::digest(&artifact);
        if hex::encode(digest) != descriptor.artifact_hash {
            bail!("{kind} artifact hash mismatch")
        }
        verifier
            .verify(&descriptor, digest.as_ref())
            .with_context(|| format!("verify {kind} descriptor"))?;
    }
    Ok(())
}
