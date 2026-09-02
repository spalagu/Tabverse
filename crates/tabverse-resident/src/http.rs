//! HTTP client construction for the standalone resident process.
//!
//! The resident worker cannot depend on the Tauri crate's HTTP factory, but
//! it keeps the same invariant: call sites receive clients from one audited
//! factory and never choose DNS or timeout policy ad hoc.

use std::{net::SocketAddr, sync::OnceLock, time::Duration};

pub fn build_pinned(host: &str, addrs: &[SocketAddr]) -> anyhow::Result<reqwest::Client> {
    static CRYPTO: OnceLock<()> = OnceLock::new();
    CRYPTO.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(120))
        .resolve_to_addrs(host, addrs)
        .build()?)
}
