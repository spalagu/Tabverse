//! Building the request Codex answers.
//!
//! Separate from the transport that sends it, because every rule here is a
//! pure function of the conversation and every one of them is a rule a cache
//! depends on. Prefix caching is not a feature that gets switched on: it is a
//! consequence of sending the same opening bytes, so the serialisation has to
//! be deterministic and the parts that vary have to be the parts at the end.
//!
//! Header and field rules were informed by Pi's
//! `packages/ai/test/openai-codex-stream.test.ts`; see the repository's
//! `NOTICE` file:
//!   · `session-id` and `x-client-request-id` carry the session, each clamped
//!     to 64 characters, and `prompt_cache_key` carries it in the body
//!   · with cache retention off, none of the three is sent at all
//!   · reasoning effort travels as `{ effort, summary: "auto" }`
//!   · tool choice is passed through as given

use crate::provider::{Message, ToolSpec};
use serde_json::{json, Map, Value};

/// OpenAI's ceiling on these fields. Longer values are cut rather than
/// rejected: a session whose id is too long should still work, just with a
/// coarser cache key.
pub const MAX_SESSION_KEY: usize = 64;

/// Whether this request may participate in prompt caching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheRetention {
    /// Send the session identifiers so the provider can reuse a prefix.
    #[default]
    Keep,
    /// Send nothing that ties this request to any other. Costs every cache hit
    /// and is the right answer when the conversation must not be linkable.
    None,
}

#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// Identifies the conversation to the cache. Absent means no caching
    /// identifiers at all, the same as retention being off.
    pub session_id: Option<String>,
    pub cache_retention: CacheRetention,
    /// How hard to think. Passed through verbatim — the set of levels belongs
    /// to the model, and validating it here would mean shipping a new build to
    /// use a level the model already understands.
    pub reasoning_effort: Option<String>,
    /// Forced tool selection, as the API spells it.
    pub tool_choice: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexRequest {
    /// In insertion order, which is stable because it is written once here.
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl CodexRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Cut to the provider's limit on a character boundary.
fn clamp(value: &str) -> String {
    value.chars().take(MAX_SESSION_KEY).collect()
}

pub fn build_request(
    model: &str,
    messages: &[Message],
    tools: &[ToolSpec],
    options: &RequestOptions,
) -> CodexRequest {
    let mut headers = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("accept".to_string(), "text/event-stream".to_string()),
    ];

    // The caching identifiers are one decision in three places; they travel
    // together or not at all. Sending the header without the body key would
    // claim an affinity the request does not actually have.
    let cache_key = match (options.cache_retention, options.session_id.as_deref()) {
        (CacheRetention::None, _) | (_, None) => None,
        (CacheRetention::Keep, Some("")) => None,
        (CacheRetention::Keep, Some(id)) => Some(clamp(id)),
    };
    if let Some(key) = &cache_key {
        headers.push(("session-id".to_string(), key.clone()));
        headers.push(("x-client-request-id".to_string(), key.clone()));
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("stream".into(), json!(true));
    body.insert("input".into(), json!(input_items(messages)));
    if !tools.is_empty() {
        body.insert("tools".into(), json!(tool_specs(tools)));
    }
    if let Some(effort) = &options.reasoning_effort {
        // summary: "auto" alongside the effort, which is what upstream sends.
        body.insert(
            "reasoning".into(),
            json!({ "effort": effort, "summary": "auto" }),
        );
    }
    if let Some(choice) = &options.tool_choice {
        body.insert("tool_choice".into(), choice.clone());
    }
    if let Some(key) = cache_key {
        body.insert("prompt_cache_key".into(), json!(key));
    }

    CodexRequest {
        headers,
        body: Value::Object(body),
    }
}

/// The conversation in the shape the Responses API takes it.
fn input_items(messages: &[Message]) -> Vec<Value> {
    let mut items = Vec::new();
    for message in messages {
        match message {
            Message::User { text } => items.push(json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": text }],
            })),
            Message::Assistant { text, tool_calls } => {
                // Text first, then the calls it made: the order the model
                // produced them, and the order it will expect them back.
                if !text.is_empty() {
                    items.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                for call in tool_calls {
                    items.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        // Arguments travel as a string, not as an object. The
                        // model produced a string; re-encoding our parse of it
                        // would change the bytes and with them the cache.
                        "arguments": call.input.to_string(),
                    }));
                }
            }
            Message::ToolResult {
                call_id, content, ..
            } => items.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": content,
            })),
        }
    }
    items
}

fn tool_specs(tools: &[ToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
                // Explicit rather than defaulted: strict schema adherence is
                // what makes a tool call parseable, and a default that changes
                // under us would change it silently.
                "strict": false,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ToolCall;

    fn user(text: &str) -> Message {
        Message::User {
            text: text.to_string(),
        }
    }

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_string(),
            description: "does a thing".to_string(),
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    fn options(session: Option<&str>) -> RequestOptions {
        RequestOptions {
            session_id: session.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn the_session_travels_in_both_headers_and_in_the_body() {
        let req = build_request("gpt-5.5", &[user("hi")], &[], &options(Some("sess-1")));
        assert_eq!(req.header("session-id"), Some("sess-1"));
        assert_eq!(req.header("x-client-request-id"), Some("sess-1"));
        assert_eq!(req.body["prompt_cache_key"], json!("sess-1"));
    }

    #[test]
    fn all_three_are_clamped_to_the_same_limit() {
        let long = "x".repeat(200);
        let req = build_request("gpt-5.5", &[user("hi")], &[], &options(Some(&long)));
        let expected = "x".repeat(MAX_SESSION_KEY);
        assert_eq!(req.header("session-id"), Some(expected.as_str()));
        assert_eq!(req.header("x-client-request-id"), Some(expected.as_str()));
        assert_eq!(req.body["prompt_cache_key"], json!(expected));
    }

    #[test]
    fn without_a_session_none_of_the_three_appears() {
        let req = build_request("gpt-5.5", &[user("hi")], &[], &options(None));
        assert_eq!(req.header("session-id"), None);
        assert_eq!(req.header("x-client-request-id"), None);
        assert!(req.body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn retention_off_withholds_them_even_with_a_session() {
        // The three are one decision. A header claiming affinity without the
        // body key would assert something the request does not carry.
        let req = build_request(
            "gpt-5.5",
            &[user("hi")],
            &[],
            &RequestOptions {
                session_id: Some("sess-1".into()),
                cache_retention: CacheRetention::None,
                ..Default::default()
            },
        );
        assert_eq!(req.header("session-id"), None);
        assert_eq!(req.header("x-client-request-id"), None);
        assert!(req.body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn an_empty_session_is_the_same_as_none() {
        let req = build_request("gpt-5.5", &[user("hi")], &[], &options(Some("")));
        assert_eq!(req.header("session-id"), None);
        assert!(req.body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn reasoning_effort_travels_with_the_summary_upstream_sends() {
        let req = build_request(
            "gpt-5.5",
            &[user("hi")],
            &[],
            &RequestOptions {
                reasoning_effort: Some("xhigh".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            req.body["reasoning"],
            json!({ "effort": "xhigh", "summary": "auto" })
        );
    }

    #[test]
    fn an_unfamiliar_effort_is_passed_through_rather_than_rejected() {
        // The set of levels belongs to the model. Validating it here would mean
        // shipping a build to use a level the model already understands.
        let req = build_request(
            "gpt-6",
            &[user("hi")],
            &[],
            &RequestOptions {
                reasoning_effort: Some("something-new".into()),
                ..Default::default()
            },
        );
        assert_eq!(req.body["reasoning"]["effort"], json!("something-new"));
    }

    #[test]
    fn tool_choice_is_forwarded_as_given() {
        let req = build_request(
            "gpt-5.5",
            &[user("hi")],
            &[spec("read")],
            &RequestOptions {
                tool_choice: Some(json!("required")),
                ..Default::default()
            },
        );
        assert_eq!(req.body["tool_choice"], json!("required"));
    }

    #[test]
    fn no_tools_means_no_tools_field_at_all() {
        // An empty array is not the same as saying nothing: one of them tells
        // the model it has no tools, and changes the prefix for every request
        // that follows.
        let req = build_request("gpt-5.5", &[user("hi")], &[], &options(None));
        assert!(req.body.get("tools").is_none());
    }

    #[test]
    fn a_conversation_becomes_input_items_in_order() {
        let messages = vec![
            user("read a.txt"),
            Message::Assistant {
                text: "I will".into(),
                tool_calls: vec![ToolCall {
                    id: "call_1".into(),
                    name: "read".into(),
                    input: json!({ "path": "a.txt" }),
                }],
            },
            Message::ToolResult {
                call_id: "call_1".into(),
                content: "contents".into(),
                is_error: false,
            },
            user("thanks"),
        ];
        let req = build_request("gpt-5.5", &messages, &[], &options(None));
        let items = req.body["input"].as_array().unwrap();
        // Five, not four: the assistant's text and the call it made are
        // separate items, which is the whole reason this is a list rather than
        // a message with attachments.
        assert_eq!(items.len(), 5);
        assert_eq!(items[0]["role"], json!("user"));
        assert_eq!(items[1]["role"], json!("assistant"));
        assert_eq!(items[2]["type"], json!("function_call"));
        assert_eq!(items[2]["call_id"], json!("call_1"));
        assert_eq!(
            items[2]["arguments"],
            json!("{\"path\":\"a.txt\"}"),
            "arguments travel as a string, the way the model produced them"
        );
        assert_eq!(items[3]["type"], json!("function_call_output"));
        assert_eq!(items[3]["output"], json!("contents"));
        assert_eq!(items[4]["role"], json!("user"));
    }

    #[test]
    fn an_assistant_turn_that_only_called_a_tool_adds_no_empty_message() {
        let messages = vec![Message::Assistant {
            text: String::new(),
            tool_calls: vec![ToolCall {
                id: "c".into(),
                name: "read".into(),
                input: json!({}),
            }],
        }];
        let req = build_request("gpt-5.5", &messages, &[], &options(None));
        let items = req.body["input"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], json!("function_call"));
    }

    #[test]
    fn the_same_conversation_serialises_to_the_same_bytes_every_time() {
        // The whole basis of prefix caching. Any wobble here — a map that
        // iterates in a different order, a field added conditionally on
        // something that varies — and every request pays in full.
        let messages = vec![user("hello"), user("again")];
        let tools = vec![spec("read"), spec("write")];
        let opts = options(Some("sess"));
        let first = serde_json::to_string(&build_request("gpt-5.5", &messages, &tools, &opts).body)
            .unwrap();
        for _ in 0..20 {
            let again =
                serde_json::to_string(&build_request("gpt-5.5", &messages, &tools, &opts).body)
                    .unwrap();
            assert_eq!(first, again);
        }
    }

    #[test]
    fn a_longer_conversation_keeps_the_shorter_one_as_its_opening() {
        // What a prefix cache actually matches on: the serialised opening of
        // the second request must contain the first request's items unchanged.
        let short = vec![user("one")];
        let long = vec![user("one"), user("two")];
        let opts = options(Some("sess"));
        let a = build_request("gpt-5.5", &short, &[], &opts);
        let b = build_request("gpt-5.5", &long, &[], &opts);

        let a_items = serde_json::to_string(&a.body["input"]).unwrap();
        let b_items = serde_json::to_string(&b.body["input"]).unwrap();
        let a_inner = a_items.trim_start_matches('[').trim_end_matches(']');
        assert!(
            b_items.starts_with(&format!("[{a_inner}")),
            "the earlier items must be byte-identical in the later request\\n  a: {a_items}\\n  b: {b_items}"
        );
    }
}
