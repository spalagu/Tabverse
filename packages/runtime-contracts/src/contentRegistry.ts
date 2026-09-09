import catalogSource from "../../../resources/content-types.json";

export type ContentHandlerId =
  | "archive"
  | "certificate"
  | "code"
  | "font"
  | "html"
  | "image"
  | "markdown"
  | "media"
  | "office"
  | "pdf"
  | "sqlite"
  | "structured-text"
  | "table"
  | "text";

export interface ContentTypeDefinition {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly handler: ContentHandlerId;
  readonly view: boolean;
  readonly edit: boolean;
}

interface ContentCatalogSource {
  readonly schemaVersion: number;
  readonly types: readonly ContentTypeDefinition[];
}

/** One immutable source of content routing metadata for Workbench and OS adapters. */
export class ContentRegistry {
  readonly types: readonly ContentTypeDefinition[];
  readonly #byExtension: ReadonlyMap<string, ContentTypeDefinition>;

  constructor(source: ContentCatalogSource) {
    if (source.schemaVersion !== 1) {
      throw new Error(`Unsupported content catalog schema: ${source.schemaVersion}`);
    }
    const ids = new Set<string>();
    const byExtension = new Map<string, ContentTypeDefinition>();
    for (const type of source.types) {
      if (ids.has(type.id)) throw new Error(`Duplicate content type: ${type.id}`);
      ids.add(type.id);
      for (const rawExtension of type.extensions) {
        const extension = normalizeExtension(rawExtension);
        const previous = byExtension.get(extension);
        if (previous !== undefined) {
          throw new Error(
            `Extension .${extension} belongs to both ${previous.id} and ${type.id}`,
          );
        }
        byExtension.set(extension, type);
      }
    }
    this.types = Object.freeze([...source.types]);
    this.#byExtension = byExtension;
  }

  resolvePath(path: string): ContentTypeDefinition | undefined {
    const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
    // Longest suffix wins if the catalog later adds compound extensions.
    const suffixes = name
      .split(".")
      .slice(1)
      .map((_, index, parts) => parts.slice(index).join("."));
    for (const suffix of suffixes) {
      const match = this.#byExtension.get(suffix);
      if (match !== undefined) return match;
    }
    // Extensionless technical names such as Dockerfile are catalog entries.
    return this.#byExtension.get(name);
  }

  resolveExtension(extension: string): ContentTypeDefinition | undefined {
    return this.#byExtension.get(normalizeExtension(extension));
  }
}

function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, "").toLowerCase();
}

export const CONTENT_REGISTRY = new ContentRegistry(
  catalogSource as ContentCatalogSource,
);
