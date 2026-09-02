use crate::{RuntimeDescriptor, SignatureVerifier};
use anyhow::{bail, Context, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedKeySet {
    pub schema_version: u16,
    pub plugins: BTreeMap<String, Vec<String>>,
}

impl TrustedKeySet {
    pub fn read(path: &Path) -> Result<Self> {
        let keys: Self = serde_json::from_slice(
            &fs::read(path).with_context(|| format!("read trusted keys {}", path.display()))?,
        )?;
        if keys.schema_version != 1 {
            bail!("resident-trusted-keys-incompatible")
        }
        Ok(keys)
    }
}

pub struct Ed25519SignatureVerifier {
    keys: BTreeMap<String, Vec<VerifyingKey>>,
}

impl Ed25519SignatureVerifier {
    pub fn new(keys: TrustedKeySet) -> Result<Self> {
        let mut parsed = BTreeMap::new();
        for (plugin, entries) in keys.plugins {
            let mut plugin_keys = Vec::new();
            for entry in entries {
                let bytes = hex::decode(&entry)
                    .map_err(|_| anyhow::anyhow!("resident-trusted-key-invalid: {plugin}"))?;
                let bytes: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("resident-trusted-key-invalid: {plugin}"))?;
                plugin_keys.push(
                    VerifyingKey::from_bytes(&bytes)
                        .map_err(|_| anyhow::anyhow!("resident-trusted-key-invalid: {plugin}"))?,
                );
            }
            if plugin_keys.is_empty() {
                bail!("resident-trusted-key-missing: {plugin}")
            }
            parsed.insert(plugin, plugin_keys);
        }
        Ok(Self { keys: parsed })
    }
}

impl SignatureVerifier for Ed25519SignatureVerifier {
    fn verify(&self, descriptor: &RuntimeDescriptor, digest: &[u8]) -> Result<()> {
        let keys = self
            .keys
            .get(&descriptor.plugin_id)
            .ok_or_else(|| anyhow::anyhow!("resident-plugin-not-trusted"))?;
        let signature_bytes = hex::decode(&descriptor.signature)
            .map_err(|_| anyhow::anyhow!("resident-signature-invalid"))?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| anyhow::anyhow!("resident-signature-invalid"))?;
        let message = signing_message(descriptor, digest)?;
        if keys
            .iter()
            .any(|key| key.verify(&message, &signature).is_ok())
        {
            Ok(())
        } else {
            bail!("resident-signature-invalid")
        }
    }
}

fn signing_message(descriptor: &RuntimeDescriptor, digest: &[u8]) -> Result<Vec<u8>> {
    let mut message = b"tabverse-resident-artifact/v1\0".to_vec();
    for field in [
        descriptor.plugin_id.as_bytes(),
        descriptor.plugin_version.as_bytes(),
        descriptor.artifact_hash.as_bytes(),
        descriptor.entrypoint.as_bytes(),
    ] {
        message.extend_from_slice(&(field.len() as u64).to_be_bytes());
        message.extend_from_slice(field);
    }
    let permissions = serde_json::to_vec(&descriptor.permissions)?;
    message.extend_from_slice(&(permissions.len() as u64).to_be_bytes());
    message.extend_from_slice(&permissions);
    message.extend_from_slice(&descriptor.protocol_range.min.to_be_bytes());
    message.extend_from_slice(&descriptor.protocol_range.max.to_be_bytes());
    message.extend_from_slice(digest);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProtocolRange;
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};

    #[test]
    fn signature_binds_artifact_plugin_version_entrypoint_permissions_and_protocol() {
        let signing = SigningKey::from_bytes(&[0x2a; 32]);
        let keys = TrustedKeySet {
            schema_version: 1,
            plugins: BTreeMap::from([(
                "tabverse.fixture".into(),
                vec![hex::encode(signing.verifying_key().as_bytes())],
            )]),
        };
        let verifier = Ed25519SignatureVerifier::new(keys).unwrap();
        let digest = Sha256::digest(b"artifact");
        let mut descriptor = RuntimeDescriptor {
            plugin_id: "tabverse.fixture".into(),
            plugin_version: "1.0.0".into(),
            artifact_hash: hex::encode(digest),
            entrypoint: "worker".into(),
            permissions: vec![crate::CapabilityRequest {
                capability: "terminal.runtime".into(),
                reason: "keep the shell running".into(),
                optional: false,
            }],
            protocol_range: ProtocolRange { min: 1, max: 2 },
            signature: String::new(),
        };
        descriptor.signature = hex::encode(
            signing
                .sign(&signing_message(&descriptor, digest.as_ref()).unwrap())
                .to_bytes(),
        );
        verifier.verify(&descriptor, digest.as_ref()).unwrap();
        for mutate in [
            "plugin",
            "version",
            "entrypoint",
            "permission",
            "protocol",
            "digest",
        ] {
            let mut changed = descriptor.clone();
            let mut changed_digest = digest.to_vec();
            match mutate {
                "plugin" => changed.plugin_id = "tabverse.other".into(),
                "version" => changed.plugin_version = "2.0.0".into(),
                "entrypoint" => changed.entrypoint = "other".into(),
                "permission" => changed.permissions.push(crate::CapabilityRequest {
                    capability: "network".into(),
                    reason: "fixture mutation".into(),
                    optional: false,
                }),
                "protocol" => changed.protocol_range.max = 1,
                "digest" => changed_digest[0] ^= 1,
                _ => unreachable!(),
            }
            assert!(
                verifier.verify(&changed, &changed_digest).is_err(),
                "{mutate}"
            );
        }
    }

    #[test]
    fn trusted_key_file_is_strict_and_versioned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trusted-keys.json");
        fs::write(&path, br#"{"schemaVersion":2,"plugins":{}}"#).unwrap();
        assert_eq!(
            TrustedKeySet::read(&path).unwrap_err().to_string(),
            "resident-trusted-keys-incompatible"
        );
        fs::write(
            &path,
            br#"{"schemaVersion":1,"plugins":{},"unexpected":true}"#,
        )
        .unwrap();
        assert!(TrustedKeySet::read(&path).is_err());
    }
}
