//! The turn loop.
//!
//! Send the conversation, receive text and possibly tool calls, run the tools
//! that are permitted, feed every result back, and go again until the model
//! stops asking. Everything else in this crate exists to keep this function
//! honest: events for what happened, a provider trait so it can be driven
//! without a network, a permission point so nothing runs unexamined.
//!
//! Three decisions here are worth stating because the obvious alternative is
//! wrong. A refused tool still produces a result that goes back to the model —
//! silence would leave it waiting on an answer that never comes, and it cannot
//! adapt to a refusal it was never told about. A tool that fails is likewise an
//! error *result*, not an aborted turn: "the file was not found" is information
//! the model can act on. And an unknown tool name is answered the same way,
//! because models do occasionally invent one.

use crate::branch;
use crate::compact::{self, Budget};
use crate::event::{
    EventSink, LocationView, PermissionOutcome, SessionEvent, StopReason, ToolCallView,
};
use crate::permission::{self, ApprovalGate, Policy};
use crate::provider::{Message, Provider, ProviderEvent, ToolCall, ToolSpec};
use anyhow::Result;
use tabverse_agent_tools::{env::ExecutionEnv, CancelToken, Tool, ToolContext, ToolProgress};

/// Ceiling on tool rounds within a single prompt. A model that keeps asking
/// forever is a real failure mode, and an unbounded loop spends real money.
pub const DEFAULT_MAX_ROUNDS: u32 = 50;

pub struct Session<'a> {
    provider: &'a dyn Provider,
    tools: Vec<Box<dyn Tool>>,
    policy: &'a dyn Policy,
    gate: &'a dyn ApprovalGate,
    env: &'a dyn ExecutionEnv,
    cancel: CancelToken,
    messages: Vec<Message>,
    max_rounds: u32,
    budget: Budget,
    /// What the agent remembers from earlier sessions, kept ahead of the
    /// conversation rather than inside it.
    memory: Option<Message>,
}

impl<'a> Session<'a> {
    pub fn new(
        provider: &'a dyn Provider,
        tools: Vec<Box<dyn Tool>>,
        policy: &'a dyn Policy,
        gate: &'a dyn ApprovalGate,
        env: &'a dyn ExecutionEnv,
    ) -> Self {
        Self {
            provider,
            tools,
            policy,
            gate,
            env,
            cancel: CancelToken::new(),
            messages: Vec::new(),
            max_rounds: DEFAULT_MAX_ROUNDS,
            budget: Budget::default(),
            memory: None,
        }
    }

    pub fn with_max_rounds(mut self, rounds: u32) -> Self {
        self.max_rounds = rounds;
        self
    }

    /// Set when to compact and how much to keep.
    pub fn with_budget(mut self, budget: Budget) -> Self {
        self.budget = budget;
        self
    }

    /// Put what the agent remembers ahead of every request.
    ///
    /// Ahead of, not inside: memory is not part of the conversation. Prepending
    /// it to `messages` would write it into the session log on every turn,
    /// count it as conversation when deciding whether to compact, and
    /// eventually let compaction summarise it away. Sitting in front also puts
    /// it where a prefix cache wants the least-changing bytes to be.
    pub fn with_memory(mut self, preamble: Option<Message>) -> Self {
        self.memory = preamble;
        self
    }

    /// What actually goes to the provider: memory first, then the conversation.
    fn request_messages(&self) -> Vec<Message> {
        match &self.memory {
            None => self.messages.clone(),
            Some(preamble) => {
                let mut out = Vec::with_capacity(self.messages.len() + 1);
                out.push(preamble.clone());
                out.extend_from_slice(&self.messages);
                out
            }
        }
    }

    /// Drive cancellation from a token the caller already holds.
    ///
    /// Without this the session makes its own, and anyone outside — the stop
    /// button, the remote peer — ends up holding a token the loop never reads.
    /// The signal has to be the same object on both sides.
    pub fn with_cancel(mut self, token: CancelToken) -> Self {
        self.cancel = token;
        self
    }

    /// Resume from a replayed log. The conversation continues where it stopped
    /// rather than starting over, which is the difference between reopening a
    /// session and merely seeing a transcript of one.
    pub fn with_history(mut self, messages: Vec<Message>) -> Self {
        self.messages = messages;
        self
    }

    /// Handle to stop the run from elsewhere — the UI's stop button, or the
    /// remote peer's.
    pub fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }

    /// The conversation so far. The session log and any compaction pass read this.
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// Append the messages added since `from` to a log, returning the new
    /// cursor. Append-only means the caller tracks how far it has written —
    /// rewriting the whole conversation each turn would defeat the format.
    pub fn append_new_messages(
        &self,
        log: &mut crate::log::SessionLog,
        from: usize,
    ) -> Result<usize> {
        for message in self.messages.iter().skip(from) {
            log.append_message(message)?;
        }
        Ok(self.messages.len())
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.tools
            .iter()
            .map(|t| ToolSpec {
                name: t.name().to_string(),
                description: t.description(),
                parameters: t.parameters(),
            })
            .collect()
    }

    fn find_tool(&self, name: &str) -> Option<&dyn Tool> {
        self.tools
            .iter()
            .find(|t| t.name() == name)
            .map(|t| t.as_ref())
    }

    /// Run one user prompt to completion.
    pub fn prompt(&mut self, text: &str, sink: &mut dyn EventSink) -> Result<StopReason> {
        sink.emit(SessionEvent::UserPrompt {
            text: text.to_string(),
        });
        self.messages.push(Message::User {
            text: text.to_string(),
        });

        // Between turns, once, and only past a threshold. Compacting rewrites
        // the prefix, which throws away the provider's cache for every token
        // before it — so it is priced deliberately here rather than checked
        // opportunistically inside the loop, where it would also change the
        // conversation underneath a tool round that is already in flight.
        if compact::needs_compaction(&self.messages, &self.budget) {
            match compact::compact(&self.messages, &self.budget, self.provider) {
                Ok(done) => {
                    sink.emit(SessionEvent::Compacted {
                        tokens_before: done.tokens_before,
                        tokens_after: done.tokens_after,
                        replaced: done.replaced,
                    });
                    self.messages = done.messages;
                }
                Err(error) => {
                    // Past the threshold the next request is very likely to be
                    // refused for length, and that refusal is harder to act on
                    // than this one. Ending here names the actual problem.
                    let reason =
                        StopReason::Error(format!("could not compact the history: {error}"));
                    sink.emit(SessionEvent::TurnEnded {
                        turn: 0,
                        reason: reason.clone(),
                    });
                    return Ok(reason);
                }
            }
        }

        let specs = self.tool_specs();
        let mut turn: u32 = 0;

        loop {
            if self.cancel.is_cancelled() {
                sink.emit(SessionEvent::TurnEnded {
                    turn,
                    reason: StopReason::Cancelled,
                });
                return Ok(StopReason::Cancelled);
            }

            turn += 1;
            sink.emit(SessionEvent::TurnStarted { turn });

            let outcome = {
                let mut forward = |event: ProviderEvent| match event {
                    ProviderEvent::Text(delta) => sink.emit(SessionEvent::AssistantText { delta }),
                    ProviderEvent::Thinking(delta) => {
                        sink.emit(SessionEvent::AssistantThinking { delta })
                    }
                };
                match self
                    .provider
                    .stream(&self.request_messages(), &specs, &mut forward)
                {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        let reason = StopReason::Error(error.to_string());
                        sink.emit(SessionEvent::TurnEnded {
                            turn,
                            reason: reason.clone(),
                        });
                        return Ok(reason);
                    }
                }
            };

            self.messages.push(Message::Assistant {
                text: outcome.text.clone(),
                tool_calls: outcome.tool_calls.clone(),
            });

            if outcome.tool_calls.is_empty() {
                sink.emit(SessionEvent::TurnEnded {
                    turn,
                    reason: StopReason::Done,
                });
                return Ok(StopReason::Done);
            }

            for call in &outcome.tool_calls {
                // A model often asks for several tools at once. Once the user
                // has stopped the turn, the ones behind the cancelled call must
                // not run, and must not put more approval prompts in front of
                // someone who just said stop. They still get a result message:
                // a tool call left unanswered would make the history invalid
                // for the next request.
                let result = if self.cancel.is_cancelled() {
                    let content = format!("`{}` was not run: the turn was stopped.", call.name);
                    sink.emit(SessionEvent::ToolFinished {
                        call_id: call.id.clone(),
                        result: content.clone(),
                        is_error: true,
                        location: None,
                    });
                    CallResult {
                        content,
                        is_error: true,
                    }
                } else {
                    self.run_one_call(call, sink)
                };
                // Folded on the way in, never afterwards. Shrinking a message
                // that has already been sent would rewrite the prefix and cost
                // the cache from that point on; doing it here means every
                // message already in the conversation stays exactly what it
                // was. What the user saw in ToolFinished is the untouched
                // result — the fold is about what the model has to carry.
                let content = match branch::fold(&result.content, &mut |full| {
                    branch::spill_to_temp_file(full)
                }) {
                    Ok(folded) => folded.text,
                    // Nowhere to park the middle means folding would destroy
                    // it, so the full result goes through instead. Bigger than
                    // ideal beats silently losing what a tool found.
                    Err(_) => result.content,
                };
                self.messages.push(Message::ToolResult {
                    call_id: call.id.clone(),
                    content,
                    is_error: result.is_error,
                });
            }

            // Checked here, not only at the top of the loop. The moment a user
            // is most likely to press stop is while a tool is running or an
            // approval is waiting on them — and if the model then asks for
            // nothing further, a check that only happens next time round would
            // let the turn end as "done" and swallow the cancellation entirely.
            if self.cancel.is_cancelled() {
                sink.emit(SessionEvent::TurnEnded {
                    turn,
                    reason: StopReason::Cancelled,
                });
                return Ok(StopReason::Cancelled);
            }

            // Deliberately nothing here. A tool round finishing is not the turn
            // finishing: the model is about to be asked again. Emitting
            // TurnEnded{Done} after every round told the UI the work was over
            // while it was still going — in the built app the stop button
            // turned back into send while an approval was still waiting, which
            // is exactly the moment a user wants it. The next TurnStarted is
            // what closes the round; only a return from this function ends the
            // turn.

            if turn >= self.max_rounds {
                sink.emit(SessionEvent::TurnEnded {
                    turn,
                    reason: StopReason::RoundLimit,
                });
                return Ok(StopReason::RoundLimit);
            }
        }
    }

    fn run_one_call(&self, call: &ToolCall, sink: &mut dyn EventSink) -> CallResult {
        let view = ToolCallView {
            call_id: call.id.clone(),
            name: call.name.clone(),
            input: call.input.clone(),
        };

        // An invented tool name is answered, not raised: the model can pick a
        // real one next round if it is told which ones exist.
        let Some(tool) = self.find_tool(&call.name) else {
            let known: Vec<&str> = self.tools.iter().map(|t| t.name()).collect();
            let content = format!(
                "No tool named `{}`. Available tools: {}.",
                call.name,
                known.join(", ")
            );
            sink.emit(SessionEvent::ToolFinished {
                call_id: call.id.clone(),
                result: content.clone(),
                is_error: true,
                location: None,
            });
            return CallResult {
                content,
                is_error: true,
            };
        };

        sink.emit(SessionEvent::PermissionRequested(view.clone()));
        let outcome =
            permission::resolve(self.policy, self.gate, &call.id, &call.name, &call.input);
        sink.emit(SessionEvent::PermissionResolved {
            call_id: call.id.clone(),
            outcome: outcome.clone(),
        });

        if let PermissionOutcome::Denied(reason) = outcome {
            let content = format!("Permission denied for `{}`: {reason}", call.name);
            sink.emit(SessionEvent::ToolFinished {
                call_id: call.id.clone(),
                result: content.clone(),
                is_error: true,
                location: None,
            });
            return CallResult {
                content,
                is_error: true,
            };
        }

        sink.emit(SessionEvent::ToolStarted(view));

        let ctx = ToolContext::new(self.env, &self.cancel);
        let call_id = call.id.clone();
        let mut progress = |p: ToolProgress| {
            let ToolProgress::Output(chunk) = p;
            sink.emit(SessionEvent::ToolProgress {
                call_id: call_id.clone(),
                chunk,
            });
        };

        match tool.execute(call.input.clone(), &ctx, &mut progress) {
            Ok(output) => {
                let content = output.joined_text();
                sink.emit(SessionEvent::ToolFinished {
                    call_id: call.id.clone(),
                    result: content.clone(),
                    is_error: false,
                    location: output.location.as_ref().map(LocationView::from),
                });
                CallResult {
                    content,
                    is_error: false,
                }
            }
            Err(error) => {
                let content = error.to_string();
                sink.emit(SessionEvent::ToolFinished {
                    call_id: call.id.clone(),
                    result: content.clone(),
                    is_error: true,
                    location: None,
                });
                CallResult {
                    content,
                    is_error: true,
                }
            }
        }
    }
}

struct CallResult {
    content: String,
    is_error: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventLog;
    use crate::permission::{AllowReadOnly, ApproveForTest, AskEverything, AutoDeny};
    use crate::provider::{turn_calling, turn_saying, ScriptedProvider};
    use serde_json::json;
    use tabverse_agent_tools::{builtin_tools, env::LocalEnv};

    fn workspace() -> (tempfile::TempDir, LocalEnv) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "file contents here\n").unwrap();
        let env = LocalEnv::new(dir.path());
        (dir, env)
    }

    #[test]
    fn a_turn_with_no_tool_calls_ends_immediately() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::saying("Nothing to do.");
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );

        let reason = session.prompt("hi", &mut log).unwrap();
        assert_eq!(reason, StopReason::Done);
        assert_eq!(log.assistant_text(), "Nothing to do.");
        assert!(log.tools_run().is_empty());
    }

    #[test]
    fn full_loop_calls_a_tool_feeds_the_result_back_and_continues() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "hello.txt" })),
            turn_saying("The file says: file contents here"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );

        let reason = session.prompt("what is in hello.txt?", &mut log).unwrap();
        assert_eq!(reason, StopReason::Done);
        assert_eq!(log.tools_run(), vec!["read"]);

        // The second request must carry the tool result, or the model is
        // answering without ever seeing what the tool produced.
        let second = provider
            .nth_request(1)
            .expect("a second request must happen");
        let fed_back = second.iter().any(|m| {
            matches!(m, Message::ToolResult { content, is_error, .. }
                if content.contains("file contents here") && !is_error)
        });
        assert!(fed_back, "tool result must be fed back: {second:#?}");
    }

    #[test]
    fn event_order_is_request_resolve_start_finish() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "hello.txt" })),
            turn_saying("done"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("go", &mut log).unwrap();

        let names: Vec<&str> = log
            .events
            .iter()
            .map(|e| match e {
                SessionEvent::UserPrompt { .. } => "user_prompt",
                SessionEvent::TurnStarted { .. } => "turn_started",
                SessionEvent::AssistantText { .. } => "text",
                SessionEvent::AssistantThinking { .. } => "thinking",
                SessionEvent::PermissionRequested(_) => "permission_requested",
                SessionEvent::PermissionResolved { .. } => "permission_resolved",
                SessionEvent::ToolStarted(_) => "tool_started",
                SessionEvent::ToolProgress { .. } => "tool_progress",
                SessionEvent::ToolFinished { .. } => "tool_finished",
                SessionEvent::TurnEnded { .. } => "turn_ended",
                SessionEvent::Compacted { .. } => "compacted",
            })
            .collect();
        let expected = [
            "user_prompt",
            "turn_started",
            "permission_requested",
            "permission_resolved",
            "tool_started",
            "tool_finished",
            // No turn_ended here: the round is over but the answer is not, and
            // the next turn_started is what closes it. Anything watching this
            // stream for "the work is finished" must see exactly one of these.
            "turn_started",
            "text",
            "turn_ended",
        ];
        assert_eq!(names, expected, "got {names:?}");
        assert_eq!(
            names.iter().filter(|n| **n == "turn_ended").count(),
            1,
            "one answer, one ending"
        );
    }

    #[test]
    fn a_denied_tool_does_not_run_and_the_refusal_reaches_the_model() {
        let (dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling(
                "c1",
                "write",
                json!({ "path": "created.txt", "content": "x" }),
            ),
            turn_saying("understood"),
        ]);
        let mut log = EventLog::new();
        let deny = AutoDeny("the user said no".into());
        let mut session = Session::new(&provider, builtin_tools(), &AskEverything, &deny, &env);

        session.prompt("write a file", &mut log).unwrap();

        assert!(
            !dir.path().join("created.txt").exists(),
            "a denied tool must not have run"
        );
        assert!(
            log.tools_run().is_empty(),
            "tool_started must not be emitted"
        );
        let second = provider.nth_request(1).unwrap();
        let told = second.iter().any(|m| {
            matches!(m, Message::ToolResult { content, is_error, .. }
                if content.contains("the user said no") && *is_error)
        });
        assert!(told, "the model must be told it was refused: {second:#?}");
    }

    #[test]
    fn a_rule_can_allow_reads_while_writes_are_still_refused() {
        let (dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "hello.txt" })),
            turn_calling("c2", "write", json!({ "path": "new.txt", "content": "x" })),
            turn_saying("ok"),
        ]);
        let mut log = EventLog::new();
        let deny = AutoDeny::default();
        let mut session = Session::new(&provider, builtin_tools(), &AllowReadOnly, &deny, &env);
        session.prompt("go", &mut log).unwrap();

        assert_eq!(
            log.tools_run(),
            vec!["read"],
            "only the read should have run"
        );
        assert!(!dir.path().join("new.txt").exists());

        let outcomes: Vec<&PermissionOutcome> = log
            .events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::PermissionResolved { outcome, .. } => Some(outcome),
                _ => None,
            })
            .collect();
        assert_eq!(outcomes[0], &PermissionOutcome::AllowedByRule);
        assert!(matches!(outcomes[1], PermissionOutcome::Denied(_)));
    }

    #[test]
    fn a_failing_tool_is_a_result_not_an_aborted_turn() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "missing.txt" })),
            turn_saying("I see, it does not exist"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );

        let reason = session.prompt("read a missing file", &mut log).unwrap();
        assert_eq!(
            reason,
            StopReason::Done,
            "a tool error must not end the run"
        );
        let second = provider.nth_request(1).unwrap();
        assert!(second.iter().any(|m| {
            matches!(m, Message::ToolResult { content, is_error, .. }
                if *is_error && content.contains("missing.txt"))
        }));
    }

    #[test]
    fn an_invented_tool_name_is_answered_with_the_real_list() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "teleport", json!({})),
            turn_saying("my mistake"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("go", &mut log).unwrap();

        let second = provider.nth_request(1).unwrap();
        let told = second.iter().any(|m| {
            matches!(m, Message::ToolResult { content, is_error, .. }
                if *is_error && content.contains("No tool named") && content.contains("read"))
        });
        assert!(told, "the model must learn which tools exist: {second:#?}");
    }

    #[test]
    fn two_tool_calls_in_one_turn_both_run_in_order() {
        let (dir, env) = workspace();
        let mut turn = turn_calling("c1", "write", json!({ "path": "a.txt", "content": "A" }));
        turn.tool_calls.push(crate::provider::ToolCall {
            id: "c2".into(),
            name: "write".into(),
            input: json!({ "path": "b.txt", "content": "B" }),
        });
        let provider = ScriptedProvider::new(vec![turn, turn_saying("both written")]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("write two files", &mut log).unwrap();

        assert_eq!(log.tools_run(), vec!["write", "write"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "A"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("b.txt")).unwrap(),
            "B"
        );
    }

    #[test]
    fn a_model_that_never_stops_is_cut_off_at_the_round_limit() {
        let (_dir, env) = workspace();
        // The script runs out, and an exhausted ScriptedProvider keeps returning
        // empty turns — which end the loop. So supply enough tool-calling turns
        // to exceed the limit instead.
        let turns: Vec<_> = (0..6)
            .map(|i| turn_calling(&format!("c{i}"), "read", json!({ "path": "hello.txt" })))
            .collect();
        let provider = ScriptedProvider::new(turns);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_max_rounds(3);

        let reason = session.prompt("loop forever", &mut log).unwrap();
        assert_eq!(reason, StopReason::RoundLimit);
        assert_eq!(log.tools_run().len(), 3, "must stop after the third round");
    }

    #[test]
    fn cancelling_while_a_tool_runs_ends_the_turn_as_cancelled() {
        // The stop button's shape: something cancels the shared token while the
        // turn is parked on an approval.
        struct CancelWhileAsked(CancelToken);
        impl crate::permission::ApprovalGate for CancelWhileAsked {
            fn request(
                &self,
                _call_id: &str,
                _tool: &str,
                _input: &serde_json::Value,
            ) -> crate::permission::Decision {
                self.0.cancel();
                crate::permission::Decision::Deny("stopped".into())
            }
        }

        let (dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "write", json!({ "path": "made.txt", "content": "x" })),
            turn_saying("should not be reached"),
        ]);
        let token = CancelToken::new();
        let gate = CancelWhileAsked(token.clone());
        let mut log = EventLog::new();
        let mut session = Session::new(&provider, builtin_tools(), &AskEverything, &gate, &env)
            .with_cancel(token);

        let reason = session.prompt("write a file", &mut log).unwrap();
        assert_eq!(
            reason,
            StopReason::Cancelled,
            "stop during a tool must not read as done"
        );
        assert!(
            !dir.path().join("made.txt").exists(),
            "the tool must not have run"
        );
        assert!(
            matches!(
                log.events.last(),
                Some(SessionEvent::TurnEnded {
                    reason: StopReason::Cancelled,
                    ..
                })
            ),
            "the last event must say cancelled, got {:?}",
            log.events.last()
        );
        assert_eq!(
            provider.request_count(),
            1,
            "a cancelled turn must not go back to the model for another round"
        );
    }

    #[test]
    fn a_stopped_turn_does_not_ask_about_the_calls_behind_it() {
        // A model may ask for several tools in one turn. Stopping the first
        // must not leave the user answering approval prompts for the rest.
        struct CancelWhenAsked(CancelToken);
        impl crate::permission::ApprovalGate for CancelWhenAsked {
            fn request(
                &self,
                _call_id: &str,
                _tool: &str,
                _input: &serde_json::Value,
            ) -> crate::permission::Decision {
                self.0.cancel();
                crate::permission::Decision::Deny("stopped".into())
            }
        }

        use crate::provider::TurnOutcome;

        let (dir, env) = workspace();
        let two_writes = TurnOutcome {
            text: String::new(),
            tool_calls: vec![
                ToolCall {
                    id: "c1".into(),
                    name: "write".into(),
                    input: json!({ "path": "first.txt", "content": "x" }),
                },
                ToolCall {
                    id: "c2".into(),
                    name: "write".into(),
                    input: json!({ "path": "second.txt", "content": "y" }),
                },
            ],
        };
        let provider = ScriptedProvider::new(vec![two_writes, turn_saying("unreachable")]);
        let token = CancelToken::new();
        let gate = CancelWhenAsked(token.clone());
        let mut log = EventLog::new();
        let mut session = Session::new(&provider, builtin_tools(), &AskEverything, &gate, &env)
            .with_cancel(token);

        assert_eq!(
            session.prompt("write two files", &mut log).unwrap(),
            StopReason::Cancelled
        );
        assert!(
            !dir.path().join("second.txt").exists(),
            "the second tool must not run"
        );
        let asked = log
            .events
            .iter()
            .filter(|e| matches!(e, SessionEvent::PermissionRequested(_)))
            .count();
        assert_eq!(
            asked, 1,
            "only the call the user stopped may have been asked about"
        );

        // Every call still needs an answer in the history, or the next request
        // to a real provider is rejected as malformed.
        let answered: Vec<&str> = session
            .messages()
            .iter()
            .filter_map(|m| match m {
                Message::ToolResult { call_id, .. } => Some(call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(answered, vec!["c1", "c2"]);
    }

    #[test]
    fn a_session_carries_on_once_the_token_is_rearmed() {
        // Stopping ends the turn, not the conversation.
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![turn_saying("first"), turn_saying("second")]);
        let token = CancelToken::new();
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_cancel(token.clone());

        token.cancel();
        assert_eq!(
            session.prompt("stopped one", &mut log).unwrap(),
            StopReason::Cancelled
        );
        token.reset();
        assert_eq!(
            session.prompt("and then?", &mut log).unwrap(),
            StopReason::Done
        );
        assert_eq!(
            provider.request_count(),
            1,
            "only the second prompt reached the model"
        );
    }

    #[test]
    fn cancelling_before_the_first_turn_stops_the_run() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::saying("should never be asked");
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.cancel_token().cancel();

        let reason = session.prompt("go", &mut log).unwrap();
        assert_eq!(reason, StopReason::Cancelled);
        assert_eq!(
            provider.request_count(),
            0,
            "a cancelled run must not call the model"
        );
    }

    #[test]
    fn tool_output_reaches_the_event_stream_before_the_tool_finishes() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "bash", json!({ "command": "echo streaming" })),
            turn_saying("done"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("run something", &mut log).unwrap();

        let progress_at = log
            .events
            .iter()
            .position(|e| matches!(e, SessionEvent::ToolProgress { chunk, .. } if chunk.contains("streaming")))
            .expect("a tool's output must surface as progress events");
        let finished_at = log
            .events
            .iter()
            .position(|e| matches!(e, SessionEvent::ToolFinished { .. }))
            .expect("the call must finish");
        // Order is the point: progress that only arrives with the result is not
        // progress, and the UI would show nothing while a long build runs.
        assert!(
            progress_at < finished_at,
            "progress must precede the result, got {progress_at} then {finished_at}"
        );

        match &log.events[progress_at] {
            SessionEvent::ToolProgress { call_id, .. } => assert_eq!(call_id, "c1"),
            other => panic!("expected progress, got {other:?}"),
        }
    }

    #[test]
    fn a_session_survives_a_restart_and_keeps_talking() {
        use crate::log::SessionLog;
        let (dir, env) = workspace();
        let log_path = dir.path().join("session.jsonl");

        // First run: one prompt, one tool call, everything written down.
        {
            let provider = ScriptedProvider::new(vec![
                turn_calling("c1", "read", json!({ "path": "hello.txt" })),
                turn_saying("the file says: file contents here"),
            ]);
            let mut log = SessionLog::open(&log_path).unwrap();
            let mut events = EventLog::new();
            let mut session = Session::new(
                &provider,
                builtin_tools(),
                &ApproveForTest,
                &ApproveForTest,
                &env,
            );
            session
                .prompt("what is in hello.txt?", &mut events)
                .unwrap();
            for event in &events.events {
                log.append_event(event).unwrap();
            }
            session.append_new_messages(&mut log, 0).unwrap();
        }

        // The app restarts: nothing survives but the file.
        let replay = SessionLog::replay(&log_path).unwrap();
        assert_eq!(replay.skipped, 0);
        assert!(
            replay.events.iter().any(
                |e| matches!(e, SessionEvent::UserPrompt { text } if text.contains("hello.txt"))
            ),
            "the replay must show what was asked, not just what the agent did"
        );
        assert!(
            replay.events.iter().any(|e| matches!(e, SessionEvent::ToolFinished { result, .. } if result.contains("file contents"))),
            "the tool result belongs in the replay"
        );

        // Second run: resume and ask a follow-up.
        let provider = ScriptedProvider::saying("it says the same as before");
        let mut events = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_history(replay.messages.clone());
        session.prompt("say that again", &mut events).unwrap();

        let sent = provider
            .nth_request(0)
            .expect("the follow-up must reach the model");
        assert!(
            sent.iter()
                .any(|m| matches!(m, Message::User { text } if text.contains("hello.txt"))),
            "the resumed conversation must still contain the original question: {sent:#?}"
        );
        assert!(
            sent.iter().any(|m| matches!(m, Message::ToolResult { content, .. } if content.contains("file contents"))),
            "and the tool result it already has, or the model will ask for it again"
        );
        assert!(
            sent.iter()
                .any(|m| matches!(m, Message::User { text } if text == "say that again")),
            "with the new question on the end"
        );
    }

    #[test]
    fn the_conversation_keeps_every_exchange_for_the_log_to_replay() {
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "hello.txt" })),
            turn_saying("done"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("go", &mut log).unwrap();

        let roles: Vec<&str> = session
            .messages()
            .iter()
            .map(|m| match m {
                Message::User { .. } => "user",
                Message::Assistant { .. } => "assistant",
                Message::ToolResult { .. } => "tool_result",
            })
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "tool_result", "assistant"]);
    }

    #[test]
    fn a_history_too_big_for_the_window_is_compacted_and_the_work_carries_on() {
        // The acceptance criterion: a conversation past the context limit keeps
        // going, and the facts planted early are still in front of the model
        // afterwards. Planted deliberately in the tool calls, because those are
        // what a summary is most likely to smooth over.
        let (_dir, env) = workspace();
        let mut history = vec![Message::User {
            text: "port the parser to the new AST".to_string(),
        }];
        for i in 0..20 {
            history.push(Message::Assistant {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: format!("c{i}"),
                    name: "read".into(),
                    input: json!({ "path": format!("src/f{i}.rs") }),
                }],
            });
            history.push(Message::ToolResult {
                call_id: format!("c{i}"),
                content: "x".repeat(2000),
                is_error: false,
            });
        }
        let before = history.len();

        // First request is the summary; the second is the turn itself.
        let provider = ScriptedProvider::new(vec![
            turn_saying("I read the parser files and started porting."),
            turn_saying("Carrying on from there."),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_history(history)
        .with_budget(Budget {
            context_tokens: 4_000,
            compact_at: 0.75,
            keep_recent: 4,
        });

        let reason = session.prompt("keep going", &mut log).unwrap();

        assert_eq!(
            reason,
            StopReason::Done,
            "the session must survive its own history"
        );
        let compaction = log
            .events
            .iter()
            .find_map(|e| match e {
                SessionEvent::Compacted {
                    tokens_before,
                    tokens_after,
                    replaced,
                } => Some((*tokens_before, *tokens_after, *replaced)),
                _ => None,
            })
            .expect("the user has to be told the history was folded");
        assert!(
            compaction.1 < compaction.0,
            "compaction must actually shrink it"
        );
        assert!(compaction.2 > 0);
        assert!(
            session.messages().len() < before,
            "the history must be shorter than it was"
        );

        // What the model saw on the real turn — request 1, since request 0 was
        // the summary — must still contain the planted facts.
        let asked = provider
            .nth_request(1)
            .expect("the turn itself must have happened");
        let text = asked
            .iter()
            .map(|m| match m {
                Message::User { text } => text.clone(),
                // Tool calls carry their arguments, and that is where the
                // planted paths live — a reader that only takes `text` would
                // pass while the model saw nothing.
                Message::Assistant { text, tool_calls } => format!(
                    "{text} {}",
                    tool_calls
                        .iter()
                        .map(|c| c.input.to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
                Message::ToolResult { content, .. } => content.clone(),
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            text.contains("port the parser to the new AST"),
            "the task must survive"
        );
        assert!(
            text.contains("src/f0.rs"),
            "a fact from the far end must survive"
        );
        assert!(text.contains("src/f19.rs"), "and one from the near end");
        assert!(
            text.contains("I read the parser files"),
            "the summary itself must be in front of the model"
        );
        assert!(text.contains("keep going"), "as must the new question");
    }

    #[test]
    fn a_conversation_that_fits_is_never_compacted() {
        // Compaction costs a request and the whole cached prefix; it must not
        // happen because it can, only because it must.
        let (_dir, env) = workspace();
        let provider = ScriptedProvider::new(vec![turn_saying("fine")]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_budget(Budget::default());

        session.prompt("hello", &mut log).unwrap();

        assert!(!log
            .events
            .iter()
            .any(|e| matches!(e, SessionEvent::Compacted { .. })));
        assert_eq!(
            provider.request_count(),
            1,
            "no summary request may have been made"
        );
    }

    #[test]
    fn a_provider_that_cannot_summarise_ends_the_turn_saying_so() {
        let (_dir, env) = workspace();
        let history: Vec<Message> = (0..20)
            .map(|i| Message::User {
                text: format!("{i} {}", "x".repeat(2000)),
            })
            .collect();
        let provider = ScriptedProvider::failing("summariser unavailable");
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_history(history)
        .with_budget(Budget {
            context_tokens: 4_000,
            compact_at: 0.75,
            keep_recent: 4,
        });

        match session.prompt("go on", &mut log).unwrap() {
            StopReason::Error(message) => {
                assert!(message.contains("could not compact"), "got {message}");
                assert!(message.contains("summariser unavailable"), "got {message}");
            }
            other => panic!("expected a named failure, got {other:?}"),
        }
    }

    #[test]
    fn a_multi_turn_session_never_rewrites_what_it_already_sent() {
        // The criterion's first half. Prefix stability *is* what a prompt cache
        // rewards, so that is the property to hold — a hit rate can only be
        // reported by a provider, and is bounded above by this.
        use crate::cache::ProbeProvider;

        let (_dir, env) = workspace();
        let inner = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "hello.txt" })),
            turn_saying("that is what it says"),
            turn_calling("c2", "glob", json!({ "pattern": "*.txt" })),
            turn_saying("and those are the files"),
        ]);
        let probe = ProbeProvider::new(&inner);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &probe,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );

        session.prompt("what is in hello.txt?", &mut log).unwrap();
        session.prompt("which files are there?", &mut log).unwrap();

        let report = probe.report();
        assert_eq!(report.main_requests, 4);
        assert_eq!(
            report.side_requests, 0,
            "no compaction should have been needed"
        );
        assert!(
            report.prefix_stable(),
            "the conversation must only ever grow, got {:?}",
            report.divergences
        );
        // The property worth holding is a direction, not a number: each request
        // reuses at least as much as the one before, because every turn adds to
        // a prefix that is already paid for. A mean would encode how long this
        // particular test happens to be.
        assert_eq!(report.reuse.len(), 4);
        assert_eq!(report.reuse[0], 0.0, "nothing precedes the first request");
        for pair in report.reuse.windows(2) {
            assert!(
                pair[1] >= pair[0],
                "reuse must not fall as the session grows: {:?}",
                report.reuse
            );
        }
        assert!(
            *report.reuse.last().unwrap() > 0.7,
            "by the fourth request most of it should be cacheable, got {:?}",
            report.reuse
        );
    }

    #[test]
    fn the_tool_block_is_byte_identical_on_every_request() {
        // The failure this guards: iterate tools out of a hash map, or build
        // their schema with a map that reorders, and every request misses while
        // the conversation looks word for word the same.
        use crate::cache::ProbeProvider;

        let (_dir, env) = workspace();
        let inner = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "hello.txt" })),
            turn_saying("done"),
        ]);
        let probe = ProbeProvider::new(&inner);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &probe,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("go", &mut log).unwrap();

        let snapshots = probe.snapshots();
        assert!(snapshots.len() >= 2);
        for pair in snapshots.windows(2) {
            assert_eq!(
                pair[0].tools, pair[1].tools,
                "the tool block must be reproduced exactly, not merely equivalently"
            );
        }
        // And in serialised form, since that is what actually gets hashed.
        let first = serde_json::to_string(&snapshots[0].tools).unwrap();
        let last = serde_json::to_string(&snapshots.last().unwrap().tools).unwrap();
        assert_eq!(first, last);
    }

    #[test]
    fn compaction_costs_the_prefix_once_and_it_recovers_afterwards() {
        // The criterion's second half: the cache loss at a compaction is
        // expected, bounded to one request, and does not repeat afterwards.
        use crate::cache::{Cause, ProbeProvider};

        let (_dir, env) = workspace();
        let history: Vec<Message> = (0..30)
            .map(|i| Message::User {
                text: format!("{i} {}", "x".repeat(1000)),
            })
            .collect();
        let inner = ScriptedProvider::new(vec![
            turn_saying("a summary of the early work"),
            turn_saying("first answer after compacting"),
            turn_saying("second answer"),
        ]);
        let probe = ProbeProvider::new(&inner);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &probe,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_history(history)
        .with_budget(Budget {
            context_tokens: 4_000,
            compact_at: 0.75,
            keep_recent: 4,
        });

        session.prompt("carry on", &mut log).unwrap();
        session.prompt("and again", &mut log).unwrap();

        let report = probe.report();
        assert_eq!(
            report.side_requests, 1,
            "exactly one summary request — a second means the fold did not shrink anything"
        );
        assert!(
            report.divergences.is_empty(),
            "after the fold the conversation only grows again: {:?}",
            report.divergences
        );
        assert_eq!(report.main_requests, 2);

        // And the shape a defect would take, for contrast: a rewrite in the
        // middle of the conversation is exactly what the probe exists to catch.
        let mut tampered: Vec<_> = probe
            .snapshots()
            .into_iter()
            .filter(|s| !s.tools.is_empty())
            .collect();
        if let Some(Message::User { text }) = tampered[1].messages.first_mut() {
            *text = "something else entirely".into();
        }
        let bad = crate::cache::analyse(&tampered);
        assert_eq!(bad.divergences[0].cause, Cause::HistoryRewritten);
    }

    #[test]
    fn an_oversized_result_reaches_the_model_folded_and_the_user_whole() {
        // The criterion: a huge result is folded on its way into the history,
        // the facts in it stay reachable, and the transcript still shows what
        // the tool actually said.
        let (dir, env) = workspace();
        let big: String = (0..600)
            .map(|i| format!("line {i} with enough text to matter"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("big.txt"), &big).unwrap();

        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "big.txt" })),
            turn_saying("read it"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("read the file", &mut log).unwrap();

        let carried = session
            .messages()
            .iter()
            .find_map(|m| match m {
                Message::ToolResult { content, .. } => Some(content.clone()),
                _ => None,
            })
            .expect("a tool result must be in the history");

        assert!(
            carried.len() < big.len() / 3,
            "the model should carry a fraction: {} of {}",
            carried.len(),
            big.len()
        );
        assert!(carried.contains("line 0 "), "the head survives");
        assert!(carried.contains("line 599 "), "so does the tail");
        assert!(carried.contains("lines elided"), "and it says so");

        // Everything is still reachable: the notice names a file holding it all.
        let path = carried
            .split(" is at ")
            .nth(1)
            .and_then(|rest| rest.split(" —").next())
            .expect("the notice must name the file");
        let spilled = std::fs::read_to_string(path).unwrap();
        assert!(
            spilled.contains("line 300 with enough text to matter"),
            "the middle is not lost"
        );
        std::fs::remove_file(path).ok();

        // What the user was shown is untouched — the fold is about what the
        // model has to carry, not about hiding output from the person reading.
        let shown = log
            .events
            .iter()
            .find_map(|e| match e {
                SessionEvent::ToolFinished { result, .. } => Some(result.clone()),
                _ => None,
            })
            .unwrap();
        assert!(
            shown.contains("line 300"),
            "the transcript shows the real output"
        );
    }

    #[test]
    fn folding_never_touches_a_message_that_was_already_sent() {
        // The constraint that makes this safe: folding happens on the way in,
        // so the prefix the provider already saw is never rewritten. Asserted
        // with the cache probe rather than by reading the code.
        use crate::cache::ProbeProvider;

        let (dir, env) = workspace();
        let big: String = (0..600)
            .map(|i| format!("line {i} padding padding"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("big.txt"), &big).unwrap();

        let inner = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "big.txt" })),
            turn_calling("c2", "read", json!({ "path": "big.txt" })),
            turn_saying("done"),
        ]);
        let probe = ProbeProvider::new(&inner);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &probe,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("read it twice", &mut log).unwrap();

        let report = probe.report();
        assert!(
            report.prefix_stable(),
            "folding must not rewrite history: {:?}",
            report.divergences
        );

        for message in session.messages() {
            if let Message::ToolResult { content, .. } = message {
                if let Some(path) = content
                    .split(" is at ")
                    .nth(1)
                    .and_then(|rest| rest.split(" —").next())
                {
                    std::fs::remove_file(path).ok();
                }
            }
        }
    }

    #[test]
    fn a_result_small_enough_to_carry_is_carried_verbatim() {
        let (dir, env) = workspace();
        std::fs::write(dir.path().join("small.txt"), "one\ntwo\nthree").unwrap();
        let provider = ScriptedProvider::new(vec![
            turn_calling("c1", "read", json!({ "path": "small.txt" })),
            turn_saying("ok"),
        ]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        );
        session.prompt("read it", &mut log).unwrap();

        let carried = session
            .messages()
            .iter()
            .find_map(|m| match m {
                Message::ToolResult { content, .. } => Some(content.clone()),
                _ => None,
            })
            .unwrap();
        assert!(!carried.contains("elided"), "nothing to fold: {carried}");
        assert!(carried.contains("two"));
    }

    /// Answers differently depending on whether it can see a particular fact.
    ///
    /// "Influences the answer" is otherwise unverifiable without a real model:
    /// a scripted provider says the same thing regardless. This one makes the
    /// influence the thing under test.
    struct AnswersFromMemory {
        looks_for: String,
    }

    impl crate::provider::Provider for AnswersFromMemory {
        fn stream(
            &self,
            messages: &[Message],
            _tools: &[crate::provider::ToolSpec],
            sink: &mut dyn FnMut(crate::provider::ProviderEvent),
        ) -> Result<crate::provider::TurnOutcome> {
            let saw = messages.iter().any(|m| match m {
                Message::User { text } => text.contains(&self.looks_for),
                _ => false,
            });
            let text = if saw {
                format!("I already know: {}", self.looks_for)
            } else {
                "I have no idea how this project is built.".to_string()
            };
            sink(crate::provider::ProviderEvent::Text(text.clone()));
            Ok(crate::provider::TurnOutcome {
                text,
                tool_calls: Vec::new(),
            })
        }
    }

    fn tools_with_memory(store: std::sync::Arc<crate::memory::MemoryStore>) -> Vec<Box<dyn Tool>> {
        let mut tools = builtin_tools();
        tools.push(Box::new(crate::memory::MemoryTool::new(store)));
        tools
    }

    #[test]
    fn something_remembered_in_one_session_changes_what_the_next_one_answers() {
        // The criterion end to end: the model stores a fact in one session, and
        // in a second session — a different Session over the same store — that
        // fact reaches the model and visibly changes its answer.
        use crate::memory::MemoryStore;

        let (dir, env) = workspace();
        let store = std::sync::Arc::new(MemoryStore::open(dir.path().join("memory.jsonl")));
        const FACT: &str = "this project builds with `cargo xtask dist`";

        // Session one: the model decides to remember something.
        let writing = ScriptedProvider::new(vec![
            turn_calling("m1", "memory", json!({ "action": "add", "text": FACT })),
            turn_saying("noted"),
        ]);
        let mut log = EventLog::new();
        let mut first = Session::new(
            &writing,
            tools_with_memory(std::sync::Arc::clone(&store)),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_memory(store.preamble());
        first
            .prompt("remember how to build this", &mut log)
            .unwrap();
        assert_eq!(store.entries().len(), 1, "the tool must have written it");

        // A new store over the same file, as a fresh process would open it.
        let reopened = std::sync::Arc::new(MemoryStore::open(dir.path().join("memory.jsonl")));
        let reader = AnswersFromMemory {
            looks_for: FACT.to_string(),
        };
        let mut log2 = EventLog::new();
        let mut second = Session::new(
            &reader,
            tools_with_memory(std::sync::Arc::clone(&reopened)),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_memory(reopened.preamble());
        second.prompt("how do I build this?", &mut log2).unwrap();

        let said = log2
            .events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantText { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect::<String>();
        assert!(
            said.contains("I already know"),
            "the remembered fact has to change the answer, got: {said}"
        );
    }

    #[test]
    fn a_session_with_no_memory_answers_as_if_it_has_none() {
        // The other half of the same test: without the fact, the same provider
        // and the same question give the other answer. Otherwise the assertion
        // above could pass on a provider that always says the same thing.
        use crate::memory::MemoryStore;

        let (dir, env) = workspace();
        let store = std::sync::Arc::new(MemoryStore::open(dir.path().join("empty.jsonl")));
        let reader = AnswersFromMemory {
            looks_for: "this project builds with `cargo xtask dist`".to_string(),
        };
        let mut log = EventLog::new();
        let mut session = Session::new(
            &reader,
            tools_with_memory(store.clone()),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_memory(store.preamble());
        session.prompt("how do I build this?", &mut log).unwrap();

        let said = log
            .events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantText { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect::<String>();
        assert!(said.contains("no idea"), "got: {said}");
    }

    #[test]
    fn memory_rides_ahead_of_the_conversation_and_never_inside_it() {
        // It must not be written to the session log every turn, must not count
        // as conversation when deciding to compact, and must be the first thing
        // the provider sees — that last part is where a cache wants it.
        use crate::memory::MemoryStore;

        let (dir, env) = workspace();
        let store = MemoryStore::open(dir.path().join("memory.jsonl"));
        store.add("remember this").unwrap();

        let provider = ScriptedProvider::new(vec![turn_saying("ok")]);
        let mut log = EventLog::new();
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_memory(store.preamble());
        session.prompt("hello", &mut log).unwrap();

        let sent = provider.last_request();
        assert!(
            matches!(&sent[0], Message::User { text } if text.contains("remember this")),
            "memory has to be the first thing in the request"
        );
        assert!(
            !session
                .messages()
                .iter()
                .any(|m| matches!(m, Message::User { text } if text.contains("remember this"))),
            "and must not have joined the conversation, which is what gets logged and compacted"
        );
    }
}
