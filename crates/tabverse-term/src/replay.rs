//! Binary-safe replay storage and attach ordering for helper-owned terminals.

use std::collections::VecDeque;

use crate::protocol::ProtocolError;

pub const DEFAULT_MAX_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_LINES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachBatch {
    pub snapshot: Vec<u8>,
    pub delta: Vec<u8>,
}

#[derive(Debug)]
struct AttachState {
    snapshot: Vec<u8>,
    delta: Vec<u8>,
}

/// One session's raw terminal history.
///
/// Bytes are never decoded as UTF-8. The line limit only treats `b'\n'` as
/// a boundary; the byte limit may trim inside a line because a line with no
/// newline must not grow without bound.
pub struct ReplayRing {
    bytes: VecDeque<u8>,
    max_bytes: usize,
    max_lines: usize,
    attach: Option<AttachState>,
}

impl Default for ReplayRing {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES)
    }
}

impl ReplayRing {
    pub fn new(max_bytes: usize, max_lines: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            max_bytes,
            max_lines,
            attach: None,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if let Some(attach) = &mut self.attach {
            attach.delta.extend_from_slice(chunk);
        }
        self.bytes.extend(chunk.iter().copied());
        self.enforce_limits();
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }

    /// Freeze the history that belongs to Snapshot. Bytes pushed after this
    /// call are recorded in `delta`, even if the ring later evicts them.
    pub fn begin_attach(&mut self) -> Result<(), ProtocolError> {
        if self.attach.is_some() {
            return Err(ProtocolError::AttachInProgress);
        }
        self.attach = Some(AttachState {
            snapshot: self.snapshot(),
            delta: Vec::new(),
        });
        Ok(())
    }

    /// Finish the ordered handoff. Future pushes are live output and are not
    /// repeated in this batch.
    pub fn finish_attach(&mut self) -> Result<AttachBatch, ProtocolError> {
        let attach = self
            .attach
            .take()
            .ok_or(ProtocolError::NoAttachInProgress)?;
        Ok(AttachBatch {
            snapshot: attach.snapshot,
            delta: attach.delta,
        })
    }

    fn enforce_limits(&mut self) {
        while self.bytes.len() > self.max_bytes {
            self.bytes.pop_front();
        }
        while self.logical_lines() > self.max_lines {
            // The line cap evicts a whole oldest line. When the oldest
            // retained fragment has no newline it is one line, not more than
            // the cap on its own, so this loop always finds a boundary.
            while let Some(byte) = self.bytes.pop_front() {
                if byte == b'\n' {
                    break;
                }
            }
        }
    }

    fn logical_lines(&self) -> usize {
        if self.bytes.is_empty() {
            return 0;
        }
        let newlines = self.bytes.iter().filter(|&&b| b == b'\n').count();
        newlines + usize::from(self.bytes.back() != Some(&b'\n'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_cap_evicts_the_oldest_bytes_and_keeps_binary_data() {
        let mut ring = ReplayRing::new(5, 100);
        ring.push(&[0, 0xff, 1]);
        ring.push(&[2, 3, 4]);
        assert_eq!(ring.snapshot(), vec![0xff, 1, 2, 3, 4]);
    }

    #[test]
    fn line_cap_evicts_whole_oldest_lines() {
        let mut ring = ReplayRing::new(100, 2);
        ring.push(b"one\ntwo\nthree");
        assert_eq!(ring.snapshot(), b"two\nthree");
        ring.push(b"\nfour");
        assert_eq!(ring.snapshot(), b"three\nfour");
    }

    #[test]
    fn an_unterminated_line_is_still_one_bounded_line() {
        let mut ring = ReplayRing::new(4, 1);
        ring.push(b"abcdef");
        assert_eq!(ring.snapshot(), b"cdef");
    }

    #[test]
    fn attach_orders_snapshot_then_delta_and_never_repeats_live() {
        let mut ring = ReplayRing::new(100, 100);
        ring.push(b"A");
        ring.begin_attach().unwrap();
        ring.push(b"B");
        let batch = ring.finish_attach().unwrap();
        ring.push(b"C");

        assert_eq!(batch.snapshot, b"A", "A existed before attach");
        assert_eq!(batch.delta, b"B", "B arrived during attach");
        assert_eq!(ring.snapshot(), b"ABC");
        assert!(
            !batch.snapshot.ends_with(b"B"),
            "delta must not leak into snapshot"
        );
        assert!(!batch.delta.ends_with(b"C"), "live C must not be replayed");
    }

    #[test]
    fn attach_delta_survives_ring_eviction() {
        let mut ring = ReplayRing::new(3, 100);
        ring.push(b"abc");
        ring.begin_attach().unwrap();
        ring.push(b"def");
        let batch = ring.finish_attach().unwrap();
        assert_eq!(batch.snapshot, b"abc");
        assert_eq!(batch.delta, b"def");
        assert_eq!(ring.snapshot(), b"def");
    }

    #[test]
    fn attach_state_is_single_use() {
        let mut ring = ReplayRing::default();
        assert_eq!(ring.finish_attach(), Err(ProtocolError::NoAttachInProgress));
        ring.begin_attach().unwrap();
        assert_eq!(ring.begin_attach(), Err(ProtocolError::AttachInProgress));
        ring.finish_attach().unwrap();
        assert_eq!(ring.finish_attach(), Err(ProtocolError::NoAttachInProgress));
    }
}
