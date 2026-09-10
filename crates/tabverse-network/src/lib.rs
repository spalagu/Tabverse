//! Host-network delegation for Tabverse Remote.
//!
//! The important boundary is capability, not HTTP proxy policy: a remote
//! renderer asks the host to perform network I/O from the host environment.
//! HTTP(S) is the first data-plane protocol. Request/response heads are small
//! JSON frames; bodies are raw bytes on the surrounding bidirectional stream.
//! No base64, whole-body buffering, or arbitrary response-size ceiling lives
//! in this layer.

#[cfg(not(target_arch = "wasm32"))]
use anyhow::Context;
use anyhow::{anyhow, bail, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[cfg(not(target_arch = "wasm32"))]
use futures_util::StreamExt;
#[cfg(not(target_arch = "wasm32"))]
use http::header::{HeaderName, HeaderValue};
#[cfg(not(target_arch = "wasm32"))]
use reqwest::cookie::CookieStore;
#[cfg(not(target_arch = "wasm32"))]
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
#[cfg(not(target_arch = "wasm32"))]
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
    FileRead,
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

    pub fn file_read(context_id: impl Into<String>) -> Self {
        Self {
            version: DATA_STREAM_VERSION,
            kind: DataStreamKind::FileRead,
            context_id: context_id.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadRequest {
    pub path: String,
    pub offset: u64,
    pub length: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadHead {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub total: u64,
    pub offset: u64,
    pub length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FileReadStart {
    File { head: FileReadHead },
    Error { code: String, message: String },
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
    #[cfg(not(target_arch = "wasm32"))]
    fn invalid(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
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
///
/// The concrete HTTP client is injected by the Host adapter. This crate does
/// not own DNS, proxy, TLS, redirect, or timeout policy and therefore cannot
/// create a second network-policy boundary beside the application's canonical
/// HTTP client factory.
#[derive(Clone)]
#[cfg(not(target_arch = "wasm32"))]
pub struct HostNetworkGateway {
    client: reqwest::Client,
    cookie_jars: Arc<Mutex<HashMap<String, Arc<reqwest::cookie::Jar>>>>,
    cache: Arc<Mutex<HttpCache>>,
}

#[cfg(not(target_arch = "wasm32"))]
const CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
#[cfg(not(target_arch = "wasm32"))]
const CACHE_MAX_ENTRY_BYTES: usize = 16 * 1024 * 1024;
#[cfg(not(target_arch = "wasm32"))]
const CACHE_MAX_ENTRIES: usize = 256;

#[derive(Default)]
#[cfg(not(target_arch = "wasm32"))]
struct HttpCache {
    entries: VecDeque<CacheEntry>,
    bytes: usize,
}

#[derive(Clone)]
#[cfg(not(target_arch = "wasm32"))]
struct CacheEntry {
    context_id: String,
    url: String,
    status: u16,
    final_url: String,
    headers: Vec<HeaderPair>,
    body: Arc<[u8]>,
    stored_at: Instant,
    freshness: Duration,
    vary: Vec<(String, String)>,
}

#[cfg(not(target_arch = "wasm32"))]
impl HostNetworkGateway {
    /// Bind the streaming gateway to a Host-provided HTTP client.
    ///
    /// Production callers are responsible for constructing this client at the
    /// application network-policy boundary. In particular, Remote Browser
    /// navigation expects redirects to be surfaced rather than followed so the
    /// remote renderer can keep its own logical history coherent.
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            cookie_jars: Arc::new(Mutex::new(HashMap::new())),
            cache: Arc::new(Mutex::new(HttpCache::default())),
        }
    }

    /// Start one authenticated Remote connection's Browser state namespace.
    /// The returned gateway shares Host network policy but no cookies with
    /// this gateway or any other connection.
    pub fn isolated(&self) -> Self {
        Self::new(self.client.clone())
    }

    /// Serve one HTTP exchange over an already-authenticated bidirectional
    /// data stream. `recv` contains a framed request head followed immediately
    /// by raw request-body bytes until EOF. `send` receives a framed response
    /// start followed by raw response-body bytes until EOF.
    pub async fn serve_http_exchange<R, W>(
        &self,
        context_id: &str,
        mut recv: R,
        mut send: W,
    ) -> Result<()>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin,
    {
        let head: HttpRequestHead = read_json_frame(&mut recv)
            .await
            .context("read remote HTTP request head")?;

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
                    NetworkFailure::invalid("network-invalid-url", format!("invalid URL: {error}")),
                )
                .await?;
                return Ok(());
            }
        };

        let cookie_jar = {
            let mut jars = self.cookie_jars.lock().unwrap_or_else(|e| e.into_inner());
            jars.entry(context_id.to_string())
                .or_insert_with(|| Arc::new(reqwest::cookie::Jar::default()))
                .clone()
        };
        let cacheable_request = method == reqwest::Method::GET;
        let mut forwarded_headers = Vec::new();
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
            if is_hop_by_hop(&name)
                || name == http::header::HOST
                || name == http::header::CONTENT_LENGTH
                || name == http::header::COOKIE
            {
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
            forwarded_headers.push((name, value));
        }
        if let Some(cookies) = cookie_jar.cookies(&url) {
            forwarded_headers.push((http::header::COOKIE, cookies));
        }

        let request_no_store =
            header_contains_token(&forwarded_headers, http::header::CACHE_CONTROL, "no-store");
        let request_forces_revalidation =
            ["no-cache", "max-age=0"].iter().any(|token| {
                header_contains_token(&forwarded_headers, http::header::CACHE_CONTROL, token)
            }) || header_value(&forwarded_headers, http::header::PRAGMA)
                .is_some_and(|value| value.eq_ignore_ascii_case("no-cache"));
        let cached = (cacheable_request && !request_no_store)
            .then(|| {
                self.cache.lock().unwrap_or_else(|e| e.into_inner()).lookup(
                    context_id,
                    url.as_str(),
                    &forwarded_headers,
                )
            })
            .flatten();
        if let Some(entry) = cached.as_ref().filter(|entry| {
            !request_forces_revalidation && entry.stored_at.elapsed() < entry.freshness
        }) {
            return write_cached_response(&mut send, entry).await;
        }

        let mut request = self.client.request(method.clone(), url.clone());
        for (name, value) in &forwarded_headers {
            request = request.header(name, value);
        }
        let mut gateway_revalidation = false;
        if let Some(entry) = cached.as_ref() {
            if header_value(&forwarded_headers, http::header::IF_NONE_MATCH).is_none() {
                if let Some(etag) = response_header(&entry.headers, "etag") {
                    request = request.header(http::header::IF_NONE_MATCH, etag);
                    gateway_revalidation = true;
                }
            }
            if header_value(&forwarded_headers, http::header::IF_MODIFIED_SINCE).is_none() {
                if let Some(modified) = response_header(&entry.headers, "last-modified") {
                    request = request.header(http::header::IF_MODIFIED_SINCE, modified);
                    gateway_revalidation = true;
                }
            }
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

        for value in response.headers().get_all(http::header::SET_COOKIE) {
            if let Ok(cookie) = value.to_str() {
                cookie_jar.add_cookie_str(cookie, response.url());
            }
        }

        if gateway_revalidation && response.status() == reqwest::StatusCode::NOT_MODIFIED {
            if let Some(mut entry) = cached {
                refresh_cached_headers(&mut entry, response.headers());
                entry.stored_at = Instant::now();
                entry.freshness = response_freshness(&entry.headers);
                self.cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .replace(entry.clone());
                return write_cached_response(&mut send, &entry).await;
            }
        }

        let response_head = HttpResponseHead {
            status: response.status().as_u16(),
            final_url: response.url().to_string(),
            headers: response
                .headers()
                .iter()
                .filter(|(name, _)| !is_hop_by_hop(name) && *name != http::header::SET_COOKIE)
                .map(|(name, value)| HeaderPair {
                    name: name.as_str().to_string(),
                    value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
                })
                .collect(),
        };
        let should_store = cacheable_request
            && cache_allows_store(
                &forwarded_headers,
                &response_head.headers,
                response_head.status,
            );
        write_json_frame(
            &mut send,
            &HttpResponseStart::Response {
                head: response_head.clone(),
            },
        )
        .await?;

        let mut cache_body = should_store.then(Vec::new);
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.context("read host HTTP response body")?;
            if let Some(cached_body) = cache_body.as_mut() {
                if cached_body.len().saturating_add(chunk.len()) <= CACHE_MAX_ENTRY_BYTES {
                    cached_body.extend_from_slice(&chunk);
                } else {
                    cache_body = None;
                }
            }
            send.write_all(&chunk)
                .await
                .context("write remote HTTP response body")?;
        }
        send.shutdown()
            .await
            .context("finish remote HTTP response stream")?;
        if let Some(body) = cache_body {
            if let Some(entry) = cache_entry(
                context_id,
                url.as_str(),
                &forwarded_headers,
                response_head,
                body,
            ) {
                self.cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .replace(entry);
            }
        }
        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl HttpCache {
    fn lookup(
        &self,
        context_id: &str,
        url: &str,
        request_headers: &[(HeaderName, HeaderValue)],
    ) -> Option<CacheEntry> {
        self.entries
            .iter()
            .rev()
            .find(|entry| {
                entry.context_id == context_id
                    && entry.url == url
                    && entry.vary.iter().all(|(name, expected)| {
                        request_header_text(request_headers, name) == *expected
                    })
            })
            .cloned()
    }

    fn replace(&mut self, entry: CacheEntry) {
        if let Some(index) = self.entries.iter().position(|existing| {
            existing.context_id == entry.context_id
                && existing.url == entry.url
                && existing.vary == entry.vary
        }) {
            if let Some(old) = self.entries.remove(index) {
                self.bytes = self.bytes.saturating_sub(old.body.len());
            }
        }
        self.bytes = self.bytes.saturating_add(entry.body.len());
        self.entries.push_back(entry);
        while self.bytes > CACHE_MAX_BYTES || self.entries.len() > CACHE_MAX_ENTRIES {
            let Some(oldest) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(oldest.body.len());
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn header_value(headers: &[(HeaderName, HeaderValue)], wanted: HeaderName) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == wanted)
        .and_then(|(_, value)| value.to_str().ok())
}

#[cfg(not(target_arch = "wasm32"))]
fn request_header_text(headers: &[(HeaderName, HeaderValue)], wanted: &str) -> String {
    headers
        .iter()
        .filter(|(name, _)| name.as_str().eq_ignore_ascii_case(wanted))
        .filter_map(|(_, value)| value.to_str().ok())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(not(target_arch = "wasm32"))]
fn response_header<'a>(headers: &'a [HeaderPair], wanted: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|pair| pair.name.eq_ignore_ascii_case(wanted))
        .map(|pair| pair.value.as_str())
}

#[cfg(not(target_arch = "wasm32"))]
fn header_contains_token(
    headers: &[(HeaderName, HeaderValue)],
    wanted: HeaderName,
    token: &str,
) -> bool {
    header_value(headers, wanted).is_some_and(|value| {
        value
            .split(',')
            .map(str::trim)
            .any(|part| part.eq_ignore_ascii_case(token))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn response_has_cache_token(headers: &[HeaderPair], token: &str) -> bool {
    response_header(headers, "cache-control").is_some_and(|value| {
        value
            .split(',')
            .map(str::trim)
            .any(|part| part.eq_ignore_ascii_case(token))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn response_freshness(headers: &[HeaderPair]) -> Duration {
    if response_has_cache_token(headers, "no-cache") {
        return Duration::ZERO;
    }
    let max_age = response_header(headers, "cache-control").and_then(|value| {
        value.split(',').map(str::trim).find_map(|part| {
            let (name, seconds) = part.split_once('=')?;
            name.trim()
                .eq_ignore_ascii_case("max-age")
                .then(|| seconds.trim_matches('"').parse::<u64>().ok())
                .flatten()
        })
    });
    let mut freshness = max_age
        .map(Duration::from_secs)
        .or_else(|| {
            let expires = httpdate::parse_http_date(response_header(headers, "expires")?).ok()?;
            let date = response_header(headers, "date")
                .and_then(|value| httpdate::parse_http_date(value).ok())
                .unwrap_or_else(SystemTime::now);
            expires.duration_since(date).ok()
        })
        .unwrap_or_default();
    if let Some(age) = response_header(headers, "age").and_then(|age| age.parse::<u64>().ok()) {
        freshness = freshness.saturating_sub(Duration::from_secs(age));
    }
    freshness
}

#[cfg(not(target_arch = "wasm32"))]
fn cache_allows_store(
    request_headers: &[(HeaderName, HeaderValue)],
    response_headers: &[HeaderPair],
    status: u16,
) -> bool {
    let status_cacheable = matches!(status, 200 | 203 | 204 | 301 | 404 | 410);
    status_cacheable
        && !header_contains_token(request_headers, http::header::CACHE_CONTROL, "no-store")
        && !response_has_cache_token(response_headers, "no-store")
        && response_header(response_headers, "vary") != Some("*")
        && (response_freshness(response_headers) > Duration::ZERO
            || response_header(response_headers, "etag").is_some()
            || response_header(response_headers, "last-modified").is_some())
}

#[cfg(not(target_arch = "wasm32"))]
fn cache_entry(
    context_id: &str,
    url: &str,
    request_headers: &[(HeaderName, HeaderValue)],
    head: HttpResponseHead,
    body: Vec<u8>,
) -> Option<CacheEntry> {
    let vary_names = response_header(&head.headers, "vary")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if vary_names.iter().any(|name| name == "*") {
        return None;
    }
    let vary = vary_names
        .into_iter()
        .map(|name| {
            let value = request_header_text(request_headers, &name);
            (name, value)
        })
        .collect();
    Some(CacheEntry {
        context_id: context_id.to_string(),
        url: url.to_string(),
        status: head.status,
        final_url: head.final_url,
        freshness: response_freshness(&head.headers),
        headers: head.headers,
        body: body.into(),
        stored_at: Instant::now(),
        vary,
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn refresh_cached_headers(entry: &mut CacheEntry, fresh: &http::HeaderMap) {
    for name in [
        http::header::CACHE_CONTROL,
        http::header::DATE,
        http::header::ETAG,
        http::header::EXPIRES,
        http::header::LAST_MODIFIED,
        http::header::AGE,
    ] {
        let Some(value) = fresh.get(&name) else {
            continue;
        };
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        if let Some(existing) = entry
            .headers
            .iter_mut()
            .find(|pair| pair.name.eq_ignore_ascii_case(name.as_str()))
        {
            existing.value = value;
        } else {
            entry.headers.push(HeaderPair {
                name: name.as_str().to_string(),
                value,
            });
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn write_cached_response<W: AsyncWrite + Unpin>(
    send: &mut W,
    entry: &CacheEntry,
) -> Result<()> {
    write_json_frame(
        send,
        &HttpResponseStart::Response {
            head: HttpResponseHead {
                status: entry.status,
                final_url: entry.final_url.clone(),
                headers: entry.headers.clone(),
            },
        },
    )
    .await?;
    send.write_all(&entry.body).await?;
    send.shutdown().await?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
async fn write_failure<W: AsyncWrite + Unpin>(send: &mut W, error: NetworkFailure) -> Result<()> {
    write_json_frame(send, &HttpResponseStart::Error { error }).await?;
    send.shutdown().await?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
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

pub async fn write_file_read_request<W: AsyncWrite + Unpin>(
    writer: &mut W,
    request: &FileReadRequest,
) -> Result<()> {
    write_json_frame(writer, request).await
}

pub async fn read_file_read_request<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<FileReadRequest> {
    read_json_frame(reader).await
}

pub async fn write_file_read_start<W: AsyncWrite + Unpin>(
    writer: &mut W,
    start: &FileReadStart,
) -> Result<()> {
    write_json_frame(writer, start).await
}

pub async fn read_file_read_start<R: AsyncRead + Unpin>(reader: &mut R) -> Result<FileReadStart> {
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
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
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
    async fn file_stream_metadata_round_trips_without_touching_body_bytes() {
        let (mut writer, mut reader) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move {
            write_data_stream_preface(&mut writer, &DataStreamPreface::file_read("files-tab"))
                .await
                .unwrap();
            write_file_read_request(
                &mut writer,
                &FileReadRequest {
                    path: "/tmp/raw.bin".into(),
                    offset: 7,
                    length: Some(11),
                },
            )
            .await
            .unwrap();
            writer.write_all(&[0, 1, 2, 255]).await.unwrap();
        });
        assert_eq!(
            read_data_stream_preface(&mut reader).await.unwrap(),
            DataStreamPreface::file_read("files-tab")
        );
        assert_eq!(
            read_file_read_request(&mut reader).await.unwrap(),
            FileReadRequest {
                path: "/tmp/raw.bin".into(),
                offset: 7,
                length: Some(11),
            }
        );
        let mut raw = [0; 4];
        reader.read_exact(&mut raw).await.unwrap();
        assert_eq!(raw, [0, 1, 2, 255]);
        task.await.unwrap();
    }

    async fn exchange_full(
        gateway: HostNetworkGateway,
        context_id: &str,
        url: String,
        headers: Vec<HeaderPair>,
    ) -> (HttpResponseHead, Vec<u8>) {
        let (client_side, host_side) = tokio::io::duplex(64 * 1024);
        let (mut client_recv, mut client_send) = tokio::io::split(client_side);
        let (host_recv, host_send) = tokio::io::split(host_side);
        let context_id = context_id.to_string();
        let serve = tokio::spawn(async move {
            gateway
                .serve_http_exchange(&context_id, host_recv, host_send)
                .await
                .unwrap();
        });
        write_http_request_head(
            &mut client_send,
            &HttpRequestHead {
                method: "GET".into(),
                url,
                headers,
            },
        )
        .await
        .unwrap();
        client_send.shutdown().await.unwrap();
        let start = read_http_response_start(&mut client_recv).await.unwrap();
        let HttpResponseStart::Response { head } = start else {
            panic!("host gateway returned {start:?}");
        };
        let mut body = Vec::new();
        client_recv.read_to_end(&mut body).await.unwrap();
        serve.await.unwrap();
        (head, body)
    }

    async fn exchange(
        gateway: HostNetworkGateway,
        context_id: &str,
        url: String,
    ) -> HttpResponseHead {
        exchange_full(gateway, context_id, url, Vec::new()).await.0
    }

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
        // This standalone crate does not run the Tauri composition root. Match
        // the Host HTTP factory's process-wide choice before reqwest builds a
        // client; an Err means another test installed the same provider first.
        let _ = rustls::crypto::ring::default_provider().install_default();

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

        let gateway = HostNetworkGateway::new(Default::default());
        let (client_side, host_side) = tokio::io::duplex(64 * 1024);
        let (mut client_recv, mut client_send) = tokio::io::split(client_side);
        let (host_recv, host_send) = tokio::io::split(host_side);

        let serve = tokio::spawn(async move {
            gateway
                .serve_http_exchange("test-browser", host_recv, host_send)
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

    #[tokio::test]
    async fn fresh_cache_reuses_bytes_only_inside_the_same_context_and_vary_key() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let origin = tokio::spawn(async move {
            let mut requests = Vec::new();
            loop {
                let accepted =
                    tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
                let Ok(Ok((mut socket, _))) = accepted else {
                    break;
                };
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8(request).unwrap());
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nCache-Control: max-age=60\r\nVary: Accept-Language\r\nContent-Length: 11\r\nConnection: close\r\n\r\ncached-body",
                    )
                    .await
                    .unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });

        let gateway = HostNetworkGateway::new(Default::default());
        let url = format!("http://localhost:{port}/asset");
        let language = |value: &str| {
            vec![HeaderPair {
                name: "accept-language".into(),
                value: value.into(),
            }]
        };
        let (_, first) =
            exchange_full(gateway.clone(), "browser-a", url.clone(), language("en")).await;
        let (_, repeated) =
            exchange_full(gateway.clone(), "browser-a", url.clone(), language("en")).await;
        exchange_full(gateway.clone(), "browser-a", url.clone(), language("fr")).await;
        exchange_full(gateway, "browser-b", url, language("en")).await;

        assert_eq!(first, b"cached-body");
        assert_eq!(repeated, first);
        assert_eq!(origin.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn stale_etag_cache_revalidates_and_reuses_the_streamed_body() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let origin = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8(request).unwrap());
                let response = if index == 0 {
                    "HTTP/1.1 200 OK\r\nCache-Control: no-cache\r\nETag: \"asset-v1\"\r\nContent-Length: 7\r\nConnection: close\r\n\r\nversion"
                } else {
                    "HTTP/1.1 304 Not Modified\r\nCache-Control: max-age=60\r\nETag: \"asset-v1\"\r\nConnection: close\r\n\r\n"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });

        let gateway = HostNetworkGateway::new(Default::default());
        let url = format!("http://localhost:{port}/etag");
        let (_, first) = exchange_full(gateway.clone(), "browser-a", url.clone(), vec![]).await;
        let (head, second) = exchange_full(gateway, "browser-a", url, vec![]).await;

        assert_eq!(head.status, 200);
        assert_eq!(first, b"version");
        assert_eq!(second, first);
        let requests = origin.await.unwrap();
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("if-none-match: \"asset-v1\""));
    }

    #[tokio::test]
    async fn remote_cookies_stay_host_side_and_are_isolated_by_context_and_connection() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let origin = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8(request).unwrap());
                let cookie = if index == 0 {
                    "Set-Cookie: remote_session=alpha; HttpOnly; Path=/\r\n"
                } else {
                    ""
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\n{cookie}Content-Length: 0\r\nConnection: close\r\n\r\n"
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });

        let gateway = HostNetworkGateway::new(Default::default());
        let url = |path: &str| format!("http://localhost:{port}/{path}");
        let set = exchange(gateway.clone(), "browser-a", url("set")).await;
        exchange(gateway.clone(), "browser-a", url("same-context")).await;
        exchange(gateway.clone(), "browser-b", url("other-context")).await;
        exchange(gateway.isolated(), "browser-a", url("other-connection")).await;

        assert!(set.headers.iter().all(|header| header.name != "set-cookie"));
        let requests = origin.await.unwrap();
        assert!(requests[1].contains("cookie: remote_session=alpha"));
        assert!(!requests[2].contains("remote_session=alpha"));
        assert!(!requests[3].contains("remote_session=alpha"));
    }
}
