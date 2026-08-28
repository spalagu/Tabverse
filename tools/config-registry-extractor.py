#!/usr/bin/env python3
"""Export the Rust settings registry for the browser development runtime.

The desktop runtime obtains defaults and schema directly from
src-tauri/src/config.rs. Browser-only development and unit tests cannot invoke
Tauri, so this extractor parses that same registry and emits the equivalent
JSON payload. It performs structural cross-checks while extracting but does
not scan the repository or enforce publication policy.
"""

import json
import pathlib
import re
import sys
from bisect import bisect_right

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "src-tauri" / "src" / "config.rs"
THEME_TOKENS = ROOT / "packages" / "workbench" / "src" / "theme" / "tokens.json"
# The registry's own name for that domain's type, and for the one value in it
# that is not a theme. Named here like `SETTINGS` and `token_enum!` are: this
# gate is a parser of one particular file, and a shape it cannot find is an
# extraction failure (exit 2), never a silent skip.
THEME_PREF_TYPE = "ThemePref"
THEME_PREF_SYSTEM = (THEME_PREF_TYPE, "System")

TS_ROOTS = ["src/**/*.ts", "src/**/*.tsx"]
RS_ROOTS = ["src-tauri/src/**/*.rs", "crates/**/*.rs"]

# Names a setting goes by outside the registry, where no rule derives them
# from the key. The derived name is always the key's last component compared
# with `_` stripped and case folded, which already covers sidebar_width,
# sidebar_pinned, search_engine and custom_search_template.
NAME_ALIASES = {
    "appearance.theme": ["themePreference"],
    "browser.archive_after": ["archiveThreshold"],
}

# Two occurrences of a choice's tokens only read as alternatives of one
# another while they stay this close. Every real alternation in this tree —
# a union type, a `matches!` arm list, a `<select>`'s options, an array of
# choices — puts consecutive members on the same line or the next.
MAX_ALTERNATION_GAP = 3

# --------------------------------------------------------------- tokenizing

TS_RE = re.compile(
    r"""
    (?P<block>/\*.*?\*/)
  | (?P<line>//[^\n]*)
  | (?P<dq>"(?:\\.|[^"\\\n])*")
  | (?P<sq>'(?:\\.|[^'\\\n])*')
  | (?P<tpl>`(?:\\.|[^`\\])*`)
  | (?P<num>\d+(?:\.\d+)?)
  | (?P<id>[A-Za-z_$][A-Za-z0-9_$]*)
  | (?P<op>\S)
""",
    re.X | re.S,
)

RS_RE = re.compile(
    r"""
    (?P<block>/\*.*?\*/)
  | (?P<line>//[^\n]*)
  | (?P<raw>r(?P<hashes>\#*)"(?:.|\n)*?"(?P=hashes))
  | (?P<dq>"(?:\\.|[^"\\])*")
  | (?P<chr>'(?:\\.|[^'\\])')
  | (?P<life>'[A-Za-z_][A-Za-z0-9_]*)
  | (?P<num>\d+(?:_\d+)*)
  | (?P<id>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op>\S)
""",
    re.X | re.S,
)

UNESCAPE = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'", "`": "`"}


class Tok:
    __slots__ = ("kind", "val", "line", "pos", "end", "depth", "is_key")

    def __init__(self, kind, val, line, pos, end):
        self.kind = kind  # 'str' | 'num' | 'bool' | 'id' | 'op'
        self.val = val
        self.line = line
        self.pos = pos
        self.end = end
        self.depth = 0
        self.is_key = False

    def __repr__(self):  # debugging aid only
        return f"Tok({self.kind},{self.val!r},L{self.line})"


def die(msg):
    print(f"config-registry-extractor: {msg}", file=sys.stderr)
    sys.exit(2)


def rel(path):
    # `--registry` can point outside the tree (a test's mutated copy in a
    # temp dir), and a path this cannot shorten is still a path worth naming.
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def read_text(path):
    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        die(f"cannot read {rel(path)}: {e}")
    raise AssertionError  # unreachable


def unescape(body):
    out = []
    i = 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            out.append(UNESCAPE.get(body[i + 1], body[i + 1]))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def tokenize(text, lang):
    """Token stream with absolute offsets, so adjacency (`>=` vs `> =`) can
    still be asked after lexing. Comments never reach it, which is why the
    `"system" | "light" | "dark"` in a doc comment above `fn
    theme_preference` is not a finding."""
    starts = [0] + [m.end() for m in re.finditer(r"\n", text)]
    regex = TS_RE if lang == "ts" else RS_RE
    out = []
    for m in regex.finditer(text):
        kind = m.lastgroup
        # A named group inside an alternative (RS_RE's `hashes`) can win
        # lastgroup; recover the real alternative by asking each in turn.
        if kind == "hashes":
            kind = "raw"
        if kind in ("block", "line", "chr", "life"):
            continue
        raw = m.group(0)
        line = bisect_right(starts, m.start())
        if kind in ("dq", "sq"):
            out.append(Tok("str", unescape(raw[1:-1]), line, m.start(), m.end()))
        elif kind == "tpl":
            # A template with a substitution is not one literal, and its
            # `${…}` code is not re-lexed: declared blind spot, no default in
            # this tree is written as a template.
            if "${" not in raw:
                out.append(Tok("str", unescape(raw[1:-1]), line, m.start(), m.end()))
        elif kind == "raw":
            body = raw[raw.index('"') + 1 : raw.rindex('"')]
            out.append(Tok("str", body, line, m.start(), m.end()))
        elif kind == "num":
            out.append(Tok("num", raw.replace("_", ""), line, m.start(), m.end()))
        elif kind == "id":
            k = "bool" if raw in ("true", "false") else "id"
            out.append(Tok(k, raw, line, m.start(), m.end()))
        else:
            out.append(Tok("op", raw, line, m.start(), m.end()))
    return out


def drop_cfg_test(toks):
    """Remove every `#[cfg(test)] mod … { … }` block. Done on tokens because
    a text-level brace scan would count braces inside string literals."""
    out = []
    i = 0
    n = len(toks)
    while i < n:
        t = toks[i]
        if (
            t.kind == "op"
            and t.val == "#"
            and i + 6 < n
            and toks[i + 1].val == "["
            and toks[i + 2].val == "cfg"
            and toks[i + 3].val == "("
            and toks[i + 4].val == "test"
            and toks[i + 5].val == ")"
            and toks[i + 6].val == "]"
        ):
            j = i + 7
            while j < n and not (toks[j].kind == "op" and toks[j].val == "{"):
                j += 1
            if j >= n:
                break
            depth = 0
            while j < n:
                if toks[j].kind == "op" and toks[j].val in "([{":
                    depth += 1
                elif toks[j].kind == "op" and toks[j].val in ")]}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            i = j
            continue
        out.append(t)
        i += 1
    return out


def annotate(toks):
    """Bracket depth on every token, and key position on string literals."""
    depth = 0
    for t in toks:
        if t.kind == "op" and t.val in "([{":
            t.depth = depth
            depth += 1
        elif t.kind == "op" and t.val in ")]}":
            depth -= 1
            t.depth = depth
        else:
            t.depth = depth
    for i, t in enumerate(toks):
        if t.kind != "str":
            continue
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        prev = toks[i - 1] if i > 0 else None
        opens_entry = prev is None or (prev.kind == "op" and prev.val in "{,;[")
        t.is_key = bool(
            nxt is not None and nxt.kind == "op" and nxt.val == ":" and opens_entry
        )
    return toks


def norm(name):
    return name.replace("_", "").replace("$", "").lower()


def declared_name(header):
    """The name a block is declared under, from the tokens before its `{`.

    Only a real declaration counts — `fn NAME(…)`, `function NAME(…)`,
    `NAME: (…) =>`, `NAME = (…) =>`. `} else if (…) {` and `useEffect(() =>
    {` declare nothing and must yield nothing: an earlier draft took every
    identifier in the preceding text as the block's name, and a giant store
    object then handed `sidebarPinned` to two thousand lines that had no
    business with it.
    """
    toks = [t for _i, t in header]
    for i, t in enumerate(toks[:-1]):
        if t.kind == "id" and t.val in ("fn", "function") and toks[i + 1].kind == "id":
            return norm(toks[i + 1].val)
    i = len(toks) - 1
    marked = False
    if i >= 1 and toks[i].val == ">" and toks[i - 1].val == "=" and toks[i - 1].end == toks[i].pos:
        i -= 2
        marked = True
    if i >= 0 and toks[i].kind == "op" and toks[i].val == ")":
        depth = 0
        while i >= 0:
            if toks[i].kind == "op" and toks[i].val in ")]}":
                depth += 1
            elif toks[i].kind == "op" and toks[i].val in "([{":
                depth -= 1
                if depth == 0:
                    i -= 1
                    break
            i -= 1
    if i >= 0 and toks[i].kind == "op" and toks[i].val in ":=":
        i -= 1
        marked = True
    if not marked or i < 0 or toks[i].kind != "id":
        return None
    return norm(toks[i].val)


def segments_of(toks):
    """(first_index, last_index, scope_names, members) per statement segment.

    A segment runs between `{`, `}` and `;`. Braces delimit unconditionally,
    including the ones that open inside a call — `create(…)((set, get) => {`
    is the shape of nearly every block in this tree, and keying the split to
    an outer bracket depth (an earlier draft did) collapsed the whole store
    into one 1800-line segment. Commas do not delimit, so an object
    literal's sibling properties share a segment while a nested object
    starts its own.

    `scope_names` carries the declared name of every enclosing block — the
    channel by which `fn theme_preference(…) {` governs a `return "system"`
    four lines down.
    """
    out = []
    cur = []
    scope_stack = []

    def scope_names():
        s = set()
        for frame in scope_stack:
            s |= frame
        return s

    def flush():
        if cur:
            out.append((cur[0][0], cur[-1][0], scope_names(), list(cur)))
        cur.clear()

    for idx, t in enumerate(toks):
        if t.kind == "op" and t.val == "{":
            name = declared_name(cur)
            flush()
            scope_stack.append({name} if name else set())
        elif t.kind == "op" and t.val == "}":
            flush()
            if scope_stack:
                scope_stack.pop()
        elif t.kind == "op" and t.val == ";":
            flush()
        else:
            cur.append((idx, t))
    flush()
    return out


# --------------------------------------------------------- registry parsing


def parse_token_enums(src):
    """token_enum! { Name { Variant => "token", … } } -> {Name: [tokens]}."""
    enums = {}
    for m in re.finditer(r"token_enum!\s*\{(.*?)\n\}", src, re.S):
        body = m.group(1)
        stripped = re.sub(r"///[^\n]*", "", body)
        name_m = re.search(r"([A-Za-z_]\w*)\s*\{", stripped)
        if not name_m:
            die("a token_enum! invocation has no enum name")
        tokens = re.findall(r"([A-Za-z_]\w*)\s*=>\s*\"([^\"]*)\"", stripped)
        if not tokens:
            die(f"token_enum! {name_m.group(1)} yielded no tokens")
        enums[name_m.group(1)] = {v: t for v, t in tokens}
    return enums


def parse_consts(src):
    return {
        m.group(1): int(m.group(2))
        for m in re.finditer(r"pub const ([A-Z][A-Z0-9_]*)\s*:\s*u\d+\s*=\s*(\d+)\s*;", src)
    }


def parse_theme_domain(src):
    """`appearance.theme`'s domain: the system token plus every theme id.

    The one domain that is read rather than declared. Both halves come from
    the same two places the program itself reads them from — `SYSTEM_THEME`
    in the registry, and the `themes` object in packages/workbench/src/theme/tokens.json, which
    build.rs compiles into the table `ThemePref` looks names up in — so this
    gate still holds no vocabulary of its own.

    Sorted, because that is the order the generated Rust table comes out in
    (serde_json holds an object as a sorted map); nothing here depends on the
    order, but a domain that reads differently from the one the program has
    would send the next person hunting for a difference that is not there.
    """
    m = re.search(r'pub const SYSTEM_THEME\s*:\s*&str\s*=\s*"([^"]+)"\s*;', src)
    if not m:
        die("no `pub const SYSTEM_THEME` in the registry — teach the gate this shape")
    if not THEME_TOKENS.exists():
        die(f"missing {rel(THEME_TOKENS)}, which declares the themes")
    try:
        themes = json.loads(read_text(THEME_TOKENS)).get("themes")
    except json.JSONDecodeError as e:
        die(f"{rel(THEME_TOKENS)} is not valid JSON: {e}")
    if not isinstance(themes, dict) or not themes:
        die(f"{rel(THEME_TOKENS)} declares no themes")
    return [m.group(1)] + sorted(themes)


def parse_defaults(src, enums, themes):
    """impl Default for Config -> {"section.field": ("str"|"num"|"bool", v)}."""
    m = re.search(r"impl Default for Config\s*\{(.*?)\n\}", src, re.S)
    if not m:
        die("no `impl Default for Config` block in the registry")
    body = m.group(1)
    inner = re.search(r"fn default\(\)\s*->\s*Self\s*\{(.*)\}", body, re.S)
    if not inner:
        die("`impl Default for Config` has no `fn default`")
    out = {}
    for sec in re.finditer(r"([a-z_]\w*)\s*:\s*[A-Z]\w*\s*\{([^{}]*)\}", inner.group(1)):
        section = sec.group(1)
        for field in re.finditer(r"([a-z_]\w*)\s*:\s*([^,\n]+),", sec.group(2)):
            key = f"{section}.{field.group(1)}"
            value = field.group(2).strip()
            if re.fullmatch(r"Vec::new\(\)", value):
                # An entity list (terminal.profiles, terminal.templates):
                # a list of named things the user adds to and deletes from,
                # which SETTINGS has no row for and never will (profiles.rs
                # and templates.rs each say why at length). Empty is a
                # complete fact, not a value this table extracts. The block
                # used to dodge this case by leaving its LAST field without
                # a trailing comma; a second such list arrived and the trick
                # stopped scaling, so the shape is recognized instead.
                continue
            out[key] = parse_value(key, value, enums, themes)
    return out


def parse_value(key, text, enums, themes):
    m = re.fullmatch(r"([A-Z]\w*)::([A-Z]\w*)", text)
    if m:
        enum, variant = m.group(1), m.group(2)
        if enum not in enums or variant not in enums[enum]:
            if (enum, variant) == THEME_PREF_SYSTEM:
                return ("str", themes[0])
            die(f"{key}: default {text} names no token_enum! variant")
        return ("str", enums[enum][variant])
    if re.fullmatch(r"String::new\(\)", text):
        return ("str", "")
    m = re.fullmatch(r'"([^"]*)"(?:\.to_string\(\))?', text)
    if m:
        return ("str", m.group(1))
    if re.fullmatch(r"\d+", text):
        return ("num", text)
    if text in ("true", "false"):
        return ("bool", text)
    die(f"{key}: cannot read the default expression `{text}` — teach the gate this shape")


def parse_settings(src, enums, consts, themes):
    m = re.search(r"pub static SETTINGS\s*:\s*&\[Setting\]\s*=\s*&\[(.*?)\n\];", src, re.S)
    if not m:
        die("no `pub static SETTINGS` table in the registry")
    rows = []
    for row in re.finditer(r"Setting\s*\{(.*?)\n    \}", m.group(1), re.S):
        body = row.group(1)
        key_m = re.search(r'key:\s*"([^"]+)"', body)
        if not key_m:
            die("a SETTINGS row has no key")
        key = key_m.group(1)
        # The two descriptive fields carry no value knowledge, so the gate
        # itself never consults them; they are read here because the export
        # sends whole registry rows and a row without its page section and
        # string key is not the row `config_schema` answers with.
        section_m = re.search(r'section:\s*"([^"]+)"', body)
        str_key_m = re.search(r'str_key:\s*"([^"]+)"', body)
        if not section_m or not str_key_m:
            die(f"{key}: SETTINGS row is missing `section` or `str_key`")
        descr = (section_m.group(1), str_key_m.group(1))
        # `Options(X::tokens)` — one spelling for every domain, whether X
        # spells its members out (a token_enum) or reads them (the themes).
        choice = re.search(
            r"Kind::Choice\s*\{\s*options:\s*Options\(\s*([A-Za-z_]\w*)::tokens\s*\)", body
        )
        number = re.search(
            r"Kind::Number\s*\{\s*min:\s*([A-Za-z_0-9]+),\s*max:\s*([A-Za-z_0-9]+)", body
        )
        if choice:
            enum = choice.group(1)
            if enum in enums:
                options = list(enums[enum].values())
            elif enum == THEME_PREF_TYPE:
                # The domain read out of tokens.json. Checked rather than
                # assumed: if that type ever stopped deriving its members
                # from the generated theme table, this gate would go on
                # comparing every file in the tree against a list the program
                # no longer holds — and would report a clean tree while the
                # copy it exists to forbid sat in the registry.
                #
                # Scoped to the impl block, and that is not a nicety: a
                # whole-file search for the same text passes on this file's
                # own tests, which mention that table too. (Measured — the
                # first cut of this check did exactly that and survived the
                # mutation it was written for.)
                impl = re.search(
                    rf"\nimpl {THEME_PREF_TYPE}\s*\{{\n(.*?)\n\}}\n", src, re.S
                )
                if not impl:
                    die(f"no `impl {THEME_PREF_TYPE}` block — teach the gate this shape")
                if "theme_gen::THEMES" not in impl.group(1):
                    die(
                        f"{key}: {enum} no longer reads crate::theme_gen::THEMES — "
                        "teach the gate where its domain comes from now"
                    )
                options = list(themes)
            else:
                die(f"{key}: Kind::Choice names unknown enum {enum}")
            rows.append((key, "choice", options, None, None, *descr))
        elif number:
            bounds = []
            for raw in (number.group(1), number.group(2)):
                if raw.isdigit():
                    bounds.append(int(raw))
                elif raw in consts:
                    bounds.append(consts[raw])
                else:
                    die(f"{key}: Kind::Number bound `{raw}` resolves to nothing")
            rows.append((key, "number", None, tuple(bounds), None, *descr))
        elif re.search(r"kind:\s*Kind::Toggle", body):
            rows.append((key, "toggle", None, None, None, *descr))
        elif re.search(r"kind:\s*Kind::Text", body):
            rows.append((key, "text", None, None, parse_text_rule(key, body), *descr))
        else:
            die(f"{key}: unreadable `kind` — teach the gate this shape")
    return rows


def parse_text_rule(key, body):
    """`Kind::Text(TextRule { … })` -> the rule as JSON, for the export.

    Read and carried, never re-implemented: whether a *value* satisfies this
    rule is judged in exactly one place (`check_text` in the registry, and
    the same rule read off `config_schema` in the frontend), and a copy of
    that judgement here would be the third home of the very rule the type
    exists to give a first one.
    """
    m = re.search(r"Kind::Text\s*\(\s*TextRule\s*\{(.*?)\}\s*\)", body, re.S)
    if not m:
        die(f"{key}: unreadable `Kind::Text` — teach the gate this shape")
    inner = m.group(1)
    allow = re.search(r"allow_empty:\s*(true|false)", inner)
    contain = re.search(r'must_contain:\s*(?:None|Some\(\s*"([^"]*)"\s*\))', inner)
    schemes = re.search(r"schemes:\s*(?:None|Some\(\s*&\[([^\]]*)\]\s*\))", inner)
    if not (allow and contain and schemes):
        die(f"{key}: TextRule is missing allow_empty, must_contain or schemes")
    return {
        "allow_empty": allow.group(1) == "true",
        "must_contain": contain.group(1),
        "schemes": (
            None if schemes.group(1) is None else re.findall(r'"([^"]*)"', schemes.group(1))
        ),
    }


def parse_sections(src):
    """`pub static SECTIONS` -> the file's table names, in declared order.

    Only the export needs these: `Config::default()` serializes the three
    reserved sections as empty tables, and a demo payload missing them would
    not be the shape the desktop injects.
    """
    m = re.search(r"pub static SECTIONS\s*:\s*&\[&str\]\s*=\s*&\[(.*?)\];", src, re.S)
    if not m:
        die("no `pub static SECTIONS` table in the registry")
    names = re.findall(r'"([^"]+)"', m.group(1))
    if not names:
        die("`pub static SECTIONS` yielded no section names")
    return names


def load_registry(registry=None):
    registry = registry or REGISTRY
    if not registry.exists():
        die(f"missing registry {rel(registry)}")
    src = read_text(registry)
    enums = parse_token_enums(src)
    consts = parse_consts(src)
    themes = parse_theme_domain(src)
    defaults = parse_defaults(src, enums, themes)
    rows = parse_settings(src, enums, consts, themes)

    # Three parses of one file must agree. This is the check that makes a
    # broken extractor fail loudly instead of reporting a clean tree.
    if not rows:
        die("SETTINGS is empty — nothing to check")
    if not defaults:
        die("no defaults extracted from `impl Default for Config`")
    if set(defaults) != {k for k, *_ in rows}:
        die(
            "registry disagrees with itself: defaults "
            f"{sorted(defaults)} vs SETTINGS {sorted(k for k, *_ in rows)}"
        )

    sections = parse_sections(src)

    settings = []
    for key, kind, options, bounds, rule, section, str_key in rows:
        dkind, dval = defaults[key]
        if kind == "choice":
            if not options:
                die(f"{key}: choice domain is empty")
            if dval not in options:
                die(f"{key}: default {dval!r} is outside its own domain {options}")
        if kind == "number":
            if dkind != "num":
                die(f"{key}: Kind::Number with a {dkind} default")
            if not bounds[0] <= int(dval) <= bounds[1]:
                die(f"{key}: default {dval} is outside its own range {bounds}")
        if kind == "toggle" and dkind != "bool":
            die(f"{key}: Kind::Toggle with a {dkind} default")
        if kind == "text" and dkind != "str":
            die(f"{key}: Kind::Text with a {dkind} default")
        leaf = key.split(".")[-1]
        names = sorted({norm(leaf)} | {norm(a) for a in NAME_ALIASES.get(key, [])})
        settings.append(
            {
                "key": key,
                "kind": kind,
                "default": (dkind, dval),
                "options": options,
                "bounds": bounds,
                "rule": rule,
                "names": names,
                "alias_src": [leaf] + NAME_ALIASES.get(key, []),
                "section": section,
                "str_key": str_key,
            }
        )
    return settings, sections


# ------------------------------------------------------------------- export


def json_default(dkind, dval):
    """A default as JSON, from the ("kind", text) pair the parse produced."""
    if dkind == "num":
        return int(dval)
    if dkind == "bool":
        return dval == "true"
    return dval


def json_kind(setting):
    """`Kind` as serde writes it — externally tagged, lowercase variants."""
    kind = setting["kind"]
    if kind == "choice":
        return {"choice": {"options": list(setting["options"])}}
    if kind == "number":
        lo, hi = setting["bounds"]
        return {"number": {"min": lo, "max": hi}}
    if kind == "text":
        # The content rule rides along, because the settings page and the
        # demo backend judge a typed value by it — reading it off the schema
        # is what stops either of them keeping a rule of its own.
        return {"text": setting["rule"]}
    return kind


def emit_payload(settings, sections, registry):
    """The registry in the shape the two commands answer in.

    `values` is `Config::default()` as serde would serialize it, section by
    section — including the reserved sections, which serialize as empty
    tables and whose absence would make this a differently shaped object
    than the one the desktop injects. `schema` is `config_schema()`'s rows:
    the static description flattened together with the default.
    """
    values = {name: {} for name in sections}
    schema = []
    for s in settings:
        section, _, field = s["key"].partition(".")
        if section not in values:
            die(f"{s['key']}: section `{section}` is not one of SECTIONS {sections}")
        if not field:
            die(f"{s['key']}: not a `section.field` key")
        values[section][field] = json_default(*s["default"])
        schema.append(
            {
                "key": s["key"],
                "kind": json_kind(s),
                "section": s["section"],
                "str_key": s["str_key"],
                "default": json_default(*s["default"]),
            }
        )
    return {"registry": rel(registry), "values": values, "schema": schema}



USAGE = (
    "usage: config-registry-extractor.py "
    "--emit-json <path|-> [--registry <config.rs>]"
)


def parse_args(argv):
    out = {"emit": None, "registry": None}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("--emit-json", "--registry"):
            if i + 1 >= len(argv):
                die(f"{arg} needs a value ({USAGE})")
            out["emit" if arg == "--emit-json" else "registry"] = argv[i + 1]
            i += 2
            continue
        die(f"unknown argument {arg!r} ({USAGE})")
    if not out["emit"]:
        die(f"--emit-json is required ({USAGE})")
    return out


def emit(opts):
    registry = pathlib.Path(opts["registry"]).resolve() if opts["registry"] else None
    settings, sections = load_registry(registry)
    text = json.dumps(
        emit_payload(settings, sections, registry or REGISTRY), indent=2
    )
    if opts["emit"] == "-":
        print(text)
    else:
        out = pathlib.Path(opts["emit"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(emit(parse_args(sys.argv[1:])))
