/**
 * Portable V3 ingress for content/navigation requests.
 *
 * Platform adapters produce these intents from file associations, drag/drop,
 * dialogs, deep links and OS-open events. Product routing decides whether an
 * intent becomes a Content, Browser, Terminal or external-open action.
 */
export type OpenIntent =
  | {
      readonly kind: "path";
      readonly path: string;
    }
  | {
      readonly kind: "url";
      readonly url: string;
    };

export function pathOpenIntent(path: string): OpenIntent {
  if (path.length === 0) throw new Error("OpenIntent path must not be empty");
  return { kind: "path", path };
}

export function urlOpenIntent(url: string): OpenIntent {
  if (url.length === 0) throw new Error("OpenIntent URL must not be empty");
  return { kind: "url", url };
}
