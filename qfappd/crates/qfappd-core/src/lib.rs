//! qfappd-core — platform-independent logic for the QuartzFire
//! Application Control daemon.
//!
//! Everything in this crate is pure computation over plain data so that the
//! policy engine, mark codec, flow table, and nftables renderer can be unit
//! tested on any development platform; the Linux-only I/O (NFQUEUE, ctnetlink,
//! nDPI FFI, gRPC) lives in the `qfappd` binary crate.

pub mod catalog;
pub mod config;
pub mod ctmark;
pub mod event;
pub mod flowtable;
pub mod nftgen;
pub mod policy;
pub mod stats;
