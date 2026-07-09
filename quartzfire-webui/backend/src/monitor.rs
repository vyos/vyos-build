//! Live firewall-log streaming for the Traffic Monitor page.
//!
//! A VyOS filter rule with `log` set makes nftables emit a kernel-log line
//! whose prefix encodes exactly which rule fired, e.g.
//!
//! ```text
//! [ipv4-FWD-filter-10-A]IN=eth1 OUT=eth0 SRC=10.0.0.5 DST=1.1.1.1 LEN=60
//!     TOS=0x00 TTL=63 DF PROTO=TCP SPT=51000 DPT=443 SYN URGP=0
//! ```
//!
//! (`default-log` hits use `default` in place of the rule number.) This module
//! follows the kernel journal with `journalctl -k -f -o json`, parses those
//! lines, and pushes them to the browser as Server-Sent Events. The service
//! user must be able to read the journal — the systemd unit grants this via
//! `SupplementaryGroups=systemd-journal`.

use axum::{
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use serde::Serialize;
use std::{convert::Infallible, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
use tokio_stream::{wrappers::LinesStream, StreamExt};

/// One parsed firewall log line — the JSON payload of each SSE event.
#[derive(Serialize, Default)]
pub struct LogEntry {
    /// Journal receive time, milliseconds since the epoch.
    ts: u64,
    /// `ipv4` or `ipv6`.
    family: String,
    /// Base chain the rule lives in: `forward`, `input`, or `output`.
    chain: String,
    /// Rule number; null when the chain's default action fired.
    rule: Option<u32>,
    /// `accept`, `drop`, or `reject`.
    action: String,
    #[serde(rename = "in", skip_serializing_if = "Option::is_none")]
    in_if: Option<String>,
    #[serde(rename = "out", skip_serializing_if = "Option::is_none")]
    out_if: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dst: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proto: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dpt: Option<u32>,
    /// IP total length of the logged packet.
    #[serde(skip_serializing_if = "Option::is_none")]
    len: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icmp_type: Option<u32>,
}

/// GET /api/monitor/firewall-log — SSE stream of parsed firewall log entries,
/// starting with a backfill of whatever is still in the kernel journal.
pub async fn firewall_log() -> Response {
    let mut child = match Command::new("journalctl")
        .args(["-k", "-f", "-n", "1000", "-o", "json", "--no-pager"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("cannot start journalctl: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read the system journal on this device",
            )
                .into_response();
        }
    };
    let Some(stdout) = child.stdout.take() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "journalctl produced no output").into_response();
    };

    // The closure owns the child, so the stream keeps journalctl alive; when
    // the browser disconnects the stream is dropped and kill_on_drop reaps it.
    let stream = LinesStream::new(BufReader::new(stdout).lines()).filter_map(move |line| {
        let _keep_child_alive = &child;
        let entry = parse_journal_line(&line.ok()?)?;
        let json = serde_json::to_string(&entry).ok()?;
        Some(Ok::<Event, Infallible>(Event::default().data(json)))
    });

    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// Parse one `journalctl -o json` line into a firewall log entry; None for
/// anything that isn't a base-chain firewall log message.
fn parse_journal_line(line: &str) -> Option<LogEntry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    // Non-UTF8 messages come through as byte arrays — as_str skips those.
    let msg = v.get("MESSAGE")?.as_str()?;
    let ts = v
        .get("__REALTIME_TIMESTAMP")
        .and_then(|t| t.as_str())
        .and_then(|t| t.parse::<u64>().ok())
        .map(|us| us / 1000)
        .unwrap_or(0);
    parse_message(msg, ts)
}

/// Parse the nftables log text: `[family-HOOK-chain-rule-ACTION]KEY=VAL …`.
fn parse_message(msg: &str, ts: u64) -> Option<LogEntry> {
    let rest = msg.trim_start().strip_prefix('[')?;
    let (prefix, fields) = rest.split_once(']')?;

    // The chain name itself may contain '-', so peel the fixed pieces off both
    // ends: family and hook in front, rule number and action letter at the back.
    let parts: Vec<&str> = prefix.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let family = parts[0];
    if family != "ipv4" && family != "ipv6" {
        return None;
    }
    // Only the base chains the GUI models; named/NAT chains are not ours.
    let chain = match parts[1] {
        "FWD" => "forward",
        "INP" => "input",
        "OUT" => "output",
        _ => return None,
    };
    let action = match *parts.last()? {
        "A" => "accept",
        "D" => "drop",
        "R" => "reject",
        _ => return None,
    };
    let rule_part = parts[parts.len() - 2];
    let rule = if rule_part == "default" { None } else { Some(rule_part.parse::<u32>().ok()?) };

    let mut e = LogEntry {
        ts,
        family: family.to_string(),
        chain: chain.to_string(),
        rule,
        action: action.to_string(),
        ..LogEntry::default()
    };
    for tok in fields.split_whitespace() {
        let Some((k, val)) = tok.split_once('=') else { continue };
        if val.is_empty() {
            continue;
        }
        match k {
            "IN" => e.in_if = Some(val.to_string()),
            "OUT" => e.out_if = Some(val.to_string()),
            "SRC" => e.src = Some(val.to_string()),
            "DST" => e.dst = Some(val.to_string()),
            "PROTO" => e.proto = Some(val.to_ascii_lowercase()),
            "SPT" => e.spt = val.parse().ok(),
            "DPT" => e.dpt = val.parse().ok(),
            // LEN appears again for the L4 payload — keep the first (IP total).
            "LEN" if e.len.is_none() => e.len = val.parse().ok(),
            "TYPE" => e.icmp_type = val.parse().ok(),
            _ => {}
        }
    }
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_forward_accept() {
        let e = parse_message(
            "[ipv4-FWD-filter-10-A]IN=eth1 OUT=eth0 MAC=00:11:22:33:44:55:66:77:88:99:aa:bb:08:00 \
             SRC=10.0.0.5 DST=1.1.1.1 LEN=60 TOS=0x00 PREC=0x00 TTL=63 ID=12345 DF PROTO=TCP \
             SPT=51000 DPT=443 WINDOW=64240 RES=0x00 SYN URGP=0",
            1,
        )
        .expect("should parse");
        assert_eq!(e.chain, "forward");
        assert_eq!(e.rule, Some(10));
        assert_eq!(e.action, "accept");
        assert_eq!(e.src.as_deref(), Some("10.0.0.5"));
        assert_eq!(e.dpt, Some(443));
        assert_eq!(e.proto.as_deref(), Some("tcp"));
        assert_eq!(e.len, Some(60));
    }

    #[test]
    fn parses_default_log_drop() {
        let e = parse_message(
            "[ipv4-INP-filter-default-D]IN=eth0 OUT= SRC=192.0.2.9 DST=192.0.2.1 LEN=40 \
             PROTO=TCP SPT=55555 DPT=23",
            1,
        )
        .expect("should parse");
        assert_eq!(e.chain, "input");
        assert_eq!(e.rule, None);
        assert_eq!(e.action, "drop");
        assert_eq!(e.out_if, None);
    }

    #[test]
    fn ignores_unrelated_kernel_lines() {
        assert!(parse_message("usb 1-1: new high-speed USB device", 1).is_none());
        assert!(parse_message("[UFW BLOCK] IN=eth0 SRC=1.2.3.4", 1).is_none());
    }
}
