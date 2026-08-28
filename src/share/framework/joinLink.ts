export const JOIN_PAGE_URL = "https://spalagu.github.io/Tabverse/join/";

/** The one-line invitation: the join page with the ticket in the fragment,
 * so the ticket never reaches the server the page is fetched from. */
export function joinLink(ticket: string): string {
  return `${JOIN_PAGE_URL}#${ticket}`;
}
