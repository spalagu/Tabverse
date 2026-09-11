//! Raw file streams carried beside the long-lived Remote control stream.

use anyhow::{Context, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use std::sync::Arc;
use tabverse_network::{
    read_file_read_request, read_file_read_start, write_file_read_request, write_file_read_start,
    FileReadHead, FileReadRequest, FileReadStart,
};
use tokio::io::AsyncReadExt;

pub struct OpenedRemoteFile {
    pub file: std::fs::File,
    pub head: FileReadHead,
}

pub trait RemoteFileSource: Send + Sync {
    fn open(&self, request: &FileReadRequest) -> Result<OpenedRemoteFile>;
}

/// One extra stream accepted from an already-authenticated Remote connection.
/// The Remote lifecycle rechecks the current App share and viewer before it
/// calls `serve_file`.
pub struct IncomingFileStream {
    send: SendStream,
    recv: RecvStream,
}

impl IncomingFileStream {
    pub async fn serve_file(self, source: Arc<dyn RemoteFileSource>) -> Result<()> {
        let Self { mut send, mut recv } = self;
        let request = read_file_read_request(&mut recv)
            .await
            .context("read file request")?;
        let opened = match tokio::task::spawn_blocking(move || source.open(&request))
            .await
            .context("join file open task")?
        {
            Ok(opened) => opened,
            Err(error) => {
                write_file_read_start(
                    &mut send,
                    &FileReadStart::Error {
                        code: "file-read-failed".into(),
                        message: error.to_string(),
                    },
                )
                .await?;
                send.finish().context("finish failed file stream")?;
                return Ok(());
            }
        };
        write_file_read_start(
            &mut send,
            &FileReadStart::File {
                head: opened.head.clone(),
            },
        )
        .await?;

        let mut file = tokio::fs::File::from_std(opened.file).take(opened.head.length);
        tokio::io::copy(&mut file, &mut send)
            .await
            .context("stream file bytes")?;
        send.finish().context("finish file stream")?;
        Ok(())
    }
}

pub async fn accept_file_stream(conn: &Connection) -> Result<IncomingFileStream> {
    let (send, recv) = conn
        .accept_bi()
        .await
        .context("accept Remote file stream")?;
    Ok(IncomingFileStream { send, recv })
}

pub struct RemoteFileStream {
    recv: RecvStream,
}

impl RemoteFileStream {
    pub async fn open(conn: &Connection, request: &FileReadRequest) -> Result<Self> {
        let (mut send, recv) = conn.open_bi().await.context("open file data stream")?;
        write_file_read_request(&mut send, request).await?;
        send.finish().context("finish file request")?;
        Ok(Self { recv })
    }

    pub async fn response_start(&mut self) -> Result<FileReadStart> {
        read_file_read_start(&mut self.recv).await
    }

    pub async fn read_chunk(&mut self, limit: usize) -> Result<Vec<u8>> {
        let mut bytes = vec![0; limit.clamp(1, 1024 * 1024)];
        let read = self.recv.read(&mut bytes).await?.unwrap_or(0);
        bytes.truncate(read);
        Ok(bytes)
    }

    pub fn cancel(&mut self) {
        let _ = self.recv.stop(0u8.into());
    }
}
