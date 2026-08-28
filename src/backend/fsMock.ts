import type {
  FileMeta,
  FsEntry,
  FsListing,
  GitStatus,
  GrepOptions,
  GrepResult,
  PreviewFile,
  PreviewLine,
  PreviewSite,
  ReplacePlan,
  ReplacePreview,
  ReplaceResult,
  SearchHit,
  WalkResult,
} from "./fs";

/**
 * In-memory filesystem for the browser demo, so the explorer UI can be built
 * and verified without the desktop app. Shapes mirror the Rust backend exactly
 * (including directory git aggregation), which is what makes it useful for
 * checking the UI rather than just filling space.
 */
interface MockFile {
  kind: "file";
  text?: string;
  headText?: string;
  git?: GitStatus;
  /** Data URI for non-text previews. */
  dataUrl?: string;
  mime?: string;
  fileKind?: FileMeta["kind"];
}
interface MockDir {
  kind: "dir";
  children: Record<string, MockNode>;
}
type MockNode = MockFile | MockDir;

const PNG_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAT0lEQVR42u3NsQ2AMAwF0R9AShoKKtaBLZiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLdiCLehc4E5xTr8AAJ4CBQGmwvJmAAAAAElFTkSuQmCC";

const TREE: MockDir = {
  kind: "dir",
  children: {
    src: {
      kind: "dir",
      children: {
        "main.ts": {
          kind: "file",
          git: "modified",
          text: 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n',
          headText: 'export function greet(name: string) {\n  return "hi " + name;\n}\n',
        },
        "util.ts": {
          kind: "file",
          text: "export const VERSION = 1;\n",
        },
        nested: {
          kind: "dir",
          children: {
            "deep.ts": {
              kind: "file",
              git: "untracked",
              text: "// brand new file\n",
            },
          },
        },
      },
    },
    docs: {
      kind: "dir",
      children: {
        "readme.md": {
          kind: "file",
          text: "# Demo\n\nThis tree lives in memory.\n",
        },
      },
    },
    "logo.png": {
      kind: "file",
      fileKind: "image",
      mime: "image/png",
      dataUrl: PNG_DOT,
    },
    "notes.txt": { kind: "file", text: "plain text\n" },
  },
};

const ROOT = "/demo";


/** One glob → one RegExp, with the crate's literal_separator rule: `*`
 *  stops at `/`, a `**` prefix crosses directories. */
function globRe(pattern: string): RegExp | null {
  try {
    const src = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/(?![^*])/g, "(?:[^/]+/)*")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    return new RegExp(`^${src}$`);
  } catch {
    return null;
  }
}

/** Byte-less stand-in for search.rs's Needle: plain/regex, case and word
 *  flags, byte offsets swapped for index offsets (the demo texts are
 *  ASCII, where the two coincide). */
function mockNeedle(
  query: string,
  o: GrepOptions
): (line: string) => [number, number][] {
  if (o.regex) {
    const re = new RegExp(
      o.wholeWord ? `\\b(?:${query})\\b` : query,
      o.caseSensitive ? "" : "i"
    );
    return (line) => {
      const out: [number, number][] = [];
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        out.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) re.lastIndex++;
        else re.lastIndex = m.index + m[0].length;
        if (out.length > 500) break;
      }
      return out;
    };
  }
  const needle = o.caseSensitive ? query : query.toLowerCase();
  return (line) => {
    if (!needle) return [];
    const hay = o.caseSensitive ? line : line.toLowerCase();
    const out: [number, number][] = [];
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const wordOk = (s: string, a: number, b: number) =>
        (a === 0 || !/[\w]/.test(s[a - 1])) &&
        (b >= s.length || !/[\w]/.test(s[b]));
      if (!o.wholeWord || wordOk(hay, at, end)) out.push([at, end]);
      from = Math.max(end, at + 1);
    }
    return out;
  };
}

/** Every file in the demo tree as [rel, node], the same enumeration grep
 *  and replace ride — one scope for both, mirroring files_under. */
function mockFiles(
  include: string | null,
  exclude: string | null
): { rel: string; node: MockFile }[] {
  const inc = include ? globRe(include) : null;
  const exc = exclude ? globRe(exclude) : null;
  const out: { rel: string; node: MockFile }[] = [];
  const visit = (node: MockDir, prefix: string) => {
    for (const [name, child] of Object.entries(node.children)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "dir") visit(child, rel);
      else if (
        (!inc || inc.test(rel)) && (!exc || !exc.test(rel))
      )
        out.push({ rel, node: child });
    }
  };
  visit(TREE, "");
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}


function resolve(path: string): MockNode | null {
  const rel = path.replace(/^\/demo\/?/, "");
  if (rel === "") return TREE;
  let node: MockNode = TREE;
  for (const seg of rel.split("/").filter(Boolean)) {
    if (node.kind !== "dir") return null;
    const next: MockNode | undefined = node.children[seg];
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Worst status among descendants, matching the Rust severity order. */
const SEVERITY: GitStatus[] = [
  "ignored",
  "untracked",
  "added",
  "modified",
  "renamed",
  "deleted",
  "conflicted",
];

function aggregate(node: MockNode): GitStatus | null {
  if (node.kind === "file") return node.git ?? null;
  let worst: GitStatus | null = null;
  for (const child of Object.values(node.children)) {
    const s = aggregate(child);
    if (s && (!worst || SEVERITY.indexOf(s) > SEVERITY.indexOf(worst))) worst = s;
  }
  return worst;
}

function entryFor(name: string, path: string, node: MockNode): FsEntry {
  const isDir = node.kind === "dir";
  const git = aggregate(node);
  return {
    name,
    path,
    isDir,
    isSymlink: false,
    size:
      node.kind === "file"
        ? (node.text?.length ?? node.dataUrl?.length ?? 0)
        : 0,
    modified: 1780000000,
    git,
    gitFromChildren: isDir && git !== null,
  };
}

export const fsMock = {
  async list(dir: string): Promise<FsListing> {
    const target = dir && dir !== "" ? dir : ROOT;
    const node = resolve(target);
    if (!node || node.kind !== "dir") throw new Error(`no such directory: ${target}`);
    const entries = Object.entries(node.children).map(([name, child]) =>
      entryFor(name, `${target.replace(/\/$/, "")}/${name}`, child)
    );
    entries.sort(
      (a, b) =>
        Number(b.isDir) - Number(a.isDir) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    return {
      dir: target,
      parent: target === ROOT ? null : target.split("/").slice(0, -1).join("/"),
      entries,
      repoRoot: ROOT,
      branch: "main",
    };
  },

  async read(path: string): Promise<FileMeta> {
    const node = resolve(path);
    if (!node || node.kind !== "file") throw new Error(`no such file: ${path}`);
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      size: node.text?.length ?? node.dataUrl?.length ?? 0,
      kind: node.fileKind ?? "text",
      mime: node.mime ?? "text/plain",
      text: node.text ?? null,
      truncated: false,
      readOnlyReason: null,
      modified: 0,
      headText: node.headText ?? null,
      git: node.git ?? null,
    };
  },

  async write(path: string, content: string): Promise<void> {
    const node = resolve(path);
    if (!node || node.kind !== "file") throw new Error(`no such file: ${path}`);
    // Saving in the demo behaves like the real thing: content lands, and the
    // file now differs from HEAD if it didn't already.
    if (node.headText === undefined) node.headText = node.text;
    node.text = content;
    node.git = node.headText === content ? undefined : "modified";
  },

  async reveal(): Promise<void> {},

  async walk(
    dir: string,
    includeHidden: boolean,
    name?: string
  ): Promise<WalkResult> {
    const out: string[] = [];
    const visit = (node: MockNode, prefix: string) => {
      if (node.kind === "file") {
        out.push(prefix);
        return;
      }
      for (const [name, child] of Object.entries(node.children)) {
        visit(child, prefix ? `${prefix}/${name}` : name);
      }
    };
    const node = resolve(dir || ROOT);
    if (node) visit(node, "");
    // includeHidden is accepted for shape parity; the demo tree plants no
    // dotfiles, so the toggle has nothing to reveal here.
    void includeHidden;
    const re = name ? globRe(name) : null;
    const paths = (re ? out.filter((p) => re.test(p)) : out)
      .sort()
      .slice(0, 5000);
    return { paths, truncated: false };
  },

  async grep(
    _root: string,
    query: string,
    options: GrepOptions,
    maxHits: number
  ): Promise<GrepResult> {
    const find = mockNeedle(query, options);
    const files = mockFiles(options.include, options.exclude);
    const hits: SearchHit[] = [];
    let filesMatched = 0;
    let truncated = false;
    if (query) {
      for (const { rel, node } of files) {
        const text = node.text;
        if (text === undefined) continue;
        let matchedHere = false;
        for (const [i, line] of text.split("\n").entries()) {
          for (const [start] of find(line)) {
            if (hits.length >= maxHits) {
              truncated = true;
              break;
            }
            matchedHere = true;
            hits.push({
              rel,
              path: `${ROOT}/${rel}`,
              line: i + 1,
              col: start + 1,
              text: line.slice(0, 400),
            });
          }
          if (truncated) break;
        }
        if (matchedHere) filesMatched++;
        if (truncated) break;
      }
    }
    return { hits, filesMatched, filesScanned: files.length, truncated };
  },

  async replace(
    _root: string,
    query: string,
    replacement: string,
    options: GrepOptions,
    only: string[] | null,
    plan?: ReplacePlan | null
  ): Promise<ReplaceResult> {
    const find = mockNeedle(query, options);
    let filesChanged = 0;
    let replacements = 0;
    const failed: ReplaceResult["failed"] = [];
    if (!query) return { filesChanged, replacements, failed };
    const wanted = only ? new Set(only) : null;
    const skip = new Map<string, Set<string>>();
    for (const s of plan?.skip ?? []) {
      const k = skip.get(s.rel) ?? new Set<string>();
      k.add(`${s.line}:${s.col}`);
      skip.set(s.rel, k);
    }
    // The demo tree's mtimes never move, so the stamp check cannot fail
    // here; the guard's teeth live on the desktop side.
    for (const { rel, node } of mockFiles(options.include, options.exclude)) {
      if (wanted && !wanted.has(rel)) continue;
      const text = node.text;
      if (text === undefined) continue;
      const skipped = skip.get(rel);
      const rebuilt = text
        .split("\n")
        .map((line, i) => {
          const spans = find(line);
          if (spans.length === 0) return line;
          let at = 0;
          let outLine = "";
          for (const [s, e] of spans) {
            if (skipped?.has(`${i + 1}:${s + 1}`)) {
              outLine += line.slice(at, e);
              at = e;
              continue;
            }
            outLine += line.slice(at, s) + replacement;
            at = e;
            replacements++;
          }
          return outLine + line.slice(at);
        })
        .join("\n");
      if (rebuilt !== text) {
        if (node.headText === undefined) node.headText = text;
        node.text = rebuilt;
        node.git = node.headText === rebuilt ? undefined : "modified";
        filesChanged++;
      }
    }
    return { filesChanged, replacements, failed };
  },

  async replacePreview(
    _root: string,
    query: string,
    replacement: string,
    options: GrepOptions,
    only: string[] | null
  ): Promise<ReplacePreview> {
    const find = mockNeedle(query, options);
    const files: PreviewFile[] = [];
    let replacements = 0;
    const wanted = only ? new Set(only) : null;
    for (const { rel, node } of mockFiles(options.include, options.exclude)) {
      if (wanted && !wanted.has(rel)) continue;
      const text = node.text;
      if (text === undefined) continue;
      const lines = text.split("\n");
      const sites: PreviewSite[] = [];
      for (const [i, line] of lines.entries()) {
        for (const [start, end] of find(line)) {
          const context: PreviewLine[] = [];
          if (i > 0) context.push({ line: i, text: lines[i - 1].slice(0, 400) });
          context.push({ line: i + 1, text: line.slice(0, 400) });
          if (i + 1 < lines.length)
            context.push({ line: i + 2, text: lines[i + 1].slice(0, 400) });
          sites.push({
            line: i + 1,
            col: start + 1,
            beforeLen: end - start,
            afterLen: replacement.length,
            context,
          });
        }
      }
      if (sites.length === 0) continue;
      replacements += sites.length;
      files.push({
        rel,
        path: `${ROOT}/${rel}`,
        // The demo FileMeta reports 0; the preview stamps the same.
        modified: 0,
        before: text,
        sites,
      });
    }
    return { files, replacements, filesMatched: files.length };
  },

  async create(path: string, dir: boolean): Promise<void> {
    const parts = path.replace(/^\/demo\/?/, "").split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error("bad path");
    let node = TREE as MockDir;
    for (const seg of parts) {
      const next = node.children[seg];
      if (!next || next.kind !== "dir") throw new Error("no such dir");
      node = next;
    }
    if (node.children[name]) throw new Error(`${name} already exists`);
    node.children[name] = dir
      ? { kind: "dir", children: {} }
      : { kind: "file", text: "", git: "untracked" };
  },

  async rename(from: string, to: string): Promise<void> {
    const strip = (p: string) => p.replace(/^\/demo\/?/, "").split("/").filter(Boolean);
    const f = strip(from), t = strip(to);
    const fname = f.pop()!, tname = t.pop()!;
    let src = TREE as MockDir;
    for (const seg of f) src = src.children[seg] as MockDir;
    let dst = TREE as MockDir;
    for (const seg of t) dst = dst.children[seg] as MockDir;
    if (!src.children[fname]) throw new Error("missing source");
    if (dst.children[tname]) throw new Error("target exists");
    dst.children[tname] = src.children[fname];
    delete src.children[fname];
  },

  async trash(path: string): Promise<void> {
    const parts = path.replace(/^\/demo\/?/, "").split("/").filter(Boolean);
    const name = parts.pop()!;
    let node = TREE as MockDir;
    for (const seg of parts) node = node.children[seg] as MockDir;
    delete node.children[name];
  },

  async home(): Promise<string> {
    return ROOT;
  },

  async watchTab(): Promise<void> {},
  async unwatchTab(): Promise<void> {},

  url(path: string): string {
    const node = resolve(path);
    if (node && node.kind === "file" && node.dataUrl) return node.dataUrl;
    return `data:text/plain,${encodeURIComponent(path)}`;
  },
};
