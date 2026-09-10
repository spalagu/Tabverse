//! The point every tool call passes through before it runs.
//!
//! A GUI agent may continue running while the user is focused elsewhere, so
//! every tool call is resolved by an in-process policy and approval gate before
//! execution.
//!
//! Two layers on purpose. A `Policy` answers from rules, instantly and without a
//! human. Only when it declines to decide does an `ApprovalGate` get asked, and
//! that is the slow path that ends up in front of a person — locally, or on a
//! second device once remote control is wired up.

use crate::event::PermissionOutcome;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny(String),
    /// No rule covers this; ask a human.
    Ask,
}

/// Rule-based, no human involved.
pub trait Policy: Send + Sync {
    fn decide(&self, tool_name: &str, input: &Value) -> Decision;
}

pub trait ApprovalGate: Send + Sync {
    /// `call_id` addresses this request. A gate that answers asynchronously —
    /// the UI one does, and so will the remote peer — needs it to route the
    /// reply back to the call that is waiting.
    fn request(&self, call_id: &str, tool_name: &str, input: &Value) -> Decision;
}

/// Ask about everything. The safe default, and what a fresh workspace gets.
pub struct AskEverything;

impl Policy for AskEverything {
    fn decide(&self, _tool_name: &str, _input: &Value) -> Decision {
        Decision::Ask
    }
}

/// Read-only tools run without asking; anything that writes or executes is put
/// to a human. The split is by what a tool can *do*, not by how it is named.
pub struct AllowReadOnly;

impl Policy for AllowReadOnly {
    fn decide(&self, tool_name: &str, _input: &Value) -> Decision {
        match tool_name {
            "read" | "glob" | "grep" => Decision::Allow,
            _ => Decision::Ask,
        }
    }
}

/// Test fixture that approves without asking.
#[cfg(test)]
pub(crate) struct ApproveForTest;

#[cfg(test)]
impl Policy for ApproveForTest {
    fn decide(&self, _tool_name: &str, _input: &Value) -> Decision {
        Decision::Allow
    }
}

#[cfg(test)]
impl ApprovalGate for ApproveForTest {
    fn request(&self, _call_id: &str, _tool_name: &str, _input: &Value) -> Decision {
        Decision::Allow
    }
}

/// Refuse everything that reaches the gate. Tests use it to prove that a denial
/// stops the tool and still lets the turn continue.
pub struct AutoDeny(pub String);

impl Default for AutoDeny {
    fn default() -> Self {
        Self("denied by policy".to_string())
    }
}

impl ApprovalGate for AutoDeny {
    fn request(&self, _call_id: &str, _tool_name: &str, _input: &Value) -> Decision {
        Decision::Deny(self.0.clone())
    }
}

/// Resolve a call to a final outcome: rules first, a human only if needed.
pub(crate) fn resolve(
    policy: &dyn Policy,
    gate: &dyn ApprovalGate,
    call_id: &str,
    tool_name: &str,
    input: &Value,
) -> PermissionOutcome {
    match policy.decide(tool_name, input) {
        Decision::Allow => PermissionOutcome::AllowedByRule,
        Decision::Deny(reason) => PermissionOutcome::Denied(reason),
        Decision::Ask => match gate.request(call_id, tool_name, input) {
            Decision::Allow => PermissionOutcome::Approved,
            Decision::Deny(reason) => PermissionOutcome::Denied(reason),
            // A gate that will not decide is treated as a refusal: running the
            // tool because nobody said no is exactly the failure this exists to
            // prevent.
            Decision::Ask => {
                PermissionOutcome::Denied("no decision was made on this request".to_string())
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_rule_allowing_it_never_reaches_the_gate() {
        struct ExplodingGate;
        impl ApprovalGate for ExplodingGate {
            fn request(&self, _c: &str, _t: &str, _i: &Value) -> Decision {
                panic!("the gate must not be consulted when a rule already allowed it");
            }
        }
        let outcome = resolve(
            &ApproveForTest,
            &ExplodingGate,
            "c-test",
            "read",
            &json!({}),
        );
        assert_eq!(outcome, PermissionOutcome::AllowedByRule);
    }

    #[test]
    fn read_only_tools_pass_and_writers_are_asked() {
        let gate = AutoDeny("nope".into());
        assert_eq!(
            resolve(&AllowReadOnly, &gate, "c-test", "grep", &json!({})),
            PermissionOutcome::AllowedByRule
        );
        assert_eq!(
            resolve(&AllowReadOnly, &gate, "c-test", "write", &json!({})),
            PermissionOutcome::Denied("nope".into())
        );
        assert_eq!(
            resolve(&AllowReadOnly, &gate, "c-test", "bash", &json!({})),
            PermissionOutcome::Denied("nope".into())
        );
    }

    #[test]
    fn an_undecided_gate_counts_as_refusal() {
        struct Undecided;
        impl ApprovalGate for Undecided {
            fn request(&self, _c: &str, _t: &str, _i: &Value) -> Decision {
                Decision::Ask
            }
        }
        match resolve(&AskEverything, &Undecided, "c-test", "bash", &json!({})) {
            PermissionOutcome::Denied(reason) => assert!(reason.contains("no decision")),
            other => panic!("silence must not authorise anything, got {other:?}"),
        }
    }

    #[test]
    fn approval_is_distinguishable_from_a_rule() {
        // The UI shows these differently: one happened silently, one cost the
        // user a click. The event stream must not conflate them.
        assert_eq!(
            resolve(
                &AskEverything,
                &ApproveForTest,
                "c-test",
                "write",
                &json!({})
            ),
            PermissionOutcome::Approved
        );
    }
}
