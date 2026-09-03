use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

const DNS_CACHE_TTL: Duration = Duration::from_secs(30);
const DNS_CACHE_LIMIT: usize = 256;
const HAPPY_EYEBALLS_DELAY: Duration = Duration::from_millis(250);
const MAX_RACED_ADDRESSES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetPolicy {
    /// A local browser is allowed to reach the machine's own private network.
    LocalNavigation,
    /// A remote viewer must never turn the host into a metadata or link-local proxy.
    RemoteGrant,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    scope: String,
    host: String,
    port: u16,
}

#[derive(Debug, Clone)]
struct CachedAnswer {
    expires_at: Instant,
    addresses: Vec<SocketAddr>,
}

/// Bounded DNS answer cache shared by the page proxy's connections.
///
/// Remote grants deliberately request fresh answers at both authorization and
/// execution, so rebinding detection is never hidden by this cache.
pub struct DnsCache {
    ttl: Duration,
    entries: Mutex<HashMap<CacheKey, CachedAnswer>>,
}

impl Default for DnsCache {
    fn default() -> Self {
        Self {
            ttl: DNS_CACHE_TTL,
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl DnsCache {
    pub fn resolve<F>(
        &self,
        scope: &str,
        host: &str,
        port: u16,
        fresh: bool,
        resolver: F,
    ) -> Result<Vec<SocketAddr>, String>
    where
        F: FnOnce() -> Result<Vec<SocketAddr>, String>,
    {
        let key = CacheKey {
            scope: scope.to_string(),
            host: host.to_ascii_lowercase(),
            port,
        };
        if !fresh {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            entries.retain(|_, answer| answer.expires_at > now);
            if let Some(answer) = entries.get(&key) {
                return Ok(answer.addresses.clone());
            }
        }

        let addresses = resolver()?;
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= DNS_CACHE_LIMIT {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, answer)| answer.expires_at)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key,
            CachedAnswer {
                expires_at: Instant::now() + self.ttl,
                addresses: addresses.clone(),
            },
        );
        Ok(addresses)
    }

    #[cfg(test)]
    fn with_ttl(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }
}

pub fn system_resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    if let Ok(literal) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(literal, port)]);
    }
    (host, port)
        .to_socket_addrs()
        .map(|addresses| addresses.collect())
        .map_err(|error| format!("dns-failed: host resolution failed: {error}"))
}

/// Canonicalize one answer and enforce the policy before any socket opens.
pub fn approve_addresses(
    mut addresses: Vec<SocketAddr>,
    port: u16,
    policy: TargetPolicy,
) -> Result<Vec<SocketAddr>, String> {
    for address in &mut addresses {
        address.set_port(port);
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err("dns-failed: host resolved to no address".into());
    }
    if policy == TargetPolicy::RemoteGrant
        && addresses
            .iter()
            .any(|address| prohibited_address(address.ip()))
    {
        return Err("ssrf-denied: target resolved to a prohibited address class".into());
    }
    Ok(addresses)
}

fn prohibited_address(ip: IpAddr) -> bool {
    if ip.is_unspecified() || ip.is_multicast() {
        return true;
    }
    match ip {
        IpAddr::V4(ip) => {
            ip.is_link_local()
                || ip.is_broadcast()
                || ip == std::net::Ipv4Addr::new(169, 254, 169, 254)
                || ip == std::net::Ipv4Addr::new(100, 100, 100, 200)
        }
        IpAddr::V6(ip) => {
            ip.is_unicast_link_local()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| prohibited_address(IpAddr::V4(mapped)))
        }
    }
}

/// Preserve the resolver's first-family preference while alternating families.
pub fn happy_eyeballs_order(addresses: &[SocketAddr]) -> Vec<SocketAddr> {
    let mut preferred_v6 = addresses.first().is_some_and(SocketAddr::is_ipv6);
    let mut v4 = addresses.iter().copied().filter(SocketAddr::is_ipv4);
    let mut v6 = addresses.iter().copied().filter(SocketAddr::is_ipv6);
    let mut ordered = Vec::with_capacity(addresses.len());
    loop {
        let next = if preferred_v6 { v6.next() } else { v4.next() }.or_else(|| {
            if preferred_v6 {
                v4.next()
            } else {
                v6.next()
            }
        });
        let Some(address) = next else {
            break;
        };
        ordered.push(address);
        preferred_v6 = !preferred_v6;
    }
    ordered
}

/// Race address families with a bounded stagger and return the first socket.
pub fn connect_happy_eyeballs(addresses: &[SocketAddr], budget: Duration) -> Option<TcpStream> {
    if budget.is_zero() {
        return None;
    }
    let deadline = Instant::now() + budget;
    let (send, receive) = mpsc::channel();
    let won = Arc::new(AtomicBool::new(false));
    let ordered = happy_eyeballs_order(addresses);
    for (index, address) in ordered.into_iter().take(MAX_RACED_ADDRESSES).enumerate() {
        let send = send.clone();
        let won = Arc::clone(&won);
        let delay = HAPPY_EYEBALLS_DELAY.saturating_mul(index as u32);
        let _ = std::thread::Builder::new()
            .name("tabverse-network-connect".into())
            .spawn(move || {
                if delay >= budget {
                    return;
                }
                std::thread::sleep(delay);
                if won.load(Ordering::Acquire) {
                    return;
                }
                let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                    return;
                };
                if let Ok(stream) = TcpStream::connect_timeout(&address, left) {
                    if !won.swap(true, Ordering::AcqRel) {
                        let _ = send.send(stream);
                    }
                }
            });
    }
    drop(send);
    receive.recv_timeout(budget).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn remote_policy_refuses_metadata_link_local_and_mapped_aliases() {
        for ip in [
            "169.254.169.254",
            "100.100.100.200",
            "fe80::1",
            "::ffff:169.254.169.254",
        ] {
            let address = SocketAddr::new(ip.parse().unwrap(), 80);
            assert!(approve_addresses(vec![address], 80, TargetPolicy::RemoteGrant).is_err());
            assert!(approve_addresses(vec![address], 80, TargetPolicy::LocalNavigation).is_ok());
        }
    }

    #[test]
    fn address_order_alternates_families_without_losing_answers() {
        let addresses = [
            "[2001:db8::1]:443".parse().unwrap(),
            "[2001:db8::2]:443".parse().unwrap(),
            "192.0.2.1:443".parse().unwrap(),
            "192.0.2.2:443".parse().unwrap(),
        ];
        let ordered = happy_eyeballs_order(&addresses);
        assert_eq!(ordered.len(), addresses.len());
        assert!(ordered[0].is_ipv6());
        assert!(ordered[1].is_ipv4());
        assert!(ordered[2].is_ipv6());
        assert!(ordered[3].is_ipv4());
    }

    #[test]
    fn cache_is_scoped_bounded_by_ttl_and_bypassable_for_rebind_checks() {
        let cache = DnsCache::with_ttl(Duration::from_millis(5));
        let calls = AtomicUsize::new(0);
        let resolve = || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(vec!["192.0.2.1:80".parse().unwrap()])
        };
        cache
            .resolve("system", "example.test", 80, false, resolve)
            .unwrap();
        cache
            .resolve("system", "example.test", 80, false, resolve)
            .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        cache
            .resolve("system", "example.test", 80, true, resolve)
            .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        std::thread::sleep(Duration::from_millis(10));
        cache
            .resolve("system", "example.test", 80, false, resolve)
            .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn family_race_reaches_a_live_second_family() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let addresses = [
            SocketAddr::new("::1".parse().unwrap(), port),
            SocketAddr::new("127.0.0.1".parse().unwrap(), port),
        ];
        let accepted = std::thread::spawn(move || listener.accept().unwrap());
        let connected = connect_happy_eyeballs(&addresses, Duration::from_secs(2));
        assert!(connected.is_some());
        drop(connected);
        accepted.join().unwrap();
    }
}
