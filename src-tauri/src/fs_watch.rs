use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::AppHandle;
use notify::{Config, Event, Watcher};
use tauri::Emitter;

use tabverse_fs::{Exclusions, WalkRules};

/// One armed watcher: kept alive by the map, dropped with it. Dropping the
/// watcher is also what stops delivery — the backend calls the closure, so
/// there is no thread of our own to join.
struct WatchHandle {
    /// Held for liveness, not read: this field existing in the map is what
    /// keeps delivery running, and dropping it (map remove, or a replace)
    /// is what stops it.
    #[allow(dead_code)]
    watcher: Box<dyn Watcher + Send>,
    /// What this watcher is aimed at, kept for the same-root no-op below.
    root: PathBuf,
}

/// The files tabs currently watching a directory: tab id -> its watcher.
pub struct WatchState {
    watchers: Mutex<HashMap<String, WatchHandle>>,
}

impl WatchState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(
        &self,
        app: &AppHandle,
        tab_id: &str,
        root: &str,
        rules: &WalkRules,
    ) -> Result<(), String> {
        let app = app.clone();
        // Compile here, once, where the snapshot is taken — a bad glob in
        // the config is a start failure the caller can show, not a filter
        // that silently lets everything through.
        let excl = Exclusions::compile(rules).map_err(|e| e.to_string())?;
        self.arm::<notify::RecommendedWatcher, _>(
            tab_id,
            Path::new(root),
            Config::default(),
            &excl,
            move |fired| {
                // The browser-* event family's delivery shape: one event
                // name, a payload naming the tab it belongs to.
                let _ = app.emit("fs-changed", serde_json::json!({ "tabId": fired }));
            },
        )
    }

    /// Release the tab's watcher — a closed or dormant tab has no tree to
    /// refresh. Watching nothing is not an error, so this cannot fail.
    pub fn stop(&self, tab_id: &str) {
        self.watchers.lock().unwrap().remove(tab_id);
    }

    /// The arming itself, generic over the watcher kind and taking the
    /// config so the tests can drive the same filter through the poll
    /// backend, whose timing does not depend on FSEvents' coalescing
    /// latency. The filter is backend-agnostic — it sees paths, wherever
    /// the backend got them from — and takes the compiled exclusions so
    /// the snapshot the tests arm with is the same object a live one holds.
    fn arm<W, F>(
        &self,
        tab_id: &str,
        root: &Path,
        config: Config,
        excl: &Exclusions,
        sink: F,
    ) -> Result<(), String>
    where
        W: Watcher + Send + 'static,
        F: Fn(&str) + Send + 'static,
    {
        // Same root: keep the live watcher — replacing it would tear a
        // working stream down for no observable difference, which is
        // exactly what pane switching between two windows on one
        // directory would otherwise do on every Tab press. It also IS the
        // config-snapshot boundary: re-arming the same root with new
        // rules keeps the old ones, by the same argument.
        let already = self
            .watchers
            .lock()
            .unwrap()
            .get(tab_id)
            .map(|h| h.root.clone());
        if already.as_deref() == Some(root) {
            return Ok(());
        }

        let tab = tab_id.to_string();
        let watched_root = root.to_path_buf();
        let excl = excl.clone();
        let mut watcher = W::new(
            move |ev: notify::Result<Event>| {
                let Ok(ev) = ev else { return };
                if ev
                    .paths
                    .iter()
                    .any(|p| path_excluded(&watched_root, p, &excl))
                {
                    return;
                }
                sink(&tab);
            },
            config,
        )
        .map_err(|e| format!("watch {}: {e}", root.display()))?;
        watcher
            .watch(root, notify::RecursiveMode::Recursive)
            .map_err(|e| format!("watch {}: {e}", root.display()))?;
        self.watchers.lock().unwrap().insert(
            tab_id.to_string(),
            WatchHandle {
                watcher: Box::new(watcher),
                root: root.to_path_buf(),
            },
        );
        Ok(())
    }

    /// How many tabs are watching — for the lifecycle tests.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.watchers.lock().unwrap().len()
    }

    /// What a tab is watching, for the lifecycle tests.
    #[cfg(test)]
    pub(crate) fn root_of(&self, tab_id: &str) -> Option<PathBuf> {
        self.watchers
            .lock()
            .unwrap()
            .get(tab_id)
            .map(|h| h.root.clone())
    }
}

fn path_excluded(root: &Path, path: &Path, excl: &Exclusions) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    rel.components()
        .any(|c| !excl.dir_admitted(&c.as_os_str().to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::PollWatcher;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// The poll backend with a short tick, so the exclusion filter is
    /// exercised deterministically instead of behind FSEvents' coalescing
    /// latency. Content comparison is on because the poll backend's
    /// default change detection is second-granularity mtime — a test write
    /// in the same second as the last one would fire nothing, and a filter
    /// test whose stimulus never happened proves nothing.
    fn poll_arm<F>(
        hub: &WatchState,
        tab: &str,
        root: &Path,
        rules: &WalkRules,
        sink: F,
    ) -> Result<(), String>
    where
        F: Fn(&str) + Send + 'static,
    {
        let excl = Exclusions::compile(rules).expect("test rules compile");
        hub.arm::<PollWatcher, _>(
            tab,
            root,
            Config::default()
                .with_poll_interval(Duration::from_millis(80))
                .with_compare_contents(true),
            &excl,
            sink,
        )
    }

    fn plain_rules() -> WalkRules {
        WalkRules::default()
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tabverse-fswatch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wait_until(what: impl Fn() -> bool, budget: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < budget {
            if what() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        what()
    }

    #[test]
    fn a_tab_holds_one_watcher_and_a_new_root_replaces_it() {
        let hub = WatchState::new();
        let a = temp_root("life-a");
        let b = temp_root("life-b");

        poll_arm(&hub, "t1", &a, &plain_rules(), |_| {}).unwrap();
        assert_eq!(hub.len(), 1);
        assert_eq!(hub.root_of("t1"), Some(a.clone()));

        // A root change is stop+start: one entry, aimed at the new root.
        poll_arm(&hub, "t1", &b, &plain_rules(), |_| {}).unwrap();
        assert_eq!(hub.len(), 1);
        assert_eq!(hub.root_of("t1"), Some(b.clone()));

        // Second tab, second watcher — per tab, not per process.
        poll_arm(&hub, "t2", &a, &plain_rules(), |_| {}).unwrap();
        assert_eq!(hub.len(), 2);

        hub.stop("t1");
        assert_eq!(hub.len(), 1);
        assert_eq!(hub.root_of("t1"), None);
        hub.stop("nobody");
        assert_eq!(hub.len(), 1, "stopping an unarmed tab is a no-op");
        hub.stop("t2");
        assert_eq!(hub.len(), 0);
    }

    #[test]
    fn the_same_root_twice_keeps_the_live_watcher() {
        let hub = WatchState::new();
        let a = temp_root("same");
        let hits = Arc::new(Mutex::new(0));
        let sink = {
            let hits = hits.clone();
            move |_tab: &str| {
                *hits.lock().unwrap() += 1;
            }
        };
        poll_arm(&hub, "t1", &a, &plain_rules(), sink).unwrap();
        std::fs::write(a.join("one.txt"), "one").unwrap();
        assert!(wait_until(
            || *hits.lock().unwrap() > 0,
            Duration::from_secs(5)
        ));

        // Re-arming the same root must not replace the watcher: the sink
        // registered at the first arm keeps firing, which a replacement
        // would have torn down.
        let sink2 = move |_tab: &str| {};
        poll_arm(&hub, "t1", &a, &plain_rules(), sink2).unwrap();
        assert_eq!(hub.len(), 1);
        std::fs::write(a.join("one.txt"), "two").unwrap();
        let before = *hits.lock().unwrap();
        assert!(wait_until(
            || *hits.lock().unwrap() > before,
            Duration::from_secs(5)
        ));
    }

    #[test]
    fn changes_under_excluded_directories_never_reach_the_sink() {
        let root = temp_root("excl");
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/x.txt"), "one").unwrap();
        std::fs::write(root.join("real.txt"), "one").unwrap();

        let hub = WatchState::new();
        let hits: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_hits = hits.clone();
        poll_arm(&hub, "tab-e", &root, &plain_rules(), move |tab| {
            sink_hits.lock().unwrap().push(tab.to_string());
        })
        .unwrap();

        // Let the first polls pass so startup noise (if the backend ever
        // emits any) is drained before the assertions begin.
        std::thread::sleep(Duration::from_millis(300));
        hits.lock().unwrap().clear();

        // A write inside node_modules: the tree's own walks skip it, and
        // so must the watcher — an npm install must not hammer the tree.
        std::fs::write(root.join("node_modules/x.txt"), "two").unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            hits.lock().unwrap().is_empty(),
            "an excluded path fired: {:?}",
            hits.lock().unwrap()
        );

        // The same gesture outside the exclude list must fire — the half
        // that proves the filter is not just swallowing everything (the
        // negative-probe rule: one probe's silence says nothing about the
        // other).
        std::fs::write(root.join("real.txt"), "two").unwrap();
        assert!(wait_until(
            || !hits.lock().unwrap().is_empty(),
            Duration::from_secs(5)
        ));
        assert_eq!(*hits.lock().unwrap(), vec!["tab-e".to_string()]);
    }

    #[test]
    fn the_users_list_filters_events_and_only_the_watcher_that_read_it() {
        let root = temp_root("rules");
        std::fs::create_dir_all(root.join("vendor")).unwrap();
        std::fs::write(root.join("vendor/x.txt"), "one").unwrap();
        std::fs::write(root.join("real.txt"), "one").unwrap();
        let custom = WalkRules {
            exclude: vec!["vendor".into()],
            respect_gitignore: false,
        };

        let hub = WatchState::new();
        let plain_hits: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_plain = plain_hits.clone();
        // Armed BEFORE the config existed — keeps the plain rules, which
        // is the spawn-snapshot boundary this test pins from the other
        // side: an already-running watcher is not re-hooked.
        poll_arm(&hub, "plain", &root, &plain_rules(), move |tab| {
            sink_plain.lock().unwrap().push(tab.to_string());
        })
        .unwrap();
        let custom_hits: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_custom = custom_hits.clone();
        poll_arm(&hub, "custom", &root, &custom, move |tab| {
            sink_custom.lock().unwrap().push(tab.to_string());
        })
        .unwrap();

        // Let startup noise drain before the assertions begin.
        std::thread::sleep(Duration::from_millis(300));
        plain_hits.lock().unwrap().clear();
        custom_hits.lock().unwrap().clear();

        std::fs::write(root.join("vendor/x.txt"), "two").unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            custom_hits.lock().unwrap().is_empty(),
            "the configured list swallowed the vendor event: {:?}",
            custom_hits.lock().unwrap()
        );
        // The same event through the plain watcher fires — both halves of
        // the pair, or the first silence proves nothing.
        assert!(
            wait_until(
                || !plain_hits.lock().unwrap().is_empty(),
                Duration::from_secs(5)
            ),
            "a watcher armed before the config kept the old rules and still fires"
        );

        // And the custom watcher is alive at all, not just mute.
        plain_hits.lock().unwrap().clear();
        std::fs::write(root.join("real.txt"), "two").unwrap();
        assert!(wait_until(
            || !custom_hits.lock().unwrap().is_empty(),
            Duration::from_secs(5)
        ));
    }
}
