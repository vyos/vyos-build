//! Flow-decision event schema — one flat JSON object per classified flow.
//!
//! The schema is a stability contract (ELK/Splunk pipelines and the WebUI
//! Alerts tab consume it); it is documented in docs/event-schema.md and
//! covered by a golden test below. Fields are only ever added, never renamed
//! or removed. Loosely modeled on Suricata EVE.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    /// RFC 3339 with millisecond precision, UTC.
    pub timestamp: String,
    /// Constant "app_control" — lets mixed pipelines route by type.
    pub event_type: &'static str,
    pub src_ip: String,
    pub src_port: u16,
    pub dest_ip: String,
    pub dest_port: u16,
    /// "TCP" | "UDP" | protocol number as string.
    pub proto: String,
    pub vlan: u16,
    /// Ingress interface name at decision time ("" if unresolved).
    pub in_iface: String,
    /// nDPI application name; "Unknown" when classification never completed.
    pub app: String,
    pub app_id: u16,
    /// nDPI category name.
    pub category: String,
    /// "allow" | "block".
    pub action: String,
    /// The named action (policy) that produced the verdict.
    pub action_name: String,
    /// "drop" | "reset"; only meaningful when action == "block".
    pub block_mode: String,
    /// nDPI confidence: "dpi", "dpi_cache", "match_by_port", "match_by_ip",
    /// "unknown", … (lowercased ndpi_confidence_t name).
    pub confidence: String,
    /// True when the verdict came from the action's default
    /// ("when application does not match") rather than an app/category rule.
    pub default_applied: bool,
    /// TLS/QUIC SNI or HTTP host, when nDPI extracted one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sni: Option<String>,
    /// JA4 client fingerprint when available (JA3 if libndpi predates JA4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ja4: Option<String>,
    /// Flow byte/packet totals at decision time (both directions).
    pub bytes: u64,
    pub pkts: u64,
}

impl Event {
    pub const EVENT_TYPE: &'static str = "app_control";

    pub fn to_json_line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("event serializes");
        line.push('\n');
        line
    }
}

/// Formats a UNIX timestamp (secs, millis) as RFC 3339 UTC without pulling in
/// a date-time dependency. Days-from-civil algorithm (Howard Hinnant).
pub fn rfc3339_utc(unix_secs: i64, millis: u32) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };

    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Event {
        Event {
            timestamp: "2026-07-11T14:03:22.117Z".into(),
            event_type: Event::EVENT_TYPE,
            src_ip: "10.0.1.23".into(),
            src_port: 51544,
            dest_ip: "104.16.1.1".into(),
            dest_port: 443,
            proto: "TCP".into(),
            vlan: 0,
            in_iface: "eth1".into(),
            app: "ChatGPT".into(),
            app_id: 244,
            category: "AI".into(),
            action: "block".into(),
            action_name: "Global".into(),
            block_mode: "drop".into(),
            confidence: "dpi".into(),
            default_applied: false,
            sni: Some("chatgpt.com".into()),
            ja4: None,
            bytes: 3908,
            pkts: 7,
        }
    }

    /// Golden test: the serialized field set and order are a published
    /// contract. If this test breaks, docs/event-schema.md must be updated
    /// and the change must be additive-only.
    #[test]
    fn schema_golden() {
        let json = sample().to_json_line();
        assert_eq!(
            json,
            "{\"timestamp\":\"2026-07-11T14:03:22.117Z\",\"event_type\":\"app_control\",\
             \"src_ip\":\"10.0.1.23\",\"src_port\":51544,\"dest_ip\":\"104.16.1.1\",\
             \"dest_port\":443,\"proto\":\"TCP\",\"vlan\":0,\"in_iface\":\"eth1\",\
             \"app\":\"ChatGPT\",\"app_id\":244,\"category\":\"AI\",\"action\":\"block\",\
             \"action_name\":\"Global\",\"block_mode\":\"drop\",\"confidence\":\"dpi\",\
             \"default_applied\":false,\"sni\":\"chatgpt.com\",\"bytes\":3908,\"pkts\":7}\n"
        );
    }

    #[test]
    fn absent_optionals_are_omitted() {
        let mut e = sample();
        e.sni = None;
        let json = e.to_json_line();
        assert!(!json.contains("\"sni\""));
        assert!(!json.contains("\"ja4\""));
    }

    #[test]
    fn rfc3339_known_values() {
        assert_eq!(rfc3339_utc(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339_utc(951_782_400, 1), "2000-02-29T00:00:00.001Z");
        // 2026-07-11T14:03:22Z = 20645 days * 86400 + 50602
        assert_eq!(rfc3339_utc(1_783_778_602, 117), "2026-07-11T14:03:22.117Z");
    }
}
