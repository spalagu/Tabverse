//! Turning Codex's SSE response into turn events.
//!
//! Codex speaks the OpenAI Responses API: a stream of `data:` lines, each a
//! JSON event, describing an answer being assembled. Text arrives in deltas, a
//! tool call arrives as an item that is opened, filled in over several frames,
//! and closed, and the whole thing ends with a terminal event that says why.
//!
//! Stream parsing has more edge cases than its size suggests: bytes arrive
//! split at arbitrary points, the terminal event can be followed by silence
//! rather than a close, an incomplete answer has to be distinguished from a
//! finished one, and a tool call's arguments are only valid once assembled.
//!
//! Event shapes were informed by Pi's
//! `packages/ai/test/openai-codex-stream.test.ts`; see the repository's
//! `NOTICE` file. This module models the SSE path; websocket cache affinity is
//! implemented separately.

use crate::provider::{ToolCall, TurnOutcome};
use anyhow::{Context, Result};
use serde_json::Value;

/// What the parser produces as bytes arrive.
#[derive(Debug, Clone, PartialEq)]
pub enum Chunk {
    /// Assistant text, incremental.
    Text(String),
    /// Reasoning text, incremental. Shown separately, never fed back as answer.
    Thinking(String),
    /// The answer is over. Nothing after this counts.
    Done(Stop),
}

/// Why the answer ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// The model finished.
    Complete,
    /// It ran out of room. The text so far is real but cut off, and the caller
    /// must not treat it as a finished thought.
    Length,
}

/// Assembles SSE bytes into chunks, then into a turn.
///
/// Feed it whatever arrives, whenever it arrives. It holds the tail of a
/// partial line between calls, because a network chunk boundary has no reason
/// to respect a line boundary and the first version of any parser like this
/// gets that wrong.
#[derive(Default)]
pub struct StreamParser {
    /// Bytes since the last newline: an unfinished line, not an empty one.
    pending: String,
    /// Accumulated assistant text, in order.
    text: String,
    /// Tool calls being built, keyed by the item id the stream uses.
    calls: Vec<PartialCall>,
    stop: Option<Stop>,
    /// True once a terminal event has been seen. Later frames are ignored
    /// rather than appended: a stream that keeps talking after it said it was
    /// finished must not be able to change the answer.
    finished: bool,
}

#[derive(Debug, Clone)]
struct PartialCall {
    item_id: String,
    /// The id the tool result must be addressed to. Only known when the item is
    /// closed, so it starts empty.
    call_id: String,
    name: String,
    input: String,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the next piece of the body. Returns whatever became complete.
    pub fn push(&mut self, bytes: &str) -> Result<Vec<Chunk>> {
        self.pending.push_str(bytes);
        let mut out = Vec::new();
        // Only whole lines can be parsed; the remainder stays for next time.
        while let Some(cut) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=cut).collect();
            if let Some(chunk) = self.line(line.trim_end_matches(['\r', '\n']))? {
                out.push(chunk);
            }
        }
        Ok(out)
    }

    /// No more bytes are coming.
    ///
    /// A stream can end without a terminal event — a dropped connection, a
    /// proxy that closed early. That is not the same as an answer that
    /// finished, and saying so is the difference between the caller retrying
    /// and the caller acting on half a thought.
    pub fn finish(mut self) -> Result<(TurnOutcome, Stop)> {
        // A last line with no trailing newline is still a line.
        if !self.pending.trim().is_empty() {
            let line = std::mem::take(&mut self.pending);
            let _ = self.line(line.trim_end_matches(['\r', '\n']))?;
        }
        let Some(stop) = self.stop else {
            anyhow::bail!("the stream ended without saying whether the answer was finished");
        };
        let outcome = TurnOutcome {
            text: self.text,
            tool_calls: self
                .calls
                .into_iter()
                // A call whose id never arrived was never usable: the result
                // would have nowhere to go. Dropping it beats sending the model
                // a result addressed to nothing.
                .filter(|c| !c.call_id.is_empty() && !c.name.is_empty())
                .map(|c| {
                    let input = serde_json::from_str(&c.input).unwrap_or_else(|_| {
                        // Arguments that will not parse are handed over as a
                        // string rather than dropped: the model can be told its
                        // own call was malformed, which is actionable, whereas
                        // a silently missing call is not.
                        serde_json::json!({ "_raw": c.input })
                    });
                    ToolCall {
                        id: c.call_id,
                        name: c.name,
                        input,
                    }
                })
                .collect(),
        };
        // Returned rather than kept: whether the answer was finished or merely
        // cut off is not decoration on the text, it decides what the caller may
        // do next. A signature that lets it be ignored is a signature that will
        // see it ignored.
        Ok((outcome, stop))
    }

    /// Whether a terminal event has been seen, so a caller can stop reading
    /// rather than waiting for a body that may never close.
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    fn line(&mut self, line: &str) -> Result<Option<Chunk>> {
        let Some(payload) = line.strip_prefix("data:") else {
            // Comments, event: lines, blank separators. Not an error.
            return Ok(None);
        };
        let payload = payload.trim();
        if payload.is_empty() {
            return Ok(None);
        }
        if payload == "[DONE]" {
            // The transport's end marker. The answer's own ending is the
            // terminal event; if that never came, `finish` will say so.
            return Ok(None);
        }
        if self.finished {
            return Ok(None);
        }
        let event: Value =
            serde_json::from_str(payload).with_context(|| format!("bad SSE payload: {payload}"))?;
        Ok(self.event(&event))
    }

    fn event(&mut self, event: &Value) -> Option<Chunk> {
        match event.get("type").and_then(Value::as_str)? {
            "response.output_text.delta" => {
                let delta = event.get("delta").and_then(Value::as_str)?;
                self.text.push_str(delta);
                Some(Chunk::Text(delta.to_string()))
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let delta = event.get("delta").and_then(Value::as_str)?;
                Some(Chunk::Thinking(delta.to_string()))
            }
            "response.output_item.added" => {
                let item = event.get("item")?;
                if is_tool_item(item) {
                    let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                    self.calls.push(PartialCall {
                        item_id: item_id.to_string(),
                        call_id: item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input: String::new(),
                    });
                }
                None
            }
            "response.custom_tool_call_input.delta" | "response.function_call_arguments.delta" => {
                let id = event.get("item_id").and_then(Value::as_str).unwrap_or("");
                let delta = event.get("delta").and_then(Value::as_str)?;
                self.call_mut(id).input.push_str(delta);
                None
            }
            "response.custom_tool_call_input.done" | "response.function_call_arguments.done" => {
                // The complete arguments, which supersede whatever the deltas
                // assembled — the authoritative copy, not a duplicate of it.
                let id = event.get("item_id").and_then(Value::as_str).unwrap_or("");
                let input = event
                    .get("input")
                    .or_else(|| event.get("arguments"))
                    .and_then(Value::as_str)?;
                self.call_mut(id).input = input.to_string();
                None
            }
            "response.output_item.done" => {
                let item = event.get("item")?;
                if is_tool_item(item) {
                    let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                    let call = self.call_mut(item_id);
                    // The closing item is where call_id and name are reliably
                    // present; earlier frames may have carried neither.
                    if let Some(call_id) = item.get("call_id").and_then(Value::as_str) {
                        call.call_id = call_id.to_string();
                    }
                    if let Some(name) = item.get("name").and_then(Value::as_str) {
                        call.name = name.to_string();
                    }
                    if let Some(input) = item
                        .get("input")
                        .or_else(|| item.get("arguments"))
                        .and_then(Value::as_str)
                    {
                        call.input = input.to_string();
                    }
                }
                None
            }
            "response.completed" => {
                self.finished = true;
                self.stop = Some(Stop::Complete);
                Some(Chunk::Done(Stop::Complete))
            }
            "response.incomplete" => {
                self.finished = true;
                // Ran out of room rather than finished. The caller has to know:
                // continuing as if the model had said its piece would put a
                // truncated sentence into the conversation as a settled fact.
                self.stop = Some(Stop::Length);
                Some(Chunk::Done(Stop::Length))
            }
            "error" | "response.failed" => {
                self.finished = true;
                None
            }
            _ => None,
        }
    }

    /// The call this frame is about, created if the stream never announced it.
    ///
    /// Tolerant on purpose: a delta for an item we never saw opened is a stream
    /// we do not fully understand, and dropping the call would lose work the
    /// model actually asked for.
    fn call_mut(&mut self, item_id: &str) -> &mut PartialCall {
        if let Some(index) = self.calls.iter().position(|c| c.item_id == item_id) {
            return &mut self.calls[index];
        }
        self.calls.push(PartialCall {
            item_id: item_id.to_string(),
            call_id: String::new(),
            name: String::new(),
            input: String::new(),
        });
        self.calls.last_mut().expect("just pushed")
    }
}

fn is_tool_item(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("custom_tool_call") | Some("function_call")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One SSE frame.
    fn frame(value: serde_json::Value) -> String {
        format!("data: {}\n\n", serde_json::to_string(&value).unwrap())
    }

    fn text_answer() -> String {
        [
            frame(serde_json::json!({ "type": "response.created", "response": { "id": "r1" } })),
            frame(serde_json::json!({
                "type": "response.output_item.added",
                "item": { "type": "message", "id": "msg_1", "role": "assistant", "content": [] }
            })),
            frame(serde_json::json!({
                "type": "response.content_part.added",
                "part": { "type": "output_text", "text": "" }
            })),
            frame(serde_json::json!({ "type": "response.output_text.delta", "delta": "Hello" })),
            frame(serde_json::json!({ "type": "response.output_text.delta", "delta": " there" })),
            frame(serde_json::json!({
                "type": "response.completed",
                "response": { "status": "completed" }
            })),
            "data: [DONE]\n\n".to_string(),
        ]
        .concat()
    }

    fn tool_answer() -> String {
        [
            frame(serde_json::json!({
                "type": "response.output_item.added",
                "item": { "type": "custom_tool_call", "id": "ctc_1" }
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "ctc_1", "delta": "{\"path\":"
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "ctc_1", "delta": "\"a.txt\"}"
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.done",
                "item_id": "ctc_1", "input": "{\"path\":\"a.txt\"}"
            })),
            frame(serde_json::json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "custom_tool_call", "id": "ctc_1",
                    "call_id": "call_1", "name": "read", "input": "{\"path\":\"a.txt\"}"
                }
            })),
            frame(serde_json::json!({
                "type": "response.completed",
                "response": { "status": "completed" }
            })),
        ]
        .concat()
    }

    fn run(body: &str) -> (Vec<Chunk>, TurnOutcome, Stop) {
        let mut parser = StreamParser::new();
        let chunks = parser.push(body).unwrap();
        let (outcome, stop) = parser.finish().unwrap();
        (chunks, outcome, stop)
    }

    #[test]
    fn text_deltas_become_chunks_and_the_whole_message() {
        let (chunks, outcome, stop) = run(&text_answer());
        assert_eq!(stop, Stop::Complete);
        assert_eq!(
            chunks,
            vec![
                Chunk::Text("Hello".into()),
                Chunk::Text(" there".into()),
                Chunk::Done(Stop::Complete),
            ]
        );
        assert_eq!(outcome.text, "Hello there");
        assert!(outcome.tool_calls.is_empty());
    }

    #[test]
    fn a_tool_call_is_assembled_from_its_pieces() {
        let (_, outcome, _stop) = run(&tool_answer());
        assert_eq!(outcome.tool_calls.len(), 1);
        let call = &outcome.tool_calls[0];
        assert_eq!(call.id, "call_1", "the result must be addressed to call_id");
        assert_eq!(call.name, "read");
        assert_eq!(call.input, serde_json::json!({ "path": "a.txt" }));
    }

    #[test]
    fn bytes_split_anywhere_produce_the_same_answer() {
        // A network chunk boundary has no reason to respect a line boundary,
        // and this is where a parser like this is usually wrong.
        let body = tool_answer();
        for size in [1, 3, 7, 64, 500] {
            let mut parser = StreamParser::new();
            let mut chunks = Vec::new();
            let bytes: Vec<char> = body.chars().collect();
            for piece in bytes.chunks(size) {
                let s: String = piece.iter().collect();
                chunks.extend(parser.push(&s).unwrap());
            }
            let (outcome, stop) = parser.finish().unwrap();
            assert_eq!(stop, Stop::Complete, "split at {size}");
            assert_eq!(outcome.tool_calls.len(), 1, "split at {size}");
            assert_eq!(
                outcome.tool_calls[0].input,
                serde_json::json!({ "path": "a.txt" })
            );
            assert_eq!(
                chunks.last(),
                Some(&Chunk::Done(Stop::Complete)),
                "split at {size}"
            );
        }
    }

    #[test]
    fn an_incomplete_answer_is_not_a_finished_one() {
        // Running out of room leaves real text that is nonetheless cut off.
        // Treating it as finished would settle a truncated sentence into the
        // conversation as if the model had meant to stop there.
        let body = [
            frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": "half a th" }),
            ),
            frame(serde_json::json!({
                "type": "response.incomplete",
                "response": {
                    "status": "incomplete",
                    "incomplete_details": { "reason": "max_output_tokens" }
                }
            })),
        ]
        .concat();
        let (chunks, outcome, stop) = run(&body);
        assert_eq!(chunks.last(), Some(&Chunk::Done(Stop::Length)));
        assert_eq!(
            stop,
            Stop::Length,
            "the caller must be able to tell a cut-off answer from a finished one"
        );
        assert_eq!(outcome.text, "half a th");
    }

    #[test]
    fn the_answer_is_over_when_it_says_so_even_if_the_body_stays_open() {
        // The transport may not close. Waiting for it to would hang the turn.
        let mut parser = StreamParser::new();
        parser.push(&text_answer()).unwrap();
        assert!(parser.is_finished());

        // And anything that arrives afterwards cannot change the answer.
        parser
            .push(&frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": " MORE" }),
            ))
            .unwrap();
        assert_eq!(parser.finish().unwrap().0.text, "Hello there");
    }

    #[test]
    fn a_stream_that_stops_without_saying_why_is_an_error() {
        // A dropped connection is not a finished answer. Reporting it as one
        // would have the caller act on half a thought instead of retrying.
        let mut parser = StreamParser::new();
        parser
            .push(&frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": "partial" }),
            ))
            .unwrap();
        let err = parser.finish().unwrap_err();
        assert!(err.to_string().contains("without saying"), "got {err}");
    }

    #[test]
    fn several_tool_calls_in_one_answer_stay_separate() {
        let body = [
            frame(serde_json::json!({
                "type": "response.output_item.added",
                "item": { "type": "custom_tool_call", "id": "a" }
            })),
            frame(serde_json::json!({
                "type": "response.output_item.added",
                "item": { "type": "custom_tool_call", "id": "b" }
            })),
            // Interleaved, because nothing says they arrive one at a time.
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "a", "delta": "{\"x\":1"
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "b", "delta": "{\"y\":2"
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "a", "delta": "}"
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "b", "delta": "}"
            })),
            frame(serde_json::json!({
                "type": "response.output_item.done",
                "item": { "type": "custom_tool_call", "id": "a", "call_id": "c_a", "name": "read" }
            })),
            frame(serde_json::json!({
                "type": "response.output_item.done",
                "item": { "type": "custom_tool_call", "id": "b", "call_id": "c_b", "name": "glob" }
            })),
            frame(serde_json::json!({ "type": "response.completed", "response": {} })),
        ]
        .concat();
        let (_, outcome, _stop) = run(&body);
        assert_eq!(outcome.tool_calls.len(), 2);
        assert_eq!(outcome.tool_calls[0].id, "c_a");
        assert_eq!(outcome.tool_calls[0].input, serde_json::json!({ "x": 1 }));
        assert_eq!(outcome.tool_calls[1].id, "c_b");
        assert_eq!(outcome.tool_calls[1].input, serde_json::json!({ "y": 2 }));
    }

    #[test]
    fn the_closing_item_wins_over_the_deltas() {
        // The deltas are a running guess; the closing item is the record.
        let body = [
            frame(serde_json::json!({
                "type": "response.output_item.added",
                "item": { "type": "custom_tool_call", "id": "a" }
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "a", "delta": "{\"half\":"
            })),
            frame(serde_json::json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "custom_tool_call", "id": "a", "call_id": "c", "name": "read",
                    "input": "{\"whole\":true}"
                }
            })),
            frame(serde_json::json!({ "type": "response.completed", "response": {} })),
        ]
        .concat();
        let (_, outcome, _stop) = run(&body);
        assert_eq!(
            outcome.tool_calls[0].input,
            serde_json::json!({ "whole": true })
        );
    }

    #[test]
    fn arguments_that_will_not_parse_are_handed_over_rather_than_dropped() {
        // The model can act on being told its own call was malformed. It
        // cannot act on a call that silently disappeared.
        let body = [
            frame(serde_json::json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "custom_tool_call", "id": "a", "call_id": "c", "name": "read",
                    "input": "{not json"
                }
            })),
            frame(serde_json::json!({ "type": "response.completed", "response": {} })),
        ]
        .concat();
        let (_, outcome, _stop) = run(&body);
        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(
            outcome.tool_calls[0].input,
            serde_json::json!({ "_raw": "{not json" })
        );
    }

    #[test]
    fn a_call_that_never_got_an_address_is_not_sent_on() {
        // A result has nowhere to go without a call_id, and a tool result
        // addressed to nothing is worse than a missing one.
        let body = [
            frame(serde_json::json!({
                "type": "response.output_item.added",
                "item": { "type": "custom_tool_call", "id": "a" }
            })),
            frame(serde_json::json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": "a", "delta": "{}"
            })),
            frame(serde_json::json!({ "type": "response.completed", "response": {} })),
        ]
        .concat();
        let (_, outcome, _stop) = run(&body);
        assert!(outcome.tool_calls.is_empty());
    }

    #[test]
    fn reasoning_is_kept_apart_from_the_answer() {
        let body = [
            frame(serde_json::json!({
                "type": "response.reasoning_summary_text.delta", "delta": "weighing it up"
            })),
            frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": "the answer" }),
            ),
            frame(serde_json::json!({ "type": "response.completed", "response": {} })),
        ]
        .concat();
        let (chunks, outcome, _stop) = run(&body);
        assert_eq!(chunks[0], Chunk::Thinking("weighing it up".into()));
        assert_eq!(
            outcome.text, "the answer",
            "thinking must not join the answer"
        );
    }

    #[test]
    fn frames_this_build_does_not_know_are_ignored_rather_than_fatal() {
        // The API gains events. An unknown one must not fail a turn that is
        // otherwise perfectly readable.
        let body = [
            frame(serde_json::json!({ "type": "response.something.invented", "x": 1 })),
            ": a comment line\n\n".to_string(),
            "event: ping\n\n".to_string(),
            frame(serde_json::json!({ "type": "response.output_text.delta", "delta": "fine" })),
            frame(serde_json::json!({ "type": "response.completed", "response": {} })),
        ]
        .concat();
        let (_, outcome, _stop) = run(&body);
        assert_eq!(outcome.text, "fine");
    }

    #[test]
    fn a_malformed_payload_is_reported_with_what_it_was() {
        let mut parser = StreamParser::new();
        let err = parser.push("data: {this is not json}\n\n").unwrap_err();
        assert!(err.to_string().contains("bad SSE payload"), "got {err}");
    }

    #[test]
    fn a_final_line_with_no_newline_still_counts() {
        let body = format!(
            "{}data: {}",
            frame(serde_json::json!({ "type": "response.output_text.delta", "delta": "x" })),
            serde_json::json!({ "type": "response.completed", "response": {} })
        );
        let mut parser = StreamParser::new();
        parser.push(&body).unwrap();
        assert_eq!(parser.finish().unwrap().0.text, "x");
    }
}
