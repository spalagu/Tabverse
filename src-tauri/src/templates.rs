use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use toml_edit::{Array, ArrayOfTables, InlineTable, Item, Table, Value};

use crate::config::{self, Warning};

pub const KEY: &str = "templates";
pub const SECTION: &str = "terminal";

const ENTRY_FIELDS: &[&str] = &["name", "tree"];
const LEAF_FIELDS: &[&str] = &["kind", "profile", "cwd", "run_on_start"];
const SPLIT_FIELDS: &[&str] = &["kind", "vertical", "ratios", "children"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    #[serde(deserialize_with = "de_name")]
    pub name: String,
    pub tree: TemplateNode,
}

/// Ratios are positive integer weights rather than floating-point shares.
/// `60, 40` and `3, 2` describe the same split, remain exactly comparable,
/// and the interface normalizes them when it creates the live pane tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TemplateNode {
    Leaf {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_on_start: Option<String>,
    },
    Split {
        #[serde(default)]
        vertical: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ratios: Vec<u32>,
        children: Vec<TemplateNode>,
    },
}

fn de_name<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let raw = String::deserialize(d)?;
    if raw.trim().is_empty() {
        return Err(D::Error::custom(
            "a terminal template's name must not be blank",
        ));
    }
    Ok(raw)
}

pub fn de_templates<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Template>, D::Error> {
    let list = Vec::<Template>::deserialize(d)?;
    for template in &list {
        validate_node(&template.tree).map_err(D::Error::custom)?;
    }
    for (index, template) in list.iter().enumerate() {
        if list[..index]
            .iter()
            .any(|other| other.name == template.name)
        {
            return Err(D::Error::custom(format!(
                "two terminal templates are named `{}` — template names have to be unique",
                template.name
            )));
        }
    }
    Ok(list)
}

fn validate_node(node: &TemplateNode) -> Result<(), String> {
    match node {
        TemplateNode::Leaf { .. } => Ok(()),
        TemplateNode::Split {
            ratios, children, ..
        } => {
            if children.len() < 2 {
                return Err("a template split must contain at least two children".to_string());
            }
            if !ratios.is_empty() && (ratios.len() != children.len() || ratios.contains(&0)) {
                return Err(
                    "a template split's ratios must contain one positive weight per child"
                        .to_string(),
                );
            }
            for child in children {
                validate_node(child)?;
            }
            Ok(())
        }
    }
}

/// Unknown template fields, recursively, with their source positions.
pub fn scan_unknown_keys(
    path_text: &str,
    src: &str,
    value: &toml::de::DeValue<'_>,
) -> Vec<Warning> {
    let mut out = Vec::new();
    let toml::de::DeValue::Array(entries) = value else {
        return out;
    };
    for entry in entries {
        let toml::de::DeValue::Table(table) = entry.get_ref() else {
            continue;
        };
        scan_table(path_text, src, table, ENTRY_FIELDS, &mut out);
        if let Some(tree) = table
            .iter()
            .find(|(key, _)| key.get_ref().as_ref() == "tree")
            .map(|(_, value)| value.get_ref())
        {
            scan_tree(path_text, src, tree, &mut out);
        }
    }
    out
}

fn scan_tree(path_text: &str, src: &str, value: &toml::de::DeValue<'_>, out: &mut Vec<Warning>) {
    let toml::de::DeValue::Table(table) = value else {
        return;
    };
    let kind = table
        .iter()
        .find(|(key, _)| key.get_ref().as_ref() == "kind")
        .and_then(|(_, value)| match value.get_ref() {
            toml::de::DeValue::String(raw) => Some(raw.as_ref()),
            _ => None,
        });
    let fields = if kind == Some("split") {
        SPLIT_FIELDS
    } else {
        LEAF_FIELDS
    };
    scan_table(path_text, src, table, fields, out);
    if kind == Some("split") {
        if let Some(toml::de::DeValue::Array(children)) = table
            .iter()
            .find(|(key, _)| key.get_ref().as_ref() == "children")
            .map(|(_, value)| value.get_ref())
        {
            for child in children {
                scan_tree(path_text, src, child.get_ref(), out);
            }
        }
    }
}

fn scan_table(
    path_text: &str,
    src: &str,
    table: &toml::de::DeTable<'_>,
    allowed: &[&str],
    out: &mut Vec<Warning>,
) {
    for (key, _) in table.iter() {
        let field = key.get_ref().as_ref();
        if allowed.contains(&field) {
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

// ------------------------------------------------------------- write-back

pub fn set_in_file(
    path: &std::path::Path,
    target: &str,
    template: &Template,
) -> Result<(), String> {
    if template.name.trim().is_empty() {
        return Err("a terminal template's name must not be blank".to_string());
    }
    validate_node(&template.tree)?;
    let mut doc = config::open_document(path)?;
    let section = config::section_mut(&mut doc, SECTION)?;
    let array = array_mut(section)?;
    let existing = array
        .iter()
        .position(|table| entry_name(table).as_deref() == Some(target));
    match existing {
        Some(index) => write_entry(array.get_mut(index).expect("index just found"), template),
        None => {
            let mut table = Table::new();
            write_entry(&mut table, template);
            array.push(table);
        }
    }
    publish(path, doc)
}

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
        .position(|table| entry_name(table).as_deref() == Some(name))
    else {
        return Ok(());
    };
    array.remove(index);
    if array.is_empty() {
        section.remove(KEY);
    }
    publish(path, doc)
}

fn publish(path: &std::path::Path, doc: toml_edit::DocumentMut) -> Result<(), String> {
    let text = doc.to_string();
    if let Err(error) = toml::from_str::<config::Config>(&text) {
        return Err(error.message().to_string());
    }
    config::write_atomically(path, &text)
}

fn array_mut(section: &mut Table) -> Result<&mut ArrayOfTables, String> {
    if section.get(KEY).is_none() {
        section.insert(KEY, Item::ArrayOfTables(ArrayOfTables::new()));
    }
    section
        .get_mut(KEY)
        .and_then(Item::as_array_of_tables_mut)
        .ok_or_else(|| {
            format!(
                "`{SECTION}.{KEY}` is not written as a series of [[{SECTION}.{KEY}]] tables in this file, so templates cannot be saved"
            )
        })
}

fn entry_name(table: &Table) -> Option<String> {
    table
        .get("name")
        .and_then(Item::as_value)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn write_entry(table: &mut Table, template: &Template) {
    config::put(table, "name", Value::from(template.name.as_str()));
    config::put(table, "tree", node_value(&template.tree));
}

fn node_value(node: &TemplateNode) -> Value {
    let mut table = InlineTable::new();
    match node {
        TemplateNode::Leaf {
            profile,
            cwd,
            run_on_start,
        } => {
            table.insert("kind", Value::from("leaf"));
            if let Some(value) = profile {
                table.insert("profile", Value::from(value.as_str()));
            }
            if let Some(value) = cwd {
                table.insert("cwd", Value::from(value.as_str()));
            }
            if let Some(value) = run_on_start {
                table.insert("run_on_start", Value::from(value.as_str()));
            }
        }
        TemplateNode::Split {
            vertical,
            ratios,
            children,
        } => {
            table.insert("kind", Value::from("split"));
            table.insert("vertical", Value::from(*vertical));
            if !ratios.is_empty() {
                let mut values = Array::new();
                for ratio in ratios {
                    values.push(i64::from(*ratio));
                }
                table.insert("ratios", Value::Array(values));
            }
            let mut values = Array::new();
            for child in children {
                values.push(node_value(child));
            }
            table.insert("children", Value::Array(values));
        }
    }
    Value::InlineTable(table)
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn config_template_set(target: String, template: Template) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path =
            config::write_target(config::current_platform(), &config::EnvVars::from_process())?;
        set_in_file(&path, &target, &template)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn config_template_remove(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path =
            config::write_target(config::current_platform(), &config::EnvVars::from_process())?;
        remove_from_file(&path, &name)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write fixture");
        path
    }

    fn templates_from(body: &str) -> Vec<Template> {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "config.toml", body);
        config::load_from_paths(&[path])
            .expect("fixture loads")
            .config
            .terminal
            .templates
    }

    #[test]
    fn a_nested_template_loads_with_shape_and_launch_fields() {
        let list = templates_from(
            "[[terminal.templates]]\n\
             name = \"work\"\n\
             tree = { kind = \"split\", vertical = false, ratios = [60, 40], children = [\n\
               { kind = \"leaf\", profile = \"code\", cwd = \"/work/app\" },\n\
               { kind = \"split\", vertical = true, children = [\n\
                 { kind = \"leaf\", cwd = \"/work/logs\" },\n\
                 { kind = \"leaf\", run_on_start = \"make watch\" }\n\
               ] }\n\
             ] }\n",
        );
        assert_eq!(list.len(), 1);
        let TemplateNode::Split {
            vertical,
            ratios,
            children,
        } = &list[0].tree
        else {
            panic!("root is not a split");
        };
        assert!(!vertical);
        assert_eq!(ratios, &[60, 40]);
        assert_eq!(children.len(), 2);
    }

    #[test]
    fn a_split_with_one_child_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "bad.toml",
            "[[terminal.templates]]\nname = \"bad\"\n\
             tree = { kind = \"split\", children = [{ kind = \"leaf\" }] }\n",
        );
        let error = config::load_from_paths(&[path]).expect_err("bad split must fail");
        assert!(error.message.contains("at least two"), "{error}");
    }

    #[test]
    fn set_and_remove_keep_the_rest_of_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "# keep\n[appearance]\ntheme = \"dark\"\n",
        );
        let template = Template {
            name: "work".into(),
            tree: TemplateNode::Leaf {
                profile: Some("code".into()),
                cwd: Some("/work".into()),
                run_on_start: None,
            },
        };
        set_in_file(&path, "work", &template).expect("set");
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(text.starts_with("# keep\n[appearance]\ntheme = \"dark\"\n"));
        assert!(text.contains("[[terminal.templates]]"));
        assert_eq!(templates_from(&text), vec![template]);
        remove_from_file(&path, "work").expect("remove");
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(!text.contains("templates"));
        assert!(text.starts_with("# keep\n[appearance]\ntheme = \"dark\"\n"));
    }

    #[test]
    fn an_unknown_leaf_field_warns_and_still_loads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "config.toml",
            "[[terminal.templates]]\nname = \"work\"\n\
             tree = { kind = \"leaf\", cwd = \"/work\", cwwd = \"/typo\" }\n",
        );
        let loaded = config::load_from_paths(&[path]).expect("unknown fields do not stop a load");
        assert_eq!(loaded.config.terminal.templates.len(), 1);
        assert_eq!(loaded.warnings.len(), 1);
        assert_eq!(loaded.warnings[0].key, "terminal.templates.cwwd");
    }
}
