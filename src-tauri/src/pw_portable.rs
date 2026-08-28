use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::credentials;

/// What each column means, whoever wrote the file.
///
/// The header is the only thing that says which column is which, and every
/// exporter names them differently — so a column is found by what it is
/// called, from the set of names the common ones use, rather than by
/// counting from the left.
const URL_NAMES: &[&str] = &[
    "url",
    "website",
    "web site",
    "login_uri",
    "hostname",
    "site",
];
const USER_NAMES: &[&str] = &[
    "username",
    "user",
    "login",
    "login_username",
    "account",
    "email",
];
const PASS_NAMES: &[&str] = &["password", "pass", "login_password"];

/// One line of a comma-separated file, honouring quotes.
///
/// Written out rather than pulled in: a password is exactly the kind of
/// field that contains a comma, a quote or a newline, and a split on ","
/// silently truncates it — which would store a wrong password that looks
/// right in a list.
fn parse_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                // A doubled quote inside a quoted field is one quote.
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == ',' {
            out.push(std::mem::take(&mut field));
        } else {
            field.push(c);
        }
    }
    out.push(field);
    out
}

/// Split a whole file into records, keeping fields that span lines together.
fn parse_records(text: &str) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut pending = String::new();
    for line in text.lines() {
        if pending.is_empty() {
            pending.push_str(line);
        } else {
            pending.push('\n');
            pending.push_str(line);
        }
        // An odd number of quotes means the record continues on the next
        // line — a note field with a line break in it, most often.
        if pending.matches('"').count().is_multiple_of(2) {
            records.push(parse_line(&pending));
            pending.clear();
        }
    }
    if !pending.is_empty() {
        records.push(parse_line(&pending));
    }
    records
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// The site a login belongs to, from whatever the file called it.
///
/// Files carry anything from a bare host to a full address with a path and
/// a query. What this app stores is a host, so everything else is peeled
/// off — otherwise the same site imported from two browsers becomes two
/// entries, neither of which matches the page the user is looking at.
pub fn host_of(raw: &str) -> String {
    let s = raw.trim();
    let s = s.split_once("://").map(|(_, rest)| rest).unwrap_or(s);
    let s = s.split('/').next().unwrap_or(s);
    // Credentials in the address, and the port, are not part of the host.
    let s = s.rsplit('@').next().unwrap_or(s);
    let s = s.split(':').next().unwrap_or(s);
    s.trim().to_ascii_lowercase()
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    /// Rows that carried no password, or no site to attach it to.
    pub skipped: usize,
    /// Rows the keychain refused; the reason is reported once, not per row.
    pub failed: usize,
    pub first_error: Option<String>,
}

/// Read a file another browser wrote, and put what it holds in the keychain.
pub fn import_csv(path: &Path) -> Result<ImportReport, String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut records = parse_records(&text).into_iter();
    let header = records
        .next()
        .ok_or_else(|| "the file is empty".to_string())?;
    let mut column: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, name) in header.iter().enumerate() {
        let n = name.trim().trim_matches('"').to_ascii_lowercase();
        if URL_NAMES.contains(&n.as_str()) {
            column.entry("url").or_insert(i);
        } else if USER_NAMES.contains(&n.as_str()) {
            column.entry("user").or_insert(i);
        } else if PASS_NAMES.contains(&n.as_str()) {
            column.entry("pass").or_insert(i);
        }
    }
    let (Some(&url_at), Some(&pass_at)) = (column.get("url"), column.get("pass")) else {
        return Err(
            "this file has no column named for a site and one for a password, so there is \
             nothing to read. Export from the other browser as CSV and try that file."
                .to_string(),
        );
    };
    let user_at = column.get("user").copied();

    let mut report = ImportReport {
        added: 0,
        skipped: 0,
        failed: 0,
        first_error: None,
    };
    for row in records {
        let field = |i: usize| row.get(i).map(|s| s.trim()).unwrap_or("");
        let host = host_of(field(url_at));
        let password = field(pass_at);
        // A row with no password is not a login; a row with no site has
        // nowhere to be filled in. Neither is an error worth stopping for.
        if host.is_empty() || password.is_empty() {
            report.skipped += 1;
            continue;
        }
        let username = user_at.map(field).unwrap_or("");
        match credentials::save_web(&host, username, password) {
            Ok(()) => report.added += 1,
            Err(e) => {
                report.failed += 1;
                // The message names the site, never the value.
                if report.first_error.is_none() {
                    report.first_error = Some(e);
                }
            }
        }
    }
    Ok(report)
}

/// Write every saved login in the shape other browsers import.
///
/// The column names are the ones Chrome writes, which Safari, Firefox and
/// the standalone managers all read. Returns how many were written.
pub fn export_csv(path: &Path) -> Result<usize, String> {
    let mut out = String::from("name,url,username,password,note\n");
    let mut written = 0usize;
    let mut hosts: Vec<String> = credentials::list_web()?
        .into_iter()
        .map(|(host, _)| host)
        .collect();
    hosts.sort();
    hosts.dedup();
    for host in hosts {
        for c in credentials::find_web(&host)? {
            out.push_str(&format!(
                "{},{},{},{},{}\n",
                quote(&c.host),
                quote(&format!("https://{}/", c.host)),
                quote(&c.username),
                quote(&c.password),
                quote("")
            ));
            written += 1;
        }
    }
    fs::write(path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_password_holding_a_comma_or_a_quote_survives_the_round_trip() {
        let nasty = "a,b\"c";
        let line = format!("{},{}", quote("site"), quote(nasty));
        let fields = parse_line(&line);
        assert_eq!(fields, vec!["site".to_string(), nasty.to_string()]);
    }

    #[test]
    fn a_field_spanning_two_lines_stays_one_field() {
        let text = "url,password\n\"example.com\",\"one\ntwo\"\n";
        let records = parse_records(text);
        assert_eq!(records.len(), 2);
        assert_eq!(records[1][1], "one\ntwo");
    }

    #[test]
    fn a_site_is_reduced_to_its_host_however_it_was_written() {
        for raw in [
            "https://Example.com/login?next=1",
            "example.com",
            "http://user@example.com:8443/",
            "  https://EXAMPLE.com  ",
        ] {
            assert_eq!(host_of(raw), "example.com", "for {raw}");
        }
    }

    #[test]
    fn columns_are_found_by_name_not_by_position() {
        // Firefox's order, which puts the site first and the password third,
        // versus a manager that writes them in another order entirely.
        let text = "\"username\",\"url\",\"password\"\n\"me\",\"https://a.test/\",\"s3cret\"\n";
        let records = parse_records(text);
        let header: Vec<String> = records[0].iter().map(|s| s.to_ascii_lowercase()).collect();
        let url_at = header.iter().position(|h| URL_NAMES.contains(&h.as_str()));
        let pass_at = header.iter().position(|h| PASS_NAMES.contains(&h.as_str()));
        assert_eq!(url_at, Some(1));
        assert_eq!(pass_at, Some(2));
    }
}
