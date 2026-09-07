//! Host-network delegation for Tabverse Remote.
//!
//! The important boundary is capability, not HTTP proxy policy: a remote
//! renderer asks the host to perform network I/O from the host environment.
//! HTTP(S) is the first data-plane protocol. Request/response heads are small
//! JSON frames; bodies are raw bytes on the surrounding bidirectional stream.
//! No base64, whole-body buffering, or arbitrary response-size ceiling lives
//! in this layer.

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use http::header::{HeaderName, HeaderValue};
use reqwest::redirect::Policy;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::io::ReaderStream;

/// Data-stream protocol version. This is intentionally independent from the
/// small control-frame protocol so bulk transports can evolve without making
/// semantic Remote messages churn.
pub const DATA_STREAM_VERSION: u16 = 1;

/// Metadata frames are bounded; response/request bodies are not framed here
/// and therefore do not inherit this ceiling.
pub const MAX_HEAD_FRAME: u32 = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataStreamKind {
    Http,
}

/// First frame on every extra Remote data stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStreamPreface {
    pub version: u16,
    pub kind: DataStreamKind,
    /// Browser/network state is scoped independently from the host's local
    /// BrowserSession. The gateway itself treats this as opaque identity; a
    /// later cookie/cache layer can key state by it without changing transport.
    pub context_id: String,
}

impl DataStreamPreface {
    pub fn http(context_id: impl Into<String>) -> Self {
        Self {
            version: DATA_STREAM_VERSION,
            kind: DataStreamKind::Http,
            context_id: context_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestHead {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderPair>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseHead {
    pub status: u16,
    pub final_url: String,
    pub headers: Vec<HeaderPair>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl NetworkFailure {
    fn invalid(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    fn reqwest(error: &reqwest::Error) -> Self {
        let code = if error.is_timeout() {
            "network-timeout"
        } else if error.is_connect() {
            "network-connect-failed"
        } else if error.is_request() {
            "network-request-failed"
        } else {
            "network-failed"
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
            retryable: error.is_timeout() || error.is_connect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HttpResponseStart {
    Response { head: HttpResponseHead },
    Error { error: NetworkFailure },
}

/// Host-side HTTP implementation. It deliberately owns only HTTP mechanics;
/// cookie/session policy belongs to the Remote Browser context above it.
#[derive(Clone)]
pub struct HostNetworkGateway {
    client: std::result::Result<reqwest::Client, String>,
}

impl Default for HostNetworkGateway {
    fn default() -> Self {
        Self::new()
    }
}

impl HostNetworkGateway {
    /// Build the production client once. There is no whole-request timeout:
    /// connect/idle policy belongs to concrete operations, while large or long
    /// streams must be able to remain alive. Redirects are surfaced to the
    /// remote renderer so its logical navigation/history can stay coherent.
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .tls_backend_rustls()
            .redirect(Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string());
        Self { client }
    }

    #[cfg(test)]
    fn with_client(client: reqwest::Client) -> Self {
        Self { client: Ok(client) }
    }

    /// Serve one HTTP exchange over an already-authenticated bidirectional
    /// data stream. `recv` contains a framed request head followed immediately
    /// by raw request-body bytes until EOF. `send` receives a framed response
    /// start followed by raw response-body bytes until EOF.
    pub async fn serve_http_exchange<R, W>(&self, mut recv: R, mut send: W) -> Result<()>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin,
    {
        let head: HttpRequestHead = read_json_frame(&mut recv)
            .await
            .context("read remote HTTP request head")?;

        let client = match &self.client {
            Ok(client) => client,
            Err(message) => {
                write_failure(
                    &mut send,
                    NetworkFailure::invalid("network-client-unavailable", message.clone()),
                )
                .await?;
                return Ok(());
            }
        };

        let method = match reqwest::Method::from_bytes(head.method.as_bytes()) {
            Ok(method) => method,
            Err(error) => {
                write_failure(
                    &mut send,
                    NetworkFailure::invalid(
                        "network-invalid-method",
                        format!("invalid HTTP method: {error}"),
                    ),
                )
                .await?;
                return Ok(());
            }
        };

        let url = match reqwest::Url::parse(&head.url) {
            Ok(url) if matches!(url.scheme(), "http" | "https") => url,
            Ok(url) => {
                write_failure(
                    &mut send,
                    NetworkFailure::invalid(
                        "network-unsupported-protocol",
                        format!("HTTP data stream does not carry {} URLs", url.scheme()),
                    ),
                )
                .await?;
                return Ok(());
            }
            Err(error) => {
                write_failure(
                    &mut send,
                    NetworkFailure::invalid(
                        "network-invalid-url",
                        format!("invalid URL: {error}"),
                    ),
                )
                .await?;
                return Ok(());
            }
        };

        let mut request = client.request(method, url);
        for pair in head.headers {
            let Ok(name) = HeaderName::from_bytes(pair.name.as_bytes()) else {
                write_failure(
                    &mut send,
                    NetworkFailure::invalid(
                        "network-invalid-header",
                        format!("invalid header name: {}", pair.name),
                    ),
                )
                .await?;
                return Ok(());
            };
            if is_hop_by_hop(&name) || name == http::header::HOST || name == http::header::CONTENT_LENGTH {
                continue;
            }
            let Ok(value) = HeaderValue::from_str(&pair.value) else {
                write_failure(
                    &mut send,
                    NetworkFailure::invalid(
                        "network-invalid-header",
                        format!("invalid value for header {}", pair.name),
                    ),
                )
                .await?;
                return Ok(());
            };
            request = request.header(name, value);
        }

        // ReaderStream is the critical streaming boundary: reqwest consumes
        // request bytes as the remote side produces them rather than waiting
        // for a complete body in memory.
        let request_body = ReaderStream::new(recv);
        request = request.body(reqwest::Body::wrap_stream(request_body));

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                write_failure(&mut send, NetworkFailure::reqwest(&error)).await?;
                return Ok(());
            }
        };

        let response_head = HttpResponseHead {
            status: response.status().as_u16(),
            final_url: response.url().to_string(),
            headers: response
                .headers()
                .iter()
                .filter(|(name, _)| !is_hop_by_hop(name))
                .map(|(name, value)| HeaderPair {
                    name: name.as_str().to_string(),
                    value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
                })
                .collect(),
        };
        write_json_frame(
            &mut send,
            &HttpResponseStart::Response {
                head: response_head,
            },
        )
        .await?;

        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.context("read host HTTP response body")?;
            send.write_all(&chunk)
                .await
                .context("write remote HTTP response body")?;
        }
        send.shutdown()
            .await
            .context("finish remote HTTP response stream")?;
        Ok(())
    }
}

async fn write_failure<W: AsyncWrite + Unpin>(send: &mut W, error: NetworkFailure) -> Result<()> {
    write_json_frame(send, &HttpResponseStart::Error { error }).await?;
    send.shutdown().await?;
    Ok(())
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "connection"
            | "proxy-connection"
            | "keep-alive"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
    )
}

pub async fn write_data_stream_preface<W: AsyncWrite + Unpin>(
    writer: &mut W,
    preface: &DataStreamPreface,
) -> Result<()> {
    write_json_frame(writer, preface).await
}

pub async fn read_data_stream_preface<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<DataStreamPreface> {
    read_json_frame(reader).await
}

pub async fn write_http_request_head<W: AsyncWrite + Unpin>(
    writer: &mut W,
    head: &HttpRequestHead,
) -> Result<()> {
    write_json_frame(writer, head).await
}

pub async fn read_http_response_start<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<HttpResponseStart> {
    read_json_frame(reader).await
}

async fn write_json_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() as u64 > MAX_HEAD_FRAME as u64 {
        bail!("network metadata frame too large: {}", bytes.len());
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    writer.write_all(&bytes).await?;
    Ok(())
}

async fn read_json_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(reader: &mut R) -> Result<T> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len);
    if len > MAX_HEAD_FRAME {
        bail!("network metadata frame too large: {len}");
    }
    let mut bytes = vec![0u8; len as usize];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|e| anyhow!(e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn metadata_frames_round_trip_without_touching_body_encoding() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        let expected = DataStreamPreface::http("browser-context-7");
        let write = tokio::spawn({
            let expected = expected.clone();
            async move { write_data_stream_preface(&mut a, &expected).await.unwrap() }
        });
        let actual = read_data_stream_preface(&mut b).await.unwrap();
        write.await.unwrap();
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn host_gateway_uses_host_dns_and_streams_bodies_beyond_the_old_one_mib_cap() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        const BODY_LEN: usize = 1024 * 1024 + 131_072;

        let origin = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            assert!(String::from_utf8_lossy(&request).starts_with("GET /large HTTP/1.1"));
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {BODY_LEN}\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            let chunk = vec![0x5a; 16 * 1024];
            let mut left = BODY_LEN;
            while left > 0 {
                let n = left.min(chunk.len());
                socket.write_all(&chunk[..n]).await.unwrap();
                left -= n;
            }
            socket.shutdown().await.unwrap();
        });

        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        let gateway = HostNetworkGateway::with_client(client);
        let (client_side, host_side) = tokio::io::duplex(64 * 1024);
        let (mut client_recv, mut client_send) = tokio::io::split(client_side);
        let (host_recv, host_send) = tokio::io::split(host_side);

        let serve = tokio::spawn(async move {
            gateway
                .serve_http_exchange(host_recv, host_send)
                .await
                .unwrap();
        });

        write_http_request_head(
            &mut client_send,
            &HttpRequestHead {
                method: "GET".into(),
                // `localhost`, not 127.0.0.1: resolution therefore happens in
                // the host-side reqwest client, which is the V3 requirement.
                url: format!("http://localhost:{port}/large"),
                headers: Vec::new(),
            },
        )
        .await
        .unwrap();
        client_send.shutdown().await.unwrap();

        let start = read_http_response_start(&mut client_recv).await.unwrap();
        let HttpResponseStart::Response { head } = start else {
            panic!("host gateway returned {start:?}");
        };
        assert_eq!(head.status, 200);
        assert!(head.final_url.contains("/large"));

        let mut body = Vec::new();
        client_recv.read_to_end(&mut body).await.unwrap();
        assert_eq!(body.len(), BODY_LEN);
        assert!(body.iter().all(|b| *b == 0x5a));

        serve.await.unwrap();
        origin.await.unwrap();
    }
}
