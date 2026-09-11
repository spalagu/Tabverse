//! Framing for raw-byte Remote data streams.
//!
//! File metadata is carried in bounded JSON frames. File bodies remain raw
//! bytes on the surrounding authenticated QUIC stream.

use anyhow::{anyhow, bail, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_HEAD_FRAME: u32 = 512 * 1024;

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
        bail!("remote data metadata frame too large: {}", bytes.len());
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
        bail!("remote data metadata frame too large: {len}");
    }
    let mut bytes = vec![0u8; len as usize];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|error| anyhow!(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn file_stream_metadata_does_not_touch_body_bytes() {
        let (mut writer, mut reader) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move {
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
}
