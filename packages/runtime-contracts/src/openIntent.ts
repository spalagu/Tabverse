import {
  CONTENT_REGISTRY,
  type ContentHandlerId,
  type ContentRegistry,
  type ContentTypeDefinition,
} from "./contentRegistry";

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

export type OpenIntentRoute =
  | {
      readonly kind: "content";
      readonly path: string;
      readonly contentType?: ContentTypeDefinition;
      readonly handler: ContentHandlerId;
    }
  | { readonly kind: "browser"; readonly url: string }
  | { readonly kind: "terminal"; readonly url: string; readonly scheme: "ssh" | "telnet" }
  | { readonly kind: "external"; readonly url: string };

/** Product-level routing shared by every ingress adapter. Files unknown to the
 * catalog still have a useful read-only hex view instead of becoming a dead end. */
export class OpenIntentRouter {
  constructor(private readonly content: ContentRegistry = CONTENT_REGISTRY) {}

  route(intent: OpenIntent): OpenIntentRoute {
    if (intent.kind === "path") {
      const contentType = this.content.resolvePath(intent.path);
      return {
        kind: "content",
        path: intent.path,
        contentType,
        handler: contentType?.handler ?? "binary",
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(intent.url);
    } catch {
      throw new Error(`OpenIntent URL is invalid: ${intent.url}`);
    }
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (scheme === "http" || scheme === "https") {
      return { kind: "browser", url: intent.url };
    }
    if (scheme === "ssh" || scheme === "telnet") {
      return { kind: "terminal", url: intent.url, scheme };
    }
    if (scheme === "file") {
      return this.route(pathOpenIntent(pathFromFileUrl(parsed)));
    }
    return { kind: "external", url: intent.url };
  }
}

export const OPEN_INTENT_ROUTER = new OpenIntentRouter();

function pathFromFileUrl(url: URL): string {
  const decoded = decodeURIComponent(url.pathname);
  if (url.hostname !== "") return `//${url.hostname}${decoded}`;
  return /^\/[a-z]:\//i.test(decoded) ? decoded.slice(1) : decoded;
}
