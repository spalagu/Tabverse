/**
 * The ticket carried in the URL fragment, or "" when there is none.
 *
 * The fragment never reaches a server — which matters for a secret — and
 * "click the link, you're in" is the whole reason the page auto-connects
 * from it. Share links percent-encode the ticket; hand-pasted fragments may
 * not, and a stray `%` must not take the page down before it ever renders.
 */
export function ticketFromHash(hash: string): string {
  if (hash.length <= 1) return "";
  const raw = hash.slice(1);
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}
