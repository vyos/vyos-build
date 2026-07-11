//! Raw FFI bindings, generated at build time by bindgen. See build.rs.
//!
//! `ndpi` module: libndpi (>= 4.8 from source at /usr/local).
//! `nfct` module: libnetfilter_conntrack (Debian package).
//!
//! Struct layouts and signatures come from the headers installed on the
//! build host, so a version mismatch is a compile error there — never a
//! silent ABI break at runtime.

#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]
// This crate is nothing but bindgen-generated FFI; clippy lints on generated
// code (e.g. useless_transmute in the nDPI headers' bitfield accessors) are
// noise we can't fix without editing generated output.
#![allow(clippy::all, clippy::pedantic, clippy::nursery)]

#[cfg(feature = "ndpi")]
pub mod ndpi {
    include!(concat!(env!("OUT_DIR"), "/ndpi_bindings.rs"));
}

#[cfg(feature = "nfct")]
pub mod nfct {
    include!(concat!(env!("OUT_DIR"), "/nfct_bindings.rs"));

    // Query verbs (enum nf_conntrack_query) and attribute ids used by the
    // mark writer are bindgen-generated; the CTA-free constants below are
    // stable protocol numbers, not header-derived.
    pub const IPPROTO_TCP: u8 = 6;
    pub const IPPROTO_UDP: u8 = 17;
}
