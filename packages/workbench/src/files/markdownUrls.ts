import { trimTrailingSlashes } from "./pathStrings";

/**
 * URL rules for the markdown preview, kept as pure string logic so they are
 * unit-testable without a DOM or the fs backend. The preview may load local
 * images through the app's file protocol, and nothing else: which references
 * qualify — and what local path they mean — is decided here.
 */

/**
 * True when the reference already names a scheme (`https:`, `data:`, …) or a
 * network host (`//cdn…`). Those are left alone — rewriting them to local
 * files would turn a remote reference into a filesystem probe.
 */
export function hasExplicitOrigin(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//");
}

/**
 * Resolve a relative reference against the directory of the previewed file
 * into an absolute filesystem path, or null when nothing local is named
 * (empty string, or a pure `#fragment`).
 *
 * Query and fragment are dropped — they mean nothing to the file protocol
 * and would otherwise be percent-encoded into the filename. Percent escapes
 * are decoded (`my%20img.png` names a file with a space); `.`/`..` segments
 * collapse, with `..` clamped at the filesystem root.
 */
export function resolveLocalPath(dir: string, ref: string): string | null {
  const query = ref.indexOf("?");
  const fragment = ref.indexOf("#");
  const suffix =
    query < 0 ? fragment : fragment < 0 ? query : Math.min(query, fragment);
  let path = suffix < 0 ? ref : ref.slice(0, suffix);
  if (!path) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Stray `%` that is not an escape sequence — treat the text literally.
  }
  const joined = path.startsWith("/")
    ? path
    : `${trimTrailingSlashes(dir)}/${path}`;
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
