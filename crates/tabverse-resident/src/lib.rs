//! Per-user Tabverse control plane for continuous runtimes outside the GUI.
//!
//! This crate does not depend on Tauri or React. The GUI can only request the
//! control plane through the protocol. Only the process holding [`Supervisor`]
//! can invoke the worker factory, making continuous-worker ownership a structural
//! constraint instead of a caller convention.

pub mod http;
mod installer;
mod ipc;
mod platform;
mod process;
mod protocol;
mod signature;
mod store;
mod supervisor;

pub use installer::{InstallArtifacts, StagedInstall};
pub use ipc::{ResidentClient, ResidentServer};
pub use platform::{resolve_current_supervisor, InstallFile, InstallPlan, PlatformKind};
pub use process::ProcessWorkerFactory;
pub use protocol::{
    authenticate_hello, AuthToken, ClientHello, ProtocolRange, ProtocolWelcome,
    RESIDENT_PROTOCOL_CURRENT, RESIDENT_PROTOCOL_PREVIOUS,
};
pub use signature::{Ed25519SignatureVerifier, TrustedKeySet};
pub use store::{
    AttachReplay, CapabilityRequest, EventRecord, ResidentStore, RuntimeDescriptor, RuntimeRef,
    RuntimeStatus,
};
pub use supervisor::{
    ArtifactVerifier, EnsureRuntime, RunningWorker, SignatureVerifier, SpawnedWorker, Supervisor,
    WorkerContext, WorkerFactory, WorkerOutput,
};
