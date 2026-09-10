//! The Codex provider.
//!
//! Split by concern rather than kept as one file: the stream parser is pure and
//! heavily tested, while authentication and transport touch the network and are
//! mostly plumbing. Keeping them apart is what lets the part with all the edge
//! cases be exercised without one.

pub mod auth;
pub mod provider;
pub mod request;
pub mod stream;
pub mod websocket;
