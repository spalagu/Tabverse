use std::{collections::HashMap, fmt, sync::Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Creating,
    Ready,
    Attached,
    Closing,
    Closed,
    Crashed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    TabClose,
    PluginDisable,
    AppExit,
    CreateFailed,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TabClose => "tab-close",
            Self::PluginDisable => "plugin-disable",
            Self::AppExit => "app-exit",
            Self::CreateFailed => "create-failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub tab_id: String,
    pub label: String,
    pub generation: u64,
    pub event_seq: u64,
    pub phase: SessionPhase,
    pub slot_revision: Option<u64>,
    pub close_reason: Option<CloseReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsureSession {
    Created(SessionSnapshot),
    Existing(SessionSnapshot),
}

impl EnsureSession {
    pub fn snapshot(&self) -> &SessionSnapshot {
        match self {
            Self::Created(snapshot) | Self::Existing(snapshot) => snapshot,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    ExitRequested,
    NotFound {
        tab_id: String,
    },
    StaleGeneration {
        expected: u64,
        actual: u64,
    },
    NotCommandable {
        phase: SessionPhase,
    },
    StaleSlotRevision {
        current: u64,
        received: u64,
    },
    InvalidTransition {
        from: SessionPhase,
        operation: &'static str,
    },
    GenerationExhausted,
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExitRequested => write!(f, "browser runtime is exiting"),
            Self::NotFound { tab_id } => write!(f, "browser session not found: {tab_id}"),
            Self::StaleGeneration { expected, actual } => {
                write!(
                    f,
                    "stale browser generation {actual}; current is {expected}"
                )
            }
            Self::NotCommandable { phase } => {
                write!(f, "browser session is not commandable in {phase:?}")
            }
            Self::StaleSlotRevision { current, received } => {
                write!(f, "stale surface revision {received}; current is {current}")
            }
            Self::InvalidTransition { from, operation } => {
                write!(f, "cannot {operation} a browser session in {from:?}")
            }
            Self::GenerationExhausted => write!(f, "browser session generation exhausted"),
        }
    }
}

impl std::error::Error for SessionError {}

#[derive(Debug)]
struct SessionRecord {
    label: String,
    generation: u64,
    event_seq: u64,
    phase: SessionPhase,
    slot_revision: Option<u64>,
    close_reason: Option<CloseReason>,
}

impl SessionRecord {
    fn snapshot(&self, tab_id: &str) -> SessionSnapshot {
        SessionSnapshot {
            tab_id: tab_id.to_owned(),
            label: self.label.clone(),
            generation: self.generation,
            event_seq: self.event_seq,
            phase: self.phase,
            slot_revision: self.slot_revision,
            close_reason: self.close_reason,
        }
    }

    fn advance(&mut self, phase: SessionPhase) {
        self.phase = phase;
        self.event_seq = self.event_seq.saturating_add(1);
    }
}

#[derive(Debug)]
struct Ledger {
    accepting: bool,
    next_generation: u64,
    sessions: HashMap<String, SessionRecord>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            accepting: true,
            next_generation: 1,
            sessions: HashMap::new(),
        }
    }
}

/// Linearizes browser lifecycle changes by tab id without owning engine objects.
///
/// The manager deliberately retains `Closing` records until the runtime reports
/// `BrowserClosed`; requesting a close is not treated as confirmation of one.
#[derive(Debug, Default)]
pub struct BrowserSessionManager {
    ledger: Mutex<Ledger>,
}

impl BrowserSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ensure_session(&self, tab_id: &str, label: &str) -> Result<EnsureSession, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        if !ledger.accepting {
            return Err(SessionError::ExitRequested);
        }

        if let Some(record) = ledger.sessions.get(tab_id) {
            if record.phase != SessionPhase::Closed {
                if record.phase == SessionPhase::Closing {
                    return Err(SessionError::NotCommandable {
                        phase: record.phase,
                    });
                }
                return Ok(EnsureSession::Existing(record.snapshot(tab_id)));
            }
        }

        let generation = ledger.next_generation;
        ledger.next_generation = generation
            .checked_add(1)
            .ok_or(SessionError::GenerationExhausted)?;
        let record = SessionRecord {
            label: label.to_owned(),
            generation,
            event_seq: 0,
            phase: SessionPhase::Creating,
            slot_revision: None,
            close_reason: None,
        };
        let snapshot = record.snapshot(tab_id);
        ledger.sessions.insert(tab_id.to_owned(), record);
        Ok(EnsureSession::Created(snapshot))
    }

    pub fn mark_ready(
        &self,
        tab_id: &str,
        generation: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        let record = current_record(&mut ledger, tab_id, generation)?;
        match record.phase {
            SessionPhase::Creating | SessionPhase::Crashed => record.advance(SessionPhase::Ready),
            SessionPhase::Ready | SessionPhase::Attached => {}
            phase => {
                return Err(SessionError::InvalidTransition {
                    from: phase,
                    operation: "mark ready",
                })
            }
        }
        Ok(record.snapshot(tab_id))
    }

    pub fn attach_surface(
        &self,
        tab_id: &str,
        generation: u64,
        slot_revision: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        let record = current_record(&mut ledger, tab_id, generation)?;
        if !matches!(record.phase, SessionPhase::Ready | SessionPhase::Attached) {
            return Err(SessionError::InvalidTransition {
                from: record.phase,
                operation: "attach a surface",
            });
        }
        if let Some(current) = record.slot_revision {
            if slot_revision < current {
                return Err(SessionError::StaleSlotRevision {
                    current,
                    received: slot_revision,
                });
            }
            if slot_revision == current {
                return Ok(record.snapshot(tab_id));
            }
        }
        record.slot_revision = Some(slot_revision);
        record.advance(SessionPhase::Attached);
        Ok(record.snapshot(tab_id))
    }

    pub fn accept_command(
        &self,
        tab_id: &str,
        generation: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        if !ledger.accepting {
            return Err(SessionError::ExitRequested);
        }
        let record = current_record(&mut ledger, tab_id, generation)?;
        if !matches!(record.phase, SessionPhase::Ready | SessionPhase::Attached) {
            return Err(SessionError::NotCommandable {
                phase: record.phase,
            });
        }
        Ok(record.snapshot(tab_id))
    }

    pub fn renderer_crashed(
        &self,
        tab_id: &str,
        generation: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        let record = current_record(&mut ledger, tab_id, generation)?;
        match record.phase {
            SessionPhase::Ready | SessionPhase::Attached => record.advance(SessionPhase::Crashed),
            phase => {
                return Err(SessionError::InvalidTransition {
                    from: phase,
                    operation: "record a renderer crash for",
                })
            }
        }
        Ok(record.snapshot(tab_id))
    }

    pub fn begin_close(
        &self,
        tab_id: &str,
        generation: u64,
        reason: CloseReason,
    ) -> Result<SessionSnapshot, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        let record = current_record(&mut ledger, tab_id, generation)?;
        match record.phase {
            SessionPhase::Creating
            | SessionPhase::Ready
            | SessionPhase::Attached
            | SessionPhase::Crashed => {
                record.close_reason = Some(reason);
                record.advance(SessionPhase::Closing);
            }
            SessionPhase::Closing if record.close_reason == Some(reason) => {}
            SessionPhase::Closing => {
                return Err(SessionError::InvalidTransition {
                    from: record.phase,
                    operation: "change close reason for",
                });
            }
            phase => {
                return Err(SessionError::InvalidTransition {
                    from: phase,
                    operation: "begin closing",
                })
            }
        }
        Ok(record.snapshot(tab_id))
    }

    pub fn abort_create(
        &self,
        tab_id: &str,
        generation: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        let record = current_record(&mut ledger, tab_id, generation)?;
        if record.phase != SessionPhase::Creating {
            return Err(SessionError::InvalidTransition {
                from: record.phase,
                operation: "abort creation of",
            });
        }
        record.close_reason = Some(CloseReason::CreateFailed);
        record.advance(SessionPhase::Closed);
        Ok(record.snapshot(tab_id))
    }

    pub fn confirm_closed(
        &self,
        tab_id: &str,
        generation: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        let mut ledger = self.ledger.lock().unwrap();
        let record = current_record(&mut ledger, tab_id, generation)?;
        match record.phase {
            SessionPhase::Closing => record.advance(SessionPhase::Closed),
            SessionPhase::Closed => {}
            phase => {
                return Err(SessionError::InvalidTransition {
                    from: phase,
                    operation: "confirm closed",
                })
            }
        }
        Ok(record.snapshot(tab_id))
    }

    pub fn request_exit(&self) -> Vec<SessionSnapshot> {
        let mut ledger = self.ledger.lock().unwrap();
        ledger.accepting = false;
        ledger
            .sessions
            .iter_mut()
            .filter_map(|(tab_id, record)| {
                if record.phase == SessionPhase::Closed {
                    return None;
                }
                if record.phase != SessionPhase::Closing {
                    record.close_reason = Some(CloseReason::AppExit);
                    record.advance(SessionPhase::Closing);
                }
                Some(record.snapshot(tab_id))
            })
            .collect()
    }

    pub fn snapshot(&self, tab_id: &str) -> Option<SessionSnapshot> {
        self.ledger
            .lock()
            .unwrap()
            .sessions
            .get(tab_id)
            .map(|record| record.snapshot(tab_id))
    }

    pub fn live_count(&self) -> usize {
        self.ledger
            .lock()
            .unwrap()
            .sessions
            .values()
            .filter(|record| record.phase != SessionPhase::Closed)
            .count()
    }
}

fn current_record<'a>(
    ledger: &'a mut Ledger,
    tab_id: &str,
    generation: u64,
) -> Result<&'a mut SessionRecord, SessionError> {
    let record = ledger
        .sessions
        .get_mut(tab_id)
        .ok_or_else(|| SessionError::NotFound {
            tab_id: tab_id.to_owned(),
        })?;
    if record.generation != generation {
        return Err(SessionError::StaleGeneration {
            expected: record.generation,
            actual: generation,
        });
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Barrier},
        thread,
    };

    use super::*;

    fn create_ready(manager: &BrowserSessionManager, tab_id: &str) -> SessionSnapshot {
        let ensured = manager.ensure_session(tab_id, &format!("browser-{tab_id}"));
        let created = match ensured.unwrap() {
            EnsureSession::Created(snapshot) => snapshot,
            EnsureSession::Existing(_) => panic!("expected a fresh session"),
        };
        manager.mark_ready(tab_id, created.generation).unwrap()
    }

    #[test]
    fn concurrent_ensure_linearizes_to_one_generation() {
        let manager = Arc::new(BrowserSessionManager::new());
        let barrier = Arc::new(Barrier::new(24));
        let threads: Vec<_> = (0..24)
            .map(|_| {
                let manager = manager.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    manager.ensure_session("tab-a", "browser-tab-a").unwrap()
                })
            })
            .collect();
        let outcomes: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();

        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, EnsureSession::Created(_)))
                .count(),
            1
        );
        assert!(outcomes
            .iter()
            .all(|outcome| outcome.snapshot().generation == 1));
        assert_eq!(manager.live_count(), 1);
    }

    #[test]
    fn stale_surface_revisions_cannot_overwrite_new_geometry() {
        let manager = BrowserSessionManager::new();
        let ready = create_ready(&manager, "tab-a");
        let attached = manager
            .attach_surface("tab-a", ready.generation, 8)
            .unwrap();
        assert_eq!(attached.slot_revision, Some(8));
        assert_eq!(attached.phase, SessionPhase::Attached);

        let repeated = manager
            .attach_surface("tab-a", ready.generation, 8)
            .unwrap();
        assert_eq!(repeated.event_seq, attached.event_seq);
        assert_eq!(
            manager.attach_surface("tab-a", ready.generation, 7),
            Err(SessionError::StaleSlotRevision {
                current: 8,
                received: 7,
            })
        );
        assert_eq!(
            manager
                .attach_surface("tab-a", ready.generation, 9)
                .unwrap()
                .slot_revision,
            Some(9)
        );
    }

    #[test]
    fn exit_rejects_new_sessions_and_commands_until_close_confirmation() {
        let manager = BrowserSessionManager::new();
        let first = create_ready(&manager, "tab-a");
        let second = create_ready(&manager, "tab-b");

        let closing = manager.request_exit();
        assert_eq!(closing.len(), 2);
        assert!(closing
            .iter()
            .all(|snapshot| snapshot.close_reason == Some(CloseReason::AppExit)));
        assert_eq!(manager.live_count(), 2);
        assert_eq!(
            manager.ensure_session("tab-c", "browser-tab-c"),
            Err(SessionError::ExitRequested)
        );
        assert_eq!(
            manager.accept_command("tab-a", first.generation),
            Err(SessionError::ExitRequested)
        );

        manager.confirm_closed("tab-a", first.generation).unwrap();
        assert_eq!(manager.live_count(), 1);
        manager.confirm_closed("tab-b", second.generation).unwrap();
        assert_eq!(manager.live_count(), 0);
    }

    #[test]
    fn failed_creation_closes_the_generation_and_allows_a_retry() {
        let manager = BrowserSessionManager::new();
        let created = manager.ensure_session("tab-a", "browser-tab-a").unwrap();
        let first = created.snapshot().clone();
        let aborted = manager.abort_create("tab-a", first.generation).unwrap();
        assert_eq!(aborted.phase, SessionPhase::Closed);
        assert_eq!(aborted.close_reason, Some(CloseReason::CreateFailed));
        assert_eq!(manager.live_count(), 0);

        let retried = manager.ensure_session("tab-a", "browser-tab-a").unwrap();
        assert_eq!(retried.snapshot().generation, first.generation + 1);
    }

    #[test]
    fn a_crashed_session_only_becomes_commandable_after_explicit_recovery() {
        let manager = BrowserSessionManager::new();
        let ready = create_ready(&manager, "tab-a");
        let crashed = manager.renderer_crashed("tab-a", ready.generation).unwrap();
        assert_eq!(crashed.phase, SessionPhase::Crashed);
        assert_eq!(
            manager.accept_command("tab-a", ready.generation),
            Err(SessionError::NotCommandable {
                phase: SessionPhase::Crashed,
            })
        );
        let recovered = manager.mark_ready("tab-a", ready.generation).unwrap();
        assert_eq!(recovered.phase, SessionPhase::Ready);
        assert!(manager.accept_command("tab-a", ready.generation).is_ok());
    }

    #[test]
    fn one_hundred_close_cycles_advance_generation_and_reject_stale_commands() {
        let manager = BrowserSessionManager::new();
        let mut previous_generation = None;

        for expected in 1..=100 {
            let ready = create_ready(&manager, "tab-a");
            assert_eq!(ready.generation, expected);
            manager
                .attach_surface("tab-a", ready.generation, expected)
                .unwrap();
            manager
                .begin_close("tab-a", ready.generation, CloseReason::TabClose)
                .unwrap();
            manager.confirm_closed("tab-a", ready.generation).unwrap();
            assert_eq!(manager.live_count(), 0);

            if let Some(stale) = previous_generation {
                assert_eq!(
                    manager.accept_command("tab-a", stale),
                    Err(SessionError::StaleGeneration {
                        expected,
                        actual: stale,
                    })
                );
            }
            previous_generation = Some(ready.generation);
        }
    }
}
