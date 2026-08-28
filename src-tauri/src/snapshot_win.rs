#![cfg(target_os = "windows")]

use std::sync::mpsc::Sender;

use base64::Engine as _;
use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::SHCreateMemStream;

pub fn take(webview: &tauri::Webview, tx: Sender<Result<String, String>>) {
    let outcome = webview.with_webview(move |pw| unsafe {
        let controller = pw.controller();
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(format!("no core webview to capture: {e}")));
                return;
            }
        };
        let Some(stream) = SHCreateMemStream(None) else {
            let _ = tx.send(Err("could not make a memory stream".into()));
            return;
        };
        let read_back = stream.clone();
        let done = tx.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let answer = match result {
                Ok(()) => read_stream(&read_back),
                Err(e) => Err(format!("capture failed: {e}")),
            };
            let _ = done.send(answer);
            Ok(())
        }));
        if let Err(e) = core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        ) {
            let _ = tx.send(Err(format!("capture would not start: {e}")));
        }
    });
    if let Err(e) = outcome {
        eprintln!("[snapshot] could not reach the webview: {e}");
    }
}

/// Drain the finished capture stream from its start.
unsafe fn read_stream(stream: &IStream) -> Result<String, String> {
    stream
        .Seek(0, STREAM_SEEK_SET, None)
        .map_err(|e| e.to_string())?;
    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        let mut read: u32 = 0;
        let hr = stream.Read(
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            buf.len() as u32,
            Some(&mut read),
        );
        if read > 0 {
            out.extend_from_slice(&buf[..read as usize]);
        }
        // S_FALSE (still ok()) with zero read is the end of the stream.
        if hr.is_err() || read == 0 {
            break;
        }
    }
    if out.is_empty() {
        return Err("the capture stream came back empty".into());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&out)
    ))
}
