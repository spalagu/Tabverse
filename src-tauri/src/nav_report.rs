use crate::AppHandle;
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavErrorEvent {
    pub tab_id: String,
    /// "failure" — a real failure, or "certificate" — a security block the
    /// user is allowed to override.
    pub kind: &'static str,
    pub host: String,
    pub url: String,
    /// Already phrased for a human, in terms of the next thing to try.
    pub message: String,
}

/// Which shape of trouble this is. Each engine maps its own error codes
/// onto these; nothing below this line knows what an engine is.
#[allow(dead_code)]
pub enum Trouble {
    /// The name did not resolve.
    UnknownHost,
    /// It resolved and refused.
    Refused,
    /// It answered too slowly, or not at all.
    TimedOut,
    /// This machine has no network at all.
    Offline,
    /// A certificate this machine does not trust — a decision, not a failure.
    Certificate,
    /// The app's own policy stopped it, which should no longer happen.
    BlockedByApp,
    /// Anything else: say where it came from rather than invent a cause.
    Unclassified(String),
}

pub fn describe(trouble: &Trouble, host: &str) -> (&'static str, String) {
    let site = if host.is_empty() { "this site" } else { host };
    match trouble {
        Trouble::Certificate => (
            "certificate",
            format!(
                "{site} presented a certificate this machine does not trust. \
                 That is a certificate problem, not a network one — common for \
                 internal tools with their own certificate authority, and also \
                 exactly what an intercepted connection looks like."
            ),
        ),
        Trouble::UnknownHost => (
            "failure",
            format!(
                "Can't find {site}. Check the spelling, or whether reaching this \
                 host needs a VPN connection."
            ),
        ),
        Trouble::Refused => (
            "failure",
            format!(
                "{site} refused the connection. The name resolved, so the host is \
                 reachable — check the port, or whether the service is running."
            ),
        ),
        Trouble::TimedOut => (
            "failure",
            format!("{site} did not answer in time. It may be slow, or blocked on the way."),
        ),
        Trouble::Offline => (
            "failure",
            "This machine is offline — no network connection at all.".to_string(),
        ),
        Trouble::BlockedByApp => (
            "failure",
            format!(
                "Tabverse blocked a plain-http page on {site}. This should no longer \
                 happen; please report it."
            ),
        ),
        Trouble::Unclassified(detail) => {
            ("failure", format!("{site} could not be opened: {detail}"))
        }
    }
}

/// Tell the tab. One event, one shape, whichever engine noticed.
pub fn report(app: &AppHandle, tab_id: &str, url: &str, trouble: Trouble) {
    let host = url
        .parse::<tauri::Url>()
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let (kind, message) = describe(&trouble, &host);
    let _ = app.emit(
        "browser-nav-error",
        NavErrorEvent {
            tab_id: tab_id.to_string(),
            kind,
            host,
            url: url.to_string(),
            message,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_certificate_is_a_decision_not_a_failure() {
        let (kind, text) = describe(&Trouble::Certificate, "internal.example");
        assert_eq!(kind, "certificate");
        assert!(text.contains("internal.example"));
    }

    #[test]
    fn every_message_names_the_site_it_is_about() {
        for trouble in [
            Trouble::UnknownHost,
            Trouble::Refused,
            Trouble::TimedOut,
            Trouble::Certificate,
            Trouble::BlockedByApp,
        ] {
            let (_, text) = describe(&trouble, "example.test");
            assert!(text.contains("example.test"), "{text}");
        }
    }

    #[test]
    fn a_missing_host_still_reads_as_a_sentence() {
        let (_, text) = describe(&Trouble::Refused, "");
        assert!(text.starts_with("this site"), "{text}");
    }
}
