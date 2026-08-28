import { useEffect, useState } from "react";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";

export interface InspectViewMeta {
  path: string;
  name: string;
  size: number;
  mime: string;
}

export interface CertInfo {
  kind: "certificate" | "csr";
  subjectCn: string;
  subject: string;
  issuer: string;
  sans: string[];
  notBefore: number;
  notAfter: number;
  serial: string;
  sigAlg: string;
  keyAlg: string;
  sha256: string;
  isCa: boolean;
}

export interface ExecArch {
  arch: string;
  bits: number;
  fileType: string | null;
}

export type Inspection =
  | { type: "certificates"; items: CertInfo[]; privateKey: string | null }
  | {
      type: "archive";
      entries: { path: string; size: number; dir: boolean }[];
      total: number;
      truncated: boolean;
    }
  | { type: "plist"; text: string }
  | {
      type: "sqlite";
      tables: { name: string; rows: number; columns: string[] }[];
    }
  | {
      type: "font";
      family: string;
      style: string;
      glyphCount: number;
      variable: boolean;
    }
  | { type: "image"; width: number; height: number }
  | {
      type: "executable";
      format: "mach-o" | "elf" | "pe" | "script";
      archs: ExecArch[];
      interpreter: string | null;
      executableBit: boolean;
      hasCodeSignature: boolean | null;
      hasEntryPoint: boolean | null;
      dylibCount: number | null;
      dylibs: string[] | null;
    }
  | { type: "unsupported" };

export interface InspectViewRuntime {
  inspect: (path: string) => Promise<Inspection>;
  reveal: (path: string) => Promise<void>;
  extract: (
    archive: string,
    destDir: string
  ) => Promise<{ dir: string; files: string[] }>;
  chooseDirectory: (title: string) => Promise<string | null>;
  formatSize: (bytes: number) => string;
}

export interface InspectViewProps<Meta extends InspectViewMeta = InspectViewMeta> {
  meta: Meta;
  runtime: InspectViewRuntime;
}
/**
 * Structured viewer for files the plain reader can't show: archives become an
 * entry listing, certificates/CSRs become cards, binary plists become their
 * decoded text. The Rust side does the parsing; this component only lays the
 * result out.
 */
export function InspectView<Meta extends InspectViewMeta>({
  meta,
  runtime,
}: InspectViewProps<Meta>) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; data: Inspection }
    | { phase: "error"; message: ErrorDescription }
  >({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });

    (async () => {
      try {
        const data = await runtime.inspect(meta.path);
        if (!cancelled) setState({ phase: "ready", data });
      } catch (e) {
        if (!cancelled)
          setState({
            phase: "error",
            message: describeError(e, STR.errors.actions.inspectFile),
          });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.path, runtime]);

  if (state.phase === "loading") {
    return (
      <div className="preview-center">
        {STR.files.viewers.inspecting({ name: meta.name })}
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="preview-center column">
        <ErrorState inline error={state.message} />
        <button className="btn" onClick={() => void runtime.reveal(meta.path)}>
          {STR.files.tree.revealInFinder}
        </button>
      </div>
    );
  }

  const data = state.data;
  switch (data.type) {
    case "certificates":
      return (
        <div className="inspect-view">
          {data.privateKey !== null && (
            // Deliberate refusal: the inspector will name the key but never
            // render its bytes, so a screen share can't leak it.
            <div className="inspect-key-warning">
              {STR.files.inspect.keyWarningLead}{" "}
              <strong>{data.privateKey}</strong>
              {STR.files.inspect.keyWarningTail}
            </div>
          )}
          {data.items.map((item, i) => (
            <CertCard key={`${item.sha256}-${i}`} cert={item} />
          ))}
        </div>
      );
    case "archive":
      return <ArchiveInspect meta={meta} data={data} runtime={runtime} />;
    case "executable":
      return <ExecInspect data={data} />;
    case "plist":
      return (
        <div className="inspect-view">
          <pre className="inspect-mono-block">{data.text}</pre>
        </div>
      );
    default:
      return (
        <div className="preview-center column">
          <div className="preview-note">{STR.files.inspect.nothingToInspect}</div>
          <div className="preview-sub">
            {meta.name} · {runtime.formatSize(meta.size)} · {meta.mime}
          </div>
          <button className="btn" onClick={() => void runtime.reveal(meta.path)}>
            {STR.files.tree.revealInFinder}
          </button>
        </div>
      );
  }
}

const DAY = 86_400;

function ExecInspect({
  data,
}: {
  data: Extract<Inspection, { type: "executable" }>;
}) {
  const formatName =
    data.format === "mach-o"
      ? STR.files.inspect.exec.formatMachO
      : data.format === "elf"
        ? STR.files.inspect.exec.formatElf
        : data.format === "pe"
          ? STR.files.inspect.exec.formatPe
          : STR.files.inspect.exec.formatScript;
  return (
    <div className="inspect-view">
      <div className="inspect-cert-card">
        <div className="inspect-cert-head">
          <span className="inspect-cert-cn">{formatName}</span>
          {data.archs.length > 1 && (
            <span className="inspect-pill neutral">
              {STR.files.inspect.exec.universal}
            </span>
          )}
          <span
            className={`inspect-pill ${data.executableBit ? "valid" : "neutral"}`}
            title={
              data.executableBit
                ? STR.files.inspect.exec.execBitHint
                : STR.files.inspect.exec.execBitOffHint
            }
          >
            {data.executableBit
              ? STR.files.inspect.exec.execBitOn
              : STR.files.inspect.exec.execBitOff}
          </span>
        </div>
        <dl className="inspect-cert-fields">
          {data.archs.length > 0 && (
            <>
              <dt>{STR.files.inspect.exec.fieldArchs}</dt>
              <dd>
                <ul className="inspect-cert-sans">
                  {data.archs.map((a, i) => (
                    <li key={`${a.arch}-${i}`}>
                      {STR.files.inspect.exec.archRow({
                        arch: a.arch,
                        bits: a.bits,
                        fileType: a.fileType,
                      })}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {data.interpreter !== null && (
            <Field
              label={STR.files.inspect.exec.fieldInterpreter}
              value={data.interpreter}
              mono
            />
          )}
          {data.hasCodeSignature !== null && (
            <Field
              label={STR.files.inspect.exec.fieldSignature}
              value={
                data.hasCodeSignature
                  ? STR.files.inspect.exec.signedYes
                  : STR.files.inspect.exec.signedNo
              }
            />
          )}
          {data.hasEntryPoint === true && (
            <Field
              label={STR.files.inspect.exec.fieldEntry}
              value={STR.files.inspect.exec.entryNote}
            />
          )}
          {data.dylibCount !== null && (
            <>
              <dt>{STR.files.inspect.exec.fieldDylibs}</dt>
              <dd>
                {STR.files.inspect.exec.dylibCountLabel({ n: data.dylibCount })}
                {data.dylibs && data.dylibs.length > 0 && (
                  <ul className="inspect-cert-sans">
                    {data.dylibs.map((d, i) => (
                      <li key={`${d}-${i}`} className="mono">
                        {d}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

function ArchiveInspect({
  meta,
  data,
  runtime,
}: {
  meta: InspectViewMeta;
  data: Extract<Inspection, { type: "archive" }>;
  runtime: InspectViewRuntime;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failure, setFailure] = useState<ErrorDescription | null>(null);

  const extractInto = async (destDir: string) => {
    setBusy(true);
    setOutcome(null);
    setFailure(null);
    try {
      const r = await runtime.extract(meta.path, destDir);
      setOutcome(
        STR.files.inspect.extractDone({ n: r.files.length, dir: r.dir })
      );
      // The tree refreshes itself through the directory watcher; nothing
      // here owns one to bump.
    } catch (e) {
      setFailure(describeError(e, STR.errors.actions.extractArchive));
    } finally {
      setBusy(false);
    }
  };

  const extractTo = async () => {
    const picked = await runtime.chooseDirectory(
      STR.files.inspect.extractPickHint
    );
    if (picked === null) return;
    await extractInto(picked);
  };

  const parent =
    meta.path.slice(0, meta.path.lastIndexOf("/")) || "/";

  return (
    <div className="inspect-view">
      <div className="inspect-archive-header">
        {data.truncated
          ? STR.files.inspect.archiveTruncated({
              total: data.total,
              shown: data.entries.length,
            })
          : STR.files.inspect.archiveCount({ total: data.total })}
      </div>
      <div className="inspect-extract-row">
        <button
          className="btn"
          disabled={busy}
          onClick={() => void extractInto(parent)}
        >
          {STR.files.inspect.extractHere}
        </button>
        <button className="btn" disabled={busy} onClick={() => void extractTo()}>
          {STR.files.inspect.extractTo}
        </button>
        {busy && <span className="inspect-extract-note">{STR.files.inspect.extracting}</span>}
        {outcome !== null && (
          <span className="inspect-extract-note ok">{outcome}</span>
        )}
        {failure !== null && (
          // The title says what failed; the detail says why — for a refused
          // extraction (a slip, a size cap) the why is the whole answer.
          <span className="inspect-extract-note err">
            {failure.detail
              ? `${failure.title} ${failure.detail}`
              : failure.title}
          </span>
        )}
      </div>
      <table className="inspect-archive-table">
        <thead>
          <tr>
            <th>{STR.files.inspect.colPath}</th>
            <th className="num">{STR.files.inspect.colSize}</th>
          </tr>
        </thead>
        <tbody>
          {data.entries.map((e, i) => (
            <tr key={`${e.path}-${i}`}>
              <td className={e.dir ? "dir" : undefined}>
                {e.path}
                {e.dir && !e.path.endsWith("/") ? "/" : ""}
              </td>
              <td className="num">
                {e.dir ? "—" : runtime.formatSize(e.size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ValidityPill({ notAfter }: { notAfter: number }) {
  const now = Date.now() / 1000;
  if (notAfter <= now) {
    const days = Math.floor((now - notAfter) / DAY);
    return (
      <span className="inspect-pill expired">
        {days === 0
          ? STR.files.inspect.expiredToday
          : STR.files.inspect.expiredAgo({ days })}
      </span>
    );
  }
  const left = (notAfter - now) / DAY;
  if (left < 30) {
    const days = Math.max(1, Math.ceil(left));
    return (
      <span className="inspect-pill expiring">
        {STR.files.inspect.expiresIn({ days })}
      </span>
    );
  }
  return (
    <span className="inspect-pill valid">
      {STR.files.inspect.validUntil({ date: formatDate(notAfter) })}
    </span>
  );
}

/** One dt/dd row inside the card's field grid. */
function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </>
  );
}

function CertCard({ cert }: { cert: CertInfo }) {
  const isCsr = cert.kind === "csr";
  return (
    <div className="inspect-cert-card">
      <div className="inspect-cert-head">
        <span className="inspect-cert-cn">{cert.subjectCn || cert.subject}</span>
        {isCsr ? (
          <span className="inspect-pill neutral">{STR.files.inspect.csrPill}</span>
        ) : (
          <ValidityPill notAfter={cert.notAfter} />
        )}
        {cert.isCa && (
          <span className="inspect-pill neutral">{STR.files.inspect.caPill}</span>
        )}
      </div>
      {isCsr && (
        <div className="inspect-cert-note">{STR.files.inspect.csrNote}</div>
      )}
      <dl className="inspect-cert-fields">
        <Field label={STR.files.inspect.fieldSubject} value={cert.subject} />
        {!isCsr && <Field label={STR.files.inspect.fieldIssuer} value={cert.issuer} />}
        {cert.sans.length > 0 && (
          <>
            <dt>{STR.files.inspect.fieldSans}</dt>
            <dd>
              <ul className="inspect-cert-sans">
                {cert.sans.map((san, i) => (
                  <li key={`${san}-${i}`}>{san}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {!isCsr && (
          <Field
            label={STR.files.inspect.fieldValidity}
            value={`${formatDate(cert.notBefore)} — ${formatDate(cert.notAfter)}`}
          />
        )}
        {!isCsr && <Field label={STR.files.inspect.fieldSerial} value={cert.serial} mono />}
        <Field label={STR.files.inspect.fieldSignature} value={cert.sigAlg} />
        <Field label={STR.files.inspect.fieldKey} value={cert.keyAlg} />
        <Field label={STR.files.inspect.fieldSha256} value={cert.sha256} mono />
      </dl>
    </div>
  );
}
