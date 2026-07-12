//! IPFire libloc database access.
//!
//! The rest of the code (and the tests, via a fake) only depends on the
//! small `Database` trait. The real implementation talks to libloc through
//! the C shim (src/shim.c) and only exists with the `libloc` cargo feature —
//! without it, opening the database reports "unavailable", so pure-logic
//! builds and the test suite work on any machine (same split as qfappd's
//! `ndpi` feature).

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

pub const DEFAULT_DB: &str = "/var/lib/location/database.db";
/// Shipped by the location package; used for the belt-and-braces re-verify
/// after `location update` (which already verifies before swapping the file
/// in). Only referenced by the libloc-backed implementation.
#[cfg_attr(not(feature = "libloc"), allow(dead_code))]
pub const DEFAULT_KEY: &str = "/usr/share/location/signing-key.pem";

#[derive(Debug)]
pub struct DatabaseUnavailable(pub String);

impl fmt::Display for DatabaseUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for DatabaseUnavailable {}

#[derive(Debug, Clone, Serialize)]
pub struct Country {
    pub code: String,
    pub name: String,
    pub continent: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Lookup {
    pub country: Option<String>,
    pub network: Option<String>,
}

pub trait Database {
    /// Database creation time, epoch seconds (the "version").
    fn created_at(&self) -> i64;
    /// Signature check against the vendor key. None = no key file to check
    /// against (verification then rests on `location update`, which refuses
    /// unsigned/invalid downloads before installing them).
    fn verify(&self) -> Option<bool>;
    fn countries(&self) -> Vec<Country>;
    /// CIDR strings of one country's networks, one family (4|6) at a time.
    fn networks(&self, cc: &str, family: u8) -> Vec<String>;
    /// Every classified network of one family — raw material of the
    /// synthetic geo{4,6}_known sets. Large; callers collapse + cache.
    fn all_networks(&self, family: u8) -> Vec<String>;
    fn lookup(&self, ip: &str) -> Lookup;

    fn country_codes(&self) -> BTreeSet<String> {
        self.countries().into_iter().map(|c| c.code).collect()
    }
}

/// Open the production database, or explain why that is impossible.
pub fn open_default() -> Result<Box<dyn Database>, DatabaseUnavailable> {
    #[cfg(feature = "libloc")]
    {
        Ok(Box::new(libloc::LiblocDatabase::open(DEFAULT_DB, DEFAULT_KEY)?))
    }
    #[cfg(not(feature = "libloc"))]
    {
        Err(DatabaseUnavailable(
            "this build has no libloc support (cargo feature `libloc` disabled)".into(),
        ))
    }
}

#[cfg(feature = "libloc")]
mod libloc {
    use super::{Country, Database, DatabaseUnavailable, Lookup};
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::path::Path;

    // The full libloc surface is wrapped by src/shim.c, compiled against the
    // real headers at package build — see build.rs.
    extern "C" {
        fn qzgeo_db_open(path: *const c_char) -> *mut c_void;
        fn qzgeo_db_close(db: *mut c_void);
        fn qzgeo_db_created_at(db: *mut c_void) -> i64;
        fn qzgeo_db_verify(db: *mut c_void, keyfile: *const c_char) -> c_int;
        fn qzgeo_db_networks(
            db: *mut c_void,
            cc: *const c_char,
            family: c_int,
            cb: unsafe extern "C" fn(*const c_char, *mut c_void),
            user: *mut c_void,
        ) -> c_int;
        fn qzgeo_db_countries(
            db: *mut c_void,
            cb: unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, *mut c_void),
            user: *mut c_void,
        ) -> c_int;
        fn qzgeo_db_lookup(
            db: *mut c_void,
            ip: *const c_char,
            cc_buf: *mut c_char,
            cc_len: usize,
            net_buf: *mut c_char,
            net_len: usize,
        ) -> c_int;
    }

    unsafe extern "C" fn collect_network(cidr: *const c_char, user: *mut c_void) {
        let out = &mut *(user as *mut Vec<String>);
        if let Ok(s) = CStr::from_ptr(cidr).to_str() {
            out.push(s.to_string());
        }
    }

    unsafe extern "C" fn collect_country(
        code: *const c_char,
        name: *const c_char,
        continent: *const c_char,
        user: *mut c_void,
    ) {
        let out = &mut *(user as *mut Vec<Country>);
        let text = |p: *const c_char| CStr::from_ptr(p).to_string_lossy().into_owned();
        out.push(Country {
            code: text(code).to_ascii_uppercase(),
            name: text(name),
            continent: Some(text(continent).to_ascii_uppercase()).filter(|c| !c.is_empty()),
        });
    }

    pub struct LiblocDatabase {
        handle: *mut c_void,
        keyfile: CString,
    }

    // The handle is only used behind &self and libloc reads are re-entrant
    // per database object in our single-threaded binary.
    unsafe impl Send for LiblocDatabase {}

    impl LiblocDatabase {
        pub fn open(path: &str, keyfile: &str) -> Result<Self, DatabaseUnavailable> {
            if !Path::new(path).exists() {
                return Err(DatabaseUnavailable(format!("{path} does not exist")));
            }
            let c_path = CString::new(path)
                .map_err(|e| DatabaseUnavailable(format!("bad path: {e}")))?;
            let handle = unsafe { qzgeo_db_open(c_path.as_ptr()) };
            if handle.is_null() {
                return Err(DatabaseUnavailable(format!("cannot open {path}")));
            }
            Ok(Self {
                handle,
                keyfile: CString::new(keyfile).unwrap_or_default(),
            })
        }
    }

    impl Drop for LiblocDatabase {
        fn drop(&mut self) {
            unsafe { qzgeo_db_close(self.handle) };
        }
    }

    impl Database for LiblocDatabase {
        fn created_at(&self) -> i64 {
            unsafe { qzgeo_db_created_at(self.handle) }
        }

        fn verify(&self) -> Option<bool> {
            match unsafe { qzgeo_db_verify(self.handle, self.keyfile.as_ptr()) } {
                1 => Some(true),
                0 => Some(false),
                _ => None, // key file unreadable/absent
            }
        }

        fn countries(&self) -> Vec<Country> {
            let mut out: Vec<Country> = Vec::new();
            unsafe {
                qzgeo_db_countries(
                    self.handle,
                    collect_country,
                    &mut out as *mut Vec<Country> as *mut c_void,
                );
            }
            // libloc special entries (A1/A2/…) are not selectable countries.
            out.retain(|c| c.code.len() == 2 && c.code.chars().all(|ch| ch.is_ascii_alphabetic()));
            for c in &mut out {
                if c.name.is_empty() {
                    c.name = c.code.clone();
                }
            }
            out.sort_by(|a, b| a.name.cmp(&b.name));
            out
        }

        fn networks(&self, cc: &str, family: u8) -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            let Ok(c_cc) = CString::new(cc.to_ascii_uppercase()) else { return out };
            unsafe {
                qzgeo_db_networks(
                    self.handle,
                    c_cc.as_ptr(),
                    family as c_int,
                    collect_network,
                    &mut out as *mut Vec<String> as *mut c_void,
                );
            }
            out
        }

        fn all_networks(&self, family: u8) -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            unsafe {
                qzgeo_db_networks(
                    self.handle,
                    std::ptr::null(),
                    family as c_int,
                    collect_network,
                    &mut out as *mut Vec<String> as *mut c_void,
                );
            }
            out
        }

        fn lookup(&self, ip: &str) -> Lookup {
            let Ok(c_ip) = CString::new(ip) else { return Lookup::default() };
            let mut cc_buf = [0u8; 8];
            let mut net_buf = [0u8; 128];
            let found = unsafe {
                qzgeo_db_lookup(
                    self.handle,
                    c_ip.as_ptr(),
                    cc_buf.as_mut_ptr() as *mut c_char,
                    cc_buf.len(),
                    net_buf.as_mut_ptr() as *mut c_char,
                    net_buf.len(),
                )
            };
            if found != 1 {
                return Lookup::default();
            }
            let text = |buf: &[u8]| {
                let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                String::from_utf8_lossy(&buf[..end]).into_owned()
            };
            let cc = text(&cc_buf).to_ascii_uppercase();
            Lookup {
                country: Some(cc).filter(|c| !c.is_empty()),
                network: Some(text(&net_buf)).filter(|n| !n.is_empty()),
            }
        }
    }
}
