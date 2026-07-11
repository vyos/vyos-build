//! Event sinks: one flat JSON line per classified-flow decision.
//!
//! Three independently-enabled destinations (all fed the identical line):
//!  1. UNIX datagram socket — fire-and-forget for the ELK/Splunk shipper;
//!     send failures (no reader, buffer full) are counted, never block.
//!  2. Line-delimited file — durable history, rotated by logrotate.
//!  3. stdout — captured by the systemd journal under `SyslogIdentifier=qfappd`;
//!     this is what the WebUI Alerts tab streams (`journalctl -t qfappd`).
//!     Using stdout avoids a libsystemd dependency; tracing diagnostics go to
//!     stderr so the two never interleave.
//!
//! The JSON line format itself lives in `qfappd_core::event` (schema contract
//! + golden test); this module only routes it.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use qfappd_core::config::Events;
use qfappd_core::event::Event;

use crate::worker::EventSink;

pub struct EventWriter {
    file: Option<Mutex<File>>,
    stdout: bool,
    #[cfg(unix)]
    socket: Option<UnixDatagramSink>,
    drops: Arc<AtomicU64>,
}

impl EventWriter {
    pub fn new(cfg: &Events) -> std::io::Result<Self> {
        let file = if cfg.file {
            if let Some(parent) = cfg.file_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            Some(Mutex::new(
                OpenOptions::new().create(true).append(true).open(&cfg.file_path)?,
            ))
        } else {
            None
        };

        #[cfg(unix)]
        let socket = if cfg.socket {
            Some(UnixDatagramSink::new(&cfg.socket_path)?)
        } else {
            None
        };

        Ok(Self {
            file,
            stdout: cfg.journald,
            #[cfg(unix)]
            socket,
            drops: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Cumulative count of events that could not be delivered to the datagram
    /// socket (surfaced in GetStatus).
    pub fn drops(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.drops)
    }
}

impl EventSink for EventWriter {
    fn emit(&self, event: Event) {
        let line = event.to_json_line();

        if self.stdout {
            // Best-effort; a broken stdout pipe must not crash a worker.
            let _ = std::io::stdout().write_all(line.as_bytes());
        }
        if let Some(file) = &self.file {
            if let Ok(mut f) = file.lock() {
                let _ = f.write_all(line.as_bytes());
            }
        }
        #[cfg(unix)]
        if let Some(sock) = &self.socket {
            if sock.send(line.as_bytes()).is_err() {
                self.drops.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(unix)]
struct UnixDatagramSink {
    sock: std::os::unix::net::UnixDatagram,
    path: std::path::PathBuf,
}

#[cfg(unix)]
impl UnixDatagramSink {
    fn new(path: &Path) -> std::io::Result<Self> {
        use std::os::unix::net::UnixDatagram;
        let sock = UnixDatagram::unbound()?;
        sock.set_nonblocking(true)?;
        Ok(Self { sock, path: path.to_owned() })
    }

    fn send(&self, buf: &[u8]) -> std::io::Result<()> {
        // Connectionless: the consumer (log shipper) binds the path. If it
        // isn't up yet, send_to fails and the event is counted as dropped.
        self.sock.send_to(buf, &self.path).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qfappd_core::event::Event;

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

    #[test]
    fn file_sink_appends_json_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.json");
        let cfg = Events {
            socket: false,
            socket_path: Default::default(),
            file: true,
            file_path: path.clone(),
            journald: false,
        };
        let w = EventWriter::new(&cfg).unwrap();
        w.emit(sample());
        w.emit(sample());
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 2);
        assert!(contents.lines().next().unwrap().contains("\"app\":\"ChatGPT\""));
    }
}
