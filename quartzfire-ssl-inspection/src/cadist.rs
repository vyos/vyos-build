//! The CA-distribution web page — a dependency-light plain-HTTP listener on
//! :4126 dedicated to handing out the inspection root CA.
//!
//! HTTP (not HTTPS) is intentional and matches how WatchGuard and Windows
//! distribute inspection CAs: a client that does not yet trust our CA cannot
//! validate our TLS, so bootstrapping the trust over TLS is circular. The
//! private key is NEVER served — only ca.crt (PEM), ca.der (DER), and the
//! SHA-256 fingerprint for out-of-band verification.
//!
//! Reachability is restricted to the configured trusted interfaces by the
//! qz_ssl nftables input guard (see render::nft_ruleset) — this process binds
//! all interfaces but the firewall drops :4126 everywhere except LAN/trusted,
//! so it is never exposed on WAN.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::thread;

use crate::ca;

const BIND: &str = "0.0.0.0:4126";

pub fn serve() -> i32 {
    let listener = match TcpListener::bind(BIND) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("quartzfire-ssl cadist: cannot bind {BIND}: {e}");
            return 1;
        }
    };
    eprintln!("quartzfire-ssl cadist: serving the CA on http://{BIND}/");
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                thread::spawn(move || {
                    let _ = handle(s);
                });
            }
            Err(e) => eprintln!("quartzfire-ssl cadist: accept failed: {e}"),
        }
    }
    0
}

fn read_request_target(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    // "GET /ca.crt HTTP/1.1"
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?.to_string();
    if method != "GET" && method != "HEAD" {
        return Some("\u{0}405".to_string()); // sentinel handled by caller
    }
    Some(target)
}

fn handle(mut stream: TcpStream) -> std::io::Result<()> {
    let target = match read_request_target(&stream) {
        Some(t) => t,
        None => return Ok(()),
    };
    if target == "\u{0}405" {
        return respond(&mut stream, 405, "text/plain", b"method not allowed");
    }

    // Strip any query string.
    let path = target.split('?').next().unwrap_or("/");
    match path {
        "/" | "/index.html" => {
            let body = landing_page();
            respond(&mut stream, 200, "text/html; charset=utf-8", body.as_bytes())
        }
        "/ca.crt" => serve_file(&mut stream, ca::CA_CRT, "application/x-pem-file", "ca.crt"),
        "/ca.der" => serve_file(&mut stream, ca::CA_DER, "application/x-x509-ca-cert", "ca.der"),
        "/fingerprint" | "/fingerprint.txt" => {
            let fp = ca::fingerprint().unwrap_or_else(|| "unavailable".to_string());
            respond(&mut stream, 200, "text/plain; charset=utf-8", fp.as_bytes())
        }
        _ => respond(&mut stream, 404, "text/plain", b"not found"),
    }
}

fn serve_file(stream: &mut TcpStream, path: &str, ctype: &str, filename: &str) -> std::io::Result<()> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {len}\r\n\
                 Content-Disposition: attachment; filename=\"{filename}\"\r\n\
                 Cache-Control: no-store\r\nConnection: close\r\n\r\n",
                len = bytes.len(),
            );
            stream.write_all(header.as_bytes())?;
            stream.write_all(&bytes)?;
            Ok(())
        }
        Err(_) => respond(
            stream,
            503,
            "text/plain",
            b"the inspection CA has not been generated yet",
        ),
    }
}

fn respond(stream: &mut TcpStream, code: u16, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        len = body.len(),
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    // Drain a little of the request body so the client sees a clean close.
    let mut sink = [0u8; 256];
    let _ = stream.read(&mut sink);
    Ok(())
}

/// The landing page: download links, the fingerprint for out-of-band checking,
/// and short per-OS install instructions.
fn landing_page() -> String {
    let fp = ca::fingerprint().unwrap_or_else(|| "the CA has not been generated yet".to_string());
    let have_ca = Path::new(ca::CA_CRT).exists();
    let dl = if have_ca {
        r#"<div class="dl">
            <a href="/ca.crt" download>Download ca.crt<span>PEM — macOS, Linux, iOS</span></a>
            <a href="/ca.der" download>Download ca.der<span>DER — Windows, Android</span></a>
        </div>"#
    } else {
        r#"<p class="warn">The inspection CA has not been generated yet. Enable SSL Inspection in the WebUI first.</p>"#
    };
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>QuartzFire — Install the SSL Inspection CA</title>
<style>
  /* Palette mirrors the QuartzFire WebUI design tokens (app/globals.css). */
  :root {{
    --bg:#0f1117; --surface:#161920; --sunken:#1a1d26; --border:#252830;
    --fg1:#f2f3f5; --fg3:#a2a6b0; --fg4:#6b6f7a;
    --accent:#00d992; --accent-hover:#1aff9c; --on-accent:#062014; --warn:#e0b341;
  }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 46rem;
          margin: 0 auto; padding: 2.5rem 1.25rem 3rem; line-height: 1.55; color: var(--fg1);
          background: var(--bg); -webkit-font-smoothing: antialiased; }}
  h1 {{ font-size: 1.5rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 .35rem; }}
  h1 .brand {{ color: var(--accent); }}
  h2 {{ font-size: 1rem; font-weight: 600; color: var(--fg1); margin: 0 0 .55rem; }}
  p {{ color: var(--fg3); }}
  .lead {{ color: var(--fg3); margin-top: 0; }}
  .label {{ color: var(--fg4); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 .4rem; }}
  code, .fp {{ font-family: ui-monospace, "SF Mono", Menlo, monospace; }}
  .fp {{ display: block; word-break: break-all; background: var(--sunken); color: var(--fg1);
         padding: .7rem .85rem; border-radius: .5rem; border: 1px solid var(--border); font-size: .85rem; }}
  .card {{ background: var(--surface); border: 1px solid var(--border); border-radius: .6rem;
           padding: 1.1rem 1.25rem; margin-top: 1.25rem; }}
  .dl {{ display: flex; flex-wrap: wrap; gap: .7rem; margin-top: 1rem; }}
  .dl a {{ display: flex; flex-direction: column; gap: .15rem; padding: .6rem 1.05rem;
           background: var(--accent); color: var(--on-accent); border-radius: .5rem;
           text-decoration: none; font-weight: 600; font-size: .92rem; transition: background .12s ease; }}
  .dl a span {{ font-weight: 500; font-size: .72rem; opacity: .8; }}
  .dl a:hover {{ background: var(--accent-hover); }}
  .warn {{ background: rgba(224,179,65,.12); border: 1px solid rgba(224,179,65,.35);
           color: var(--warn); padding: .65rem .85rem; border-radius: .5rem; }}
  ol {{ padding-left: 1.2rem; color: var(--fg3); margin: 0; }}
  li {{ margin: .2rem 0; }}
  li em {{ color: var(--fg1); font-style: normal; font-weight: 500; }}
  code {{ background: var(--sunken); padding: .1rem .35rem; border-radius: .3rem; color: var(--fg1);
          font-size: .85em; border: 1px solid var(--border); }}
  a {{ color: var(--accent); }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1rem; margin-top: 1.25rem; }}
  .grid .card {{ margin-top: 0; }}
</style></head><body>
<h1><span class="brand">QuartzFire</span> SSL Inspection — Root CA</h1>
<p class="lead">To browse HTTPS without warnings through this firewall, install and trust the
QuartzFire inspection root certificate below. Verify the fingerprint out-of-band
before trusting it.</p>

<div class="card">
  <p class="label">SHA-256 fingerprint</p>
  <span class="fp">{fp}</span>
  {dl}
</div>

<div class="grid">
  <section class="card"><h2>Windows</h2><ol>
    <li>Download <code>ca.der</code>.</li>
    <li>Double-click → <em>Install Certificate</em> → <em>Local Machine</em>.</li>
    <li>Place in <em>Trusted Root Certification Authorities</em>.</li>
  </ol></section>
  <section class="card"><h2>macOS</h2><ol>
    <li>Download <code>ca.crt</code> and open it in Keychain Access (System keychain).</li>
    <li>Set it to <em>Always Trust</em> for SSL.</li>
  </ol></section>
  <section class="card"><h2>iOS / iPadOS</h2><ol>
    <li>Download <code>ca.crt</code>; install the profile in Settings.</li>
    <li>Enable it under <em>Settings → General → About → Certificate Trust Settings</em>.</li>
  </ol></section>
  <section class="card"><h2>Android</h2><ol>
    <li>Download <code>ca.der</code>.</li>
    <li><em>Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate</em>.</li>
  </ol></section>
  <section class="card"><h2>Firefox</h2><ol>
    <li>Firefox uses its own store: <em>Settings → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import</em>.</li>
    <li>Import <code>ca.crt</code> and trust it for websites.</li>
  </ol></section>
  <section class="card"><h2>Linux (system trust)</h2><ol>
    <li><code>sudo cp ca.crt /usr/local/share/ca-certificates/quartzfire-ssl-inspection.crt</code></li>
    <li><code>sudo update-ca-certificates</code></li>
  </ol></section>
</div>
</body></html>
"#,
        fp = html_escape(&fp),
        dl = dl,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn landing_page_never_references_a_key() {
        let page = landing_page();
        assert!(page.contains("ca.crt"));
        assert!(page.contains("ca.der"));
        assert!(!page.to_lowercase().contains("ca.key"));
        assert!(!page.contains("PRIVATE"));
    }

    #[test]
    fn html_escape_neutralizes_markup() {
        assert_eq!(html_escape("<b>&"), "&lt;b&gt;&amp;");
    }
}
