use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use tabverse_term::SpawnOpts;
use toml_edit::{ArrayOfTables, InlineTable, Item, Table, Value};

use crate::config::{self, Warning};

/// The leaf key under `[terminal]` this module owns.
pub const KEY: &str = "profiles";

/// The section the key lives in — `terminal.profiles`, as a load warning and
/// the settings page both spell it.
pub const SECTION: &str = "terminal";

/// Every key a profile entry may carry.
///
/// Read by [`scan_unknown_keys`] and by nothing else: it is the *warning*
/// vocabulary, not the parse. An entry with a key that is not here still
/// loads (a file written by a newer version has to survive a downgrade —
/// same reasoning as `deny_unknown_fields` being refused in config.rs), and
/// the user is told which line the unrecognized key is on.
pub const FIELDS: &[&str] = &[
    "name",
    "shell",
    "cwd",
    "env",
    "badge",
    "font",
    "ligatures",
    "run_on_start",
];

/// One named launch preset.
///
/// Every field except the name is optional, and an absent field means "do
/// what opening a terminal without a profile does" rather than a value of its
/// own — which is why they are `Option`/empty rather than defaulted: a
/// profile that does not name a shell must not freeze today's shell into
/// itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Unique among profiles, and not blank. It is the handle everything
    /// else uses: the interface lists it, ⌘N picks by it, and `term_create`
    /// receives it.
    #[serde(deserialize_with = "de_name")]
    pub name: String,
    /// Absolute path of the shell to run. Absent means the same shell a
    /// profile-less terminal gets (`$SHELL`, then a platform default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Where the shell starts. Absent means the home directory, as before —
    /// and see [`spawn_opts`] for why a directory named by the *request*
    /// wins over this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Extra environment for the shell, on top of what the process already
    /// passes down. Ordered so that writing the file back is stable rather
    /// than reshuffled per run.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// The colour a pane and its sidebar row wear under this profile. Not
    /// validated against a palette here: the interface owns what a badge
    /// name means, and a list of them in this file would be the second copy
    /// of a domain that config.rs's gate exists to prevent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ligatures: Option<bool>,
    /// A command typed into the shell as soon as it exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_on_start: Option<String>,
}

fn de_name<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let raw = String::deserialize(d)?;
    if raw.trim().is_empty() {
        return Err(D::Error::custom("a profile's name must not be blank"));
    }
    Ok(raw)
}

/// The profile list, with the one rule that no single entry can carry:
/// two entries may not share a name.
///
/// Checked here rather than after the load because *here* is where the file's
/// positions still exist — an error raised during deserialization is located
/// by the parser, and the same check run over the finished `Config` could
/// only say "somewhere in your file". The message names the profile, since
/// the position toml can give a rule about a whole array is the array, not
/// the second of the two entries.
pub fn de_profiles<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Profile>, D::Error> {
    let list = Vec::<Profile>::deserialize(d)?;
    if let Some(name) = first_duplicate(&list) {
        return Err(D::Error::custom(format!(
            "two terminal profiles are named `{name}` — profile names have to be \
             unique, because that name is how one is picked"
        )));
    }
    Ok(list)
}

/// The first name that appears twice, or `None` when they are all distinct.
fn first_duplicate(list: &[Profile]) -> Option<&str> {
    let mut seen: Vec<&str> = Vec::with_capacity(list.len());
    for p in list {
        if seen.contains(&p.name.as_str()) {
            return Some(&p.name);
        }
        seen.push(&p.name);
    }
    None
}

/// The profile called `name`, or `None`.
pub fn find<'a>(list: &'a [Profile], name: &str) -> Option<&'a Profile> {
    list.iter().find(|p| p.name == name)
}

// -------------------------------------------------------------- the warnings

/// Unknown keys inside the profile array, each with the line it is on.
///
/// The counterpart of config.rs's `scan_unknown_keys` for a shape that table
/// cannot describe: `SETTINGS` has no row for `terminal.profiles`, so without
/// this every profile a user writes would be reported as an unknown setting —
/// and a misspelled field *inside* an entry would be reported as nothing at
/// all, which is the failure that matters (`shel = "/bin/bash"` silently does
/// nothing forever).
pub fn scan_unknown_keys(
    path_text: &str,
    src: &str,
    value: &toml::de::DeValue<'_>,
) -> Vec<Warning> {
    let mut out = Vec::new();
    let toml::de::DeValue::Array(entries) = value else {
        // Not an array at all — the value pass refuses it with a located
        // error, so there is nothing useful to add from here.
        return out;
    };
    for entry in entries {
        let toml::de::DeValue::Table(table) = entry.get_ref() else {
            continue;
        };
        for (key, _) in table.iter() {
            let field = key.get_ref().as_ref();
            if FIELDS.contains(&field) {
                continue;
            }
            let (line, column) = config::line_col(src, key.span().start);
            out.push(Warning {
                key: format!("{SECTION}.{KEY}.{field}"),
                path: path_text.to_string(),
                line,
                column,
            });
        }
    }
    out
}

// ---------------------------------------------------------------- the spawn

/// One request to open a terminal, as the interface makes it.
///
/// The size and the directory are the request's own; the profile name is a
/// reference to something in the file. Both halves reach [`spawn_opts`]
/// together because the answer depends on both — see the `cwd` rule there.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TermRequest {
    pub cols: u16,
    pub rows: u16,
    /// The directory this particular terminal was asked to open in — the
    /// files panel's "open a terminal here", or a restored tab's own.
    pub cwd: Option<String>,
    /// The profile to open under, or `None` for a plain terminal.
    pub profile: Option<String>,
    pub run_on_start: Option<String>,
}

/// What to hand the PTY engine for this request.
///
/// THE function this milestone's pipe is made of. Before it, `term_create`
/// wrote `shell: None, env: vec![], shell_integration: true` into its own
/// body, so no caller could say anything else however much the engine
/// supported it.
///
/// Two rules are worth stating rather than reading off:
///
///   * NO PROFILE IS TODAY'S BEHAVIOUR, byte for byte — the default shell, no
///     extra environment, the request's own directory, shell integration on.
///     Every terminal this app opens right now takes that path, so anything
///     else here would be a change nobody asked for.
///   * THE REQUEST'S DIRECTORY BEATS THE PROFILE'S. "Open a terminal in this
///     folder" is an instruction about this one terminal; a profile's `cwd`
///     is a standing preference for terminals that were not told where to go.
///     The specific instruction wins, which is also the only order in which
///     the files panel's action keeps working once a profile is chosen.
///
/// A named profile that is not in the file is an error and never a quiet
/// fallback to a plain shell: the whole point of naming one is that the
/// terminal comes up configured, and a silent plain shell is the failure
/// mode that looks exactly like success.
pub fn spawn_opts(list: &[Profile], req: &TermRequest) -> Result<SpawnOpts, String> {
    let profile = match &req.profile {
        None => None,
        Some(name) => match find(list, name) {
            Some(p) => Some(p),
            None => return Err(format!("there is no terminal profile named `{name}`")),
        },
    };
    Ok(SpawnOpts {
        shell: profile.and_then(|p| p.shell.clone()),
        cwd: req
            .cwd
            .clone()
            .or_else(|| profile.and_then(|p| p.cwd.clone())),
        cols: req.cols,
        rows: req.rows,
        env: profile
            .map(|p| {
                p.env
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        shell_integration: true,
        run_on_start: req
            .run_on_start
            .clone()
            .or_else(|| profile.and_then(|p| p.run_on_start.clone())),
    })
}

/// [`spawn_opts`] against the profiles this machine's configuration file
/// declares.
///
/// The file is read only when a profile was actually named. A request with no
/// profile — which is every terminal the app opens until the picker lands —
/// must not start depending on a file it never needed, least of all one that
/// might be unreadable: a broken `config.toml` has never stopped a terminal
/// from opening and it does not start now.
pub fn resolve(req: &TermRequest) -> Result<SpawnOpts, String> {
    if req.profile.is_none() {
        return spawn_opts(&[], req);
    }
    let loaded = config::load().map_err(|e| e.to_string())?;
    spawn_opts(&loaded.config.terminal.profiles, req)
}

// ------------------------------------------------------------- write-back

pub fn set_in_file(path: &std::path::Path, target: &str, profile: &Profile) -> Result<(), String> {
    if profile.name.trim().is_empty() {
        return Err("a profile's name must not be blank".to_string());
    }
    let mut doc = config::open_document(path)?;
    let section = config::section_mut(&mut doc, SECTION)?;
    let array = array_mut(section)?;
    let existing = array
        .iter()
        .position(|t| entry_name(t).as_deref() == Some(target));
    match existing {
        Some(index) => {
            let table = array.get_mut(index).expect("index just found");
            write_entry(table, profile);
        }
        None => {
            let mut table = Table::new();
            write_entry(&mut table, profile);
            array.push(table);
        }
    }
    publish(path, doc)
}

/// Take the profile called `name` out of the file. A name that is in no entry
/// is already in the state this asks for, so nothing is written — rewriting a
/// file nobody asked us to touch is itself a change (the same rule
/// `config::reset_in_file` follows).
pub fn remove_from_file(path: &std::path::Path, name: &str) -> Result<(), String> {
    let mut doc = config::open_document(path)?;
    let Some(section) = doc.get_mut(SECTION).and_then(Item::as_table_mut) else {
        return Ok(());
    };
    let Some(array) = section.get_mut(KEY).and_then(Item::as_array_of_tables_mut) else {
        return Ok(());
    };
    let Some(index) = array
        .iter()
        .position(|t| entry_name(t).as_deref() == Some(name))
    else {
        return Ok(());
    };
    array.remove(index);
    // An empty `profiles` key left behind reads as "there is something
    // configured here" to the next person who opens the file, and it is not
    // what a file with no profiles looks like.
    if array.is_empty() {
        section.remove(KEY);
    }
    publish(path, doc)
}

/// Re-read the edited document as a configuration, then publish it.
///
/// The check is the load path itself rather than a copy of it, so every rule
/// the file has — a blank name, an environment value that is not text, two
/// entries with one name — applies to a write the moment it applies to a
/// read. A refusal happens before anything reaches the disk.
fn publish(path: &std::path::Path, doc: toml_edit::DocumentMut) -> Result<(), String> {
    let text = doc.to_string();
    if let Err(e) = toml::from_str::<config::Config>(&text) {
        return Err(e.message().to_string());
    }
    config::write_atomically(path, &text)
}

/// The `profiles` array of tables inside `[terminal]`, created when the file
/// has none yet.
///
/// `Item::ArrayOfTables` is spelled out for the reason config.rs spells out
/// `Item::Table`: the indexing shorthand builds something else — an inline
/// array of inline tables, all on one line — and a file people are meant to
/// hand-edit should get `[[terminal.profiles]]` headers.
fn array_mut(section: &mut Table) -> Result<&mut ArrayOfTables, String> {
    if section.get(KEY).is_none() {
        section.insert(KEY, Item::ArrayOfTables(ArrayOfTables::new()));
    }
    match section.get_mut(KEY).and_then(Item::as_array_of_tables_mut) {
        Some(array) => Ok(array),
        None => Err(format!(
            "`{SECTION}.{KEY}` is not written as a series of [[{SECTION}.{KEY}]] tables in \
             this file, so profiles cannot be saved. Rewrite it that way and they will."
        )),
    }
}

/// The `name` of one entry as the file has it.
fn entry_name(table: &Table) -> Option<String> {
    table
        .get("name")
        .and_then(Item::as_value)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Lay one profile over one entry, key by key.
fn write_entry(table: &mut Table, profile: &Profile) {
    config::put(table, "name", Value::from(profile.name.as_str()));
    put_optional(table, "shell", profile.shell.as_deref());
    put_optional(table, "cwd", profile.cwd.as_deref());
    put_optional(table, "badge", profile.badge.as_deref());
    put_optional(table, "font", profile.font.as_deref());
    // The one field that is not a string, written the same way all the same:
    // present means the profile has an answer of its own, absent means the
    // line goes away and the profile follows the setting again.
    match profile.ligatures {
        Some(on) => config::put(table, "ligatures", Value::from(on)),
        None => {
            table.remove("ligatures");
        }
    }
    put_optional(table, "run_on_start", profile.run_on_start.as_deref());
    if profile.env.is_empty() {
        table.remove("env");
    } else {
        let mut inline = InlineTable::new();
        for (k, v) in &profile.env {
            inline.insert(k, Value::from(v.as_str()));
        }
        // The map is written whole rather than variable by variable: it is
        // one field of the profile as far as the interface is concerned, and
        // a per-variable point edit would have to reconcile deletions
        // against a sub-table that may be written either inline or as its
        // own `[terminal.profiles.env]` header.
        config::put(table, "env", Value::InlineTable(inline));
    }
}

/// Write `value`, or take the line out when there is no value to write.
fn put_optional(table: &mut Table, leaf: &str, value: Option<&str>) {
    match value {
        Some(v) => config::put(table, leaf, Value::from(v)),
        None => {
            table.remove(leaf);
        }
    }
}

// ---------------------------------------------------------------- commands

/// Add or edit one profile, in the file, now.
///
/// `target` is the entry to write over and `profile.name` is what it is
/// called afterwards; pass the same string for both to edit in place, a
/// different one to rename, and a name no entry has to create. The interface
/// reads the result back with `config_get`, exactly as it does after
/// `config_set` — the file is the authority and this returns nothing.
#[tauri::command]
pub async fn config_profile_set(target: String, profile: Profile) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path =
            config::write_target(config::current_platform(), &config::EnvVars::from_process())?;
        set_in_file(&path, &target, &profile)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete one profile from the file.
#[tauri::command]
pub async fn config_profile_remove(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path =
            config::write_target(config::current_platform(), &config::EnvVars::from_process())?;
        remove_from_file(&path, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;
    use tabverse_term::SessionManager;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write fixture");
        path
    }

    /// The profiles a configuration file declares, read through the very load
    /// path the app uses.
    fn profiles_from(body: &str) -> Vec<Profile> {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config.toml", body);
        config::load_from_paths(&[path])
            .expect("fixture loads")
            .config
            .terminal
            .profiles
    }

    // ------------------------------------------------------- the file shape

    #[test]
    fn an_array_of_tables_becomes_a_list_of_profiles() {
        let list = profiles_from(
            "[[terminal.profiles]]\n\
             name = \"deploy\"\n\
             shell = \"/bin/bash\"\n\
             cwd = \"/srv\"\n\
             badge = \"amber\"\n\
             font = \"Berkeley Mono\"\n\
             run_on_start = \"whoami\"\n\
             env = { AWS_PROFILE = \"prod\", REGION = \"eu-west-1\" }\n\
             \n\
             [[terminal.profiles]]\n\
             name = \"plain\"\n",
        );
        assert_eq!(list.len(), 2, "both entries load");
        assert_eq!(list[0].name, "deploy");
        assert_eq!(list[0].shell.as_deref(), Some("/bin/bash"));
        assert_eq!(list[0].cwd.as_deref(), Some("/srv"));
        assert_eq!(list[0].badge.as_deref(), Some("amber"));
        assert_eq!(list[0].font.as_deref(), Some("Berkeley Mono"));
        assert_eq!(list[0].run_on_start.as_deref(), Some("whoami"));
        assert_eq!(
            list[0].env.get("AWS_PROFILE").map(String::as_str),
            Some("prod")
        );
        assert_eq!(
            list[0].env.get("REGION").map(String::as_str),
            Some("eu-west-1")
        );
        // Everything but the name is optional, and absent stays absent
        // rather than becoming a value.
        assert_eq!(list[1].name, "plain");
        assert_eq!(list[1].shell, None);
        assert!(list[1].env.is_empty());
    }

    #[test]
    fn no_terminal_section_is_no_profiles_and_no_complaint() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[appearance]\ntheme = \"dark\"\n",
        );
        let loaded = config::load_from_paths(&[path]).expect("loads");
        assert!(loaded.config.terminal.profiles.is_empty());
        assert!(loaded.warnings.is_empty(), "profiles are not required");
    }

    fn expect_error(body: &str) -> config::LoadError {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "bad.toml", body);
        match config::load_from_paths(&[path]) {
            Ok(loaded) => panic!(
                "a bad profile loaded anyway as {:?}; a broken file must never degrade \
                 into the defaults",
                loaded.config.terminal.profiles
            ),
            Err(e) => e,
        }
    }

    #[test]
    fn a_blank_name_reports_its_line() {
        // The mistake is on line 2 of the file, and the fixture is written so
        // that the number is a property of the fixture rather than one copied
        // out of a failure.
        let e = expect_error("[[terminal.profiles]]\nname = \"\"\n");
        assert_eq!(e.line, 2, "blank name line ({e})");
        assert!(
            e.message.contains("must not be blank"),
            "message says what is wrong: {}",
            e.message
        );
    }

    #[test]
    fn an_environment_value_that_is_not_text_reports_its_line() {
        let e = expect_error(
            "[[terminal.profiles]]\nname = \"deploy\"\n\
             env = { PORT = 8080 }\n",
        );
        assert_eq!(e.line, 3, "bad env value line ({e})");
        assert!(
            e.detail.contains('^'),
            "detail keeps the caret: {}",
            e.detail
        );
    }

    #[test]
    fn two_profiles_with_one_name_are_refused_with_a_line() {
        let e = expect_error(
            "[[terminal.profiles]]\nname = \"deploy\"\n\n\
             [[terminal.profiles]]\nname = \"deploy\"\n",
        );
        assert!(e.line > 0, "the refusal is located somewhere ({e})");
        assert!(
            e.message.contains("deploy") && e.message.contains("unique"),
            "message names the profile and the rule: {}",
            e.message
        );
    }

    #[test]
    fn an_unknown_field_inside_a_profile_warns_with_its_line_and_still_loads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[[terminal.profiles]]\nname = \"deploy\"\nshel = \"/bin/bash\"\n",
        );
        let loaded = config::load_from_paths(&[path]).expect("an unknown key never stops a load");
        assert_eq!(loaded.config.terminal.profiles.len(), 1);
        assert_eq!(
            loaded.warnings.len(),
            1,
            "one warning: {:?}",
            loaded.warnings
        );
        assert_eq!(loaded.warnings[0].key, "terminal.profiles.shel");
        assert_eq!(loaded.warnings[0].line, 3);
    }

    #[test]
    fn a_profile_array_is_not_reported_as_an_unknown_setting() {
        // The failure this guards: `SETTINGS` has no row for
        // `terminal.profiles`, so the registry's own scan would call every
        // profile a user writes an unknown setting.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[[terminal.profiles]]\nname = \"deploy\"\n",
        );
        let loaded = config::load_from_paths(&[path]).expect("loads");
        assert!(
            loaded.warnings.is_empty(),
            "profiles are a known part of the file: {:?}",
            loaded.warnings
        );
    }

    #[test]
    fn the_command_line_check_locates_every_bad_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Each fixture puts its mistake on its own known line.
        let cases: [(&str, &str, &str); 3] = [
            ("blank.toml", "[[terminal.profiles]]\nname = \"\"\n", ":2:"),
            (
                "env.toml",
                "[[terminal.profiles]]\nname = \"deploy\"\nenv = { PORT = 8080 }\n",
                ":3:",
            ),
            (
                "twice.toml",
                "[[terminal.profiles]]\nname = \"deploy\"\n\n\
                 [[terminal.profiles]]\nname = \"deploy\"\n",
                ":",
            ),
        ];
        for (name, body, position) in cases {
            let path = write(dir.path(), name, body);
            let mut out = String::new();
            let code = config::validate_report(Some(&path.display().to_string()), &mut out);
            assert_eq!(code, 1, "{name} must be reported as an error: {out}");
            assert!(
                out.contains(position),
                "{name} must be reported with its position: {out}"
            );
        }
    }

    // ------------------------------------------------ composing spawn options

    #[test]
    fn no_profile_composes_exactly_what_a_plain_terminal_got() {
        let opts = spawn_opts(
            &[],
            &TermRequest {
                cols: 80,
                rows: 24,
                cwd: Some("/tmp".into()),
                profile: None,
                run_on_start: None,
            },
        )
        .expect("a request without a profile always composes");
        assert_eq!(opts.shell, None, "the engine picks the shell, as before");
        assert_eq!(opts.cwd.as_deref(), Some("/tmp"));
        assert_eq!(opts.cols, 80);
        assert_eq!(opts.rows, 24);
        assert!(opts.env.is_empty(), "no profile adds no environment");
        assert!(opts.shell_integration, "shell integration stays on");
        assert_eq!(opts.run_on_start, None);
    }

    #[test]
    fn a_requested_directory_beats_the_profiles_own() {
        let list = profiles_from("[[terminal.profiles]]\nname = \"deploy\"\ncwd = \"/srv\"\n");
        let with = spawn_opts(
            &list,
            &TermRequest {
                cols: 80,
                rows: 24,
                cwd: Some("/tmp".into()),
                profile: Some("deploy".into()),
                run_on_start: None,
            },
        )
        .expect("composes");
        assert_eq!(with.cwd.as_deref(), Some("/tmp"), "the request wins");
        let without = spawn_opts(
            &list,
            &TermRequest {
                cols: 80,
                rows: 24,
                cwd: None,
                profile: Some("deploy".into()),
                run_on_start: None,
            },
        )
        .expect("composes");
        assert_eq!(without.cwd.as_deref(), Some("/srv"), "the profile fills in");
    }

    #[test]
    fn a_requested_start_command_replaces_the_profiles_own() {
        let list = profiles_from(
            "[[terminal.profiles]]\nname = \"deploy\"\nrun_on_start = \"kubectl get nodes\"\n",
        );
        let with = spawn_opts(
            &list,
            &TermRequest {
                cols: 80,
                rows: 24,
                cwd: None,
                profile: Some("deploy".into()),
                run_on_start: Some("make watch".into()),
            },
        )
        .expect("composes");
        assert_eq!(
            with.run_on_start.as_deref(),
            Some("make watch"),
            "the request wins — one command, not two"
        );
        let without = spawn_opts(
            &list,
            &TermRequest {
                cols: 80,
                rows: 24,
                cwd: None,
                profile: Some("deploy".into()),
                run_on_start: None,
            },
        )
        .expect("composes");
        assert_eq!(
            without.run_on_start.as_deref(),
            Some("kubectl get nodes"),
            "the profile fills in"
        );
    }

    #[test]
    fn a_profile_that_is_not_there_is_refused_rather_than_quietly_plain() {
        let err = spawn_opts(
            &[],
            &TermRequest {
                cols: 80,
                rows: 24,
                cwd: None,
                profile: Some("ghost".into()),
                run_on_start: None,
            },
        )
        .expect_err("an unknown profile must not open a plain shell");
        assert!(err.contains("ghost"), "the message names it: {err}");
    }

    /// Collect PTY output until `pred` holds or the deadline passes.
    fn drain_until(
        rx: &mpsc::Receiver<Vec<u8>>,
        secs: u64,
        pred: impl Fn(&str) -> bool,
    ) -> (bool, String) {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        let mut all = Vec::new();
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                all.extend_from_slice(&chunk);
                let s = String::from_utf8_lossy(&all).to_string();
                if pred(&s) {
                    return (true, s);
                }
            }
        }
        (false, String::from_utf8_lossy(&all).to_string())
    }

    /// Open a PTY from a profile named in a configuration file, type
    /// `command`, and hand back everything the shell said.
    ///
    /// The whole path in one call — file text, the real loader, `spawn_opts`,
    /// the real engine — so that a break anywhere along it fails a test here
    /// rather than being caught by nobody.
    fn transcript_from(config_text: &str, profile: &str, command: &str, needle: &str) -> String {
        let list = profiles_from(config_text);
        let opts = spawn_opts(
            &list,
            &TermRequest {
                cols: 100,
                rows: 24,
                cwd: None,
                profile: Some(profile.to_string()),
                run_on_start: None,
            },
        )
        .expect("composes");
        run(opts, Some(command), needle)
    }

    /// Spawn, optionally type one line, and drain until `needle` shows up.
    /// The session is always killed, so a failing assertion cannot leave a
    /// shell behind.
    fn run(opts: SpawnOpts, command: Option<&str>, needle: &str) -> String {
        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let id = mgr
            .create(
                opts,
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(|_| {}),
            )
            .expect("create session");
        if let Some(cmd) = command {
            mgr.write(&id, format!("{cmd}\n").as_bytes())
                .expect("write");
        }
        let (seen, transcript) = drain_until(&rx, 25, |s| s.contains(needle));
        mgr.kill(&id).ok();
        assert!(
            seen,
            "expected `{needle}` in what the shell said; got:\n{}",
            transcript.escape_debug()
        );
        transcript
    }

    /// A shell this machine has that is NOT the one a profile-less terminal
    /// would pick.
    ///
    /// The difference is the whole discriminating power of the shell test: if
    /// the probe were the same binary `$SHELL` names, a pipe that dropped the
    /// profile's shell entirely would start that same binary and the test
    /// would pass anyway. `None` means this machine offers no second shell,
    /// and the tests say so rather than asserting nothing quietly.
    fn other_shell() -> Option<&'static str> {
        let default = std::env::var("SHELL").unwrap_or_default();
        ["/bin/sh", "/bin/bash", "/bin/zsh"]
            .into_iter()
            .find(|candidate| *candidate != default && Path::new(candidate).exists())
    }

    /// A probe line whose *answer* cannot be confused with its own echo.
    ///
    /// The shell echoes what is typed at it, so a transcript contains the
    /// question as well as the answer — and a test waiting for `WHERE=` was
    /// satisfied by the echo of `echo WHERE=$(pwd)` before the shell had run
    /// anything at all. Every probe therefore ends in `$((40+2))`, which the
    /// echo carries literally and only a shell that evaluated the line turns
    /// into `42`.
    const SYNC: &str = "$((40+2))";

    #[test]
    #[cfg_attr(windows, ignore = "the probes are written in POSIX shell")]
    fn a_profiles_environment_reaches_the_shell() {
        let Some(shell) = other_shell() else {
            eprintln!("this machine has no second shell to probe with; skipping");
            return;
        };
        // The value is read out of the running process by the shell itself.
        // Reading it back off `SpawnOpts` would pass with the pipe cut
        // anywhere between that struct and the child.
        let transcript = transcript_from(
            &format!(
                "[[terminal.profiles]]\nname = \"deploy\"\nshell = \"{shell}\"\n\
                 env = {{ TABVERSE_PROFILE_PROBE = \"reached-the-pty\" }}\n"
            ),
            "deploy",
            &format!("echo \"PROBE=[$TABVERSE_PROFILE_PROBE][{SYNC}]\""),
            "PROBE=[reached-the-pty][42]",
        );
        assert!(transcript.contains("PROBE=[reached-the-pty][42]"));
    }

    #[test]
    #[cfg_attr(windows, ignore = "the probes are written in POSIX shell")]
    fn a_profiles_shell_is_the_one_that_runs() {
        let Some(shell) = other_shell() else {
            eprintln!("this machine has no second shell to probe with; skipping");
            return;
        };
        // `$0` is the running shell's own name, asked of the shell itself. A
        // profile whose shell was dropped on the way starts whatever `$SHELL`
        // names, and `other_shell` guarantees that is a different answer.
        transcript_from(
            &format!("[[terminal.profiles]]\nname = \"posix\"\nshell = \"{shell}\"\n"),
            "posix",
            &format!("echo \"RUNNING=[$0][{SYNC}]\""),
            &format!("RUNNING=[{shell}][42]"),
        );
    }

    #[test]
    #[cfg_attr(windows, ignore = "the probes are written in POSIX shell")]
    fn a_profiles_directory_is_where_the_shell_starts() {
        let Some(shell) = other_shell() else {
            eprintln!("this machine has no second shell to probe with; skipping");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        // Symlinks make this worth resolving: /tmp is /private/tmp on macOS,
        // and `pwd` answers with the resolved path.
        let real = std::fs::canonicalize(dir.path()).expect("canonicalize");
        let marker = real.join("tabverse-cwd-probe");
        std::fs::create_dir_all(&marker).expect("marker dir");
        transcript_from(
            &format!(
                "[[terminal.profiles]]\nname = \"there\"\nshell = \"{shell}\"\ncwd = \"{}\"\n",
                marker.display()
            ),
            "there",
            &format!("echo \"WHERE=[$(pwd)][{SYNC}]\""),
            &format!("WHERE=[{}][42]", marker.display()),
        );
    }

    #[test]
    #[cfg_attr(windows, ignore = "the probes are written in POSIX shell")]
    fn a_profiles_start_command_runs_by_itself() {
        let Some(shell) = other_shell() else {
            eprintln!("this machine has no second shell to probe with; skipping");
            return;
        };
        let list = profiles_from(&format!(
            "[[terminal.profiles]]\nname = \"greet\"\nshell = \"{shell}\"\n\
             run_on_start = \"echo STARTED=[{SYNC}]\"\n"
        ));
        let opts = spawn_opts(
            &list,
            &TermRequest {
                cols: 100,
                rows: 24,
                cwd: None,
                profile: Some("greet".into()),
                run_on_start: None,
            },
        )
        .expect("composes");
        // Nothing is typed here: the command has to arrive on its own.
        run(opts, None, "STARTED=[42]");
    }

    /// The control group. Without it, a pipe that put the *same* environment
    /// and directory into every terminal would pass all three tests above.
    #[test]
    #[cfg_attr(windows, ignore = "the probes are written in POSIX shell")]
    fn a_terminal_with_no_profile_gets_none_of_it() {
        let Some(shell) = other_shell() else {
            eprintln!("this machine has no second shell to probe with; skipping");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let real = std::fs::canonicalize(dir.path()).expect("canonicalize");
        // A profile exists in the file and is deliberately not asked for.
        let list = profiles_from(&format!(
            "[[terminal.profiles]]\nname = \"deploy\"\nshell = \"{shell}\"\n\
             cwd = \"{}\"\nenv = {{ TABVERSE_PROFILE_PROBE = \"reached-the-pty\" }}\n",
            real.display()
        ));
        let opts = spawn_opts(
            &list,
            &TermRequest {
                cols: 100,
                rows: 24,
                cwd: Some(real.display().to_string()),
                profile: None,
                run_on_start: None,
            },
        )
        .expect("composes");
        // Kept for after the shell has spoken, never before it: a struct
        // assertion placed first would be the thing that fails when the pipe
        // leaks, and the claim being made here is about the process.
        let shell_named = opts.shell.clone();
        let transcript = run(
            opts,
            Some(&format!("echo \"PROBE=[$TABVERSE_PROFILE_PROBE][{SYNC}]\"")),
            "PROBE=[][42]",
        );
        assert!(
            transcript.contains("PROBE=[][42]"),
            "a terminal opened without a profile must not inherit one's \
             environment; the shell said:\n{}",
            transcript.escape_debug()
        );
        assert_eq!(shell_named, None, "and no profile names no shell");
    }

    // -------------------------------------------------------- writing back

    #[test]
    fn writing_a_profile_keeps_the_rest_of_the_file_as_it_was() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = "# my configuration\n\n\
                    [appearance]\n\
                    theme = \"dark\"      # chosen deliberately\n\n\
                    [[terminal.profiles]]\n\
                    name = \"deploy\"     # the important one\n\
                    shell = \"/bin/bash\"\n";
        let path = write(dir.path(), "config.toml", body);
        set_in_file(
            &path,
            "deploy",
            &Profile {
                name: "deploy".into(),
                shell: Some("/bin/zsh".into()),
                env: BTreeMap::from([("AWS_PROFILE".to_string(), "prod".to_string())]),
                ..Default::default()
            },
        )
        .expect("write");
        let after = std::fs::read_to_string(&path).expect("read back");
        assert!(
            after.contains("# my configuration"),
            "header comment:\n{after}"
        );
        assert!(
            after.contains("theme = \"dark\"      # chosen deliberately"),
            "an untouched line is untouched, alignment and all:\n{after}"
        );
        assert!(
            after.contains("# the important one"),
            "the comment beside an edited line survives it:\n{after}"
        );
        assert!(
            after.contains("/bin/zsh"),
            "the new value is there:\n{after}"
        );
        assert!(
            !after.contains("/bin/bash"),
            "the old value is gone:\n{after}"
        );
        let list = config::load_from_paths(&[path])
            .expect("still loads")
            .config
            .terminal
            .profiles;
        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].env.get("AWS_PROFILE").map(String::as_str),
            Some("prod")
        );
    }

    #[test]
    fn a_field_the_profile_no_longer_has_loses_its_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[[terminal.profiles]]\nname = \"deploy\"\nshell = \"/bin/bash\"\n\
             env = { AWS_PROFILE = \"prod\" }\n",
        );
        set_in_file(
            &path,
            "deploy",
            &Profile {
                name: "deploy".into(),
                ..Default::default()
            },
        )
        .expect("write");
        let after = std::fs::read_to_string(&path).expect("read back");
        assert!(
            !after.contains("shell"),
            "not set is not set to nothing:\n{after}"
        );
        assert!(
            !after.contains("AWS_PROFILE"),
            "and the same for env:\n{after}"
        );
        let list = profiles_from(&after);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].shell, None);
    }

    #[test]
    fn a_new_profile_is_appended_as_its_own_table_header() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "# mine\n[appearance]\ntheme = \"dark\"\n",
        );
        set_in_file(
            &path,
            "deploy",
            &Profile {
                name: "deploy".into(),
                shell: Some("/bin/bash".into()),
                ..Default::default()
            },
        )
        .expect("write");
        let after = std::fs::read_to_string(&path).expect("read back");
        assert!(
            after.contains("[[terminal.profiles]]"),
            "a real array-of-tables header, not an inline table:\n{after}"
        );
        assert!(
            after.starts_with("# mine"),
            "and it is appended, not put above the file's own comments:\n{after}"
        );
        assert_eq!(profiles_from(&after).len(), 1);
    }

    #[test]
    fn renaming_edits_the_entry_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[[terminal.profiles]]\nname = \"deploy\"\nshell = \"/bin/bash\"\n\n\
             [[terminal.profiles]]\nname = \"local\"\n",
        );
        set_in_file(
            &path,
            "deploy",
            &Profile {
                name: "release".into(),
                shell: Some("/bin/bash".into()),
                ..Default::default()
            },
        )
        .expect("write");
        let list = profiles_from(&std::fs::read_to_string(&path).expect("read back"));
        assert_eq!(list.len(), 2, "a rename adds nothing");
        assert_eq!(list[0].name, "release", "and it stays where it was");
        assert_eq!(list[1].name, "local");
    }

    #[test]
    fn a_write_that_would_collide_with_another_name_is_refused_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = "[[terminal.profiles]]\nname = \"deploy\"\n\n\
                    [[terminal.profiles]]\nname = \"local\"\n";
        let path = write(dir.path(), "config.toml", body);
        let err = set_in_file(
            &path,
            "local",
            &Profile {
                name: "deploy".into(),
                ..Default::default()
            },
        )
        .expect_err("two profiles may not share a name");
        assert!(err.contains("unique"), "the message says the rule: {err}");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            body,
            "a refused write leaves the file byte for byte as it was"
        );
    }

    #[test]
    fn removing_takes_one_entry_and_leaves_the_others() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[[terminal.profiles]]\nname = \"deploy\"\n\n\
             [[terminal.profiles]]\nname = \"local\"\n",
        );
        remove_from_file(&path, "deploy").expect("remove");
        let list = profiles_from(&std::fs::read_to_string(&path).expect("read back"));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "local");
    }

    #[test]
    fn removing_the_last_one_leaves_a_file_with_no_profiles_in_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "# my configuration\n\n[appearance]\ntheme = \"dark\"\n\n\
             [[terminal.profiles]]\nname = \"deploy\"\n",
        );
        remove_from_file(&path, "deploy").expect("remove");
        let after = std::fs::read_to_string(&path).expect("read back");
        assert!(
            !after.contains("profiles"),
            "no empty husk left behind:\n{after}"
        );
        assert!(
            after.contains("# my configuration") && after.contains("theme = \"dark\""),
            "and nothing else touched:\n{after}"
        );
        assert!(profiles_from(&after).is_empty());
    }

    #[test]
    fn removing_something_that_is_not_there_writes_nothing_at_all() {
        let dir = tempfile::tempdir().expect("tempdir");
        let body = "[[terminal.profiles]]\nname = \"deploy\"\n";
        let path = write(dir.path(), "config.toml", body);
        let before = std::fs::metadata(&path).expect("stat").modified().ok();
        remove_from_file(&path, "ghost").expect("a name that is not there is not an error");
        assert_eq!(std::fs::read_to_string(&path).expect("read back"), body);
        assert_eq!(
            std::fs::metadata(&path).expect("stat").modified().ok(),
            before,
            "the file was not rewritten"
        );
    }
}
