//! Squid build-capability probe.
//!
//! Stock Debian/VyOS `squid` is built WITHOUT OpenSSL bump support; the
//! `squid-openssl` package (which QuartzFire ships) has it. We check the live
//! binary rather than assume. The parse is pure and tested; the subprocess
//! call is thin. Both `verify()` (commit-time, hard fail) and apply
//! (status.json booleans) use this.

use std::process::Command;

#[derive(Debug, Clone, Copy, Default)]
pub struct Caps {
    /// OpenSSL ssl_bump support (`--with-openssl` and/or `--enable-ssl-crtd`).
    pub bump: bool,
    /// ICAP client support (`--enable-icap-client`).
    pub icap: bool,
}

/// Parse the configure-options line from `squid -v`.
pub fn parse_squid_caps(version_text: &str) -> Caps {
    let t = version_text;
    let bump = t.contains("--with-openssl")
        || t.contains("--enable-ssl-crtd")
        || t.contains("--enable-ssl");
    let icap = t.contains("--enable-icap-client");
    Caps { bump, icap }
}

/// Probe the installed Squid. None when the binary can't be run at all (not
/// installed / off-device) — callers treat that as "unknown", distinct from a
/// definite "built without support".
pub fn probe() -> Option<Caps> {
    let out = Command::new("squid").arg("-v").output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(parse_squid_caps(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENSSL_BUILD: &str = "Squid Cache: Version 5.7\n\
        Service Name: squid\n\
        configure options:  '--build=x86_64-linux-gnu' '--with-openssl' \
        '--enable-icap-client' '--enable-ssl-crtd' '--with-default-user=proxy'\n";

    const STOCK_BUILD: &str = "Squid Cache: Version 5.7\n\
        configure options:  '--build=x86_64-linux-gnu' '--enable-follow-x-forwarded-for'\n";

    #[test]
    fn detects_openssl_and_icap() {
        let c = parse_squid_caps(OPENSSL_BUILD);
        assert!(c.bump);
        assert!(c.icap);
    }

    #[test]
    fn stock_build_lacks_both() {
        let c = parse_squid_caps(STOCK_BUILD);
        assert!(!c.bump);
        assert!(!c.icap);
    }

    #[test]
    fn crtd_alone_counts_as_bump() {
        let c = parse_squid_caps("configure options: '--enable-ssl-crtd'");
        assert!(c.bump);
        assert!(!c.icap);
    }
}
