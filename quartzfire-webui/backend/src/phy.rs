//! Physical NIC capabilities for the Interfaces UI.
//!
//! The VyOS config only stores what the user *asked* for (`speed`/`duplex`
//! leaves); which speeds a port can actually do — and what it negotiated
//! right now — is operational state. Current speed/duplex/carrier come from
//! sysfs; the supported-speed list comes from `ethtool` (its GET ioctls need
//! no privileges). The UI uses this to offer only speeds the port supports
//! and to show what each port is running at.

use axum::Json;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;
use tokio::process::Command;

use crate::error::Result;

#[derive(Serialize)]
pub struct PhyInfo {
    pub name: String,
    /// Carrier: true = link up. None when the interface is admin-down (the
    /// kernel refuses the read) or the attribute is unreadable.
    pub link: Option<bool>,
    /// Negotiated speed in Mb/s. None when the link is down or unknown.
    pub speed_mbps: Option<u32>,
    /// "full" | "half". None when the link is down or unknown.
    pub duplex: Option<String>,
    /// Speeds (Mb/s) the port advertises support for, ascending. Empty when
    /// ethtool is unavailable or reports none — the UI then falls back to
    /// offering every speed.
    pub supported_speeds: Vec<u32>,
}

fn read_trim(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// Physical NICs, judged by the presence of a `device` link in sysfs —
/// bridges, bonds, VLANs, and `lo` have none.
fn physical_nics() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/sys/class/net") else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("device").exists())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// Speeds named in ethtool's "Supported link modes" block ("1000baseT/Full"
/// → 1000). The block spans multiple indented continuation lines and ends at
/// the next "key:" line ("Supported pause frame use: …").
fn parse_supported_speeds(ethtool_output: &str) -> Vec<u32> {
    fn collect(s: &str, into: &mut BTreeSet<u32>) {
        for tok in s.split_whitespace() {
            if let Some(pos) = tok.find("base") {
                if let Ok(n) = tok[..pos].parse::<u32>() {
                    into.insert(n);
                }
            }
        }
    }

    let mut speeds = BTreeSet::new();
    let mut in_block = false;
    for line in ethtool_output.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Supported link modes:") {
            in_block = true;
            collect(rest, &mut speeds);
        } else if in_block {
            // Continuation lines are bare mode lists; anything of the form
            // "Next key: …" ends the block.
            if t.contains(':') && !t.starts_with(|c: char| c.is_ascii_digit()) {
                in_block = false;
            } else {
                collect(t, &mut speeds);
            }
        }
    }
    speeds.into_iter().collect()
}

async fn phy_info(name: String) -> PhyInfo {
    let sys = Path::new("/sys/class/net").join(&name);

    let link = read_trim(&sys.join("carrier")).and_then(|c| match c.as_str() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    });
    // The kernel reports -1 (or errors) with no established link.
    let speed_mbps = read_trim(&sys.join("speed"))
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(|s| u32::try_from(s).ok())
        .filter(|s| *s > 0);
    let duplex = read_trim(&sys.join("duplex")).filter(|d| d == "full" || d == "half");

    let supported_speeds = match Command::new("ethtool").arg(&name).output().await {
        Ok(out) => parse_supported_speeds(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => Vec::new(),
    };

    PhyInfo { name, link, speed_mbps, duplex, supported_speeds }
}

/// GET /api/interfaces/phy — operational speed/duplex/carrier and supported
/// speeds of every physical NIC.
pub async fn ethernet_phy() -> Result<Json<Vec<PhyInfo>>> {
    let mut out = Vec::new();
    for name in physical_nics() {
        out.push(phy_info(name).await);
    }
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ethtool_supported_modes() {
        let out = "\
Settings for eth0:
\tSupported ports: [ TP ]
\tSupported link modes:   10baseT/Half 10baseT/Full
\t                        100baseT/Half 100baseT/Full
\t                        1000baseT/Full
\tSupported pause frame use: Symmetric
\tAdvertised link modes:  10000baseT/Full
\tSpeed: 1000Mb/s
\tDuplex: Full
";
        // Advertised modes (10000) must NOT leak into the supported list.
        assert_eq!(parse_supported_speeds(out), vec![10, 100, 1000]);
    }

    #[test]
    fn tolerates_not_reported_modes() {
        let out = "\
Settings for eth0:
\tSupported link modes:   Not reported
\tSupported pause frame use: No
";
        assert!(parse_supported_speeds(out).is_empty());
        assert!(parse_supported_speeds("").is_empty());
    }

    #[test]
    fn multi_gig_modes_parse() {
        let out = "\
\tSupported link modes:   1000baseT/Full
\t                        2500baseT/Full 5000baseT/Full
\t                        10000baseT/Full
\tSupported FEC modes: Not reported
";
        assert_eq!(parse_supported_speeds(out), vec![1000, 2500, 5000, 10000]);
    }
}
