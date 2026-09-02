use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const RESIDENT_PROTOCOL_CURRENT: u16 = 2;
pub const RESIDENT_PROTOCOL_PREVIOUS: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolRange {
    pub min: u16,
    pub max: u16,
}

impl ProtocolRange {
    pub fn negotiate(self, other: Self) -> Option<u16> {
        let min = self.min.max(other.min);
        let max = self.max.min(other.max);
        (min <= max).then_some(max)
    }

    pub const fn supervisor() -> Self {
        Self {
            min: RESIDENT_PROTOCOL_PREVIOUS,
            max: RESIDENT_PROTOCOL_CURRENT,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AuthToken([u8; 32]);

impl AuthToken {
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn matches(&self, candidate: &[u8]) -> bool {
        if candidate.len() != self.0.len() {
            return false;
        }
        let mut different = 0u8;
        for (expected, actual) in self.0.iter().zip(candidate) {
            different |= expected ^ actual;
        }
        different == 0
    }

    pub(crate) fn ipc_bytes(self) -> Vec<u8> {
        self.0.to_vec()
    }
}

impl fmt::Debug for AuthToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AuthToken([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol: ProtocolRange,
    pub app_version: String,
    pub token: Vec<u8>,
}

impl fmt::Debug for ClientHello {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientHello")
            .field("protocol", &self.protocol)
            .field("app_version", &self.app_version)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolWelcome {
    pub protocol: u16,
    pub supervisor_version: String,
}

pub fn authenticate_hello(
    expected: AuthToken,
    hello: &ClientHello,
    supervisor_version: &str,
) -> Result<ProtocolWelcome> {
    if !expected.matches(&hello.token) {
        bail!("resident-auth-denied")
    }
    let protocol = ProtocolRange::supervisor()
        .negotiate(hello.protocol)
        .ok_or_else(|| anyhow::anyhow!("resident-protocol-incompatible"))?;
    Ok(ProtocolWelcome {
        protocol,
        supervisor_version: supervisor_version.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_and_previous_negotiate_but_unknown_versions_do_not() {
        let token = AuthToken::new([7; 32]);
        for version in [RESIDENT_PROTOCOL_PREVIOUS, RESIDENT_PROTOCOL_CURRENT] {
            let welcome = authenticate_hello(
                token,
                &ClientHello {
                    protocol: ProtocolRange {
                        min: version,
                        max: version,
                    },
                    app_version: "test".into(),
                    token: vec![7; 32],
                },
                "2.0.0",
            )
            .unwrap();
            assert_eq!(welcome.protocol, version);
        }
        let incompatible = ClientHello {
            protocol: ProtocolRange { min: 3, max: 3 },
            app_version: "future".into(),
            token: vec![7; 32],
        };
        assert!(authenticate_hello(token, &incompatible, "2.0.0").is_err());
    }

    #[test]
    fn authentication_errors_and_debug_output_never_reveal_the_token() {
        let hello = ClientHello {
            protocol: ProtocolRange::supervisor(),
            app_version: "test".into(),
            token: vec![9; 32],
        };
        let rendered = format!("{hello:?} {:?}", AuthToken::new([9; 32]));
        assert!(!rendered.contains("9, 9"));
        assert!(rendered.contains("REDACTED"));
        assert_eq!(
            authenticate_hello(AuthToken::new([8; 32]), &hello, "2")
                .unwrap_err()
                .to_string(),
            "resident-auth-denied"
        );
    }
}
