//! Independent Remote data streams carried beside the long-lived control stream.
//!
//! The control protocol remains small and semantic. Bulk/network traffic opens
//! additional QUIC bidirectional streams on the already-authenticated iroh
//! connection, so a large response cannot head-of-line block presence, input,
//! approvals, or other control messages.

use anyhow::{bail, Context, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use tabverse_network::{
    read_data_stream_preface, read_http_response_start, write_data_stream_preface,
    write_http_request_head, DataStreamKind, DataStreamPreface, HostNetworkGateway,
    HttpRequestHead, HttpResponseStart, DATA_STREAM_VERSION,
};

/// One extra bidirectional stream whose small routing preface has already been
/// read, but whose request has not yet been executed.
///
/// This split is load-bearing for authorization. The Remote lifecycle owns the
/// connection and must inspect `preface()` and the viewer's *current* access
/// before calling `serve()`. In particular, a viewer downgraded from Steer to
/// View must lose the ability to start the very next network request; a
/// forever-running accept loop hidden inside this module could only check the
/// permission once when it started.
pub struct IncomingDataStream {
    preface: DataStreamPreface,
    send: SendStream,
    recv: RecvStream,
}

impl IncomingDataStream {
    /// Routing metadata only. `context_id` identifies remote Browser state; it
    /// is never an authorization credential.
    pub fn preface(&self) -> &DataStreamPreface {
        &self.preface
    }

    /// Execute one stream after the caller has authorized it.
    pub async fn serve(self, gateway: HostNetworkGateway) -> Result<()> {
        let Self {
            preface,
            send,
            recv,
        } = self;
        match preface.kind {
            DataStreamKind::Http => gateway.serve_http_exchange(recv, send).await,
        }
    }
}

/// Accept exactly one data stream and expose its routing preface to the Remote
/// lifecycle *before* any Host network I/O occurs.
///
/// Authentication, live viewer-access checks, connection lifetime, and the
/// accept loop all belong to the caller. This module owns only data-plane
/// framing and transport mechanics.
pub async fn accept_data_stream(conn: &Connection) -> Result<IncomingDataStream> {
    let (send, mut recv) = conn
        .accept_bi()
        .await
        .context("accept Remote data stream")?;
    let preface = read_data_stream_preface(&mut recv)
        .await
        .context("read Remote data-stream preface")?;
    if preface.version != DATA_STREAM_VERSION {
        bail!(
            "unsupported Remote data-stream version {} (expected {})",
            preface.version,
            DATA_STREAM_VERSION
        );
    }
    Ok(IncomingDataStream {
        preface,
        send,
        recv,
    })
}

/// Client side of one HTTP data stream. Request and response bodies stay raw;
/// only the small preface/head frames are JSON encoded by `tabverse-network`.
pub struct RemoteHttpStream {
    send: SendStream,
    recv: RecvStream,
}

impl RemoteHttpStream {
    pub async fn open(conn: &Connection, context_id: &str, head: &HttpRequestHead) -> Result<Self> {
        let (mut send, recv) = conn.open_bi().await.context("open HTTP data stream")?;
        write_data_stream_preface(&mut send, &DataStreamPreface::http(context_id))
            .await
            .context("write HTTP data-stream preface")?;
        write_http_request_head(&mut send, head)
            .await
            .context("write HTTP request head")?;
        Ok(Self { send, recv })
    }

    pub async fn write_request_chunk(&mut self, bytes: &[u8]) -> Result<()> {
        self.send
            .write_all(bytes)
            .await
            .context("write HTTP request body")
    }

    /// Half-close the request direction while keeping the response direction
    /// alive. This is the authoritative end of the streamed request body.
    pub fn finish_request(&mut self) -> Result<()> {
        self.send.finish().context("finish HTTP request stream")
    }

    pub async fn response_start(&mut self) -> Result<HttpResponseStart> {
        read_http_response_start(&mut self.recv)
            .await
            .context("read HTTP response head")
    }

    /// Convenience for bounded consumers such as tests or small resources.
    /// Production Browser plumbing should stream chunks directly rather than
    /// turning this helper into a new architecture-level response ceiling.
    pub async fn read_response_to_end(&mut self, size_limit: usize) -> Result<Vec<u8>> {
        self.recv
            .read_to_end(size_limit)
            .await
            .context("read HTTP response body")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::Endpoint;
    use std::{net::Ipv4Addr, time::Duration};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const TEST_ALPN: &[u8] = b"/tabverse/v3-data-test/1";

    #[tokio::test(flavor = "multi_thread")]
    async fn control_and_large_http_data_streams_share_one_iroh_connection() -> Result<()> {
        tokio::time::timeout(Duration::from_secs(30), async {
            const BODY_LEN: usize = 1024 * 1024 + 196_608;

            // This standalone crate does not run the Tauri composition root. Match
            // the Host HTTP factory's process-wide choice before reqwest builds a
            // client; an Err means another test installed the same provider first.
            let _ = rustls::crypto::ring::default_provider().install_default();

            // The origin is reachable only from the Host side of this test. Using
            // `localhost` below means resolution happens inside HostNetworkGateway.
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let port = listener.local_addr()?.port();
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
                    "HTTP/1.1 200 OK\r\nContent-Length: {BODY_LEN}\r\nConnection: close\r\n\r\n"
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                let chunk = vec![0x6b; 32 * 1024];
                let mut left = BODY_LEN;
                while left > 0 {
                    let n = left.min(chunk.len());
                    socket.write_all(&chunk[..n]).await.unwrap();
                    left -= n;
                }
                socket.shutdown().await.unwrap();
            });

            // This test proves QUIC stream multiplexing, not relay/discovery. Keep
            // both endpoints on loopback so CI never depends on n0 DNS publishing,
            // public relays, interface discovery, or their shutdown timing.
            let host_ep = Endpoint::builder(iroh::endpoint::presets::Minimal)
                .alpns(vec![TEST_ALPN.to_vec()])
                .clear_ip_transports()
                .bind_addr((Ipv4Addr::LOCALHOST, 0))?
                .bind()
                .await?;
            let client_ep = Endpoint::builder(iroh::endpoint::presets::Minimal)
                .clear_ip_transports()
                .bind_addr((Ipv4Addr::LOCALHOST, 0))?
                .bind()
                .await?;

            let host_addr = host_ep.addr();
            let host_ep_for_accept = host_ep.clone();
            let host_accept = tokio::spawn(async move {
                let incoming = host_ep_for_accept
                    .accept()
                    .await
                    .expect("incoming connection");
                incoming.await.expect("host handshake")
            });
            let client_conn = tokio::time::timeout(
                Duration::from_secs(20),
                client_ep.connect(host_addr, TEST_ALPN),
            )
            .await
            .context("client connect timeout")??;
            let host_conn = host_accept.await?;

            // Stream #1 represents the existing long-lived semantic control
            // stream. Extra streams become eligible for authorization only after
            // the caller has accepted and authenticated this one.
            let (mut client_control_send, client_control_recv) = client_conn.open_bi().await?;
            // QUIC streams become visible to the peer only after their first
            // bytes are sent. Write before accept_bi() to avoid both sides
            // waiting for the other to make the control stream observable.
            client_control_send.write_all(b"control-alive").await?;
            let (mut host_control_send, mut host_control_recv) = host_conn.accept_bi().await?;
            let mut control_marker = [0u8; 13];
            host_control_recv.read_exact(&mut control_marker).await?;
            assert_eq!(&control_marker, b"control-alive");

            let gateway = HostNetworkGateway::new(Default::default());
            let host_data = tokio::spawn(async move {
                // The lifecycle gets the preface before the gateway touches the
                // network. Production code checks the viewer's current access at
                // exactly this point, on every accepted stream.
                let incoming = accept_data_stream(&host_conn).await?;
                assert_eq!(incoming.preface().kind, DataStreamKind::Http);
                assert_eq!(incoming.preface().context_id, "remote-browser-context-1");
                incoming.serve(gateway).await
            });

            let mut http = RemoteHttpStream::open(
                &client_conn,
                "remote-browser-context-1",
                &HttpRequestHead {
                    method: "GET".into(),
                    url: format!("http://localhost:{port}/large"),
                    headers: Vec::new(),
                },
            )
            .await?;
            http.finish_request()?;

            let start = http.response_start().await?;
            let HttpResponseStart::Response { head } = start else {
                bail!("HostNetworkGateway returned {start:?}");
            };
            assert_eq!(head.status, 200);

            let body = http.read_response_to_end(BODY_LEN + 1).await?;
            assert_eq!(body.len(), BODY_LEN);
            assert!(body.iter().all(|byte| *byte == 0x6b));

            // The control stream remains a distinct live stream while the >1 MiB
            // data response travels on its own QUIC stream.
            client_control_send.write_all(b"!").await?;
            let mut marker = [0u8; 1];
            host_control_recv.read_exact(&mut marker).await?;
            assert_eq!(&marker, b"!");

            host_data.await??;
            origin.await?;

            // End the proof stream explicitly before closing the connection. This
            // keeps endpoint teardown independent from live stream handles.
            client_control_send.finish()?;
            host_control_send.finish()?;
            drop(client_control_send);
            drop(client_control_recv);
            drop(host_control_send);
            drop(host_control_recv);

            client_conn.close(0u32.into(), b"test complete");
            client_ep.close().await;
            host_ep.close().await;
            Ok::<(), anyhow::Error>(())
        })
        .await
        .context("iroh control/data roundtrip exceeded 30 seconds")?
    }
}
