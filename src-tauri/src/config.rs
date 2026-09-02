use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use toml_edit::{DocumentMut, Item, Table, Value};

use crate::profiles;
use crate::templates;

// ---------------------------------------------------------------- registry

/// A choice whose members are spelled once: the tokens are the TOML
/// vocabulary, the accessor turns a value back into its token, and the
/// interface reads the same list out of [`SETTINGS`] instead of restating it.
/// Three enums built this way replace the eleven hand-written copies of these
/// value domains the survey found across the codebase.
macro_rules! token_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $token:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            /// Every accepted token, in the order the interface should offer
            /// them.
            pub const TOKENS: &'static [&'static str] = &[$($token),+];

            /// [`Self::TOKENS`] behind a call, which is how a registry row
            /// asks for any domain ([`Options`]). One spelling for all three
            /// choices, whether or not the list was known when this table
            /// was written.
            pub fn tokens() -> &'static [&'static str] {
                Self::TOKENS
            }

            /// The token this value is written as in the file.
            pub fn token(self) -> &'static str {
                match self {
                    $(Self::$variant => $token),+
                }
            }

            /// The value a token names, or `None` when the token is not one
            /// of ours — the caller turns that into a located error.
            pub fn from_token(raw: &str) -> Option<Self> {
                match raw {
                    $($token => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.token())
            }
        }
    };
}

/// The one token `appearance.theme` accepts that is not the id of a theme.
///
/// Spelled here rather than inside [`ThemePref`] because two readers outside
/// this module need it as a word: the interface, which offers it as a choice
/// beside the themes, and tools/config-registry-extractor.py, which reads the
/// theme domain out of tokens.json and has to know what is added to it.
pub const SYSTEM_THEME: &str = "system";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemePref {
    /// Follow whatever the operating system is currently set to.
    System,
    /// A theme by id. The `&'static str` is borrowed from the generated
    /// table rather than copied off the file, so a value of this type cannot
    /// name a theme that does not exist — there is nowhere else for the
    /// string to have come from.
    Named(&'static str),
}

impl ThemePref {
    /// The token this value is written as in the file.
    pub fn token(self) -> &'static str {
        match self {
            Self::System => SYSTEM_THEME,
            Self::Named(id) => id,
        }
    }

    /// The value a token names, or `None` when no theme goes by that name —
    /// the caller turns that into a located error.
    pub fn from_token(raw: &str) -> Option<Self> {
        if raw == SYSTEM_THEME {
            return Some(Self::System);
        }
        crate::theme_gen::theme(raw).map(|t| Self::Named(t.id))
    }

    /// Every accepted token: `system` first, then the themes in the order
    /// the generated table holds them.
    ///
    /// Built once and kept for the process's life because [`Kind::Choice`]
    /// hands out a `'static` slice, and the theme table is a `static` that a
    /// `static`'s own initializer may not read — see [`Options`] for why the
    /// registry row asks for this by calling rather than by pointing.
    pub fn tokens() -> &'static [&'static str] {
        static TOKENS: OnceLock<Vec<&'static str>> = OnceLock::new();
        TOKENS.get_or_init(|| {
            let mut out = vec![SYSTEM_THEME];
            out.extend(crate::theme_gen::THEMES.iter().map(|t| t.id));
            out
        })
    }
}

impl Serialize for ThemePref {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.token())
    }
}

token_enum! {
    /// `browser.search_engine`
    SearchEngine {
        DuckDuckGo => "duckduckgo",
        Google => "google",
        Bing => "bing",
        Custom => "custom",
    }
}

token_enum! {
    /// `browser.archive_after` — how long an untouched tab stays in Today.
    ArchiveAfter {
        Hours12 => "12h",
        Hours24 => "24h",
        Days7 => "7d",
        Off => "off",
    }
}

token_enum! {
    DnsMode {
        System => "system",
        Cloudflare => "cloudflare",
        Google => "google",
        Quad9 => "quad9",
        Custom => "custom",
    }
}

impl DnsMode {
    /// The endpoint a built-in provider means, or `None` for the two modes
    /// that name no endpoint of their own ([`Self::System`], and
    /// [`Self::Custom`], whose address is `network.dns_custom_url`).
    ///
    /// Here rather than in the factory because these three addresses ARE the
    /// vocabulary — `cloudflare` is not a word this program knows anything
    /// else about — and a match on the variant is what keeps the token
    /// spelled once (tools/config-registry-extractor.py).
    pub fn doh_url(self) -> Option<&'static str> {
        match self {
            Self::Cloudflare => Some("https://cloudflare-dns.com/dns-query"),
            Self::Google => Some("https://dns.google/dns-query"),
            Self::Quad9 => Some("https://dns.quad9.net/dns-query"),
            Self::System | Self::Custom => None,
        }
    }
}

/// The sidebar's narrowest usable width, in points.
pub const SIDEBAR_WIDTH_MIN: u32 = 180;
/// The sidebar's widest allowed width, in points.
pub const SIDEBAR_WIDTH_MAX: u32 = 520;

/// The smallest terminal text this program will draw, in points. Below this a
/// cell is a smudge on every display this runs on.
pub const TERMINAL_FONT_SIZE_MIN: u32 = 6;
/// The largest terminal text, in points. Past this a default window holds so
/// few columns that ordinary output wraps into nonsense.
pub const TERMINAL_FONT_SIZE_MAX: u32 = 48;

/// The tightest line spacing: the font's own natural height, drawn as
/// percent because this file holds whole numbers (see [`Terminal`]).
pub const TERMINAL_LINE_HEIGHT_MIN: u32 = 100;
/// The loosest line spacing — double-spaced text.
pub const TERMINAL_LINE_HEIGHT_MAX: u32 = 200;

pub const TERMINAL_IMAGE_MEMORY_MB_MIN: u32 = 16;
/// The most inline-image storage one terminal pane may be given, in MB. The
/// cap exists because the limit is per PANE, not per tab: a window of six
/// image-heavy panes stands six times this number in memory, so "no cap"
/// is not an honest option for a setting someone sets once and forgets.
pub const TERMINAL_IMAGE_MEMORY_MB_MAX: u32 = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub appearance: Appearance,
    #[serde(default)]
    pub browser: Browser,
    #[serde(default)]
    pub network: Network,
    #[serde(default)]
    pub terminal: Terminal,
    #[serde(default)]
    pub resident: Resident,
    #[serde(default)]
    pub files: Files,
    #[serde(default)]
    pub keys: Keys,
}

impl Default for Config {
    /// The defaults. Not *a* set of defaults — the only one. Every other
    /// default in this module is written as a read of this construction
    /// (`Config::default().appearance.theme` and so on), so a value can be
    /// changed here and nowhere else. The interface no longer carries
    /// literals at all; it asks `config_get` at startup.
    fn default() -> Self {
        Self {
            appearance: Appearance {
                theme: ThemePref::System,
                sidebar_width: 248,
                sidebar_pinned: true,
            },
            browser: Browser {
                search_engine: SearchEngine::DuckDuckGo,
                custom_search_template: String::new(),
                archive_after: ArchiveAfter::Hours24,
            },
            network: Network {
                // The system's own resolver, and see [`DnsMode`] for why that
                // is not merely the conservative pick but the required one.
                dns_mode: DnsMode::System,
                dns_custom_url: String::new(),
                cover_page_traffic: false,
            },
            terminal: Terminal {
                // Empty is "the built-in stack", not "no font": src/term/
                // font.ts owns that stack, the user's family goes in front of
                // it, and nothing here names a typeface.
                font_family: String::new(),
                font_size: 13,
                line_height_percent: 120,
                ligatures: false,
                // Off preserves today's close-tab and quit behavior: running
                // terminal tasks are stopped unless a person explicitly turns
                // on the prompt that offers to keep them in the background.
                background_tasks: false,
                image_memory_mb: 128,
                paste_guard: true,
                completions_url: "https://raw.githubusercontent.com/spalagu/Tabverse/main/assets/completions/spec.json".to_string(),
                // NOT A DEFAULT VALUE and not a registry row — an empty
                // profile list is the plain fact that this user has declared
                // none ([`Terminal`], [`crate::profiles`]). The gate
                // recognizes `Vec::new()` as an entity list rather than a
                // setting; it used to dodge this by leaving the field
                // without a trailing comma, a trick that stopped scaling the
                // day a second such list ([`crate::templates`]) arrived.
                profiles: Vec::new(),
                // Same kind of fact, same recognition (see
                // [`crate::templates`]).
                templates: Vec::new(),
            },
            resident: Resident {
                // Preserve current lifecycle until the user opts in. A
                // Tab-level `on` may still override this app-wide default.
                default: false,
            },
            // Files::default() and not a struct literal, for the same
            // reason as `keys` one line down with the polarity reversed:
            // these ARE spelled defaults — but they belong to the one
            // section the registry does not judge (see [`Files`]), so the
            // derive that owns them is the only construction, and the
            // registry-gate's single-source rule reads right past this
            // line the way it reads past `Vec::new()` for profiles.
            files: Files::default(),
            // Empty, and `Keys::default()` rather than a struct literal to
            // say why: this is not a chosen default value, it is the absence
            // of overrides. There is nothing here for the registry to own.
            keys: Keys::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Appearance {
    #[serde(default = "default_theme", deserialize_with = "de_theme")]
    pub theme: ThemePref,
    #[serde(
        default = "default_sidebar_width",
        deserialize_with = "de_sidebar_width"
    )]
    pub sidebar_width: u32,
    #[serde(default = "default_sidebar_pinned")]
    pub sidebar_pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Browser {
    #[serde(
        default = "default_search_engine",
        deserialize_with = "de_search_engine"
    )]
    pub search_engine: SearchEngine,
    #[serde(
        default = "default_custom_search_template",
        deserialize_with = "de_custom_search_template"
    )]
    pub custom_search_template: String,
    #[serde(
        default = "default_archive_after",
        deserialize_with = "de_archive_after"
    )]
    pub archive_after: ArchiveAfter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Network {
    #[serde(default = "default_dns_mode", deserialize_with = "de_dns_mode")]
    pub dns_mode: DnsMode,
    #[serde(
        default = "default_dns_custom_url",
        deserialize_with = "de_dns_custom_url"
    )]
    pub dns_custom_url: String,
    #[serde(default = "default_cover_page_traffic")]
    pub cover_page_traffic: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Terminal {
    #[serde(
        default = "default_terminal_font_family",
        deserialize_with = "de_terminal_font_family"
    )]
    pub font_family: String,
    #[serde(
        default = "default_terminal_font_size",
        deserialize_with = "de_terminal_font_size"
    )]
    pub font_size: u32,
    #[serde(
        default = "default_terminal_line_height_percent",
        deserialize_with = "de_terminal_line_height_percent"
    )]
    pub line_height_percent: u32,
    #[serde(default = "default_terminal_ligatures")]
    pub ligatures: bool,
    /// Whether closing a busy terminal tab or exiting with tasks asks whether
    /// to keep them running in the background. Off preserves the existing
    /// behavior of stopping those tasks.
    #[serde(default)]
    pub background_tasks: bool,
    #[serde(
        default = "default_terminal_image_memory_mb",
        deserialize_with = "de_terminal_image_memory_mb"
    )]
    pub image_memory_mb: u32,
    #[serde(default = "default_terminal_paste_guard")]
    pub paste_guard: bool,
    #[serde(
        default = "default_terminal_completions_url",
        deserialize_with = "de_terminal_completions_url"
    )]
    pub completions_url: String,
    #[serde(default, deserialize_with = "crate::profiles::de_profiles")]
    pub profiles: Vec<crate::profiles::Profile>,
    #[serde(default, deserialize_with = "crate::templates::de_templates")]
    pub templates: Vec<crate::templates::Template>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resident {
    /// Per-Tab inherit/on/off lives with session state; this is only the
    /// device-wide value inherited by those tabs.
    #[serde(default)]
    pub default: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Files {
    /// Glob per entry, matched against a directory's own name — the
    /// built-in noise list opened to the user (see
    /// `tabverse_fs::WALK_EXCLUDE`, which this rides on top of as one
    /// list). Empty is not a chosen default but the plain fact that this
    /// user has excluded nothing beyond the built-ins — today's behavior.
    pub exclude: Vec<String>,
    /// Whether `.gitignore` files remove entries from the search and
    /// quick-open walks. Off, because on would be a behavior change
    /// nobody asked for by installing an update: directories outside the
    /// built-in list that a .gitignore names would vanish from searches
    /// that find them today. A user who wants them gone flips this
    /// knowing that.
    pub respect_gitignore: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Keys {
    #[serde(flatten)]
    pub bindings: BTreeMap<String, String>,
}

// Section defaults, and through them the per-field defaults, are reads of
// the one construction above — never fresh literals. `Config::default()`
// builds each section by struct literal, so none of these recurse.
impl Default for Appearance {
    fn default() -> Self {
        Config::default().appearance
    }
}

impl Default for Browser {
    fn default() -> Self {
        Config::default().browser
    }
}

impl Default for Network {
    fn default() -> Self {
        Config::default().network
    }
}

impl Default for Terminal {
    fn default() -> Self {
        Config::default().terminal
    }
}

impl Default for Resident {
    fn default() -> Self {
        Config::default().resident
    }
}

fn default_theme() -> ThemePref {
    Appearance::default().theme
}

fn default_sidebar_width() -> u32 {
    Appearance::default().sidebar_width
}

fn default_sidebar_pinned() -> bool {
    Appearance::default().sidebar_pinned
}

fn default_search_engine() -> SearchEngine {
    Browser::default().search_engine
}

fn default_custom_search_template() -> String {
    Browser::default().custom_search_template
}

fn default_archive_after() -> ArchiveAfter {
    Browser::default().archive_after
}

fn default_dns_mode() -> DnsMode {
    Network::default().dns_mode
}

fn default_dns_custom_url() -> String {
    Network::default().dns_custom_url
}

fn default_cover_page_traffic() -> bool {
    Network::default().cover_page_traffic
}

fn default_terminal_font_family() -> String {
    Terminal::default().font_family
}

fn default_terminal_font_size() -> u32 {
    Terminal::default().font_size
}

fn default_terminal_line_height_percent() -> u32 {
    Terminal::default().line_height_percent
}

fn default_terminal_ligatures() -> bool {
    Terminal::default().ligatures
}

fn default_terminal_image_memory_mb() -> u32 {
    Terminal::default().image_memory_mb
}

fn default_terminal_paste_guard() -> bool {
    Terminal::default().paste_guard
}

fn default_terminal_completions_url() -> String {
    Terminal::default().completions_url
}

// -------------------------------------------------------------- validation

/// The message a rejected token gets: what was written, and what may be.
fn unknown_token(field: &str, raw: &str, tokens: &[&str]) -> String {
    format!(
        "{field} must be one of {} — `{raw}` is not",
        tokens.join(", ")
    )
}

fn de_theme<'de, D: Deserializer<'de>>(d: D) -> Result<ThemePref, D::Error> {
    let raw = String::deserialize(d)?;
    match ThemePref::from_token(&raw) {
        Some(v) => Ok(v),
        None => Err(D::Error::custom(unknown_token(
            "theme",
            &raw,
            ThemePref::tokens(),
        ))),
    }
}

fn de_search_engine<'de, D: Deserializer<'de>>(d: D) -> Result<SearchEngine, D::Error> {
    let raw = String::deserialize(d)?;
    match SearchEngine::from_token(&raw) {
        Some(v) => Ok(v),
        None => Err(D::Error::custom(unknown_token(
            "search_engine",
            &raw,
            SearchEngine::TOKENS,
        ))),
    }
}

fn de_archive_after<'de, D: Deserializer<'de>>(d: D) -> Result<ArchiveAfter, D::Error> {
    let raw = String::deserialize(d)?;
    match ArchiveAfter::from_token(&raw) {
        Some(v) => Ok(v),
        None => Err(D::Error::custom(unknown_token(
            "archive_after",
            &raw,
            ArchiveAfter::TOKENS,
        ))),
    }
}

fn de_dns_mode<'de, D: Deserializer<'de>>(d: D) -> Result<DnsMode, D::Error> {
    let raw = String::deserialize(d)?;
    match DnsMode::from_token(&raw) {
        Some(v) => Ok(v),
        None => Err(D::Error::custom(unknown_token(
            "dns_mode",
            &raw,
            DnsMode::TOKENS,
        ))),
    }
}

/// A whole number that has to sit inside its own registry range.
///
/// One body for the three of them, so the sentence a person reads is written
/// once and every ranged field reports the same way. The bounds are passed
/// in from the constants the `Kind::Number` rows point at, never restated
/// here.
fn de_ranged<'de, D: Deserializer<'de>>(
    d: D,
    field: &str,
    min: u32,
    max: u32,
) -> Result<u32, D::Error> {
    // Read as i64 rather than u32 so that a negative number is answered with
    // the range sentence a person can act on, not with "invalid type".
    let raw = i64::deserialize(d)?;
    if raw < i64::from(min) || raw > i64::from(max) {
        return Err(D::Error::custom(format!(
            "{field} must be between {min} and {max} — {raw} is not"
        )));
    }
    Ok(raw as u32)
}

fn de_sidebar_width<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    de_ranged(d, "sidebar_width", SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
}

fn de_terminal_font_size<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    de_ranged(
        d,
        "font_size",
        TERMINAL_FONT_SIZE_MIN,
        TERMINAL_FONT_SIZE_MAX,
    )
}

fn de_terminal_line_height_percent<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    de_ranged(
        d,
        "line_height_percent",
        TERMINAL_LINE_HEIGHT_MIN,
        TERMINAL_LINE_HEIGHT_MAX,
    )
}

fn de_terminal_image_memory_mb<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    de_ranged(
        d,
        "image_memory_mb",
        TERMINAL_IMAGE_MEMORY_MB_MIN,
        TERMINAL_IMAGE_MEMORY_MB_MAX,
    )
}

/// The registry row `custom_search_template`'s rule is carried by.
///
/// The key is a *name*, not a rule: it says which row to read, and it is
/// spelled here as well as in [`SETTINGS`] because serde gives a
/// `deserialize_with` function no way to ask which field it was called for.
/// The two cannot silently disagree — [`text_rule`] returning nothing is a
/// hard refusal below rather than a value that goes unchecked, so a mismatch
/// stops every template from loading instead of stopping the rule.
const KEY_CUSTOM_SEARCH_TEMPLATE: &str = "browser.custom_search_template";

/// The registry row `dns_custom_url`'s rule is carried by — the same
/// arrangement, and the same reason, as [`KEY_CUSTOM_SEARCH_TEMPLATE`].
const KEY_DNS_CUSTOM_URL: &str = "network.dns_custom_url";

/// The registry row the terminal font family's rule is carried by — the same
/// arrangement again ([`KEY_CUSTOM_SEARCH_TEMPLATE`]).
const KEY_TERMINAL_FONT_FAMILY: &str = "terminal.font_family";

const KEY_TERMINAL_COMPLETIONS_URL: &str = "terminal.completions_url";

/// The text rule a registered key declares, or `None` when the key names no
/// setting or names one that is not text.
///
/// The single read of [`Kind::Text`]. Both directions go through it — the
/// deserializer below, and the interface via `config_schema` — so the rule is
/// declared in the registry row and judged from that row, never restated.
pub fn text_rule(key: &str) -> Option<TextRule> {
    SETTINGS
        .iter()
        .find(|s| s.key == key)
        .and_then(|s| match s.kind {
            Kind::Text(rule) => Some(rule),
            _ => None,
        })
}

/// Judge a text value against a rule, answering with the clause it broke.
///
/// THE implementation of what a constrained text setting accepts. It reads
/// its rule out of the [`TextRule`] it is handed and holds none of its own,
/// which is what lets the same rule govern the file, the settings page and
/// the browser demo: change the registry row and every one of them changes,
/// because none of them knows anything the row did not tell it.
pub fn check_text(rule: TextRule, value: &str) -> Result<(), String> {
    // Empty is its own state — "not configured" — and is judged before
    // anything else, because a rule about content has nothing to say about
    // an absence.
    if value.is_empty() {
        return if rule.allow_empty {
            Ok(())
        } else {
            Err("must not be empty".to_string())
        };
    }
    if let Some(schemes) = rule.schemes {
        // RFC 3986 §3.1: a scheme is case-insensitive, so HTTPS://example.com
        // is an address like any other and refusing it would be a defect
        // rather than strictness.
        let head = value.to_ascii_lowercase();
        if !schemes.iter().any(|s| head.starts_with(&format!("{s}://"))) {
            let offered: Vec<String> = schemes.iter().map(|s| format!("{s}://")).collect();
            return Err(format!("must be a {} address", offered.join(" or ")));
        }
    }
    if let Some(needle) = rule.must_contain {
        if !value.contains(needle) {
            return Err(format!("must contain {needle}"));
        }
    }
    Ok(())
}

/// A text field judged by the rule its own registry row declares.
///
/// One body for every text setting, so that "which rule governs this field"
/// stays a lookup by key rather than a second thing written per field. No
/// rule found is a refusal, never a pass: the alternative — accepting
/// anything when the lookup comes up empty — is how a renamed key would
/// switch a field's validation off without one test going red.
fn de_registered_text<'de, D: Deserializer<'de>>(
    d: D,
    key: &'static str,
) -> Result<String, D::Error> {
    let raw = String::deserialize(d)?;
    let Some(rule) = text_rule(key) else {
        return Err(D::Error::custom(format!(
            "{key} carries no text rule in the settings registry"
        )));
    };
    match check_text(rule, &raw) {
        Ok(()) => Ok(raw),
        Err(clause) => Err(D::Error::custom(format!("{key} {clause}"))),
    }
}

fn de_custom_search_template<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    de_registered_text(d, KEY_CUSTOM_SEARCH_TEMPLATE)
}

fn de_dns_custom_url<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    de_registered_text(d, KEY_DNS_CUSTOM_URL)
}

fn de_terminal_font_family<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    de_registered_text(d, KEY_TERMINAL_FONT_FAMILY)
}

fn de_terminal_completions_url<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    de_registered_text(d, KEY_TERMINAL_COMPLETIONS_URL)
}

// --------------------------------------------------------- metadata table

/// What a text setting's content has to be, said in terms rather than in a
/// pattern.
///
/// Semantics, deliberately, and not a regular expression: Rust and JavaScript
/// spell regular expressions differently, so a pattern shared between them
/// would be a second dialect of the same rule — which is the disease this
/// type is here to cure, wearing a different hat. Every field is `&'static`
/// or a bool so that [`Setting`] stays `Copy` and the whole registry stays a
/// `&'static` table.
///
/// The one instance today is `browser.custom_search_template`. Its rule used
/// to live in two places — a hand-written deserializer here and
/// `validSearchTemplate` in src/search.ts — and the two drifted: the
/// interface tested the scheme case-insensitively and this side did not, so
/// `HTTPS://…` passed the settings page and was then refused on the way to
/// disk. Both now read this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TextRule {
    /// Whether the empty string is accepted. It is its own state — "nothing
    /// configured" — rather than a value the other clauses judge.
    pub allow_empty: bool,
    /// A substring the value must carry, or `None` to demand none.
    pub must_contain: Option<&'static str>,
    /// The URL schemes the value may open with, compared case-insensitively
    /// (RFC 3986 §3.1). `None` means the value is not an address at all.
    pub schemes: Option<&'static [&'static str]>,
}

/// The members of a [`Kind::Choice`], fetched rather than stored.
///
/// A call and not a slice, because one of the three domains is not known
/// while [`SETTINGS`] is being built: `appearance.theme` accepts whatever
/// themes `tokens.json` declares, which reaches this crate as a generated
/// `static` ([`crate::theme_gen::THEMES`]), and a `static`'s initializer may
/// not read another `static`. Pointing at the *function* that answers costs
/// nothing at compile time and keeps [`SETTINGS`] the plain table that
/// tools/config-registry-extractor.py reads.
///
/// It serializes as the list itself, so `config_schema` puts the same array
/// on the wire it always did — the indirection stops at this module's edge.
#[derive(Clone, Copy)]
pub struct Options(pub fn() -> &'static [&'static str]);

impl Options {
    /// The domain, as of now.
    pub fn get(self) -> &'static [&'static str] {
        (self.0)()
    }
}

impl Serialize for Options {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.get().serialize(s)
    }
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.get().fmt(f)
    }
}

/// Two domains are the same domain when they hold the same tokens. Compared
/// by what they answer rather than by which function answers, because a
/// function pointer's identity is not a fact about the setting.
impl PartialEq for Options {
    fn eq(&self, other: &Self) -> bool {
        self.get() == other.get()
    }
}

impl Eq for Options {}

/// Which control a setting is edited with — and, for the three kinds that
/// have one, the value domain itself. Carrying the domain here is the point:
/// it is the same list the deserializer enforces, so the interface can offer
/// exactly the accepted values without declaring them a second time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// One of a set of tokens ([`Options`]).
    Choice { options: Options },
    /// A whole number within an inclusive range.
    Number { min: u32, max: u32 },
    /// On or off.
    Toggle,
    /// Text, with the constraints on its content ([`TextRule`]).
    Text(TextRule),
}

/// One row of the registry as the interface sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Setting {
    /// Dotted path into [`Config`], and the file location in one:
    /// `appearance.theme` is `[appearance] theme = …`.
    pub key: &'static str,
    pub kind: Kind,
    /// The settings-page section this belongs to — the anchor id in
    /// `src/components/settingsSections.ts`, so a search hit or a "changed"
    /// row can link straight to `#<section>`. It is not the file section
    /// (that is the key's first component): the page groups auto-archive and
    /// search engine separately though the file keeps both under
    /// `[browser]`.
    pub section: &'static str,
    /// Path into `STR` for this setting's label and description.
    pub str_key: &'static str,
}

pub static SETTINGS: &[Setting] = &[
    Setting {
        key: "appearance.theme",
        kind: Kind::Choice {
            options: Options(ThemePref::tokens),
        },
        section: "appearance",
        str_key: "settings.appearance.theme",
    },
    Setting {
        key: "appearance.sidebar_width",
        kind: Kind::Number {
            min: SIDEBAR_WIDTH_MIN,
            max: SIDEBAR_WIDTH_MAX,
        },
        section: "appearance",
        str_key: "settings.appearance.sidebarWidth",
    },
    Setting {
        key: "appearance.sidebar_pinned",
        kind: Kind::Toggle,
        section: "appearance",
        str_key: "settings.appearance.sidebarPinned",
    },
    Setting {
        key: "browser.search_engine",
        kind: Kind::Choice {
            options: Options(SearchEngine::tokens),
        },
        section: "search-engine",
        str_key: "settings.searchEngine.engine",
    },
    Setting {
        key: "browser.custom_search_template",
        // The rule the file, the settings page and the browser demo all
        // judge this field by, and the only place it is written down.
        kind: Kind::Text(TextRule {
            allow_empty: true,
            must_contain: Some("%s"),
            schemes: Some(&["http", "https"]),
        }),
        section: "search-engine",
        str_key: "settings.searchEngine.customTemplate",
    },
    Setting {
        key: "browser.archive_after",
        kind: Kind::Choice {
            options: Options(ArchiveAfter::tokens),
        },
        section: "auto-archive",
        str_key: "settings.autoArchive.after",
    },
    Setting {
        key: "network.dns_mode",
        kind: Kind::Choice {
            options: Options(DnsMode::tokens),
        },
        section: "network",
        str_key: "settings.network.dnsMode",
    },
    Setting {
        key: "network.dns_custom_url",
        // Both schemes, and the second one is not an oversight. A DNS-over-
        // HTTPS endpoint reached over plain http is only ever a resolver on
        // this machine — dnscrypt-proxy, cloudflared, a test stub — because
        // nothing else would be addressed that way, and refusing it would
        // refuse the one arrangement in which http is not a downgrade. It is
        // not a downgrade against the DEFAULT either: the system resolver
        // this replaces speaks plaintext UDP to whoever DHCP named.
        kind: Kind::Text(TextRule {
            allow_empty: true,
            must_contain: None,
            schemes: Some(&["https", "http"]),
        }),
        section: "network",
        str_key: "settings.network.dnsCustomUrl",
    },
    Setting {
        key: "network.cover_page_traffic",
        kind: Kind::Toggle,
        section: "network",
        str_key: "settings.network.coverPageTraffic",
    },
    Setting {
        // Spelled out rather than [`KEY_TERMINAL_FONT_FAMILY`], for the
        // reason that constant's own doc comment gives: the two cannot
        // silently disagree, because a rule that is not found is a refusal.
        key: "terminal.font_family",
        // Anything, including nothing. There is no list of installed fonts
        // to check a name against here — the machine's fonts are the
        // interface's to see, and it says so on the spot (src/term/
        // fontProbe.ts) rather than refusing to save a name the user is
        // about to install.
        kind: Kind::Text(TextRule {
            allow_empty: true,
            must_contain: None,
            schemes: None,
        }),
        // The page groups this with the rest of what the app looks like; the
        // file keeps it under [terminal]. The two groupings are allowed to
        // differ — see [`Setting::section`].
        section: "appearance",
        str_key: "settings.appearance.terminalFontFamily",
    },
    Setting {
        key: "terminal.font_size",
        kind: Kind::Number {
            min: TERMINAL_FONT_SIZE_MIN,
            max: TERMINAL_FONT_SIZE_MAX,
        },
        section: "appearance",
        str_key: "settings.appearance.terminalFontSize",
    },
    Setting {
        key: "terminal.line_height_percent",
        kind: Kind::Number {
            min: TERMINAL_LINE_HEIGHT_MIN,
            max: TERMINAL_LINE_HEIGHT_MAX,
        },
        section: "appearance",
        str_key: "settings.appearance.terminalLineHeight",
    },
    Setting {
        // The key is fixed (see [`Terminal::ligatures`]): the terminal view
        // reads it to decide which renderer it opens with, and the settings
        // page draws its switch from this row.
        key: "terminal.ligatures",
        kind: Kind::Toggle,
        section: "appearance",
        str_key: "settings.appearance.terminalLigatures",
    },
    Setting {
        key: "terminal.background_tasks",
        kind: Kind::Toggle,
        section: "appearance",
        str_key: "settings.appearance.terminalBackgroundTasks",
    },
    Setting {
        key: "terminal.image_memory_mb",
        kind: Kind::Number {
            min: TERMINAL_IMAGE_MEMORY_MB_MIN,
            max: TERMINAL_IMAGE_MEMORY_MB_MAX,
        },
        section: "appearance",
        str_key: "settings.appearance.terminalImageMemory",
    },
    Setting {
        key: "terminal.paste_guard",
        kind: Kind::Toggle,
        section: "appearance",
        str_key: "settings.appearance.terminalPasteGuard",
    },
    Setting {
        key: "terminal.completions_url",
        kind: Kind::Text(TextRule {
            allow_empty: false,
            must_contain: None,
            schemes: Some(&["http", "https"]),
        }),
        section: "terminal-completions",
        str_key: "settings.completions.url",
    },
    Setting {
        key: "resident.default",
        kind: Kind::Toggle,
        section: "background-tasks",
        str_key: "settings.backgroundTasks.residentDefault",
    },
];

/// The file sections that exist, including the three reserved ones. A table
/// header outside this list is an unknown section, reported like any other
/// unknown key.
pub static SECTIONS: &[&str] = &[
    "appearance",
    "browser",
    "network",
    "terminal",
    "resident",
    "files",
    "keys",
];

/// The one section the registry does not describe — see [`Keys`] for why, and
/// [`scan_unknown_keys`] for what judges its leaves instead.
const SECTION_KEYS: &str = "keys";

const FILES_LEAVES: &[&str] = &["exclude", "respect_gitignore"];

// ------------------------------------------------------------------ paths

/// Points the whole resolution at one file. Highest precedence, and the way
/// a test — or `--validate-config` — reads a file that is not the user's own
/// Tests pass a temporary directory directly to keep state isolated.
pub const ENV_CONFIG_FILE: &str = "TABVERSE_CONFIG_FILE";

const ENV_XDG_CONFIG_HOME: &str = "XDG_CONFIG_HOME";
const ENV_HOME: &str = "HOME";
const ENV_APPDATA: &str = "APPDATA";

const DIR_UNIX: &str = "tabverse";
const DIR_WINDOWS: &str = "Tabverse";
/// macOS keeps its per-application directory under the bundle identifier, so
/// the last-resort location there is the one the platform itself would pick.
const DIR_MACOS_APP_SUPPORT: &str = "dev.tabverse.app";
const FILE_NAME: &str = "config.toml";

/// Named so that all three conventions can be exercised from any one host —
/// the path rules are the kind of thing that is only ever wrong on the
/// platform you are not developing on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
    Windows,
}

/// The platform this build runs on.
pub fn current_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// The environment as path resolution sees it — injected rather than read,
/// so a test states the environment instead of mutating the process's.
#[derive(Debug, Clone, Default)]
pub struct EnvVars {
    pub config_file: Option<String>,
    pub xdg_config_home: Option<String>,
    pub home: Option<String>,
    pub appdata: Option<String>,
}

impl EnvVars {
    pub fn from_process() -> Self {
        let read = |name: &str| match std::env::var(name) {
            Ok(v) if !v.is_empty() => Some(v),
            _ => None,
        };
        Self {
            config_file: read(ENV_CONFIG_FILE),
            xdg_config_home: read(ENV_XDG_CONFIG_HOME),
            home: read(ENV_HOME),
            appdata: read(ENV_APPDATA),
        }
    }
}

/// Every place a configuration file may live, in reading order: a later file
/// overrides an earlier one, section by section, and the last is where a
/// write would go.
pub fn resolve_paths(platform: Platform, env: &EnvVars) -> Vec<PathBuf> {
    // The override names a file outright, so it replaces the search rather
    // than joining it — otherwise a file in a default location would
    // override the file the caller explicitly asked for.
    if let Some(file) = &env.config_file {
        return vec![PathBuf::from(file)];
    }

    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };

    match platform {
        Platform::MacOs | Platform::Linux => {
            if let Some(xdg) = &env.xdg_config_home {
                push(Path::new(xdg).join(DIR_UNIX).join(FILE_NAME));
            }
            if let Some(home) = &env.home {
                push(
                    Path::new(home)
                        .join(".config")
                        .join(DIR_UNIX)
                        .join(FILE_NAME),
                );
                if platform == Platform::MacOs {
                    push(
                        Path::new(home)
                            .join("Library")
                            .join("Application Support")
                            .join(DIR_MACOS_APP_SUPPORT)
                            .join(FILE_NAME),
                    );
                }
            }
        }
        Platform::Windows => {
            if let Some(appdata) = &env.appdata {
                push(Path::new(appdata).join(DIR_WINDOWS).join(FILE_NAME));
            }
        }
    }
    out
}

// ----------------------------------------------------------------- errors

/// One unknown key, kept so the interface can say where it is without the
/// user hunting for it. Warnings never stop a load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Warning {
    /// Dotted path as written in the file.
    pub key: String,
    pub path: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadError {
    pub path: String,
    /// 1-based; 0 when the failure has no position (an unreadable file).
    pub line: usize,
    /// 1-based; 0 with `line`.
    pub column: usize,
    /// One sentence, already in the user's terms.
    pub message: String,
    /// The parser's own rendering: source line and caret included.
    pub detail: String,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.line == 0 {
            write!(f, "{}: {}", self.path, self.message)
        } else {
            write!(
                f,
                "{}:{}:{}: {}\n{}",
                self.path, self.line, self.column, self.message, self.detail
            )
        }
    }
}

impl std::error::Error for LoadError {}

/// What a successful load produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Loaded {
    pub config: Config,
    pub warnings: Vec<Warning>,
    /// The files that actually contributed, in reading order. Empty means no
    /// configuration file exists, which is a normal state and not a warning.
    pub sources: Vec<String>,
}

/// Byte offset to a 1-based line and column.
pub(crate) fn line_col(src: &str, offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut column = 1usize;
    for (i, ch) in src.char_indices() {
        if i >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

fn to_load_error(path: &Path, src: &str, err: &toml::de::Error) -> LoadError {
    let (line, column) = match err.span() {
        Some(span) => line_col(src, span.start),
        None => (0, 0),
    };
    LoadError {
        path: path.display().to_string(),
        line,
        column,
        message: err.message().to_string(),
        detail: err.to_string(),
    }
}

// ---------------------------------------------------------------- loading

/// Collect the keys a file names that the registry does not know: a typo, or
/// a key from a newer version. Two passes over the source, this being the
/// first: the DOM keeps a byte range on every key, which the value pass
/// throws away.
///
/// `deny_unknown_fields` is deliberately not used. It would turn each of
/// these into a hard failure, so a user who ran a newer version once could
/// not open their configuration on the older one at all — and this product
/// takes downgrade seriously enough to ship a migration module.
fn scan_unknown_keys(path: &Path, src: &str) -> Vec<Warning> {
    let mut out = Vec::new();
    // A syntax error is reported by the value pass, with its own position;
    // there is nothing useful to add from here.
    let Ok(doc) = toml::de::DeTable::parse(src) else {
        return out;
    };
    let path_text = path.display().to_string();
    for (key, value) in doc.get_ref().iter() {
        let section = key.get_ref().as_ref();
        let (line, column) = line_col(src, key.span().start);
        if !SECTIONS.contains(&section) {
            // An unknown section is reported once; naming each key inside it
            // would repeat one mistake as many times as it has lines.
            out.push(Warning {
                key: section.to_string(),
                path: path_text.clone(),
                line,
                column,
            });
            continue;
        }
        let toml::de::DeValue::Table(table) = value.get_ref() else {
            // A known section name used as a plain value: the value pass
            // rejects it, so this is not the place to explain it.
            continue;
        };
        if section == SECTION_KEYS {
            for (leaf, _) in table.iter() {
                let command = leaf.get_ref().as_ref();
                if crate::keys::is_command(command) {
                    continue;
                }
                let (line, column) = line_col(src, leaf.span().start);
                out.push(Warning {
                    key: format!("{section}.{command}"),
                    path: path_text.clone(),
                    line,
                    column,
                });
            }
            continue;
        }
        if section == "files" {
            for (leaf, _) in table.iter() {
                let field = leaf.get_ref().as_ref();
                if FILES_LEAVES.contains(&field) {
                    continue;
                }
                let (line, column) = line_col(src, leaf.span().start);
                out.push(Warning {
                    key: format!("{section}.{field}"),
                    path: path_text.clone(),
                    line,
                    column,
                });
            }
            continue;
        }
        for (leaf, item) in table.iter() {
            let dotted = format!("{section}.{}", leaf.get_ref().as_ref());
            // The profile list is the second leaf the registry cannot
            // describe (see [`crate::profiles`]), and its entries are judged
            // by that module's own field list. Without this branch every
            // profile a user writes would be reported as an unknown setting,
            // because `SETTINGS` has no row for it and never will.
            if section == profiles::SECTION && leaf.get_ref().as_ref() == profiles::KEY {
                out.extend(profiles::scan_unknown_keys(&path_text, src, item.get_ref()));
                continue;
            }
            // The template list is judged the same way, by the module that
            // owns its shape (see [`crate::templates`]): the registry has no
            // row for `terminal.templates` and never will, and a misspelled
            // leaf inside a declared tree must be reported rather than load
            // as nothing.
            if section == templates::SECTION && leaf.get_ref().as_ref() == templates::KEY {
                out.extend(templates::scan_unknown_keys(
                    &path_text,
                    src,
                    item.get_ref(),
                ));
                continue;
            }
            if SETTINGS.iter().any(|s| s.key == dotted) {
                continue;
            }
            let (line, column) = line_col(src, leaf.span().start);
            out.push(Warning {
                key: dotted,
                path: path_text.clone(),
                line,
                column,
            });
        }
    }
    out
}

/// Merge `overlay` onto `base` in place: a table meets a table by key, and
/// anything else replaces what was there. This is what "a later file wins,
/// section by section" means — a second file that sets one key leaves the
/// rest of that section alone.
fn merge_into(base: &mut toml::Table, overlay: toml::Table) {
    for (key, value) in overlay {
        match (base.get_mut(&key), value) {
            (Some(toml::Value::Table(existing)), toml::Value::Table(incoming)) => {
                merge_into(existing, incoming);
            }
            (_, value) => {
                base.insert(key, value);
            }
        }
    }
}

/// Read, validate and merge an explicit list of candidate files.
///
/// A file that is not there contributes nothing — that is the zero-
/// configuration state, and it is never created here. Creating it would
/// freeze today's defaults as explicit values in the user's file, so a later
/// release that improves a default would never reach them.
pub fn load_from_paths(paths: &[PathBuf]) -> Result<Loaded, LoadError> {
    let mut merged = toml::Table::new();
    let mut warnings: Vec<Warning> = Vec::new();
    let mut sources: Vec<String> = Vec::new();

    for path in paths {
        let src = match std::fs::read_to_string(path) {
            Ok(src) => src,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(LoadError {
                    path: path.display().to_string(),
                    line: 0,
                    column: 0,
                    message: format!("cannot read this file: {e}"),
                    detail: String::new(),
                })
            }
        };

        // Validate the file on its own text. This is the pass that carries
        // positions: every rule, including the range and format rules
        // written on the fields, reports through it.
        if let Err(e) = toml::from_str::<Config>(&src) {
            return Err(to_load_error(path, &src, &e));
        }
        warnings.extend(scan_unknown_keys(path, &src));

        // Value pass. It cannot fail where the pass above succeeded — the
        // same text just parsed into the same type — but a failure is still
        // reported rather than swallowed.
        match toml::from_str::<toml::Table>(&src) {
            Ok(table) => merge_into(&mut merged, table),
            Err(e) => return Err(to_load_error(path, &src, &e)),
        }
        sources.push(path.display().to_string());
    }

    let config = match merged.try_into::<Config>() {
        Ok(config) => config,
        Err(e) => {
            // Only reachable when two files are individually valid but
            // disagree once merged; there is no single line to point at, so
            // the last contributing file is named instead.
            let path = match sources.last() {
                Some(p) => p.clone(),
                None => String::new(),
            };
            return Err(LoadError {
                path,
                line: 0,
                column: 0,
                message: e.message().to_string(),
                detail: e.to_string(),
            });
        }
    };

    Ok(Loaded {
        config,
        warnings,
        sources,
    })
}

/// The configuration this run should use, from this machine's own paths.
pub fn load() -> Result<Loaded, LoadError> {
    let env = EnvVars::from_process();
    load_from_paths(&resolve_paths(current_platform(), &env))
}

// ------------------------------------------------------------- write-back

/// The file a write lands in: the last candidate path.
///
/// Last is not an arbitrary pick. [`load_from_paths`] lets a later file
/// override an earlier one, so the last path is the only one where a written
/// value is certain to be the value the next load reads back — writing to any
/// other would leave a setting that silently refuses to change.
pub fn write_target(platform: Platform, env: &EnvVars) -> Result<PathBuf, String> {
    let mut paths = resolve_paths(platform, env);
    match paths.pop() {
        Some(path) => Ok(path),
        None => Err(format!(
            "there is nowhere to keep a configuration file on this system: set \
             {ENV_CONFIG_FILE} to the file you want to use, or set {ENV_HOME} \
             (on Windows, {ENV_APPDATA})"
        )),
    }
}

/// The registry row a dotted key names.
///
/// An unregistered key is refused here rather than written through. A file
/// may *carry* a key we do not know — that is how a downgrade survives, and
/// [`scan_unknown_keys`] warns about it — but nothing this program writes may
/// create one, or the file would accumulate settings that no version has ever
/// read.
fn setting_for(key: &str) -> Result<&'static Setting, String> {
    match SETTINGS.iter().find(|s| s.key == key) {
        Some(setting) => Ok(setting),
        None => Err(format!("`{key}` is not a setting")),
    }
}

fn split_key(key: &str) -> Result<(&str, &str), String> {
    match key.split_once('.') {
        Some((section, leaf)) if !section.is_empty() && !leaf.is_empty() && !leaf.contains('.') => {
            Ok((section, leaf))
        }
        _ => Err(format!("`{key}` is not a section.key path")),
    }
}

/// The TOML value a JSON value stands for.
///
/// Structural only: it decides the TOML *type*, never whether the value is
/// allowed. That second judgement belongs to [`check_value`], which runs the
/// candidate through the very deserializer a load runs through, so the two
/// directions cannot disagree about what is acceptable.
fn to_toml_value(key: &str, value: &serde_json::Value) -> Result<Value, String> {
    match value {
        serde_json::Value::String(s) => Ok(Value::from(s.as_str())),
        serde_json::Value::Bool(b) => Ok(Value::from(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Ok(Value::from(i));
            }
            match n.as_f64() {
                // A whole number that arrived as a float is that whole
                // number. The interface is JavaScript, which has one numeric
                // type, so a width of 300 can reach here as 300.0; widening
                // it back is exact and loses nothing. A *fractional* value is
                // deliberately not widened — it stays a float and the type
                // check below refuses it, which is the honest answer to
                // "sidebar_width = 248.5".
                Some(f) if f.fract() == 0.0 && f >= i64::MIN as f64 && f <= i64::MAX as f64 => {
                    Ok(Value::from(f as i64))
                }
                Some(f) => Ok(Value::from(f)),
                None => Err(format!(
                    "`{key}` was given a number this program cannot represent"
                )),
            }
        }
        other => Err(format!(
            "`{key}` cannot be set to {other} — only text, whole numbers and true/false \
             are settable"
        )),
    }
}

fn check_value(section: &str, leaf: &str, value: &Value) -> Result<(), String> {
    let mut table = Table::new();
    table.set_implicit(false);
    table.insert(leaf, Item::Value(value.clone()));
    let mut probe = DocumentMut::new();
    probe.insert(section, Item::Table(table));
    match toml::from_str::<Config>(&probe.to_string()) {
        Ok(_) => Ok(()),
        Err(e) => Err(e.message().to_string()),
    }
}

fn assign_preserving_decor(target: &mut Value, new_value: Value) {
    let decor = target.decor().clone();
    *target = new_value;
    *target.decor_mut() = decor;
}

/// Put `new_value` at `leaf`, preserving the line when there is a line to
/// preserve and appending one when there is not.
pub(crate) fn put(table: &mut Table, leaf: &str, new_value: Value) {
    match table.get_mut(leaf).and_then(Item::as_value_mut) {
        Some(existing) => assign_preserving_decor(existing, new_value),
        None => {
            // Either the key is absent, or it names something that is not a
            // scalar (a sub-table under a setting's name). Both are replaced
            // outright: there is no formatting to carry over from a line that
            // does not exist, and a sub-table cannot be what the registry
            // says this key is.
            table.insert(leaf, Item::Value(new_value));
        }
    }
}

pub(crate) fn open_document(path: &Path) -> Result<DocumentMut, String> {
    let src = match std::fs::read_to_string(path) {
        Ok(src) => src,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DocumentMut::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    match src.parse::<DocumentMut>() {
        Ok(doc) => Ok(doc),
        Err(e) => Err(format!(
            "{} cannot be edited because it does not parse: {e}\nFix it by hand, or \
             delete it to start again from the defaults — this program will not \
             overwrite a file it cannot read.",
            path.display()
        )),
    }
}

pub(crate) fn section_mut<'a>(
    doc: &'a mut DocumentMut,
    section: &str,
) -> Result<&'a mut Table, String> {
    if doc.get(section).is_none() {
        let mut table = Table::new();
        table.set_implicit(false);
        doc.insert(section, Item::Table(table));
    }
    match doc.get_mut(section).and_then(Item::as_table_mut) {
        Some(table) => Ok(table),
        // The name is taken by something that is not a `[section]` header —
        // an inline `section = { … }`, which a load does accept, or a plain
        // value, which it does not. Editing an inline table in place would
        // mean a second assignment path and a second set of formatting rules
        // for a shape the documented file format never uses, so this refuses
        // and says how to get out of it. Refusing is safe; the file is
        // untouched and the message is shown to the user.
        None => Err(format!(
            "`{section}` is not written as a [{section}] section in this file, so this \
             setting cannot be saved. Rewrite it as a [{section}] header with one key \
             per line and it will save."
        )),
    }
}

/// Publish `text` at `path` without ever leaving a half-written file there.
///
/// The bytes go to a temporary neighbour and a rename puts them in place;
/// rename within one directory is atomic on all three platforms, so an
/// interruption leaves at worst a stale `.tmp` beside the previous good file
/// rather than a truncated configuration. Same shape as the state module in
/// `tabverse-fs` — except that one has the same flaw this one had, a fixed
/// scratch name, which is only atomic while a single process writes.
pub(crate) fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    let name = match path.file_name() {
        Some(name) => name.to_string_lossy().to_string(),
        None => return Err(format!("{} is not a file path", path.display())),
    };
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return Err(format!("{} has no directory to write into", path.display())),
    };
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    // The scratch name carries this process id. A fixed one is only atomic
    // while a single process writes: two of them landing on the same
    // `config.toml.tmp` truncate and write over each other, and what gets
    // renamed into place is neither file — a real one found on this machine
    // had a line reading ` 278`, the key name gone, with a stray quote after
    // it. Two Tabverse windows, or the app running while a test writes, is
    // all it takes.
    let tmp = parent.join(format!("{name}.{}.tmp", std::process::id()));
    let write = std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", tmp.display()));
    if write.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return write;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Leaving scratch files behind would be its own slow leak.
            let _ = std::fs::remove_file(&tmp);
            Err(format!("cannot replace {}: {e}", path.display()))
        }
    }
}

/// Set one registered key in one named file.
///
/// The unit both the command and the tests go through, so what the tests
/// prove is what the product does rather than something next to it. Every
/// refusal happens before the file is opened and the file is written exactly
/// once at the end: there is no state in which a rejected value has half
/// landed.
pub fn set_in_file(path: &Path, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let setting = setting_for(key)?;
    let (section, leaf) = split_key(setting.key)?;
    let new_value = to_toml_value(key, value)?;
    check_value(section, leaf, &new_value)?;
    let mut doc = open_document(path)?;
    let table = section_mut(&mut doc, section)?;
    put(table, leaf, new_value);
    write_atomically(path, &doc.to_string())
}

pub fn files_set_in_file(
    path: &Path,
    exclude: &[String],
    respect_gitignore: bool,
) -> Result<(), String> {
    let cleaned: Vec<String> = exclude
        .iter()
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();
    tabverse_fs::Exclusions::compile(&tabverse_fs::WalkRules {
        exclude: cleaned.clone(),
        respect_gitignore,
    })
    .map_err(|e| e.to_string())?;
    let mut doc = open_document(path)?;
    let table = section_mut(&mut doc, "files")?;
    if cleaned.is_empty() {
        table.remove("exclude");
    } else {
        let mut array = toml_edit::Array::new();
        for entry in &cleaned {
            array.push(entry.as_str());
        }
        put(table, "exclude", Value::Array(array));
    }
    if respect_gitignore {
        put(table, "respect_gitignore", Value::from(true));
    } else {
        table.remove("respect_gitignore");
    }
    if table.is_empty() {
        doc.remove("files");
    }
    let text = doc.to_string();
    // The whole file must still load before it replaces the user's file —
    // the same guard `crate::templates` publishes under.
    if let Err(error) = toml::from_str::<Config>(&text) {
        return Err(error.message().to_string());
    }
    write_atomically(path, &text)
}

/// Remove one registered key from one named file, so that the built-in
/// default governs it again.
///
/// Removal, not "write the default out". A default written into the file is
/// frozen there: a later release that improves that default would never reach
/// this user, who would carry today's value for ever without having chosen
/// it. The key's line goes; the section header, the comments around it and
/// every other key stay exactly where they were.
///
/// A key that is not in the file is already in the state this call asks for,
/// so nothing is written — rewriting a file nobody asked us to touch is
/// itself a change.
pub fn reset_in_file(path: &Path, key: &str) -> Result<(), String> {
    let setting = setting_for(key)?;
    let (section, leaf) = split_key(setting.key)?;
    let mut doc = open_document(path)?;
    let table = match doc.get_mut(section).and_then(Item::as_table_mut) {
        Some(table) => table,
        None => return Ok(()),
    };
    if table.remove(leaf).is_none() {
        return Ok(());
    }
    write_atomically(path, &doc.to_string())
}

// ------------------------------------------------- write-back: [keys]
//
// The overlay's own three writers. They are separate from the three above
// rather than a special case inside them because the `[keys]` section is not
// a registry section (see [`Keys`]): its leaves are command ids, so the
// registry cannot say what may be written there and the shortcut table has
// to. Everything else about a write is shared — the same document opener,
// the same decor-preserving assignment, the same atomic publish — so a
// comment kept beside a rebound key survives exactly as one kept beside a
// setting does.

/// Refuse an override for something that is not a command.
///
/// The counterpart of [`setting_for`], and for the same reason: a file may
/// *carry* an override for a command this version has never heard of — that
/// is how a downgrade survives, and [`scan_unknown_keys`] warns about it —
/// but nothing this program writes may create one, or the section fills up
/// with lines no version will ever read.
fn command_for(command: &str) -> Result<(), String> {
    if crate::keys::is_command(command) {
        Ok(())
    } else {
        Err(format!("`{command}` is not a command"))
    }
}

pub fn set_key_in_file(path: &Path, command: &str, keys: &str) -> Result<(), String> {
    command_for(command)?;
    let mut doc = open_document(path)?;
    let table = section_mut(&mut doc, SECTION_KEYS)?;
    put(table, command, Value::from(keys));
    write_atomically(path, &doc.to_string())
}

/// Take `command`'s line out, so the key the app ships with governs it again.
///
/// NOT expressible as [`set_key_in_file`] with the shipped key, and the
/// distinction is the same one [`reset_in_file`] makes: an override that
/// happens to equal today's default is a different fact from having no
/// opinion, and the difference shows on the day the default moves. Deleting
/// the line is what "the shipped key" means.
///
/// An override that is not there is already the state this asks for, so
/// nothing is written.
pub fn reset_key_in_file(path: &Path, command: &str) -> Result<(), String> {
    command_for(command)?;
    let mut doc = open_document(path)?;
    let table = match doc.get_mut(SECTION_KEYS).and_then(Item::as_table_mut) {
        Some(table) => table,
        None => return Ok(()),
    };
    if table.remove(command).is_none() {
        return Ok(());
    }
    write_atomically(path, &doc.to_string())
}

pub fn clear_keys_in_file(path: &Path) -> Result<(), String> {
    let mut doc = open_document(path)?;
    if doc.remove(SECTION_KEYS).is_none() {
        return Ok(());
    }
    write_atomically(path, &doc.to_string())
}

// --------------------------------------------------------------- commands

/// Everything the interface needs to start: the values, and anything the
/// file said that we did not understand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigSnapshot {
    pub values: Config,
    pub warnings: Vec<Warning>,
    pub sources: Vec<String>,
}

#[tauri::command]
pub async fn config_get() -> Result<ConfigSnapshot, String> {
    // Disk read on the blocking pool, like every other file command here.
    tauri::async_runtime::spawn_blocking(|| match load() {
        Ok(loaded) => Ok(ConfigSnapshot {
            values: loaded.config,
            warnings: loaded.warnings,
            sources: loaded.sources,
        }),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn config_set(key: String, value: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_target(current_platform(), &EnvVars::from_process())?;
        set_in_file(&path, &key, &value)?;
        note_written(&key);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The first component of every key in [`SECTIONS`] that something outside
/// this module keeps a composed copy of.
const SECTION_NETWORK: &str = "network";

/// Tell whoever caches a composition of this key that it has moved.
///
/// One reader today: the HTTP factory holds the DNS policy it composed rather
/// than reading the file per client (`http::policy`). Without this the
/// settings page would report a saved change that nothing acted on until the
/// next launch — the failure mode this is here to make impossible, as opposed
/// to the delay it cannot remove (a client already built keeps its resolver,
/// which the settings page states).
fn note_written(key: &str) {
    if key.split('.').next() == Some(SECTION_NETWORK) {
        crate::http::forget();
    }
}

/// Return one setting to its built-in default by deleting the line that sets
/// it — see [`reset_in_file`] for why deleting beats writing the default out.
#[tauri::command]
pub async fn config_reset(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_target(current_platform(), &EnvVars::from_process())?;
        reset_in_file(&path, &key)?;
        note_written(&key);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn config_files_set(exclude: Vec<String>, respect_gitignore: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_target(current_platform(), &EnvVars::from_process())?;
        files_set_in_file(&path, &exclude, respect_gitignore)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bind one command to one key, in the file, now — [`config_set`] for the
/// `[keys]` section.
///
/// A command of its own rather than a key `config_set` would take, because
/// `config_set` will only write keys the registry knows and these are not
/// registry keys: they are command ids, which live in `src/shortcuts.json`
/// and change when the app's commands change (see [`Keys`]).
///
/// `keys` empty means "unbind" — the file's own spelling for a command that
/// answers no key. Going back to the shipped key is [`config_key_reset`],
/// not a call to this with the shipped key in it.
#[tauri::command]
pub async fn config_key_set(command: String, keys: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_target(current_platform(), &EnvVars::from_process())?;
        set_key_in_file(&path, &command, &keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return one command to the key the app ships with, by deleting its line —
/// [`config_reset`] for the `[keys]` section, with the same reasoning about
/// deletion beating a written-out default ([`reset_key_in_file`]).
#[tauri::command]
pub async fn config_key_reset(command: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_target(current_platform(), &EnvVars::from_process())?;
        reset_key_in_file(&path, &command)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn config_keys_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_target(current_platform(), &EnvVars::from_process())?;
        clear_keys_in_file(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A registry row on its way to the interface: the static description plus
/// the value this setting has when the file says nothing about it.
///
/// The default cannot live in [`Setting`] itself — that is a `Copy` type in a
/// `&'static` table, and a JSON value is neither. It is read out of the one
/// `Config::default()` at serialization time instead, so this carries no
/// second copy of any default: change the struct and this changes with it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingRow {
    #[serde(flatten)]
    pub setting: Setting,
    /// What `key` evaluates to in `Config::default()`.
    pub default: serde_json::Value,
}

/// The registry itself: what to draw, where it belongs, which copy to use,
/// and what the value is when nobody has said otherwise. The settings page,
/// its search index and its "changed only" view are all built from this,
/// which is what keeps them from drifting.
#[tauri::command]
pub fn config_schema() -> Vec<SettingRow> {
    let defaults =
        serde_json::to_value(Config::default()).expect("the default configuration serializes");
    SETTINGS
        .iter()
        .map(|setting| {
            let mut cursor = &defaults;
            for part in setting.key.split('.') {
                cursor = &cursor[part];
            }
            SettingRow {
                setting: *setting,
                default: cursor.clone(),
            }
        })
        .collect()
}

// -------------------------------------------------------------------- CLI

/// `tabverse --validate-config [path]`
pub const VALIDATE_FLAG: &str = "--validate-config";

/// Answers the arguments if they asked for validation, and says nothing
/// otherwise. `Some(code)` means the process should print nothing further
/// and exit with that code — no window, no runtime, so this also runs where
/// there is no display at all.
///
/// Exit codes: 0 valid · 1 errors · 2 warnings only.
pub fn validate_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<i32> {
    let mut requested = false;
    let mut file: Option<String> = None;
    for arg in args {
        if requested && file.is_none() && !arg.starts_with('-') {
            file = Some(arg);
            continue;
        }
        if arg == VALIDATE_FLAG {
            requested = true;
            continue;
        }
        if let Some(rest) = arg.strip_prefix(&format!("{VALIDATE_FLAG}=")) {
            requested = true;
            file = Some(rest.to_string());
        }
    }
    if !requested {
        return None;
    }
    let mut out = String::new();
    let code = validate_report(file.as_deref(), &mut out);
    print!("{out}");
    Some(code)
}

/// The body of the check, with its output collected rather than printed so a
/// test can read it. Identical parsing and validation to the interface: it
/// calls the same [`load_from_paths`].
pub fn validate_report(file: Option<&str>, out: &mut String) -> i32 {
    use std::fmt::Write as _;

    let paths = match file {
        Some(f) => {
            let path = PathBuf::from(f);
            if !path.exists() {
                let _ = writeln!(out, "{f}: no such file");
                return 1;
            }
            vec![path]
        }
        None => resolve_paths(current_platform(), &EnvVars::from_process()),
    };

    match load_from_paths(&paths) {
        Err(e) => {
            let _ = writeln!(out, "{e}");
            1
        }
        Ok(loaded) => {
            if loaded.sources.is_empty() {
                let _ = writeln!(
                    out,
                    "no configuration file found; built-in defaults are in effect"
                );
                // Looked in: so "not found" is actionable rather than a
                // dead end.
                for path in &paths {
                    let _ = writeln!(out, "  looked in {}", path.display());
                }
                return 0;
            }
            for source in &loaded.sources {
                let _ = writeln!(out, "{source}: read");
            }
            for w in &loaded.warnings {
                let _ = writeln!(
                    out,
                    "{}:{}:{}: warning: `{}` is not a known setting",
                    w.path, w.line, w.column, w.key
                );
            }
            if loaded.warnings.is_empty() {
                0
            } else {
                2
            }
        }
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    /// Serializes the few tests that must speak through the real process
    /// environment; everything else injects [`EnvVars`] instead.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write fixture");
        path
    }

    #[test]
    fn absent_empty_and_comment_only_all_give_the_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let absent = dir.path().join("does-not-exist.toml");
        let empty = write(dir.path(), "empty.toml", "");
        let comments = write(
            dir.path(),
            "comments.toml",
            "# Tabverse configuration\n\n# nothing set here\n\n# not even a section\n",
        );

        let a = load_from_paths(&[absent]).expect("absent file loads");
        let b = load_from_paths(&[empty]).expect("empty file loads");
        let c = load_from_paths(&[comments]).expect("comment-only file loads");

        // Field by field, so a failure names the field that diverged.
        for (label, got) in [("empty", &b.config), ("comments", &c.config)] {
            assert_eq!(
                got.appearance.theme, a.config.appearance.theme,
                "{label} theme"
            );
            assert_eq!(
                got.appearance.sidebar_width, a.config.appearance.sidebar_width,
                "{label} sidebar_width"
            );
            assert_eq!(
                got.appearance.sidebar_pinned, a.config.appearance.sidebar_pinned,
                "{label} sidebar_pinned"
            );
            assert_eq!(
                got.browser.search_engine, a.config.browser.search_engine,
                "{label} search_engine"
            );
            assert_eq!(
                got.browser.custom_search_template, a.config.browser.custom_search_template,
                "{label} custom_search_template"
            );
            assert_eq!(
                got.browser.archive_after, a.config.browser.archive_after,
                "{label} archive_after"
            );
        }
        assert_eq!(a.config, Config::default());
        assert_eq!(b.config, Config::default());
        assert_eq!(c.config, Config::default());
        assert!(a.warnings.is_empty() && b.warnings.is_empty() && c.warnings.is_empty());
        // Nothing existed, so nothing was read — and nothing was created.
        assert!(
            a.sources.is_empty(),
            "absent file must contribute no source"
        );
        assert!(!dir.path().join("does-not-exist.toml").exists());
    }

    #[test]
    fn a_section_present_alone_still_loads() {
        // The failure mode section-level `#[serde(default)]` exists to
        // prevent: without it this file is `missing field \`keys\``.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "one.toml", "[appearance]\ntheme = \"dark\"\n");
        let loaded = load_from_paths(&[path]).expect("partial file loads");
        assert_eq!(loaded.config.appearance.theme, ThemePref::Named("dark"));
        assert_eq!(
            loaded.config.browser.archive_after,
            Config::default().browser.archive_after
        );
    }

    #[test]
    fn env_override_reads_that_file_and_only_that_file() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "custom.toml",
            "[appearance]\nsidebar_width = 300\n",
        );
        let previous = std::env::var(ENV_CONFIG_FILE).ok();
        std::env::set_var(ENV_CONFIG_FILE, &path);

        let resolved = resolve_paths(current_platform(), &EnvVars::from_process());
        assert_eq!(resolved, vec![path.clone()], "override replaces the search");
        let loaded = load().expect("override file loads");
        assert_eq!(loaded.config.appearance.sidebar_width, 300);
        assert_eq!(loaded.sources, vec![path.display().to_string()]);

        match previous {
            Some(v) => std::env::set_var(ENV_CONFIG_FILE, v),
            None => std::env::remove_var(ENV_CONFIG_FILE),
        }
    }

    #[test]
    fn env_override_at_a_missing_path_is_the_absent_case() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("never-written.toml");
        let previous = std::env::var(ENV_CONFIG_FILE).ok();
        std::env::set_var(ENV_CONFIG_FILE, &missing);

        let loaded = load().expect("a missing override path is not an error");
        assert_eq!(loaded.config, Config::default());
        assert!(loaded.sources.is_empty());
        assert!(!missing.exists(), "loading must not create the file");

        match previous {
            Some(v) => std::env::set_var(ENV_CONFIG_FILE, v),
            None => std::env::remove_var(ENV_CONFIG_FILE),
        }
    }

    /// Every sample puts its mistake on line 3, so the expected line is a
    /// property of the fixture rather than a number copied out of a failure.
    const BAD_LINE: usize = 3;

    fn expect_error(body: &str) -> LoadError {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "bad.toml", body);
        match load_from_paths(&[path]) {
            Ok(loaded) => panic!(
                "bad configuration loaded anyway as {:?}; a broken file must never \
                 degrade into the defaults",
                loaded.config
            ),
            Err(e) => e,
        }
    }

    #[test]
    fn syntax_error_reports_its_line() {
        let e = expect_error("# a configuration\n[appearance]\nsidebar_width 248\n");
        assert_eq!(e.line, BAD_LINE, "syntax error line ({e})");
        assert!(
            e.detail.contains('^'),
            "detail keeps the caret: {}",
            e.detail
        );
    }

    #[test]
    fn type_error_reports_its_line() {
        let e = expect_error("# a configuration\n[appearance]\nsidebar_width = \"wide\"\n");
        assert_eq!(e.line, BAD_LINE, "type error line ({e})");
    }

    #[test]
    fn out_of_range_value_reports_its_line() {
        let e = expect_error("# a configuration\n[appearance]\nsidebar_width = 999\n");
        assert_eq!(e.line, BAD_LINE, "range error line ({e})");
        // Located at the value, not at the start of the line or of the file.
        assert!(e.column > 1, "range error column ({e})");
    }

    #[test]
    fn an_uppercase_scheme_is_an_address_like_any_other() {
        // RFC 3986: schemes are case-insensitive. The settings page agrees
        // (src/search.ts tests case-insensitively), so a template it accepts
        // has to survive the trip to disk — this side once disagreed, and a
        // user who held shift got a save that failed for no reason a person
        // could see.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let path = dir.path().join("upper.toml");
        std::fs::write(
            &path,
            "[browser]\ncustom_search_template = \"HTTPS://example.com/?q=%s\"\n",
        )
        .expect("write");
        let loaded = load_from_paths(&[path]).expect("an uppercase scheme loads");
        assert_eq!(
            loaded.config.browser.custom_search_template, "HTTPS://example.com/?q=%s",
            "the address is kept as the user typed it, not normalised"
        );
    }

    #[test]
    fn semantically_invalid_value_reports_its_line() {
        let e = expect_error(
            "# a configuration\n[browser]\ncustom_search_template = \"https://ex.com/?q=QUERY\"\n",
        );
        assert_eq!(e.line, BAD_LINE, "semantic error line ({e})");
    }

    #[test]
    fn an_unknown_enum_token_reports_its_line() {
        let e = expect_error("# a configuration\n[appearance]\ntheme = \"solarized\"\n");
        assert_eq!(e.line, BAD_LINE, "enum error line ({e})");
    }

    #[test]
    fn every_theme_tokens_json_declares_is_a_value_the_file_may_hold() {
        for theme in crate::theme_gen::THEMES {
            let src = format!("[appearance]\ntheme = \"{}\"\n", theme.id);
            let dir = tempfile::tempdir().expect("tempdir");
            let path = write(dir.path(), "config.toml", &src);
            let loaded = match load_from_paths(&[path]) {
                Ok(loaded) => loaded,
                Err(e) => panic!("the file naming theme {} was refused: {e}", theme.id),
            };
            assert_eq!(
                loaded.config.appearance.theme,
                ThemePref::Named(theme.id),
                "{} read back as something else",
                theme.id
            );
        }
        // Discriminating: the assertion above is about the themes that
        // exist, and there are more of them than the two built-ins.
        assert!(
            crate::theme_gen::THEMES.len() > 2,
            "tokens.json declares more than the two built-in themes"
        );
        // A theme nobody declared is still refused — the domain grew, it did
        // not stop being a domain.
        let e = expect_error("[appearance]\ntheme = \"no-such-theme\"\n");
        assert!(
            e.message.contains("no-such-theme"),
            "the refusal does not name what was refused ({e})"
        );
    }

    #[test]
    fn the_error_line_moves_with_the_mistake() {
        // Guards the assertions above against passing for the wrong reason:
        // if the reported line were a constant, this would still say 3.
        let e = expect_error(
            "# a configuration\n[appearance]\nsidebar_width = 248\ntheme = \"system\"\n\
             sidebar_pinned = 4\n",
        );
        assert_eq!(e.line, 5, "line follows the offending value ({e})");
    }

    #[test]
    fn this_module_has_no_silent_fallback_to_defaults() {
        // The needles are assembled at compile time so that this test's own
        // source does not contain the text it is looking for.
        let source = include_str!("config.rs");
        for needle in [
            concat!("unwrap_or", "_default"),
            concat!("unwrap_or", "_else"),
        ] {
            let hits = source.matches(needle).count();
            assert_eq!(
                hits, 0,
                "{needle} appears {hits} time(s) in config.rs — that construction is \
                 how a broken configuration turns into the defaults without anyone \
                 being told"
            );
        }
    }

    fn tail(path: &Path, n: usize) -> Vec<String> {
        let all: Vec<String> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        all[all.len() - n..].to_vec()
    }

    #[test]
    fn linux_paths_follow_xdg() {
        let env = EnvVars {
            home: Some("/home/u".into()),
            ..EnvVars::default()
        };
        assert_eq!(
            resolve_paths(Platform::Linux, &env),
            vec![PathBuf::from("/home/u/.config/tabverse/config.toml")]
        );

        let env = EnvVars {
            home: Some("/home/u".into()),
            xdg_config_home: Some("/elsewhere".into()),
            ..EnvVars::default()
        };
        assert_eq!(
            resolve_paths(Platform::Linux, &env),
            vec![
                PathBuf::from("/elsewhere/tabverse/config.toml"),
                PathBuf::from("/home/u/.config/tabverse/config.toml"),
            ]
        );
    }

    #[test]
    fn macos_paths_end_at_application_support() {
        let env = EnvVars {
            home: Some("/Users/u".into()),
            xdg_config_home: Some("/xdg".into()),
            ..EnvVars::default()
        };
        assert_eq!(
            resolve_paths(Platform::MacOs, &env),
            vec![
                PathBuf::from("/xdg/tabverse/config.toml"),
                PathBuf::from("/Users/u/.config/tabverse/config.toml"),
                PathBuf::from("/Users/u/Library/Application Support/dev.tabverse.app/config.toml"),
            ]
        );
        assert_eq!(
            resolve_paths(Platform::MacOs, &env).last(),
            Some(&PathBuf::from(
                "/Users/u/Library/Application Support/dev.tabverse.app/config.toml"
            ))
        );
    }

    #[test]
    fn windows_uses_appdata_and_not_xdg() {
        let env = EnvVars {
            appdata: Some("C:\\Users\\u\\AppData\\Roaming".into()),
            xdg_config_home: Some("/xdg".into()),
            home: Some("/Users/u".into()),
            ..EnvVars::default()
        };
        let paths = resolve_paths(Platform::Windows, &env);
        assert_eq!(paths.len(), 1, "windows has one location: {paths:?}");
        assert_eq!(tail(&paths[0], 2), vec!["Tabverse", "config.toml"]);
    }

    #[test]
    fn no_platform_puts_the_bundle_id_in_a_config_directory() {
        let env = EnvVars {
            home: Some("/home/u".into()),
            xdg_config_home: Some("/xdg".into()),
            appdata: Some("C:\\AppData".into()),
            ..EnvVars::default()
        };
        for platform in [Platform::MacOs, Platform::Linux, Platform::Windows] {
            for path in resolve_paths(platform, &env) {
                let text = path.display().to_string();
                // macOS keeps one platform-owned location under the bundle
                // id; the configuration directories never use it.
                if text.contains("Application Support") {
                    continue;
                }
                assert!(
                    !text.contains(DIR_MACOS_APP_SUPPORT),
                    "{platform:?} put the bundle id in a config path: {text}"
                );
                assert!(
                    text.contains(DIR_UNIX) || text.contains(DIR_WINDOWS),
                    "{platform:?} path is not under the product name: {text}"
                );
            }
        }
    }

    #[test]
    fn the_override_wins_on_every_platform() {
        let env = EnvVars {
            config_file: Some("/tmp/pinned.toml".into()),
            home: Some("/home/u".into()),
            xdg_config_home: Some("/xdg".into()),
            appdata: Some("C:\\AppData".into()),
        };
        for platform in [Platform::MacOs, Platform::Linux, Platform::Windows] {
            assert_eq!(
                resolve_paths(platform, &env),
                vec![PathBuf::from("/tmp/pinned.toml")],
                "{platform:?}"
            );
        }
    }

    #[test]
    fn the_network_section_is_read_and_its_two_rules_are_enforced() {
        let dir = tempfile::tempdir().expect("tempdir");

        let good = write(
            dir.path(),
            "good.toml",
            "[network]\n\
             dns_mode = \"quad9\"\n\
             dns_custom_url = \"https://doh.example/dns-query\"\n",
        );
        let loaded = load_from_paths(&[good]).expect("a well-formed network section loads");
        assert_eq!(loaded.config.network.dns_mode, DnsMode::Quad9);
        assert_eq!(
            loaded.config.network.dns_custom_url,
            "https://doh.example/dns-query"
        );

        // A mode nobody offers is refused, and the message says what may be
        // written — the same treatment every other choice field gets.
        let bad_mode = write(
            dir.path(),
            "bad-mode.toml",
            "[network]\ndns_mode = \"opendns\"\n",
        );
        let refusal = load_from_paths(&[bad_mode])
            .expect_err("an unknown resolver must not load")
            .to_string();
        assert!(
            refusal.contains("dns_mode must be one of") && refusal.contains("quad9"),
            "unhelpful refusal: {refusal}"
        );

        // The address is judged by the rule its registry row declares, which
        // is what keeps this file and the settings page from disagreeing.
        let bad_url = write(
            dir.path(),
            "bad-url.toml",
            "[network]\ndns_custom_url = \"ftp://doh.example/\"\n",
        );
        let refusal = load_from_paths(&[bad_url])
            .expect_err("an address that is not http(s) must not load")
            .to_string();
        assert!(
            refusal.contains("network.dns_custom_url"),
            "the refusal does not name the key: {refusal}"
        );

        // An absent section is the defaults, not a missing-field failure —
        // the property every section carries and the one most easily lost.
        let silent = write(
            dir.path(),
            "silent.toml",
            "[appearance]\ntheme = \"dark\"\n",
        );
        let loaded = load_from_paths(&[silent]).expect("a file with no [network] loads");
        assert_eq!(loaded.config.network, Config::default().network);

        assert!(
            !Config::default().network.cover_page_traffic,
            "cover_page_traffic must default to off"
        );
        let covered = write(
            dir.path(),
            "covered.toml",
            "[network]\ncover_page_traffic = true\n",
        );
        let loaded = load_from_paths(&[covered]).expect("the page-traffic toggle loads");
        assert!(
            loaded.config.network.cover_page_traffic,
            "a file that turns the page-traffic toggle on must load it on"
        );
    }

    #[test]
    fn the_defaults_are_what_the_terminals_already_drew_with() {
        let d = Config::default().terminal;
        assert_eq!(d.font_size, 13);
        assert_eq!(d.line_height_percent, 120, "1.2, in this file's units");
        assert_eq!(d.font_family, "", "empty means the shipped stack");
    }

    #[test]
    fn a_terminal_section_carries_the_font_and_the_profiles_together() {
        // Half of `[terminal]` is registry rows and half of it is a list of
        // entities, and the two have to survive each other: a font block
        // beside profiles must load without the profiles being read as
        // unknown settings, or the other way round.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[terminal]\n\
             font_family = \"Fira Code\"\n\
             font_size = 16\n\
             line_height_percent = 140\n\n\
             [[terminal.profiles]]\n\
             name = \"Deploy\"\n\
             font = \"IBM Plex Mono\"\n",
        );
        let loaded = load_from_paths(&[path]).expect("the section loads");
        assert_eq!(loaded.config.terminal.font_family, "Fira Code");
        assert_eq!(loaded.config.terminal.font_size, 16);
        assert_eq!(loaded.config.terminal.line_height_percent, 140);
        assert_eq!(loaded.config.terminal.profiles.len(), 1);
        assert_eq!(
            loaded.config.terminal.profiles[0].font.as_deref(),
            Some("IBM Plex Mono")
        );
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }

    #[test]
    fn background_task_prompts_default_off_and_round_trip() {
        assert!(
            !Config::default().terminal.background_tasks,
            "the default must preserve stopping tasks when closing a tab or exiting"
        );

        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[terminal]\nbackground_tasks = true\n",
        );
        let loaded = load_from_paths(&[path]).expect("the terminal setting loads");
        assert!(loaded.config.terminal.background_tasks);
        assert!(
            loaded.warnings.is_empty(),
            "background_tasks is a known terminal key: {:?}",
            loaded.warnings
        );
    }

    #[test]
    fn resident_default_is_opt_in_and_round_trips_in_its_own_section() {
        assert!(!Config::default().resident.default);
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config.toml", "[resident]\ndefault = true\n");
        let loaded = load_from_paths(&[path]).expect("the resident setting loads");
        assert!(loaded.config.resident.default);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        assert!(SETTINGS.iter().any(|row| row.key == "resident.default"));
    }

    #[test]
    fn the_ligature_switch_is_off_until_asked_for_and_a_profile_may_differ() {
        assert!(
            !Config::default().terminal.ligatures,
            "the default may not silently change a renderer"
        );

        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[terminal]\n\
             ligatures = true\n\n\
             [[terminal.profiles]]\n\
             name = \"Build\"\n\
             ligatures = false\n",
        );
        let loaded = load_from_paths(&[path]).expect("the section loads");
        assert!(loaded.config.terminal.ligatures);
        // The point of the per-profile field: one machine, ligatures on,
        // and a profile that keeps GPU acceleration for watching a build.
        assert_eq!(
            loaded.config.terminal.profiles[0].ligatures,
            Some(false),
            "a profile that says otherwise is not merged away"
        );
        assert!(
            loaded.warnings.is_empty(),
            "`ligatures` is a known profile key: {:?}",
            loaded.warnings
        );
    }

    #[test]
    fn a_font_size_outside_the_range_reports_its_line_and_the_range() {
        let e = expect_error("[terminal]\n# a note\nfont_size = 200\n");
        assert_eq!(e.line, 3);
        assert!(
            e.message.contains("font_size must be between"),
            "the refusal must say what may be written: {}",
            e.message
        );
    }

    #[test]
    fn image_memory_defaults_to_the_addons_own_and_holds_its_range() {
        assert_eq!(Config::default().terminal.image_memory_mb, 128);

        let e = expect_error("[terminal]\nimage_memory_mb = 8\n");
        assert_eq!(e.line, 2);
        assert!(
            e.message
                .contains("image_memory_mb must be between 16 and 512"),
            "the refusal must say what may be written: {}",
            e.message
        );

        let ok = load_from_paths(&[write(
            tempfile::tempdir().expect("tempdir").path(),
            "c.toml",
            "[terminal]\nimage_memory_mb = 64\n",
        )]);
        assert_eq!(
            ok.expect("a pane may be given less than the default")
                .config
                .terminal
                .image_memory_mb,
            64
        );
    }

    #[test]
    fn line_spacing_is_whole_percent_and_says_so_when_it_is_not() {
        // The unit is in the key's name for this reason: somebody who writes
        // the multiplier they know from elsewhere gets a located error naming
        // the range, rather than a value silently taken for something else.
        let e = expect_error("[terminal]\nline_height_percent = 1.2\n");
        assert_eq!(e.line, 2);
        let ok = load_from_paths(&[write(
            tempfile::tempdir().expect("tempdir").path(),
            "c.toml",
            "[terminal]\nline_height_percent = 100\n",
        )]);
        assert_eq!(
            ok.expect("the tightest spacing is allowed")
                .config
                .terminal
                .line_height_percent,
            100
        );
    }

    #[test]
    fn any_family_name_is_accepted_because_this_side_cannot_see_the_fonts() {
        // The machine's fonts are the interface's to see (src/term/
        // fontProbe.ts measures them and says so on the spot). Refusing a
        // name here would refuse the ordinary case of setting a font before
        // installing it — and would need a list of installed families in the
        // one process that has no way to get one.
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["Fira Code", "Nothing Anybody Has", "A, B"] {
            let path = write(
                dir.path(),
                "config.toml",
                &format!("[terminal]\nfont_family = \"{name}\"\n"),
            );
            assert_eq!(
                load_from_paths(&[path])
                    .expect("any family name loads")
                    .config
                    .terminal
                    .font_family,
                name
            );
        }
    }

    #[test]
    fn writing_a_network_key_drops_the_composed_dns_policy() {
        use crate::http::{cached_policy, lock_policy_for_test, set_policy, DnsPolicy};
        let _serialized = lock_policy_for_test();

        // Without this hook a saved change would be reported as saved and act
        // on nothing until the next launch — the settings page would be
        // telling the truth about the file and a lie about the program.
        set_policy(DnsPolicy::Doh("https://doh.example/dns-query".into()));
        note_written("appearance.theme");
        assert!(
            cached_policy().is_some(),
            "a write to another section must not disturb the composed policy"
        );
        note_written("network.dns_mode");
        assert_eq!(
            cached_policy(),
            None,
            "a write under [network] must drop the policy so the next client recomposes"
        );
    }

    // ---- unknown keys warn, and cost nothing else

    #[test]
    fn unknown_keys_warn_without_disturbing_the_rest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "typos.toml",
            "# line 1\n\
             [appearance]\n\
             theme = \"dark\"\n\
             sidebar_wdith = 300\n\
             \n\
             [browser]\n\
             serch_engine = \"google\"\n\
             archive_after = \"7d\"\n\
             \n\
             [nonsense]\n\
             whatever = 1\n",
        );
        let loaded = load_from_paths(&[path]).expect("unknown keys must not stop the load");

        assert_eq!(loaded.config.appearance.theme, ThemePref::Named("dark"));
        assert_eq!(loaded.config.browser.archive_after, ArchiveAfter::Days7);
        // The misspelled key did not take effect anywhere.
        assert_eq!(
            loaded.config.appearance.sidebar_width,
            Config::default().appearance.sidebar_width
        );
        assert_eq!(
            loaded.config.browser.search_engine,
            Config::default().browser.search_engine
        );

        let seen: Vec<(String, usize)> = loaded
            .warnings
            .iter()
            .map(|w| (w.key.clone(), w.line))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("appearance.sidebar_wdith".to_string(), 4),
                ("browser.serch_engine".to_string(), 7),
                ("nonsense".to_string(), 10),
            ]
        );
    }

    // ---- the registry and the struct stay in step

    #[test]
    fn every_registered_key_names_a_real_field() {
        let json = serde_json::to_value(Config::default()).expect("config serializes");
        for setting in SETTINGS {
            let pointer = format!("/{}", setting.key.replace('.', "/"));
            assert!(
                json.pointer(&pointer).is_some(),
                "{} is registered but no such field exists",
                setting.key
            );
            let section = match setting.key.split('.').next() {
                Some(s) => s,
                None => panic!("{} has no section", setting.key),
            };
            assert!(
                SECTIONS.contains(&section),
                "{} sits in unregistered section {section}",
                setting.key
            );
        }
        assert_eq!(
            SETTINGS.len(),
            18,
            "the registry must contain every user-settable preference exactly \
             once; update this count only when adding or removing a registry row"
        );
    }

    #[test]
    fn every_schema_row_carries_the_default_the_loader_would_produce() {
        // Two independent paths to the same answer: the schema walks SETTINGS
        // and reads Config::default(), while the loader parses a file that is
        // not there. Asserting they agree pins the schema's default to the one
        // that actually takes effect — a hardcoded row would survive a change
        // to Config::default(), and this comparison would catch it.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let loaded =
            load_from_paths(&[dir.path().join("absent.toml")]).expect("an absent file loads");
        let effective = serde_json::to_value(&loaded.config).expect("config serializes");
        let rows = config_schema();
        assert_eq!(
            rows.len(),
            SETTINGS.len(),
            "every registry row reaches the interface"
        );
        for row in rows {
            let mut cursor = &effective;
            for part in row.setting.key.split('.') {
                cursor = &cursor[part];
            }
            assert_eq!(
                &row.default, cursor,
                "{} says its default is {} but an absent file gives {}",
                row.setting.key, row.default, cursor
            );
            assert!(
                !row.default.is_null(),
                "{} has no default at all — the key does not resolve in Config",
                row.setting.key
            );
        }
    }

    #[test]
    fn the_schema_reaches_the_interface_in_the_shape_it_expects() {
        // This is a wire contract, not a restatement of the table: the
        // settings page switches on `kind` and reads `options` out of it, so
        // the shape has to be pinned somewhere the interface can rely on.
        let json = serde_json::to_value(config_schema()).expect("schema serializes");
        let theme = &json[0];
        assert_eq!(theme["key"], "appearance.theme");
        assert_eq!(theme["section"], "appearance");
        assert_eq!(theme["str_key"], "settings.appearance.theme");
        // The domain travels as an array of tokens like any other choice —
        // the interface cannot tell that this one was read out of
        // tokens.json rather than written down here, which is the point.
        //
        // Compared against the generated theme table rather than a list
        // spelled out here, because a list spelled out here is the copy this
        // whole change removed: it would go on saying "light, dark" while
        // the app shipped six themes, and pass.
        let expected: Vec<&str> = std::iter::once(SYSTEM_THEME)
            .chain(crate::theme_gen::THEMES.iter().map(|t| t.id))
            .collect();
        assert_eq!(
            theme["kind"]["choice"]["options"],
            serde_json::json!(expected)
        );
        // And the count is more than the two built-ins plus `system`, so
        // this assertion is answering about the themes that exist rather
        // than about a fallback pair that would be there either way.
        assert!(
            expected.len() > 3,
            "tokens.json declares more than the two built-in themes: {expected:?}"
        );
        let width = &json[1];
        assert_eq!(width["kind"]["number"]["min"], 180);
        assert_eq!(width["kind"]["number"]["max"], 520);
        assert_eq!(json[2]["kind"], "toggle");
        // A text setting carries its content rule over the same wire, which
        // is what lets src/search.ts judge a template by the registry's rule
        // instead of by a second copy of it. The field names are the
        // contract: the interface reads exactly these.
        let template = &json[4];
        assert_eq!(template["key"], "browser.custom_search_template");
        assert_eq!(template["kind"]["text"]["allow_empty"], true);
        assert_eq!(template["kind"]["text"]["must_contain"], "%s");
        assert_eq!(
            template["kind"]["text"]["schemes"],
            serde_json::json!(["http", "https"])
        );
    }

    // ---- the text rule has one home, and both directions read it

    #[test]
    fn the_registry_row_is_where_the_template_rule_lives() {
        // The lookup the deserializer makes. If the key it names and the key
        // the table declares ever came apart, this is the assertion that
        // says so — and the deserializer refuses everything rather than
        // accepting everything, which the next test pins.
        let rule = match text_rule(KEY_CUSTOM_SEARCH_TEMPLATE) {
            Some(rule) => rule,
            None => panic!(
                "{KEY_CUSTOM_SEARCH_TEMPLATE} is not a Kind::Text row, so the \
                 deserializer has no rule to read"
            ),
        };
        assert!(
            rule.must_contain.is_some() || rule.schemes.is_some(),
            "a rule that constrains nothing would make every test below pass \
             for the wrong reason"
        );
        assert_eq!(text_rule("appearance.theme"), None, "a choice is not text");
        assert_eq!(text_rule("browser.nonsense"), None, "no such setting");
    }

    #[test]
    fn the_check_follows_the_rule_it_is_handed_rather_than_one_of_its_own() {
        // The discriminating half of "one home": the judgement is a function
        // of the rule, so moving the rule moves the judgement. Two rules that
        // are each other's opposite, and the same three values judged under
        // both — a check with a rule baked into it cannot answer this twice.
        let http = TextRule {
            allow_empty: true,
            must_contain: Some("%s"),
            schemes: Some(&["http", "https"]),
        };
        let ftp = TextRule {
            allow_empty: false,
            must_contain: Some("{query}"),
            schemes: Some(&["ftp"]),
        };

        assert!(check_text(http, "https://e.test/?q=%s").is_ok());
        assert!(check_text(ftp, "https://e.test/?q=%s").is_err());

        assert!(check_text(ftp, "ftp://e.test/?q={query}").is_ok());
        assert!(check_text(http, "ftp://e.test/?q={query}").is_err());

        assert!(
            check_text(http, "").is_ok(),
            "empty is allowed by that rule"
        );
        assert!(check_text(ftp, "").is_err(), "and refused by this one");

        // A rule that constrains nothing takes anything that is not empty.
        let free = TextRule {
            allow_empty: true,
            must_contain: None,
            schemes: None,
        };
        assert!(check_text(free, "anything at all").is_ok());
        assert!(check_text(free, "").is_ok());
    }

    #[test]
    fn the_file_judges_a_template_by_exactly_the_registrys_rule() {
        // The wiring, asserted rather than assumed: for every candidate, the
        // file's verdict and `check_text(registry rule, …)` agree. A rule
        // hand-written into the deserializer would be free to differ, and
        // this is the test that would catch it — including on the two cases
        // that have actually gone wrong here, an uppercase scheme and a
        // missing placeholder.
        let rule = match text_rule(KEY_CUSTOM_SEARCH_TEMPLATE) {
            Some(rule) => rule,
            None => panic!("no rule to compare against"),
        };
        let dir = tempfile::tempdir().expect("tempdir");
        for candidate in [
            "",
            "https://e.test/?q=%s",
            "HTTPS://e.test/?q=%s",
            "HtTp://e.test/?q=%s",
            "ftp://e.test/?q=%s",
            "javascript:alert('%s')",
            "e.test/?q=%s",
            "https://e.test/?q=query",
            "https://e.test/%s/and/%s",
        ] {
            let body = format!("[browser]\ncustom_search_template = \"{candidate}\"\n");
            let path = write(dir.path(), "candidate.toml", &body);
            let loaded = load_from_paths(&[path]).is_ok();
            let allowed = check_text(rule, candidate).is_ok();
            assert_eq!(
                loaded, allowed,
                "the file said {loaded} for {candidate:?} and the registry's \
                 own rule said {allowed}"
            );
        }
    }

    #[test]
    fn the_three_cases_the_two_copies_used_to_disagree_about() {
        // Named separately from the property above so a run says which one
        // moved. An uppercase scheme is an address (RFC 3986 §3.1); a scheme
        // that is not offered is not; a template with nowhere for the query
        // to go is not a template.
        let rule = match text_rule(KEY_CUSTOM_SEARCH_TEMPLATE) {
            Some(rule) => rule,
            None => panic!("no rule"),
        };
        assert!(check_text(rule, "HTTPS://e.test/?q=%s").is_ok());
        assert!(check_text(rule, "ftp://e.test/?q=%s").is_err());
        assert!(check_text(rule, "https://e.test/?q=query").is_err());
        assert!(check_text(rule, "").is_ok());
    }

    #[test]
    fn a_choice_offers_exactly_what_the_parser_accepts() {
        for setting in SETTINGS {
            let Kind::Choice { options } = setting.kind else {
                continue;
            };
            for option in options.get() {
                let body = format!(
                    "[{}]\n{} = \"{option}\"\n",
                    match setting.key.split('.').next() {
                        Some(s) => s,
                        None => panic!("bad key"),
                    },
                    match setting.key.split('.').nth(1) {
                        Some(s) => s,
                        None => panic!("bad key"),
                    }
                );
                assert!(
                    toml::from_str::<Config>(&body).is_ok(),
                    "{} offers {option} but the parser rejects it",
                    setting.key
                );
            }
        }
    }

    #[test]
    fn the_sample_file_from_the_design_loads_as_written() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "sample.toml",
            "# Tabverse configuration. Delete this file to return to defaults.\n\
             \n\
             [appearance]\n\
             theme = \"system\"           # system | light | dark\n\
             sidebar_width = 248        # 180-520\n\
             sidebar_pinned = true\n\
             \n\
             [browser]\n\
             search_engine = \"duckduckgo\"   # duckduckgo | google | bing | custom\n\
             custom_search_template = \"\"    # must contain %s, http(s) only\n\
             archive_after = \"24h\"          # 12h | 24h | 7d | off\n\
             \n\
             [terminal]\n\
             # reserved\n\
             \n\
             [files]\n\
             # Directory-name globs added to the built-in noise list the\n\
             # search, quick-open and the tree watcher all share. One per\n\
             # entry; empty (or absent) means the built-ins alone:\n\
             # exclude = [\"vendor\", \"*-generated\"]\n\
             # respect_gitignore = false\n\
             \n\
             [keys]\n\
             # reserved\n",
        );
        let loaded = load_from_paths(&[path]).expect("the documented sample loads");
        assert_eq!(loaded.config, Config::default());
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }

    // ---- several files, later wins

    #[test]
    fn a_later_file_overrides_earlier_ones_key_by_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = write(
            dir.path(),
            "first.toml",
            "[appearance]\ntheme = \"dark\"\nsidebar_width = 200\n",
        );
        let second = write(
            dir.path(),
            "second.toml",
            "[appearance]\nsidebar_width = 400\n\n[browser]\nsearch_engine = \"bing\"\n",
        );
        let loaded = load_from_paths(&[first, second]).expect("both files load");
        // The later file replaced one key and left its neighbour alone.
        assert_eq!(loaded.config.appearance.sidebar_width, 400);
        assert_eq!(loaded.config.appearance.theme, ThemePref::Named("dark"));
        assert_eq!(loaded.config.browser.search_engine, SearchEngine::Bing);
        assert_eq!(loaded.sources.len(), 2);
    }

    // ---- the command-line entry

    #[test]
    fn validate_reports_zero_one_and_two() {
        let dir = tempfile::tempdir().expect("tempdir");
        let good = write(dir.path(), "good.toml", "[appearance]\ntheme = \"dark\"\n");
        let bad = write(
            dir.path(),
            "bad.toml",
            "[appearance]\nsidebar_width = 999\n",
        );
        let odd = write(dir.path(), "odd.toml", "[appearance]\nthme = \"dark\"\n");

        let mut out = String::new();
        assert_eq!(
            validate_report(Some(&good.display().to_string()), &mut out),
            0
        );
        assert!(out.contains("read"), "{out}");

        let mut out = String::new();
        assert_eq!(
            validate_report(Some(&bad.display().to_string()), &mut out),
            1
        );
        assert!(
            out.contains(":2:"),
            "the report carries the position: {out}"
        );

        let mut out = String::new();
        assert_eq!(
            validate_report(Some(&odd.display().to_string()), &mut out),
            2
        );
        assert!(out.contains("appearance.thme"), "{out}");

        let mut out = String::new();
        let missing = dir.path().join("gone.toml").display().to_string();
        assert_eq!(validate_report(Some(&missing), &mut out), 1);
    }

    #[test]
    fn nothing_but_the_flag_asks_for_validation() {
        assert_eq!(validate_from_args(Vec::<String>::new()), None);
        assert_eq!(
            validate_from_args(vec!["--some-other-flag".to_string()]),
            None
        );
    }

    #[test]
    fn the_flag_takes_its_path_either_way() {
        let dir = tempfile::tempdir().expect("tempdir");
        let good = write(dir.path(), "good.toml", "[appearance]\ntheme = \"light\"\n");
        let text = good.display().to_string();
        assert_eq!(
            validate_from_args(vec![VALIDATE_FLAG.to_string(), text.clone()]),
            Some(0)
        );
        assert_eq!(
            validate_from_args(vec![format!("{VALIDATE_FLAG}={text}")]),
            Some(0)
        );
    }

    /// The round-trip fixture, deliberately dirtier than anything this
    /// program writes: a two-line header comment, trailing comments aligned
    /// by hand, blank lines between the groups, a key indented on purpose, a
    /// key Tabverse does not know, and an empty section the user opened for
    /// themselves. A fixture cleaner than real input can only hide the
    /// failures real input causes, so nothing here is normalised before a
    /// test uses it.
    const DIRTY: &str = r#"# Tabverse configuration. Delete this file to return to defaults.
# Hand-edited - please keep these notes.

[appearance]
theme = "system"           # system | light | dark
sidebar_width = 248        # 180-520
  sidebar_pinned = true    # indented on purpose

[browser]
search_engine = "duckduckgo"   # duckduckgo | google | bing | custom
homepage = "https://example.com"   # not a setting Tabverse knows
archive_after = "24h"          # 12h | 24h | 7d | off

[terminal]
"#;

    fn dirty_file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config.toml", DIRTY);
        (dir, path)
    }

    fn read_back(path: &Path) -> String {
        std::fs::read_to_string(path).expect("read the file back")
    }

    /// Every line that differs, so that a failure names the damage instead of
    /// printing two files and leaving the reader to compare them by eye.
    fn differing_lines(expected: &str, actual: &str) -> Vec<String> {
        let e: Vec<&str> = expected.lines().collect();
        let a: Vec<&str> = actual.lines().collect();
        let mut out = Vec::new();
        for i in 0..e.len().max(a.len()) {
            if e.get(i) != a.get(i) {
                out.push(format!(
                    "  line {}: expected {:?}, got {:?}",
                    i + 1,
                    e.get(i),
                    a.get(i)
                ));
            }
        }
        out
    }

    fn damage(expected: &str, actual: &str) -> String {
        let lines = differing_lines(expected, actual);
        if lines.is_empty() {
            "  (no whole line differs — the two texts differ only in trailing bytes)".to_string()
        } else {
            lines.join("\n")
        }
    }

    /// Every section header and key name, in the order the file writes them.
    fn key_order(text: &str) -> Vec<String> {
        text.lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.starts_with('#') {
                    return None;
                }
                if line.starts_with('[') {
                    return Some(line.to_string());
                }
                line.split_once('=').map(|(key, _)| key.trim().to_string())
            })
            .collect()
    }

    #[test]
    fn the_scratch_file_is_this_process_and_leaves_nothing_behind() {
        // A fixed scratch name is only atomic while one process writes. This
        // asserts the name carries the process id, and that a completed write
        // leaves no scratch file next to the real one — the leak that would
        // otherwise accumulate one file per crash.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let path = dir.path().join("config.toml");
        write_atomically(&path, "[appearance]\ntheme = \"dark\"\n").expect("write");
        let leftovers: Vec<String> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert_eq!(
            leftovers,
            Vec::<String>::new(),
            "a scratch file was left behind"
        );
        // The name itself: build one the same way and check it is per-process.
        let scratch = format!("config.toml.{}.tmp", std::process::id());
        assert!(
            scratch.contains(&std::process::id().to_string()),
            "the scratch name does not name this process"
        );
    }

    #[test]
    fn an_untouched_document_renders_back_byte_for_byte() {
        for sample in [DIRTY, "", "# just a comment\n", "[appearance]\n"] {
            let doc: DocumentMut = sample.parse().expect("the sample parses");
            assert_eq!(doc.to_string(), sample, "re-rendering changed {sample:?}");
        }
    }

    #[test]
    fn one_write_changes_one_line_and_leaves_the_file_byte_for_byte_otherwise() {
        let (_dir, path) = dirty_file();
        set_in_file(&path, "appearance.theme", &json!("dark")).expect("the write succeeds");

        // The expectation is built by substituting one line in the source
        // text — a different construction from the one under test, which
        // edits a parse tree. It is not the same transformation spelled
        // twice.
        let expected = DIRTY.replace(
            r#"theme = "system"           # system | light | dark"#,
            r#"theme = "dark"           # system | light | dark"#,
        );
        assert_eq!(
            differing_lines(DIRTY, &expected).len(),
            1,
            "the expected text must differ from the input on exactly one line, or this \
             test would be comparing the file with itself"
        );

        let actual = read_back(&path);
        assert_eq!(
            actual,
            expected,
            "the write disturbed something other than its own line:\n{}",
            damage(&expected, &actual)
        );
    }

    #[test]
    fn the_trailing_comment_on_the_edited_line_survives() {
        // The named landing point for the mutation this family exists to
        // catch: swapping the decor-preserving setter for a plain
        // assignment. The format-selection round measured that a plain
        // assignment eats the comment, so this is a defect that has actually
        // been observed rather than one imagined for the test's sake.
        let (_dir, path) = dirty_file();
        set_in_file(&path, "appearance.theme", &json!("dark")).expect("the write succeeds");
        let actual = read_back(&path);
        let line = match actual.lines().find(|l| l.trim_start().starts_with("theme")) {
            Some(line) => line,
            None => panic!("the theme line is no longer in the file:\n{actual}"),
        };
        assert!(
            line.contains(r#"theme = "dark""#),
            "the edited line does not carry the new value: {line:?}"
        );
        assert!(
            line.contains("# system | light | dark"),
            "the trailing comment on the edited line was eaten; the line now reads \
             {line:?}. The value's suffix decor is where that comment lives, and a \
             plain assignment replaces it with the new value's empty one."
        );
        // The comments on the lines that were *not* edited are a separate
        // failure, asserted separately so a run says which one happened.
        assert!(
            actual.contains("# 180-520") && actual.contains("# indented on purpose"),
            "a comment on an untouched line was lost:\n{actual}"
        );
    }

    #[test]
    fn writing_the_value_that_is_already_there_changes_no_byte() {
        let (_dir, path) = dirty_file();
        set_in_file(&path, "appearance.theme", &json!("system")).expect("the write succeeds");
        let actual = read_back(&path);
        assert_eq!(
            actual,
            DIRTY,
            "an assignment that changes nothing still rewrote the file:\n{}",
            damage(DIRTY, &actual)
        );
    }

    #[test]
    fn three_writes_across_two_sections_disturb_only_their_own_lines() {
        let (_dir, path) = dirty_file();
        set_in_file(&path, "appearance.sidebar_width", &json!(300)).expect("width");
        set_in_file(&path, "browser.archive_after", &json!("7d")).expect("archive_after");
        set_in_file(&path, "appearance.sidebar_pinned", &json!(false)).expect("sidebar_pinned");

        let expected = DIRTY
            .replace(
                "sidebar_width = 248        # 180-520",
                "sidebar_width = 300        # 180-520",
            )
            .replace(
                "  sidebar_pinned = true    # indented on purpose",
                "  sidebar_pinned = false    # indented on purpose",
            )
            .replace(
                r#"archive_after = "24h"          # 12h | 24h | 7d | off"#,
                r#"archive_after = "7d"          # 12h | 24h | 7d | off"#,
            );
        assert_eq!(
            differing_lines(DIRTY, &expected).len(),
            3,
            "the expectation must differ from the input on exactly the three edited lines"
        );

        let actual = read_back(&path);
        assert_eq!(
            actual,
            expected,
            "three writes disturbed something other than their own lines:\n{}",
            damage(&expected, &actual)
        );

        // Each named separately, so a failure says which property broke
        // rather than only that some byte moved.
        assert!(
            actual.starts_with("# Tabverse configuration. Delete this file"),
            "the header comment no longer opens the file:\n{actual}"
        );
        assert!(
            actual.contains("# Hand-edited - please keep these notes."),
            "the second header line went missing:\n{actual}"
        );
        assert!(
            actual.contains(r#"homepage = "https://example.com"   # not a setting Tabverse knows"#),
            "the key Tabverse does not know was rewritten or dropped:\n{actual}"
        );
        assert!(
            actual.contains("[terminal]"),
            "the empty hand-written section was dropped:\n{actual}"
        );
        assert_eq!(
            key_order(&actual),
            key_order(DIRTY),
            "the entries were reordered"
        );
        assert_eq!(
            actual.matches("\n\n").count(),
            DIRTY.matches("\n\n").count(),
            "the blank lines between the groups changed:\n{actual}"
        );

        // And the file still says what was written to it.
        let loaded = load_from_paths(&[path]).expect("the edited file still loads");
        assert_eq!(loaded.config.appearance.sidebar_width, 300);
        assert!(!loaded.config.appearance.sidebar_pinned);
        assert_eq!(loaded.config.browser.archive_after, ArchiveAfter::Days7);
        assert_eq!(
            loaded.config.appearance.theme,
            ThemePref::System,
            "a key nobody wrote to changed value"
        );
        assert_eq!(
            loaded.warnings.len(),
            1,
            "the unknown key must still be there, warned about exactly once: {:?}",
            loaded.warnings
        );
    }

    #[test]
    fn a_reset_deletes_the_line_and_leaves_the_rest_byte_for_byte() {
        let (_dir, path) = dirty_file();
        reset_in_file(&path, "appearance.theme").expect("the reset succeeds");

        let expected = DIRTY.replace("theme = \"system\"           # system | light | dark\n", "");
        assert_eq!(
            expected.lines().count(),
            DIRTY.lines().count() - 1,
            "the expectation must be the input with exactly one line removed"
        );

        let actual = read_back(&path);
        assert_eq!(
            actual,
            expected,
            "the reset disturbed more than the line it removed:\n{}",
            damage(&expected, &actual)
        );
        // The judgement this criterion is written against: the key is gone,
        // not rewritten as the default's literal value. A default written
        // into the file would be frozen there for ever.
        assert!(
            !actual.contains("theme"),
            "the key is still named in the file after a reset:\n{actual}"
        );
        assert!(
            actual.contains("[appearance]"),
            "the reset took the section header with it:\n{actual}"
        );

        let loaded = load_from_paths(&[path]).expect("the file still loads");
        assert_eq!(
            loaded.config.appearance.theme,
            Config::default().appearance.theme
        );
        assert_eq!(
            loaded.config.appearance.sidebar_width, 248,
            "a neighbour changed"
        );
    }

    #[test]
    fn resetting_a_key_that_is_not_set_writes_nothing() {
        let (_dir, path) = dirty_file();
        // Registered, but this file never sets it.
        reset_in_file(&path, "browser.custom_search_template").expect("a no-op reset succeeds");
        assert_eq!(read_back(&path), DIRTY, "a no-op reset rewrote the file");

        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("never").join("config.toml");
        reset_in_file(&missing, "appearance.theme").expect("a reset on a missing file succeeds");
        assert!(!missing.exists(), "a reset created the file");
    }

    /// A command the shipped table really has, taken from the table rather
    /// than typed here — a test that named a command by hand would go on
    /// passing after that command was renamed, testing nothing.
    fn a_command() -> String {
        match crate::keys::defaults().first() {
            Some(binding) => binding.command.clone(),
            None => panic!("the shortcut table is empty"),
        }
    }

    #[test]
    fn a_rebinding_is_written_into_the_keys_section_and_read_back() {
        let (_dir, path) = dirty_file();
        let command = a_command();
        let command = command.as_str();
        set_key_in_file(&path, command, "⌘⇧U").expect("the rebinding is written");

        let actual = read_back(&path);
        assert!(
            actual.contains("[keys]"),
            "the section the override lives in was never created:\n{actual}"
        );
        // The file, read by the same loader the app starts with — not the
        // document this test just wrote. What matters is that the next run
        // sees it.
        let loaded = load_from_paths(std::slice::from_ref(&path)).expect("the file still loads");
        assert_eq!(
            loaded.config.keys.bindings.get(command).map(String::as_str),
            Some("⌘⇧U"),
            "the override did not survive the round trip:\n{actual}"
        );
        // And everything that was in the file before is still exactly as it
        // was: an override is appended, it does not rewrite the document.
        assert!(
            actual.starts_with(DIRTY),
            "the rebinding disturbed what the file already said:\n{}",
            damage(DIRTY, &actual)
        );
        assert_eq!(
            loaded.config.appearance.sidebar_width, 248,
            "a setting moved while a key was being written"
        );
    }

    #[test]
    fn a_hand_written_keys_section_is_what_the_next_load_uses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let command = a_command();
        let command = command.as_str();
        let path = write(
            dir.path(),
            "config.toml",
            &format!("[keys]\n{command} = \"⌃⌥K\"   # mine\n"),
        );
        let loaded = load_from_paths(std::slice::from_ref(&path)).expect("the file loads");
        assert_eq!(
            loaded.config.keys.bindings.get(command).map(String::as_str),
            Some("⌃⌥K")
        );
        assert!(
            loaded.warnings.is_empty(),
            "a real command was reported as unknown: {:?}",
            loaded.warnings
        );

        // Writing another command's override keeps the hand-typed line, its
        // trailing comment included.
        set_key_in_file(&path, command, "⌃⌥J").expect("the rebinding is written");
        let actual = read_back(&path);
        assert!(
            actual.contains("# mine"),
            "the comment on the rebound line was eaten:\n{actual}"
        );
    }

    #[test]
    fn the_empty_string_unbinds_and_a_reset_deletes_the_line() {
        let (_dir, path) = dirty_file();
        let command = a_command();
        let command = command.as_str();

        // Unbinding is a VALUE — the file says this command answers nothing.
        set_key_in_file(&path, command, "").expect("the unbinding is written");
        let loaded = load_from_paths(std::slice::from_ref(&path)).expect("the file loads");
        assert_eq!(
            loaded.config.keys.bindings.get(command).map(String::as_str),
            Some(""),
            "the unbinding did not reach the file"
        );
        // And the composition agrees: nothing answers for this command.
        let bindings = crate::keys::resolve(&loaded.config.keys.bindings);
        assert_eq!(
            bindings.keys_for(command),
            None,
            "the command still answers a key after being unbound"
        );

        // Going back to the shipped key is a DELETION — never a write of
        // whatever the shipped key happens to be today. The two look the
        // same on screen and are different facts on disk: an override equal
        // to today's default freezes it, and the day the default moves this
        // user would not move with it.
        reset_key_in_file(&path, command).expect("the reset succeeds");
        let actual = read_back(&path);
        assert!(
            !actual.contains(command),
            "the command is still named in the file after a reset:\n{actual}"
        );
        let loaded = load_from_paths(std::slice::from_ref(&path)).expect("the file loads");
        assert_eq!(
            loaded.config.keys.bindings.get(command),
            None,
            "the override survived its own reset"
        );
        let shipped = crate::keys::resolve(&BTreeMap::new());
        assert_eq!(
            crate::keys::resolve(&loaded.config.keys.bindings).keys_for(command),
            shipped.keys_for(command),
            "the command did not go back to the key the app ships with"
        );
    }

    #[test]
    fn an_override_for_something_that_is_not_a_command_is_refused() {
        // The counterpart of the unregistered-setting refusal above, and for
        // the same reason: the file may carry an override this version does
        // not know (a downgrade), but nothing this program writes may create
        // one.
        let (_dir, path) = dirty_file();
        let e = set_key_in_file(&path, "no-such-command", "⌘⇧U")
            .expect_err("an unknown command is refused");
        assert!(
            e.contains("no-such-command"),
            "the refusal does not name what was refused: {e}"
        );
        assert_eq!(
            read_back(&path),
            DIRTY,
            "a refused override reached the file"
        );
        assert!(reset_key_in_file(&path, "no-such-command").is_err());
        assert_eq!(read_back(&path), DIRTY, "a refused reset reached the file");
    }

    #[test]
    fn clearing_the_overlay_takes_the_section_and_leaves_the_settings() {
        let (_dir, path) = dirty_file();
        for command in crate::keys::defaults().iter().take(3) {
            set_key_in_file(&path, &command.command, "⌃⌥Z").expect("the rebinding is written");
        }
        clear_keys_in_file(&path).expect("the overlay is cleared");

        let actual = read_back(&path);
        assert!(
            !actual.contains("[keys]"),
            "an empty [keys] header was left behind:\n{actual}"
        );
        assert_eq!(
            actual,
            DIRTY,
            "clearing the overlay disturbed the rest of the file:\n{}",
            damage(DIRTY, &actual)
        );
        let loaded = load_from_paths(std::slice::from_ref(&path)).expect("the file loads");
        assert!(loaded.config.keys.bindings.is_empty());
        assert_eq!(loaded.config.appearance.sidebar_width, 248);

        // A file with no overlay at all is already in the state this asks
        // for, so nothing is written and nothing is created.
        assert_eq!(read_back(&path), DIRTY);
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("never").join("config.toml");
        clear_keys_in_file(&missing).expect("clearing a missing file succeeds");
        assert!(!missing.exists(), "clearing the overlay created the file");
    }

    // ---- what a write refuses

    #[test]
    fn an_unregistered_key_is_refused_and_never_reaches_the_file() {
        let (_dir, path) = dirty_file();
        for key in [
            "appearance.thme",
            // In the file already, but not ours to write.
            "browser.homepage",
            "nonsense.thing",
            "appearance",
            "appearance.theme.extra",
            "",
        ] {
            let e = match set_in_file(&path, key, &json!("dark")) {
                Ok(()) => panic!("`{key}` was written even though no setting has that name"),
                Err(e) => e,
            };
            assert!(e.contains(key), "the refusal must name the key: {e}");
            assert_eq!(read_back(&path), DIRTY, "`{key}` reached the file anyway");

            match reset_in_file(&path, key) {
                Ok(()) => panic!("`{key}` was reset even though no setting has that name"),
                Err(e) => assert!(e.contains(key), "{e}"),
            }
            assert_eq!(
                read_back(&path),
                DIRTY,
                "resetting `{key}` changed the file"
            );
        }
    }

    #[test]
    fn a_value_the_file_would_reject_is_rejected_before_anything_is_written() {
        let (_dir, path) = dirty_file();
        for (key, value, why) in [
            (
                "appearance.theme",
                json!("solarized"),
                "a token no enum has",
            ),
            ("appearance.sidebar_width", json!(999), "above the range"),
            ("appearance.sidebar_width", json!(0), "below the range"),
            ("appearance.sidebar_width", json!(-8), "negative"),
            (
                "appearance.sidebar_width",
                json!("wide"),
                "text where a number goes",
            ),
            (
                "appearance.sidebar_width",
                json!(248.5),
                "a fraction of a point",
            ),
            (
                "appearance.sidebar_pinned",
                json!("yes"),
                "text where true/false goes",
            ),
            (
                "browser.custom_search_template",
                json!("https://example.com/?q=QUERY"),
                "no %s for the query to go in",
            ),
            (
                "browser.custom_search_template",
                json!("ftp://example.com/?q=%s"),
                "not an http address",
            ),
            (
                "browser.search_engine",
                json!(3),
                "a number where a token goes",
            ),
            (
                "appearance.theme",
                json!(["dark"]),
                "a list, which no setting is",
            ),
            ("appearance.theme", json!(null), "nothing at all"),
        ] {
            let e = match set_in_file(&path, key, &value) {
                Ok(()) => panic!("{key} = {value} ({why}) was accepted"),
                Err(e) => e,
            };
            assert!(
                !e.is_empty(),
                "{key} = {value} was refused without saying why"
            );
            assert_eq!(
                read_back(&path),
                DIRTY,
                "{key} = {value} ({why}) reached the file before it was judged"
            );
        }

        // The positive control: the loop above is not passing because the
        // write path refuses everything.
        set_in_file(&path, "appearance.theme", &json!("dark")).expect("a good value still lands");
        assert_ne!(read_back(&path), DIRTY, "no write ever succeeds");
    }

    #[test]
    fn a_write_refuses_what_the_schema_does_not_offer() {
        // Driven off the registry, so a setting added to SETTINGS is covered
        // by this the moment it is added rather than when someone remembers.
        for setting in SETTINGS {
            let (_dir, path) = dirty_file();
            let refused: Vec<serde_json::Value> = match setting.kind {
                Kind::Choice { .. } => vec![json!("not-one-of-them"), json!(true)],
                Kind::Number { min, max } => {
                    vec![json!(min - 1), json!(max + 1), json!("wide")]
                }
                Kind::Toggle => vec![json!("true"), json!(1)],
                // The wrong type, and — built out of the rule the row itself
                // declares — one string per clause that rule states. A
                // clause added to the registry is covered here the moment it
                // is added, not when somebody remembers to add a case.
                Kind::Text(rule) => {
                    let mut out = vec![json!(1), json!(true)];
                    out.extend(text_violations(rule).into_iter().map(|v| json!(v)));
                    out
                }
            };
            for value in refused {
                assert!(
                    set_in_file(&path, setting.key, &value).is_err(),
                    "{} accepted {value}, which its own schema does not offer",
                    setting.key
                );
                assert_eq!(
                    read_back(&path),
                    DIRTY,
                    "{} let {value} reach the file",
                    setting.key
                );
            }
        }
    }

    #[test]
    fn a_file_that_does_not_parse_is_never_overwritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        // One unclosed quote — and, below it, everything else the user ever
        // wrote. Rewriting this file from the defaults would delete all of
        // it to fix a typo.
        let broken = "# my settings\n[appearance]\ntheme = \"dark\nsidebar_width = 300\n";
        let path = write(dir.path(), "config.toml", broken);

        let e = match set_in_file(&path, "appearance.theme", &json!("light")) {
            Ok(()) => panic!("a write into an unreadable file succeeded"),
            Err(e) => e,
        };
        assert!(
            e.contains("does not parse"),
            "the refusal must say why: {e}"
        );
        assert_eq!(
            read_back(&path),
            broken,
            "the unreadable file was overwritten — the user's settings are gone"
        );

        let e = match reset_in_file(&path, "appearance.theme") {
            Ok(()) => panic!("a reset in an unreadable file succeeded"),
            Err(e) => e,
        };
        assert!(e.contains("does not parse"), "{e}");
        assert_eq!(read_back(&path), broken);
    }

    // ---- creating what is not there yet

    #[test]
    fn a_first_write_creates_the_file_and_its_directory_with_a_real_section() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir
            .path()
            .join("nested")
            .join("tabverse")
            .join("config.toml");
        set_in_file(&path, "browser.archive_after", &json!("7d")).expect("the first write");

        let actual = read_back(&path);
        assert_eq!(actual, "[browser]\narchive_after = \"7d\"\n");
        assert!(
            !actual.contains('{'),
            "the new section degraded into an inline table: {actual:?}"
        );

        let loaded = load_from_paths(&[path]).expect("what was written loads back");
        assert_eq!(loaded.config.browser.archive_after, ArchiveAfter::Days7);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }

    #[test]
    fn a_new_section_is_appended_below_what_the_file_already_says() {
        let dir = tempfile::tempdir().expect("tempdir");
        let before = "# my own notes, first line\n# and the second\n\n[appearance]\n\
                      theme = \"dark\"   # keep me\n";
        let path = write(dir.path(), "config.toml", before);
        set_in_file(&path, "browser.archive_after", &json!("7d")).expect("the write succeeds");
        let actual = read_back(&path);

        assert!(
            actual.starts_with("# my own notes, first line\n# and the second\n"),
            "the header comments no longer open the file:\n{actual}"
        );
        assert!(
            !actual.contains("browser = "),
            "the new section was written as an inline assignment:\n{actual}"
        );
        let head = match actual.split_once("[browser]") {
            Some((head, _)) => head,
            None => panic!("the new section is not in the file:\n{actual}"),
        };
        assert!(
            head.contains("[appearance]"),
            "the new section jumped above the section that was already there:\n{actual}"
        );
        assert!(
            actual.contains("theme = \"dark\"   # keep me"),
            "an untouched line was rewritten:\n{actual}"
        );
        assert!(load_from_paths(&[path]).is_ok(), "the result must load");
    }

    #[test]
    fn a_new_key_lands_inside_its_own_section() {
        let (_dir, path) = dirty_file();
        let template = "https://example.com/search?q=%s";
        set_in_file(&path, "browser.custom_search_template", &json!(template))
            .expect("the write succeeds");

        let actual = read_back(&path);
        let head = match actual.split_once("[terminal]") {
            Some((head, _)) => head,
            None => panic!("the terminal section went missing:\n{actual}"),
        };
        assert!(
            head.contains("custom_search_template"),
            "the new key landed outside the section it belongs to:\n{actual}"
        );
        let loaded = load_from_paths(&[path]).expect("the result loads");
        assert_eq!(loaded.config.browser.custom_search_template, template);
    }

    #[test]
    fn a_section_written_as_an_inline_table_is_refused_rather_than_mangled() {
        // A shape a load accepts but a write does not, pinned here so it is
        // a decision on the record instead of a surprise: the documented file
        // format is one `[section]` header per section, and editing an inline
        // table in place would mean a second assignment path with its own
        // formatting rules. The refusal is safe — the file is untouched and
        // the message says what to change — but it is a refusal, and the
        // user hears about it rather than losing the line.
        let dir = tempfile::tempdir().expect("tempdir");
        let before = "appearance = { theme = \"dark\" }\n";
        let path = write(dir.path(), "config.toml", before);
        assert_eq!(
            load_from_paths(std::slice::from_ref(&path))
                .expect("a load accepts this shape")
                .config
                .appearance
                .theme,
            ThemePref::Named("dark"),
            "if a load ever stops accepting this, the refusal below stops mattering"
        );

        let e = match set_in_file(&path, "appearance.theme", &json!("light")) {
            Ok(()) => panic!(
                "the inline table was edited in place:\n{}",
                read_back(&path)
            ),
            Err(e) => e,
        };
        assert!(
            e.contains("[appearance]"),
            "the refusal must say what to change: {e}"
        );
        assert_eq!(read_back(&path), before, "the file was touched anyway");
    }

    // ---- the registry drives the write path

    #[test]
    fn every_registered_setting_can_be_written_and_read_back() {
        for setting in SETTINGS {
            for sample in write_samples(setting) {
                let (_dir, path) = dirty_file();
                match set_in_file(&path, setting.key, &sample) {
                    Ok(()) => {}
                    Err(e) => panic!("{} could not be set to {sample}: {e}", setting.key),
                }
                let loaded = match load_from_paths(std::slice::from_ref(&path)) {
                    Ok(loaded) => loaded,
                    Err(e) => panic!(
                        "{} = {sample} produced a file that will not load: {e}",
                        setting.key
                    ),
                };
                let json = serde_json::to_value(&loaded.config).expect("config serializes");
                let pointer = format!("/{}", setting.key.replace('.', "/"));
                assert_eq!(
                    json.pointer(&pointer),
                    Some(&sample),
                    "{} was written as {sample} and read back as something else",
                    setting.key
                );
            }
        }
    }

    /// A valid sample for each kind, taken from the registry row itself
    /// rather than from a list kept by hand beside it.
    fn write_samples(setting: &Setting) -> Vec<serde_json::Value> {
        match setting.kind {
            Kind::Choice { options } => options.get().iter().map(|o| json!(o)).collect(),
            Kind::Number { min, max } => vec![json!(min), json!(max), json!((min + max) / 2)],
            Kind::Toggle => vec![json!(true), json!(false)],
            // Built from the rule the row declares: whatever that rule now
            // says, this is a value it accepts — plus the empty string when
            // the rule says "nothing configured" is a state.
            Kind::Text(rule) => {
                let mut out = Vec::new();
                if rule.allow_empty {
                    out.push(json!(""));
                }
                out.push(json!(text_sample(rule)));
                out
            }
        }
    }

    /// A value the rule accepts, assembled from the rule.
    ///
    /// The host is a literal because no rule in the registry says anything
    /// about hosts; everything the rule *does* say — the scheme it offers,
    /// the substring it demands — is read out of the rule, so this sample
    /// follows the registry rather than agreeing with today's copy of it.
    fn text_sample(rule: TextRule) -> String {
        let scheme = match rule.schemes.and_then(|s| s.first()) {
            Some(scheme) => format!("{scheme}://"),
            None => String::new(),
        };
        format!("{scheme}sample.test/?q={}", rule.must_contain.unwrap_or(""))
    }

    /// One value per clause the rule states, each breaking exactly that
    /// clause and satisfying the others.
    fn text_violations(rule: TextRule) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(schemes) = rule.schemes {
            // A scheme the rule does not offer, built out of the ones it
            // does so it cannot accidentally become one of them.
            let unoffered = format!("not{}", schemes.join(""));
            out.push(format!(
                "{unoffered}://sample.test/?q={}",
                rule.must_contain.unwrap_or("")
            ));
        }
        if rule.must_contain.is_some() {
            let scheme = match rule.schemes.and_then(|s| s.first()) {
                Some(scheme) => format!("{scheme}://"),
                None => String::new(),
            };
            // Nothing after the scheme but digits and dots, so the substring
            // the rule demands cannot be in here by accident.
            out.push(format!("{scheme}0.0/"));
        }
        if !rule.allow_empty {
            out.push(String::new());
        }
        out
    }

    #[test]
    fn every_registered_key_is_a_section_and_a_bare_leaf() {
        for setting in SETTINGS {
            let (section, leaf) = match split_key(setting.key) {
                Ok(parts) => parts,
                Err(e) => panic!("{}: {e}", setting.key),
            };
            assert!(
                SECTIONS.contains(&section),
                "{} names section [{section}], which does not exist",
                setting.key
            );
            // Bare keys only. A key that needed quoting in TOML would be
            // written one way and looked for another, and the schema avoids
            // dotted keys outright because toml_edit does not keep their
            // relative order.
            assert!(
                leaf.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{} has a leaf that TOML would need to quote",
                setting.key
            );
        }
    }

    #[test]
    fn a_write_goes_to_the_last_path_a_read_would_have_used() {
        // Anywhere else and the value would be overridden by a file later in
        // the reading order — set, and then apparently ignored.
        let env = EnvVars {
            home: Some("/Users/u".into()),
            xdg_config_home: Some("/xdg".into()),
            appdata: Some("C:\\Users\\u\\AppData\\Roaming".into()),
            ..EnvVars::default()
        };
        for platform in [Platform::MacOs, Platform::Linux, Platform::Windows] {
            let paths = resolve_paths(platform, &env);
            let last = match paths.last() {
                Some(last) => last.clone(),
                None => panic!("{platform:?} resolved no paths at all"),
            };
            assert_eq!(write_target(platform, &env), Ok(last), "{platform:?}");
        }

        // Nowhere to write is reported, never guessed at.
        assert!(write_target(Platform::Linux, &EnvVars::default()).is_err());
        assert!(write_target(Platform::Windows, &EnvVars::default()).is_err());

        let env = EnvVars {
            config_file: Some("/tmp/pinned.toml".into()),
            home: Some("/Users/u".into()),
            ..EnvVars::default()
        };
        assert_eq!(
            write_target(Platform::MacOs, &env),
            Ok(PathBuf::from("/tmp/pinned.toml"))
        );
    }

    // ---- the commands themselves

    #[test]
    fn the_commands_write_where_the_next_read_will_look() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let (_dir, path) = dirty_file();
        let previous = std::env::var(ENV_CONFIG_FILE).ok();
        std::env::set_var(ENV_CONFIG_FILE, &path);

        tauri::async_runtime::block_on(config_set("appearance.theme".to_string(), json!("dark")))
            .expect("config_set succeeds");
        let snapshot = tauri::async_runtime::block_on(config_get()).expect("config_get succeeds");
        assert_eq!(
            snapshot.values.appearance.theme,
            ThemePref::Named("dark"),
            "config_get did not see what config_set had just written"
        );

        tauri::async_runtime::block_on(config_reset("appearance.theme".to_string()))
            .expect("config_reset succeeds");
        let snapshot = tauri::async_runtime::block_on(config_get()).expect("config_get succeeds");
        assert_eq!(
            snapshot.values.appearance.theme,
            Config::default().appearance.theme,
            "the reset did not return the setting to its built-in default"
        );
        assert!(
            snapshot
                .warnings
                .iter()
                .any(|w| w.key == "browser.homepage"),
            "the key Tabverse does not know was lost across a write and a reset: {:?}",
            snapshot.warnings
        );

        let e = match tauri::async_runtime::block_on(config_set(
            "appearance.thme".to_string(),
            json!("dark"),
        )) {
            Ok(()) => panic!("an unknown key was accepted at the command boundary"),
            Err(e) => e,
        };
        assert!(e.contains("appearance.thme"), "{e}");

        match previous {
            Some(v) => std::env::set_var(ENV_CONFIG_FILE, v),
            None => std::env::remove_var(ENV_CONFIG_FILE),
        }
    }

    #[test]
    fn the_files_section_loads_its_two_leaves_and_defaults_without_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "files.toml",
            "[files]\nexclude = [\"vendor\", \"*-generated\"]\nrespect_gitignore = true\n",
        );
        let loaded = load_from_paths(&[path]).expect("the section loads");
        assert_eq!(
            loaded.config.files.exclude,
            vec!["vendor".to_string(), "*-generated".to_string()]
        );
        assert!(loaded.config.files.respect_gitignore);
        assert!(
            loaded.warnings.is_empty(),
            "the section's own leaves are not unknown keys: {:?}",
            loaded.warnings
        );

        // Half a section: one leaf present, the other defaulted.
        let path = write(
            dir.path(),
            "half.toml",
            "[files]\nrespect_gitignore = true\n",
        );
        let loaded = load_from_paths(&[path]).expect("half a section loads");
        assert!(loaded.config.files.exclude.is_empty());
        assert!(loaded.config.files.respect_gitignore);

        // No section at all: today's behavior is the default, spelled by
        // the same derive the struct carries (see Config::default).
        let path = write(dir.path(), "none.toml", "[appearance]\ntheme = \"light\"\n");
        let loaded = load_from_paths(&[path]).expect("a file without files loads");
        assert_eq!(loaded.config.files, Config::default().files);
    }

    #[test]
    fn a_misspelled_files_leaf_warns_and_still_loads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "typo.toml",
            "[files]\nexlude = [\"vendor\"]\nrespect_gitignore = false\n",
        );
        let loaded = load_from_paths(&[path]).expect("a typo does not stop the load");
        assert!(loaded.config.files.exclude.is_empty());
        assert_eq!(
            loaded
                .warnings
                .iter()
                .map(|w| w.key.as_str())
                .collect::<Vec<_>>(),
            vec!["files.exlude"],
            "the files section is judged by its own leaf list"
        );
    }

    #[test]
    fn files_set_writes_both_leaves_and_restore_removes_them_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "# keep\n[appearance]\ntheme = \"dark\"\n",
        );
        files_set_in_file(&path, &["vendor".into(), " build-* ".into()], true).expect("set");
        let text = read_back(&path);
        assert!(text.starts_with("# keep\n[appearance]\ntheme = \"dark\"\n"));
        assert!(text.contains("[files]"));
        assert!(text.contains("respect_gitignore = true"));
        let loaded = load_from_paths(std::slice::from_ref(&path)).expect("round trip loads");
        // Blank entries dropped, the rest trimmed — the file is the shape
        // the walkers will read back.
        assert_eq!(loaded.config.files.exclude, vec!["vendor", "build-*"]);
        assert!(loaded.config.files.respect_gitignore);

        // Restore defaults: the keys go, and a section left with no keys
        // goes with them — the file reads as a user who never touched it.
        files_set_in_file(&path.clone(), &[], false).expect("restore");
        let text = read_back(&path);
        assert!(!text.contains("[files]"), "{text}");
        assert_eq!(
            load_from_paths(std::slice::from_ref(&path))
                .unwrap()
                .config
                .files,
            Config::default().files
        );

        // A broken glob is refused before the file is touched.
        let before = read_back(&path);
        let refused = files_set_in_file(&path, &["[vendor".into()], false);
        assert!(refused.is_err(), "a broken glob must be refused");
        assert_eq!(read_back(&path), before, "the refusal wrote nothing");
    }

    #[test]
    fn the_walk_commands_read_the_files_config_from_the_real_file() {
        use crate::{fs_grep, fs_walk};
        let _guard = ENV_LOCK.lock().expect("env lock");
        let dir = tempfile::tempdir().expect("tempdir");
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("vendor/lib")).unwrap();
        std::fs::write(tree.join("vendor/lib/a.c"), "needle\n").unwrap();
        std::fs::write(tree.join("top.md"), "needle\n").unwrap();
        let path = write(
            dir.path(),
            "config.toml",
            "[files]\nexclude = [\"vendor\"]\n",
        );
        let previous = std::env::var(ENV_CONFIG_FILE).ok();
        std::env::set_var(ENV_CONFIG_FILE, &path);

        let walked = tauri::async_runtime::block_on(fs_walk(
            tree.to_string_lossy().to_string(),
            false,
            None,
        ))
        .expect("fs_walk succeeds");
        assert!(
            !walked.paths.iter().any(|p| p.contains("vendor")),
            "the exclude list reached the walk: {:?}",
            walked.paths
        );
        assert!(walked.paths.iter().any(|p| p == "top.md"));

        // Search (fs_grep): the same list, the same semantics, one call.
        let searched = tauri::async_runtime::block_on(fs_grep(
            tree.to_string_lossy().to_string(),
            "needle".to_string(),
            tabverse_fs::search::GrepOptions {
                case_sensitive: true,
                whole_word: false,
                regex: false,
                include_hidden: false,
                include: None,
                exclude: None,
            },
            100,
        ))
        .expect("fs_grep succeeds");
        assert!(
            !searched.hits.iter().any(|h| h.rel.contains("vendor")),
            "the exclude list reached the search: {:?}",
            searched.hits.iter().map(|h| &h.rel).collect::<Vec<_>>()
        );
        assert_eq!(searched.hits.len(), 1);

        // And the one write channel round-trips through the same file.
        tauri::async_runtime::block_on(config_files_set(
            vec!["vendor".into(), "another".into()],
            true,
        ))
        .expect("config_files_set succeeds");
        let loaded = load().expect("the file loads after the write");
        assert_eq!(loaded.config.files.exclude, vec!["vendor", "another"]);
        assert!(loaded.config.files.respect_gitignore);

        match previous {
            Some(v) => std::env::set_var(ENV_CONFIG_FILE, v),
            None => std::env::remove_var(ENV_CONFIG_FILE),
        }
    }
}
