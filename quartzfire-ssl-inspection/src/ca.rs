//! Inspection CA lifecycle: generate, regenerate, inspect.
//!
//! The CA lives under /config/quartzfire/ssl-inspection/ so it persists across
//! VyOS image upgrades and signed-ISO updates (NOT anywhere ephemeral). The
//! PRIVATE KEY is root:root 0600 and NEVER leaves the box — it is never read
//! into a CaInfo, never returned over any interface, never logged. Only the
//! certificate's public metadata (subject/fingerprint/validity/serial) is
//! surfaced.
//!
//! openssl(1) does the crypto; the parsing of its `-noout` text is pure and
//! unit-tested (the geoip split: pure logic tested anywhere, subprocess/FFI on
//! target).

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

pub const CA_DIR: &str = "/config/quartzfire/ssl-inspection";
pub const CA_KEY: &str = "/config/quartzfire/ssl-inspection/ca.key";
pub const CA_CRT: &str = "/config/quartzfire/ssl-inspection/ca.crt";
pub const CA_DER: &str = "/config/quartzfire/ssl-inspection/ca.der";

/// Exact required subject. Acceptance criterion: enabling inspection generates
/// the CA with precisely this CN and O.
pub const SUBJECT: &str = "/CN=QuartzFire SSL Inspection/O=Quartz Systems";

/// Public certificate metadata for the WebUI / CA-distribution page. No key
/// material, ever.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CaInfo {
    pub present: bool,
    /// Whether the private key file exists (so the UI can flag a broken CA);
    /// the key CONTENTS are never included.
    pub key_present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// Colon-separated uppercase hex, e.g. "AB:CD:…".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_after: Option<String>,
}

/// Parse the text of
/// `openssl x509 -noout -subject -issuer -serial -fingerprint -sha256 -startdate -enddate`
/// into public metadata. Tolerant of field order and of openssl's `=`-vs-` = `
/// spacing across versions.
pub fn parse_x509_fields(text: &str) -> CaInfo {
    let mut info = CaInfo { present: true, ..Default::default() };
    for line in text.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("subject=") {
            info.subject = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("issuer=") {
            info.issuer = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("serial=") {
            info.serial = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("notBefore=") {
            info.not_before = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("notAfter=") {
            info.not_after = Some(v.trim().to_string());
        } else if let Some(v) = line
            .strip_prefix("SHA256 Fingerprint=")
            .or_else(|| line.strip_prefix("sha256 Fingerprint="))
        {
            info.fingerprint_sha256 = Some(v.trim().to_string());
        }
    }
    info
}

/// Inspect the installed certificate. None when no cert is present yet.
pub fn inspect() -> Option<CaInfo> {
    if !Path::new(CA_CRT).exists() {
        return None;
    }
    let out = Command::new("openssl")
        .args([
            "x509", "-in", CA_CRT, "-noout", "-subject", "-issuer", "-serial", "-fingerprint",
            "-sha256", "-startdate", "-enddate",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return Some(CaInfo { present: true, key_present: Path::new(CA_KEY).exists(), ..Default::default() });
    }
    let mut info = parse_x509_fields(&String::from_utf8_lossy(&out.stdout));
    info.key_present = Path::new(CA_KEY).exists();
    Some(info)
}

/// SHA-256 fingerprint alone (for the CA-distribution page banner). None if no
/// cert or openssl unavailable.
pub fn fingerprint() -> Option<String> {
    inspect().and_then(|i| i.fingerprint_sha256)
}

/// Generate the self-signed root CA. With `force=false`, a returning caller
/// with an existing key+cert is a no-op (returns the current metadata) — so
/// "first enable" is idempotent. `force=true` (explicit Regenerate) always
/// mints a new CA; all previously distributed copies become invalid.
///
/// Uses the exact subject and extensions the spec mandates: RSA-4096, sha256,
/// 3650 days, basicConstraints critical CA:TRUE pathlen:0, keyUsage critical
/// keyCertSign,cRLSign.
pub fn generate(force: bool) -> Result<CaInfo, String> {
    let have = Path::new(CA_CRT).exists() && Path::new(CA_KEY).exists();
    if have && !force {
        return inspect().ok_or_else(|| "existing CA present but not inspectable".to_string());
    }

    std::fs::create_dir_all(CA_DIR).map_err(|e| format!("creating {CA_DIR}: {e}"))?;

    // Generate into temp paths, then atomically rename — a reader/Squid reload
    // never sees a half-written key or a cert without its key.
    let tmp_key = format!("{CA_KEY}.qz-tmp");
    let tmp_crt = format!("{CA_CRT}.qz-tmp");
    let status = Command::new("openssl")
        .args([
            "req", "-x509", "-newkey", "rsa:4096", "-sha256", "-days", "3650", "-nodes",
            "-keyout", &tmp_key, "-out", &tmp_crt, "-subj", SUBJECT,
            "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        ])
        .status()
        .map_err(|e| format!("running openssl req: {e} — is openssl installed?"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp_key);
        let _ = std::fs::remove_file(&tmp_crt);
        return Err("openssl failed to generate the CA".to_string());
    }

    // Lock the key down BEFORE it lands at its final name.
    harden_key(&tmp_key)?;

    std::fs::rename(&tmp_key, CA_KEY).map_err(|e| format!("installing {CA_KEY}: {e}"))?;
    std::fs::rename(&tmp_crt, CA_CRT).map_err(|e| format!("installing {CA_CRT}: {e}"))?;

    // DER for Windows/Android import.
    let der = Command::new("openssl")
        .args(["x509", "-in", CA_CRT, "-outform", "DER", "-out", CA_DER])
        .status()
        .map_err(|e| format!("running openssl x509 (DER): {e}"))?;
    if !der.success() {
        return Err("openssl failed to export the DER certificate".to_string());
    }

    inspect().ok_or_else(|| "CA generated but not inspectable".to_string())
}

/// root:root 0600 on the private key. Ownership via chown(1) is best-effort
/// (we already run as root from the conf-mode owner / helpers); the 0600 mode
/// is enforced hard on unix.
fn harden_key(path: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod 600 {path}: {e}"))?;
        let _ = Command::new("chown").args(["root:root", path]).status();
    }
    let _ = path; // silence unused on non-unix
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_openssl_output() {
        let text = "subject=CN = QuartzFire SSL Inspection, O = Quartz Systems\n\
                    issuer=CN = QuartzFire SSL Inspection, O = Quartz Systems\n\
                    serial=5A3B9C2D1E0F\n\
                    SHA256 Fingerprint=AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC\n\
                    notBefore=Jul 12 00:00:00 2026 GMT\n\
                    notAfter=Jul 10 00:00:00 2036 GMT\n";
        let info = parse_x509_fields(text);
        assert!(info.present);
        assert_eq!(info.subject.as_deref(), Some("CN = QuartzFire SSL Inspection, O = Quartz Systems"));
        assert_eq!(info.serial.as_deref(), Some("5A3B9C2D1E0F"));
        assert_eq!(
            info.fingerprint_sha256.as_deref(),
            Some("AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC")
        );
        assert_eq!(info.not_before.as_deref(), Some("Jul 12 00:00:00 2026 GMT"));
        assert_eq!(info.not_after.as_deref(), Some("Jul 10 00:00:00 2036 GMT"));
    }

    #[test]
    fn subject_string_is_exact() {
        // Guards the acceptance criterion at the source.
        assert_eq!(SUBJECT, "/CN=QuartzFire SSL Inspection/O=Quartz Systems");
    }

    #[test]
    fn ca_info_never_serializes_a_key_field() {
        // Structural guarantee: there is no key field to leak.
        let json = serde_json::to_string(&CaInfo {
            present: true,
            key_present: true,
            subject: Some("x".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(!json.to_lowercase().contains("private"));
        assert!(!json.contains("BEGIN"));
        assert!(json.contains("\"key_present\":true"));
    }

    #[test]
    fn missing_fields_tolerated() {
        let info = parse_x509_fields("subject=CN = X\n");
        assert_eq!(info.subject.as_deref(), Some("CN = X"));
        assert!(info.serial.is_none());
        assert!(info.fingerprint_sha256.is_none());
    }
}
