import { useEffect, useRef, useState } from "react";
import type { ErrorDescription } from "../strings/errors";

export const MAX_TERMINAL_UPLOAD_BYTES = 64 * 1024 * 1024;

export interface TerminalUploadFile {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface TerminalUploadPrompt {
  files: TerminalUploadFile[];
  destination: string;
}

export interface TerminalTransferDestination {
  host: string;
  dir: string;
}

export interface TerminalFileTransferPorts {
  remoteHost: string | null;
  remoteCwd: string | null;
  pullTarget: string | null;
  pull: (host: string, remotePath: string) => Promise<string>;
  push: (
    host: string,
    dir: string,
    name: string,
    bytes: Uint8Array
  ) => Promise<void>;
  openLocalPath: (path: string) => void;
  pullError: (error: unknown) => ErrorDescription;
  pushError: (error: unknown) => ErrorDescription;
  uploadTooLarge: (file: TerminalUploadFile) => ErrorDescription;
  uploadDone: (count: number, host: string) => string;
}

export function splitTerminalTransferDestination(
  destination: string
): TerminalTransferDestination | null {
  const colon = destination.indexOf(":");
  if (colon <= 0 || colon === destination.length - 1) return null;
  return {
    host: destination.slice(0, colon),
    dir: destination.slice(colon + 1),
  };
}

export interface TerminalFileTransferController {
  busy: boolean;
  error: ErrorDescription | null;
  notice: string | null;
  uploadPrompt: TerminalUploadPrompt | null;
  dismissError: () => void;
  dismissUpload: () => void;
  setUploadDestination: (destination: string) => void;
  startUpload: (files: TerminalUploadFile[]) => void;
  submitUpload: () => Promise<void>;
  pullFromRemote: () => Promise<void>;
}

/** Manages the user-facing lifecycle around terminal SCP transfers. */
export function useTerminalFileTransfer(
  ports: TerminalFileTransferPorts
): TerminalFileTransferController {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadPrompt, setUploadPrompt] =
    useState<TerminalUploadPrompt | null>(null);
  const noticeTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null
  );

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) {
        globalThis.clearTimeout(noticeTimer.current);
      }
    },
    []
  );

  const pullFromRemote = async () => {
    if (ports.remoteHost === null || ports.pullTarget === null) return;
    setBusy(true);
    setError(null);
    try {
      const local = await ports.pull(ports.remoteHost, ports.pullTarget);
      ports.openLocalPath(local);
    } catch (caught) {
      setError(ports.pullError(caught));
    } finally {
      setBusy(false);
    }
  };

  const startUpload = (files: TerminalUploadFile[]) => {
    if (ports.remoteHost === null) return;
    const tooBig = files.find((file) => file.size > MAX_TERMINAL_UPLOAD_BYTES);
    if (tooBig !== undefined) {
      setError(ports.uploadTooLarge(tooBig));
      return;
    }
    setUploadPrompt({
      files,
      destination: `${ports.remoteHost}:${ports.remoteCwd ?? "~"}`,
    });
  };

  const submitUpload = async () => {
    if (uploadPrompt === null) return;
    const destination = splitTerminalTransferDestination(
      uploadPrompt.destination
    );
    if (destination === null) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of uploadPrompt.files) {
        await ports.push(
          destination.host,
          destination.dir,
          file.name,
          new Uint8Array(await file.arrayBuffer())
        );
      }
      setUploadPrompt(null);
      setNotice(ports.uploadDone(uploadPrompt.files.length, destination.host));
      if (noticeTimer.current !== null) {
        globalThis.clearTimeout(noticeTimer.current);
      }
      noticeTimer.current = globalThis.setTimeout(() => {
        noticeTimer.current = null;
        setNotice(null);
      }, 4000);
    } catch (caught) {
      setError(ports.pushError(caught));
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    error,
    notice,
    uploadPrompt,
    dismissError: () => setError(null),
    dismissUpload: () => setUploadPrompt(null),
    setUploadDestination: (destination) =>
      setUploadPrompt((current) =>
        current === null ? null : { ...current, destination }
      ),
    startUpload,
    submitUpload,
    pullFromRemote,
  };
}
