//! Browser client for Tabverse remote control.
//!
//! Runs the same iroh protocol as the desktop viewer, compiled to WebAssembly.
//! Browsers cannot send UDP from the sandbox, so connections always travel
//! through a public relay — still end-to-end encrypted, so the relay only sees
//! ciphertext. That is the whole point: someone can drive an office machine
//! from a borrowed laptop with nothing installed.

use iroh::{endpoint::presets, Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use tabverse_network::{
    read_http_response_start, write_data_stream_preface, write_http_request_head,
    DataStreamPreface, HeaderPair, HttpRequestHead,
};
use tabverse_proto::{announce_proto, RemoteClientMsg, RemoteHostMsg, REMOTE_ALPN};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShareTicket {
    addr: EndpointAddr,
    share: String,
    token: String,
    /// Highest protocol version the ticket's creator speaks. Absent on
    /// tickets from v0.0.1/v0.0.2 → treated as 1 (`announce_proto`), because
    /// those hosts close the connection on any Hello above v1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proto: Option<u32>,
}

const TICKET_PREFIX: &str = "tabv";

fn decode_ticket(s: &str) -> Result<ShareTicket, String> {
    let compact: String = s.split_whitespace().collect::<Vec<_>>().join("");
    let rest = compact
        .strip_prefix(TICKET_PREFIX)
        .ok_or_else(|| "not a Tabverse ticket".to_string())?;
    let bytes = data_encoding::BASE32_NOPAD
        .decode(rest.to_uppercase().as_bytes())
        .map_err(|e| format!("ticket is not valid base32: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("ticket payload invalid: {e}"))
}

const MAX_FRAME: u32 = 16 * 1024 * 1024;

/// A live browser session. Dropping it (or calling `leave`) closes the endpoint.
#[wasm_bindgen]
pub struct WebJoin {
    endpoint: Endpoint,
    connection: iroh::endpoint::Connection,
    input_tx: async_channel::Sender<RemoteClientMsg>,
}

/// One streamed HTTP exchange beside the semantic control stream.
#[wasm_bindgen]
pub struct WebHttpStream {
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    request_finished: bool,
}

#[wasm_bindgen]
impl WebHttpStream {
    /// Abort both halves of an exchange that the page no longer consumes.
    pub fn cancel(&mut self) {
        let _ = self.send.reset(0u32.into());
        let _ = self.recv.stop(0u32.into());
    }

    /// Send one raw request-body chunk. No JSON/base64 envelope is involved.
    #[wasm_bindgen(js_name = writeRequestChunk)]
    pub async fn write_request_chunk(&mut self, bytes: Vec<u8>) -> Result<(), JsValue> {
        if self.request_finished {
            return Err(JsValue::from_str(
                "the HTTP request stream is already finished",
            ));
        }
        self.send
            .write_all(&bytes)
            .await
            .map_err(|error| JsValue::from_str(&format!("write request body: {error}")))
    }

    /// Half-close the request while keeping the streamed response alive.
    #[wasm_bindgen(js_name = finishRequest)]
    pub fn finish_request(&mut self) -> Result<(), JsValue> {
        if !self.request_finished {
            self.send
                .finish()
                .map_err(|error| JsValue::from_str(&format!("finish request body: {error}")))?;
            self.request_finished = true;
        }
        Ok(())
    }

    /// Read the bounded response metadata frame.
    #[wasm_bindgen(js_name = responseStart)]
    pub async fn response_start(&mut self) -> Result<JsValue, JsValue> {
        let start = read_http_response_start(&mut self.recv)
            .await
            .map_err(|error| JsValue::from_str(&format!("read response head: {error:#}")))?;
        serde_wasm_bindgen::to_value(&start)
            .map_err(|error| JsValue::from_str(&format!("encode response head: {error}")))
    }

    /// Read at most `limit` raw response bytes. An empty array is EOF.
    #[wasm_bindgen(js_name = readResponseChunk)]
    pub async fn read_response_chunk(&mut self, limit: u32) -> Result<Vec<u8>, JsValue> {
        let mut bytes = vec![0; limit.clamp(1, 1024 * 1024) as usize];
        let read = self
            .recv
            .read(&mut bytes)
            .await
            .map_err(|error| JsValue::from_str(&format!("read response body: {error}")))?;
        bytes.truncate(read.unwrap_or(0));
        Ok(bytes)
    }
}

#[wasm_bindgen]
impl WebJoin {
    /// Send keyboard/paste bytes to the host's shell.
    #[wasm_bindgen(js_name = sendInput)]
    pub fn send_input(&self, b64: String) {
        let _ = self.input_tx.try_send(RemoteClientMsg::Input { b64 });
    }

    /// Liveness probe; the host answers with a pong.
    pub fn ping(&self) {
        let _ = self.input_tx.try_send(RemoteClientMsg::Ping);
    }

    /// Tell the host how many cells this viewer can display. The host shrinks
    /// its grid to the smallest viewer (tmux semantics), so everyone reads an
    /// unscaled terminal instead of a shrunken image.
    pub fn viewport(&self, cols: u16, rows: u16) {
        let _ = self
            .input_tx
            .try_send(RemoteClientMsg::Resize { cols, rows });
    }

    /// Say something to a shared agent. The host enforces Steer; this client
    /// only relays, same as `send_input` for a terminal.
    #[wasm_bindgen(js_name = sendPrompt)]
    pub fn send_prompt(&self, text: String) {
        let _ = self
            .input_tx
            .try_send(RemoteClientMsg::AgentPrompt { text });
    }

    /// Answer an agent permission request. The host enforces Approve.
    #[wasm_bindgen(js_name = sendAnswer)]
    pub fn send_answer(&self, call_id: String, allow: bool, reason: Option<String>) {
        let _ = self.input_tx.try_send(RemoteClientMsg::AgentAnswer {
            call_id,
            allow,
            reason,
        });
    }

    /// Stop the agent turn in progress. The host enforces Steer.
    #[wasm_bindgen(js_name = sendCancel)]
    pub fn send_cancel(&self) {
        let _ = self.input_tx.try_send(RemoteClientMsg::AgentCancel);
    }
    /// Invoke a host command over an app share. The host enforces Steer and
    /// answers with an rpcResult carrying the same id.
    #[wasm_bindgen(js_name = sendRpc)]
    pub fn send_rpc(&self, id: u64, cmd: String, args: JsValue) {
        let Ok(args) = serde_wasm_bindgen::from_value(args) else {
            return;
        };
        let _ = self
            .input_tx
            .try_send(RemoteClientMsg::Rpc { id, cmd, args });
    }

    /// A store action for the host to execute (app share). Steer-gated on
    /// the host; the confirmation comes back as an actionApplied broadcast.
    #[wasm_bindgen(js_name = sendAction)]
    pub fn send_action(&self, name: String, args: JsValue) {
        let Ok(args) = serde_wasm_bindgen::from_value(args) else {
            return;
        };
        let _ = self
            .input_tx
            .try_send(RemoteClientMsg::Action { name, args });
    }

    /// Clipboard text produced inside the page (app share). Steer-gated.
    #[wasm_bindgen(js_name = sendClipPush)]
    pub fn send_clip_push(&self, text: String) {
        let _ = self.input_tx.try_send(RemoteClientMsg::ClipPush { text });
    }

    /// Open one Host-network HTTP stream on this authenticated connection.
    /// The Host rechecks current viewer access before starting network I/O.
    #[wasm_bindgen(js_name = openHttpStream)]
    pub async fn open_http_stream(
        &self,
        context_id: String,
        method: String,
        url: String,
        headers: JsValue,
    ) -> Result<WebHttpStream, JsValue> {
        let headers: Vec<HeaderPair> = serde_wasm_bindgen::from_value(headers)
            .map_err(|error| JsValue::from_str(&format!("invalid HTTP headers: {error}")))?;
        let (mut send, recv) = self
            .connection
            .open_bi()
            .await
            .map_err(|error| JsValue::from_str(&format!("open HTTP data stream: {error}")))?;
        write_data_stream_preface(&mut send, &DataStreamPreface::http(context_id))
            .await
            .map_err(|error| JsValue::from_str(&format!("write data-stream preface: {error:#}")))?;
        write_http_request_head(
            &mut send,
            &HttpRequestHead {
                method,
                url,
                headers,
            },
        )
        .await
        .map_err(|error| JsValue::from_str(&format!("write HTTP request head: {error:#}")))?;
        Ok(WebHttpStream {
            send,
            recv,
            request_finished: false,
        })
    }

    /// Close the connection. The close handshake is best-effort: the page may
    /// be navigating away, so we do not await it.
    pub fn leave(&self) {
        let ep = self.endpoint.clone();
        wasm_bindgen_futures::spawn_local(async move {
            ep.close().await;
        });
    }
}

/// Connect to a shared tab.
///
/// `on_event` receives the host messages as JSON strings (same shapes the
/// desktop app uses), so the page can render with plain JavaScript.
#[wasm_bindgen(js_name = joinShare)]
pub async fn join_share(
    ticket: String,
    client_name: String,
    on_event: js_sys::Function,
) -> Result<WebJoin, JsValue> {
    let ticket = decode_ticket(&ticket).map_err(|e| JsValue::from_str(&e))?;

    let ep = Endpoint::builder(presets::N0)
        .bind()
        .await
        .map_err(|e| JsValue::from_str(&format!("bind failed: {e}")))?;

    let conn = ep
        .connect(ticket.addr.clone(), REMOTE_ALPN)
        .await
        .map_err(|e| JsValue::from_str(&format!("connect failed: {e}")))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| JsValue::from_str(&format!("open_bi failed: {e}")))?;

    write_frame(
        &mut send,
        &RemoteClientMsg::Hello {
            name: client_name,
            // Never above what the ticket's creator can answer: a v0.0.1/
            // v0.0.2 host (no proto field in the ticket) closes the
            // connection on any Hello above 1 without sending a frame.
            proto: announce_proto(ticket.proto),
            share: ticket.share.clone(),
            token: ticket.token.clone(),
        },
    )
    .await
    .map_err(|e| JsValue::from_str(&e))?;

    let (input_tx, input_rx) = async_channel::bounded::<RemoteClientMsg>(256);

    // Writer: our input towards the host.
    wasm_bindgen_futures::spawn_local(async move {
        while let Ok(msg) = input_rx.recv().await {
            if write_frame(&mut send, &msg).await.is_err() {
                break;
            }
        }
    });

    // Reader: host events towards the page. Every `RemoteHostMsg` variant is
    // forwarded verbatim as its serde JSON — including `Mode { read_only }`,
    // which the host sends once right after join (before the snapshot) so the
    // page can show the view-only badge and gate input locally. Enforcement
    // stays host-side; this client only relays the flag.
    let cb = on_event.clone();
    wasm_bindgen_futures::spawn_local(async move {
        loop {
            match read_frame::<RemoteHostMsg>(&mut recv).await {
                Ok(msg) => {
                    let json = serde_json::to_string(&msg).unwrap_or_default();
                    let ended = matches!(msg, RemoteHostMsg::End { .. });
                    let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&json));
                    if ended {
                        break;
                    }
                }
                Err(e) => {
                    // The reason prefix is load-bearing: both viewers use it
                    // to tell "the link died" (auto-reconnect) from a
                    // host-sent End (deliberate, terminal). Keep it in sync
                    // with `CONNECTION_LOST_PREFIX` in
                    // src/components/remoteReconnect.ts.
                    let json = serde_json::to_string(&RemoteHostMsg::End {
                        reason: format!("connection lost: {e}"),
                    })
                    .unwrap_or_default();
                    let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&json));
                    break;
                }
            }
        }
    });

    Ok(WebJoin {
        endpoint: ep,
        connection: conn,
        input_tx,
    })
}

async fn write_frame<T: Serialize>(
    w: &mut iroh::endpoint::SendStream,
    msg: &T,
) -> Result<(), String> {
    let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    w.write_all(&(body.len() as u32).to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    w.write_all(&body).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn read_frame<T: for<'de> Deserialize<'de>>(
    r: &mut iroh::endpoint::RecvStream,
) -> Result<T, String> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await.map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len);
    if len > MAX_FRAME {
        return Err(format!("frame too large: {len}"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}
