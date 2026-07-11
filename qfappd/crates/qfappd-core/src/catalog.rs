//! The application catalog: the set of applications (nDPI protocols) and
//! categories the installed libndpi knows about.
//!
//! At runtime the daemon builds this from libndpi (so it tracks the installed
//! signature version); tests and the WebUI fixture use hand-built instances.
//! `qfappd catalog --json` emits exactly this structure.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Catalog {
    /// libndpi revision string (e.g. "4.8.0").
    pub ndpi_version: String,
    /// Number of protocols compiled into the library; doubles as the
    /// "signature version" surfaced in the UI.
    pub num_protocols: u16,
    pub applications: Vec<AppEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppEntry {
    /// nDPI protocol id — what ends up in the ct mark APP_ID field.
    pub id: u16,
    /// nDPI short name, e.g. "TLS", "BitTorrent", "ChatGPT".
    pub name: String,
    pub category_id: u8,
    /// nDPI category display name, e.g. "Web", "Download", "AI".
    pub category: String,
}

impl Catalog {
    /// Case-insensitive name → id index (nDPI names are case-stable but
    /// policy files are written by humans and the WebUI).
    pub fn app_index(&self) -> HashMap<String, u16> {
        self.applications
            .iter()
            .map(|a| (a.name.to_ascii_lowercase(), a.id))
            .collect()
    }

    /// Case-insensitive category name → member app ids.
    pub fn category_index(&self) -> HashMap<String, Vec<u16>> {
        let mut idx: HashMap<String, Vec<u16>> = HashMap::new();
        for a in &self.applications {
            idx.entry(a.category.to_ascii_lowercase()).or_default().push(a.id);
        }
        idx
    }

    pub fn app_name(&self, id: u16) -> Option<&str> {
        self.applications.iter().find(|a| a.id == id).map(|a| a.name.as_str())
    }

    pub fn category_of(&self, id: u16) -> Option<&str> {
        self.applications.iter().find(|a| a.id == id).map(|a| a.category.as_str())
    }

    /// A tiny fixed catalog for unit tests and offline development.
    pub fn fixture() -> Self {
        let apps = [
            (0, "Unknown", 0, "Unspecified"),
            (5, "DNS", 14, "Network"),
            (7, "HTTP", 5, "Web"),
            (37, "BitTorrent", 7, "Download"),
            (48, "QUIC", 5, "Web"),
            (91, "TLS", 5, "Web"),
            (119, "Facebook", 6, "SocialNetwork"),
            (124, "YouTube", 1, "Media"),
            (211, "PornHub", 21, "Adult"),
            (244, "ChatGPT", 33, "AI"),
            (245, "Claude", 33, "AI"),
        ];
        Catalog {
            ndpi_version: "fixture".into(),
            num_protocols: apps.len() as u16,
            applications: apps
                .into_iter()
                .map(|(id, name, category_id, category)| AppEntry {
                    id,
                    name: name.into(),
                    category_id,
                    category: category.into(),
                })
                .collect(),
        }
    }
}
