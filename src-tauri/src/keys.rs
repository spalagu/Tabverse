use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

/// One row of `src/shortcuts.json`, as that file writes it.
#[derive(Debug, Clone, Deserialize)]
pub struct Binding {
    pub command: String,
    /// Absent means the command deliberately answers no key.
    #[serde(default)]
    pub keys: Option<String>,
    #[allow(dead_code)]
    pub label: String,
    /// Handled inside one view, so neither the menu nor a page answers it.
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    #[allow(dead_code)]
    pub note: Option<String>,
}

/// The table as shipped. The file, not a transcription of it.
const DEFAULTS_JSON: &str = include_str!("../../src/shortcuts.json");

/// The command whose chord the page answers on its own — see
/// [`Bindings::cycle_chord`] for why this one row needs naming here while
/// every other reaches the page through the two tables.
const CYCLE_TABS: &str = "cycle-tabs";

/// The glyph that marks a range of keys rather than one.
const RANGE: &str = "…";
/// The separator between two chords written as one entry.
const COMPOUND: &str = " / ";

/// One key combination, as both the accelerator and the page script need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub cmd: bool,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    /// Lower-cased: one character, or a name like `tab`.
    pub key: String,
}

/// The defaults, parsed once.
///
/// A file this cannot parse costs every accelerator, never the launch: the
/// menu then carries labels with no keys, which is visibly wrong rather than
/// silently wrong, and `defaults_parse` in the tests below is what keeps that
/// from being how anyone finds out.
pub fn defaults() -> &'static [Binding] {
    static PARSED: OnceLock<Vec<Binding>> = OnceLock::new();
    PARSED.get_or_init(
        || match serde_json::from_str::<Vec<Binding>>(DEFAULTS_JSON) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("keys: the shortcut table will not parse, no accelerators: {e}");
                Vec::new()
            }
        },
    )
}

/// The defaults with an overlay laid on, plus the index every consumer asks.
#[derive(Debug, Clone, Default)]
pub struct Bindings {
    rows: Vec<Row>,
}

#[derive(Debug, Clone)]
struct Row {
    command: String,
    keys: Option<String>,
    local: bool,
}

pub fn resolve(overrides: &BTreeMap<String, String>) -> Bindings {
    let rows = defaults()
        .iter()
        .map(|b| {
            let keys = match overrides.get(&b.command) {
                // The empty string is not "no opinion": it is "unbind".
                Some(over) if over.is_empty() => None,
                Some(over) => Some(over.clone()),
                None => b.keys.clone(),
            };
            Row {
                command: b.command.clone(),
                keys,
                local: b.local,
            }
        })
        .collect();
    Bindings { rows }
}

/// Whether the shipped table has a command by this name — what makes an
/// unknown `[keys]` entry reportable rather than silently inert.
///
/// Asked of the DEFAULTS and never of the composition. An overlay can move a
/// key or take one away, but it cannot invent a command; and asking the
/// composition would mean loading the configuration file from inside the code
/// that loads the configuration file.
pub fn is_command(name: &str) -> bool {
    defaults().iter().any(|b| b.command == name)
}

impl Bindings {
    /// The key this command answers, as displayed, or None when nothing does.
    pub fn keys_for(&self, command: &str) -> Option<&str> {
        self.rows
            .iter()
            .find(|r| r.command == command)
            .and_then(|r| r.keys.as_deref())
    }

    /// The accelerator for a menu item, or the empty string for no key.
    ///
    /// The empty string rather than an Option because that is what the menu
    /// builder means by "this item is reachable by mouse only", and because a
    /// key this cannot express must cost its accelerator and nothing else.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn accelerator(&self, command: &str) -> String {
        self.keys_for(command)
            .and_then(parse_chord)
            .map(|c| accelerator_of(&c))
            .unwrap_or_default()
    }

    pub fn page_tables(&self) -> (String, String) {
        let mut plain: BTreeMap<String, String> = BTreeMap::new();
        let mut shifted: BTreeMap<String, String> = BTreeMap::new();
        for row in &self.rows {
            if row.local {
                continue;
            }
            let Some(chord) = row.keys.as_deref().and_then(parse_chord) else {
                continue;
            };
            if !chord.cmd || chord.ctrl || chord.alt {
                continue;
            }
            let table = if chord.shift {
                &mut shifted
            } else {
                &mut plain
            };
            table.insert(chord.key.clone(), row.command.clone());
            // A US keyboard types "+" as shift+"=", so a binding on either is
            // one physical key arriving under two names and two shift states.
            // The rule is here rather than as four rows in the table, which is
            // how zoom-in came to be written out four times in every copy.
            for alias in plus_aliases(&chord.key) {
                plain
                    .entry(alias.clone())
                    .or_insert_with(|| row.command.clone());
                shifted.entry(alias).or_insert_with(|| row.command.clone());
            }
        }
        (js_object(&plain), js_object(&shifted))
    }

    /// The tab-cycle chord, as the JavaScript object the injected script
    /// compares an event against — or `null` when the row is unbound.
    ///
    /// A method of its own because [`page_tables`](Self::page_tables) cannot
    /// carry this row and should not be bent into carrying it: that row is
    /// `local` (a view answers it, not the app-wide handler) and its chord is
    /// a ⌃ one, and both of those are filtered out there for reasons that
    /// hold. So the page used to decide this key by hand — `e.ctrlKey &&
    /// e.key === "Tab"` — which was the seventh hand-written copy of a key in
    /// this program, sitting inside the very string the other six were
    /// removed from.
    ///
    /// SHIFT IS DELIBERATELY NOT IN THE OBJECT. The page uses it to pick a
    /// direction — cycle forwards, or backwards — so it is not part of the
    /// chord to match on; a chord that itself demanded shift would make the
    /// two indistinguishable, and this answers the chord without shift so the
    /// script can go on treating it as the direction it has always been.
    pub fn cycle_chord(&self) -> String {
        match self.keys_for(CYCLE_TABS).and_then(parse_chord) {
            Some(chord) => format!(
                "{{cmd:{},ctrl:{},alt:{},key:{}}}",
                chord.cmd,
                chord.ctrl,
                chord.alt,
                json_string(&chord.key)
            ),
            None => "null".to_string(),
        }
    }

    /// The ends of the tab-jump range, when that row is bound to one.
    ///
    /// The script answers nine keys from this one row, and asks what the ends
    /// are rather than knowing — which is what makes `⌘1…9` a binding and not
    /// a phrase printed beside a hard-coded digit test.
    pub fn jump_range(&self) -> Option<(char, char)> {
        parse_range(self.keys_for("jump-n")?).map(|(_, from, to)| (from, to))
    }

    /// Commands claiming a chord some other command also claims.
    ///
    /// The menu used to have a test of its own for this, over its own
    /// literals; the question belongs to the composition now, because that is
    /// the only place where a default and an override can collide.
    pub fn conflicts(&self) -> Vec<(String, Vec<String>)> {
        let mut claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for row in &self.rows {
            let Some(keys) = row.keys.as_deref() else {
                continue;
            };
            for id in occupied_chords(keys) {
                claims.entry(id).or_default().push(row.command.clone());
            }
        }
        claims.into_iter().filter(|(_, c)| c.len() > 1).collect()
    }
}

fn plus_aliases(key: &str) -> Vec<String> {
    if key == "=" || key == "+" {
        vec!["=".to_string(), "+".to_string()]
    } else {
        Vec::new()
    }
}

/// A `BTreeMap` as a JavaScript object literal. Every key quoted, because a
/// key that is punctuation has to be — and quoting all of them keeps the
/// emitted source one shape instead of two.
fn js_object(map: &BTreeMap<String, String>) -> String {
    let body = map
        .iter()
        .map(|(k, v)| format!("{}:{}", json_string(k), json_string(v)))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// One chord from its displayed form, or None when the entry is not one
/// chord: a range or a compound. Both are shapes a consumer treats specially,
/// and both say so by answering None here.
pub fn parse_chord(keys: &str) -> Option<Chord> {
    if keys.contains(COMPOUND) || keys.contains(RANGE) {
        return None;
    }
    let (mut chord, rest) = take_modifiers(keys);
    if rest.is_empty() {
        return None;
    }
    chord.key = rest.to_lowercase();
    Some(chord)
}

/// The leading modifier glyphs as flags, and whatever follows them.
fn take_modifiers(keys: &str) -> (Chord, &str) {
    let mut chord = Chord {
        cmd: false,
        shift: false,
        ctrl: false,
        alt: false,
        key: String::new(),
    };
    let mut rest = keys;
    loop {
        let mut chars = rest.chars();
        let Some(c) = chars.next() else { break };
        match c {
            '⌘' => chord.cmd = true,
            '⇧' => chord.shift = true,
            '⌃' => chord.ctrl = true,
            '⌥' => chord.alt = true,
            _ => break,
        }
        rest = chars.as_str();
    }
    (chord, rest)
}

/// A range entry's modifiers and ends — `⌘1…9` yields ⌘, '1' and '9'.
pub fn parse_range(keys: &str) -> Option<(Chord, char, char)> {
    let at = keys.find(RANGE)?;
    let (chord, head) = take_modifiers(&keys[..at]);
    let mut from = head.chars();
    let first = from.next()?;
    if from.next().is_some() {
        return None;
    }
    let mut tail = keys[at + RANGE.len()..].chars();
    let last = tail.next()?;
    if tail.next().is_some() {
        return None;
    }
    Some((chord, first, last))
}

/// A chord as a map key, modifiers in a fixed order — so two spellings of one
/// combination cannot become two entries.
pub fn chord_id(chord: &Chord) -> String {
    format!(
        "{}{}{}{}{}",
        if chord.cmd { "⌘" } else { "" },
        if chord.ctrl { "⌃" } else { "" },
        if chord.alt { "⌥" } else { "" },
        if chord.shift { "⇧" } else { "" },
        chord.key
    )
}

/// Every chord one entry occupies: one for an ordinary row, nine for a range,
/// both halves of a compound.
pub fn occupied_chords(keys: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in keys.split(COMPOUND) {
        if let Some(chord) = parse_chord(part) {
            out.push(chord_id(&chord));
            continue;
        }
        if let Some((chord, from, to)) = parse_range(part) {
            for c in from..=to {
                let mut one = chord.clone();
                one.key = c.to_string();
                out.push(chord_id(&one));
            }
        }
    }
    out
}

/// A chord in the notation the menu takes.
///
/// The modifier names and their order are this crate's window onto the menu
/// library's parser; the KEYS are the table's, which is the whole point.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn accelerator_of(chord: &Chord) -> String {
    let mut parts: Vec<String> = Vec::new();
    if chord.cmd {
        // One name for "⌘ on a Mac, Ctrl everywhere else", which is what the
        // table's ⌘ has always meant on the platforms this ships to.
        parts.push("CmdOrCtrl".to_string());
    }
    if chord.ctrl {
        parts.push("Control".to_string());
    }
    if chord.alt {
        parts.push("Alt".to_string());
    }
    if chord.shift {
        parts.push("Shift".to_string());
    }
    parts.push(if chord.key.chars().count() == 1 {
        chord.key.to_uppercase()
    } else {
        // A named key ("tab") is spelled the way the parser names it.
        let mut c = chord.key.chars();
        match c.next() {
            Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
            None => String::new(),
        }
    });
    parts.join("+")
}

// ------------------------------------------------------------- what is live

/// The composition in force, shared by the menu and by every page created
/// from now on.
fn live() -> &'static Mutex<Option<Bindings>> {
    static LIVE: OnceLock<Mutex<Option<Bindings>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(None))
}

/// The composition, composing it from the configuration file on first ask.
///
/// Read from the file rather than waited for from the interface: the menu is
/// built during setup, before any webview exists, and a menu that had to wait
/// for the page would carry no keys through the first frames.
pub fn current() -> Bindings {
    let mut slot = live().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(b) = slot.as_ref() {
        return b.clone();
    }
    let overrides = crate::config::load()
        .map(|loaded| loaded.config.keys.bindings)
        .unwrap_or_default();
    let composed = resolve(&overrides);
    report_conflicts(&composed);
    *slot = Some(composed.clone());
    composed
}

/// Say so when the overlay has put two commands on one key. A warning and not
/// a refusal: the file is the user's, and a key they double-booked still has
/// to leave them an app they can use.
fn report_conflicts(b: &Bindings) {
    for (chord, commands) in b.conflicts() {
        eprintln!("keys: {chord} is claimed by {}", commands.join(" and "));
    }
}

/// Take an overlay from the interface. Answers whether anything moved, so a
/// caller can skip rebuilding a menu that would come out identical.
pub fn set_overrides(overrides: &BTreeMap<String, String>) -> bool {
    let composed = resolve(overrides);
    report_conflicts(&composed);
    let mut slot = live().lock().unwrap_or_else(|e| e.into_inner());
    let changed = match slot.as_ref() {
        Some(prev) => prev.rows_signature() != composed.rows_signature(),
        None => true,
    };
    *slot = Some(composed);
    changed
}

impl Bindings {
    /// Command-to-key pairs, for asking whether two compositions differ.
    fn rows_signature(&self) -> Vec<(&str, Option<&str>)> {
        self.rows
            .iter()
            .map(|r| (r.command.as_str(), r.keys.as_deref()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_overrides() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn over(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn defaults_parse_and_are_not_empty() {
        // The failure this guards is silent by construction: a table that
        // will not parse costs every accelerator and logs one line nobody
        // reads. Counted, so a table that loses half its rows is loud too.
        let rows = defaults();
        assert_eq!(rows.len(), 44, "the shipped table's row count");
        assert!(rows.iter().all(|r| !r.command.is_empty()));
        assert!(rows.iter().all(|r| !r.label.is_empty()));
    }

    #[test]
    fn an_accelerator_comes_from_the_table() {
        let b = resolve(&no_overrides());
        assert_eq!(b.accelerator("new-terminal"), "CmdOrCtrl+T");
        assert_eq!(b.accelerator("duplicate-tab"), "CmdOrCtrl+Shift+U");
        assert_eq!(b.accelerator("shortcuts-help"), "CmdOrCtrl+/");
        assert_eq!(b.accelerator("toggle-sidebar"), "CmdOrCtrl+Shift+\\");
        assert_eq!(b.accelerator("zoom-reset"), "CmdOrCtrl+0");
        assert_eq!(b.accelerator("new-browser"), "");
        assert_eq!(b.accelerator("print"), "");
        assert_eq!(b.accelerator("downloads-panel"), "");
    }

    #[test]
    fn an_override_moves_the_menu_and_the_page_together() {
        let moved = resolve(&over(&[("duplicate-tab", "⌘⇧U")]));
        assert_eq!(moved.accelerator("duplicate-tab"), "CmdOrCtrl+Shift+U");
        let (_plain, shifted) = moved.page_tables();
        assert!(
            shifted.contains(r#""u":"duplicate-tab""#),
            "the injected table follows the override: {shifted}"
        );
        assert!(
            !shifted.contains(r#""d":"duplicate-tab""#),
            "and lets go of the key it left: {shifted}"
        );
    }

    #[test]
    fn an_empty_override_unbinds_everywhere() {
        let b = resolve(&over(&[("duplicate-tab", "")]));
        assert_eq!(b.keys_for("duplicate-tab"), None);
        assert_eq!(b.accelerator("duplicate-tab"), "");
        let (plain, shifted) = b.page_tables();
        assert!(!plain.contains("duplicate-tab"), "{plain}");
        assert!(!shifted.contains("duplicate-tab"), "{shifted}");
    }

    #[test]
    fn the_page_tables_hold_every_shortcut_a_page_could_forward() {
        let b = resolve(&no_overrides());
        let (plain, shifted) = b.page_tables();
        let both = format!("{plain}{shifted}");
        for row in defaults() {
            if row.local || row.keys.is_none() {
                continue;
            }
            assert!(
                both.contains(&format!("\"{}\"", row.command)),
                // A page-wide shortcut absent here does nothing at all while
                // a browser tab has focus — invisible until someone tries it.
                "{} is answered by no injected binding: {both}",
                row.command
            );
        }
    }

    #[test]
    fn the_cycle_chord_is_read_off_the_table() {
        // The shipped row, which the page used to test for by hand.
        assert_eq!(
            resolve(&no_overrides()).cycle_chord(),
            r#"{cmd:false,ctrl:true,alt:false,key:"tab"}"#
        );
        // Rebound onto a different modifier and a different key: the page's
        // comparison has to move with it, which is the whole point of this
        // being derived. A hand-written `e.ctrlKey && e.key === "Tab"` passes
        // every other test in this file and fails here.
        assert_eq!(
            resolve(&over(&[("cycle-tabs", "⌥`")])).cycle_chord(),
            r#"{cmd:false,ctrl:false,alt:true,key:"`"}"#
        );
        // Unbound is null and not a chord nothing can match: the script tests
        // the object before it tests an event against it.
        assert_eq!(resolve(&over(&[("cycle-tabs", "")])).cycle_chord(), "null");
    }

    #[test]
    fn the_jump_range_is_read_off_the_table() {
        assert_eq!(resolve(&no_overrides()).jump_range(), Some(('1', '9')));
        let narrowed = resolve(&over(&[("jump-n", "⌘1…4")]));
        assert_eq!(narrowed.jump_range(), Some(('1', '4')));
        assert_eq!(resolve(&over(&[("jump-n", "")])).jump_range(), None);
    }

    #[test]
    fn the_shipped_table_gives_no_two_commands_the_same_chord() {
        let clashes = resolve(&no_overrides()).conflicts();
        assert!(clashes.is_empty(), "{clashes:?}");
    }

    #[test]
    fn an_override_onto_an_occupied_key_is_reported() {
        // Including onto a key a *view* owns: the six local rows were the
        // blind spot the old menu-only check could not see.
        let clashes = resolve(&over(&[("duplicate-tab", "⌘S")])).conflicts();
        let commands: Vec<String> = clashes.iter().flat_map(|(_, c)| c.clone()).collect();
        assert!(commands.iter().any(|c| c == "save-file"), "{clashes:?}");
        assert!(commands.iter().any(|c| c == "duplicate-tab"), "{clashes:?}");
    }

    #[test]
    fn a_range_occupies_every_key_in_it() {
        let ids = occupied_chords("⌘1…9");
        assert_eq!(ids.len(), 9);
        assert!(ids.contains(&"⌘5".to_string()), "{ids:?}");
        // And a compound occupies both halves.
        assert_eq!(occupied_chords("⌘↑ / ⌘↓").len(), 2);
    }

    #[test]
    fn an_override_naming_no_command_changes_nothing() {
        let b = resolve(&over(&[("not-a-command", "⌘⇧Z")]));
        assert!(!is_command("not-a-command"));
        assert!(is_command("duplicate-tab"));
        assert_eq!(
            b.rows_signature(),
            resolve(&no_overrides()).rows_signature()
        );
    }
}
