//! Classification engine wrapper.
//!
//! One [`Engine`] per queue worker (nDPI detection modules must not be
//! shared across threads without locking; per-thread modules are the
//! upstream-recommended pattern). Flows hold an opaque per-flow DPI state.
//!
//! Built with `--features ndpi` this wraps libndpi via qfappd-sys; without
//! it a stub engine classifies nothing (every flow ends Unknown at budget
//! exhaustion). The stub exists so the full daemon logic builds and runs in
//! environments without libndpi — clearly marked: needs on-target validation.

use qfappd_core::catalog::Catalog;

/// Outcome of feeding one packet (or giving up).
#[derive(Debug, Clone, Default)]
pub struct ClassifyResult {
    pub app_id: u16,
    /// Classification concluded — stop queueing packets and verdict the flow.
    pub is_final: bool,
    /// Lowercased ndpi_confidence_t name ("dpi", "match_by_port", …).
    pub confidence: String,
    pub sni: Option<String>,
    pub ja4: Option<String>,
}

pub enum Engine {
    #[cfg(feature = "ndpi")]
    Ndpi(ndpi::NdpiEngine),
    // Constructed only by tests / the no-ndpi dev build.
    #[cfg_attr(feature = "ndpi", allow(dead_code))]
    Stub(stub::StubEngine),
}

pub enum Flow {
    #[cfg(feature = "ndpi")]
    Ndpi(ndpi::NdpiFlow),
    #[cfg_attr(feature = "ndpi", allow(dead_code))]
    Stub,
}

impl Engine {
    pub fn new_flow(&mut self) -> anyhow::Result<Flow> {
        match self {
            #[cfg(feature = "ndpi")]
            Engine::Ndpi(e) => Ok(Flow::Ndpi(e.new_flow()?)),
            Engine::Stub(_) => Ok(Flow::Stub),
        }
    }

    /// Feed one IP packet (starting at the IP header, as delivered by
    /// NFQUEUE) into the flow's DPI state.
    pub fn process(&mut self, flow: &mut Flow, ip_packet: &[u8], time_ms: u64) -> ClassifyResult {
        match (self, flow) {
            #[cfg(feature = "ndpi")]
            (Engine::Ndpi(e), Flow::Ndpi(f)) => e.process(f, ip_packet, time_ms),
            (Engine::Stub(e), Flow::Stub) => e.process(),
            #[cfg(feature = "ndpi")]
            _ => unreachable!("engine/flow variant mismatch"),
        }
    }

    /// Budget exhausted: extract nDPI's best guess (port/IP based) so the
    /// verdict and event still carry something useful.
    pub fn giveup(&mut self, flow: &mut Flow) -> ClassifyResult {
        match (self, flow) {
            #[cfg(feature = "ndpi")]
            (Engine::Ndpi(e), Flow::Ndpi(f)) => e.giveup(f),
            (Engine::Stub(e), Flow::Stub) => e.giveup(),
            #[cfg(feature = "ndpi")]
            _ => unreachable!("engine/flow variant mismatch"),
        }
    }

    pub fn catalog(&self) -> Catalog {
        match self {
            #[cfg(feature = "ndpi")]
            Engine::Ndpi(e) => e.catalog(),
            Engine::Stub(e) => e.catalog(),
        }
    }
}

/// Factory used by main/daemon/workers.
pub fn new_classifier() -> anyhow::Result<Engine> {
    #[cfg(feature = "ndpi")]
    {
        Ok(Engine::Ndpi(ndpi::NdpiEngine::new()?))
    }
    #[cfg(not(feature = "ndpi"))]
    {
        tracing::warn!(
            "built without the `ndpi` feature — STUB classifier active, every flow \
             will classify as Unknown; this build is for development only"
        );
        Ok(Engine::Stub(stub::StubEngine))
    }
}

/// Explicit stub engine — used by unit tests and the no-ndpi dev build.
#[cfg(any(test, not(feature = "ndpi")))]
pub fn stub_classifier() -> Engine {
    Engine::Stub(stub::StubEngine)
}

#[cfg_attr(feature = "ndpi", allow(dead_code))]
pub mod stub {
    use super::*;

    pub struct StubEngine;

    impl StubEngine {
        pub fn process(&self) -> ClassifyResult {
            ClassifyResult { is_final: false, confidence: "unknown".into(), ..Default::default() }
        }

        pub fn giveup(&self) -> ClassifyResult {
            ClassifyResult { is_final: true, confidence: "unknown".into(), ..Default::default() }
        }

        pub fn catalog(&self) -> Catalog {
            let mut c = Catalog::fixture();
            c.ndpi_version = "stub (built without ndpi feature)".into();
            c
        }
    }
}

#[cfg(feature = "ndpi")]
pub mod ndpi {
    use super::ClassifyResult;
    use qfappd_core::catalog::{AppEntry, Catalog};
    use qfappd_sys::ndpi as sys;
    use std::ffi::CStr;

    /// One nDPI detection module. NOT Sync — each worker thread owns its own.
    pub struct NdpiEngine {
        module: *mut sys::ndpi_detection_module_struct,
        flow_size: usize,
    }

    // The raw module pointer is only ever used from the owning worker thread;
    // Send lets the worker thread take ownership at spawn.
    unsafe impl Send for NdpiEngine {}

    /// Per-flow nDPI state (calloc'd ndpi_flow_struct).
    pub struct NdpiFlow {
        flow: *mut sys::ndpi_flow_struct,
    }

    unsafe impl Send for NdpiFlow {}

    impl NdpiEngine {
        pub fn new() -> anyhow::Result<Self> {
            unsafe {
                // ndpi_no_prefs = 0 (nDPI 4.8 signature; the argument type
                // changed in later majors — qfappd pins >= 4.8 semantics and
                // a mismatch surfaces here as a compile error on-target).
                let module = sys::ndpi_init_detection_module(0);
                if module.is_null() {
                    anyhow::bail!("ndpi_init_detection_module returned NULL");
                }
                // nDPI 4.x enables all protocols by default; the legacy
                // set_protocol_detection_bitmask2 selection API is gone. Just
                // finalize (required before processing packets).
                sys::ndpi_finalize_initialization(module);
                let flow_size = sys::ndpi_detection_get_sizeof_ndpi_flow_struct() as usize;
                Ok(Self { module, flow_size })
            }
        }

        pub fn new_flow(&mut self) -> anyhow::Result<NdpiFlow> {
            let flow = unsafe { libc::calloc(1, self.flow_size) } as *mut sys::ndpi_flow_struct;
            if flow.is_null() {
                anyhow::bail!("calloc ndpi_flow_struct failed");
            }
            Ok(NdpiFlow { flow })
        }

        pub fn process(&mut self, flow: &mut NdpiFlow, ip_packet: &[u8], time_ms: u64) -> ClassifyResult {
            let proto = unsafe {
                sys::ndpi_detection_process_packet(
                    self.module,
                    flow.flow,
                    ip_packet.as_ptr(),
                    ip_packet.len() as u16,
                    time_ms,
                    std::ptr::null(),
                )
            };
            let app_id = pick_app(&proto);
            // Final once nDPI has an app protocol and no further dissection
            // would refine it (ndpiReader's stop condition).
            let is_final = app_id != 0
                && unsafe { sys::ndpi_extra_dissection_possible(self.module, flow.flow) } == 0;
            self.result(flow, app_id, is_final)
        }

        pub fn giveup(&mut self, flow: &mut NdpiFlow) -> ClassifyResult {
            let mut guessed: u8 = 0;
            let proto = unsafe { sys::ndpi_detection_giveup(self.module, flow.flow, 1, &mut guessed) };
            let mut r = self.result(flow, pick_app(&proto), true);
            r.is_final = true;
            r
        }

        fn result(&self, flow: &mut NdpiFlow, app_id: u16, is_final: bool) -> ClassifyResult {
            let confidence = unsafe {
                let conf = (*flow.flow).confidence;
                cstr_lossy(sys::ndpi_confidence_get_name(conf)).to_ascii_lowercase()
            };
            let sni = unsafe {
                let host = (*flow.flow).host_server_name.as_ptr();
                let s = cstr_lossy(host as *const std::os::raw::c_char);
                if s.is_empty() { None } else { Some(s) }
            };
            ClassifyResult {
                app_id,
                is_final,
                confidence,
                sni,
                // JA4 landed in libndpi 4.9 and the flow-struct field name
                // differs across 4.x; populated once the appliance pins its
                // libndpi build. Documented in docs/event-schema.md.
                ja4: None,
            }
        }

        pub fn catalog(&self) -> Catalog {
            unsafe {
                // Protocol count fits u16 (nDPI defines a few hundred); the
                // library returns it as u_int.
                let n = sys::ndpi_get_num_supported_protocols(self.module) as u16;
                let mut applications = Vec::with_capacity(n as usize);
                for id in 0..n {
                    let name = cstr_lossy(sys::ndpi_get_proto_name(self.module, id));
                    // ndpi_protocol carries raw pointers, so it isn't Default;
                    // zero-init and set only the app protocol for the lookup.
                    let mut proto: sys::ndpi_protocol = std::mem::zeroed();
                    proto.app_protocol = id;
                    let category_id = sys::ndpi_get_proto_category(self.module, proto);
                    let category =
                        cstr_lossy(sys::ndpi_category_get_name(self.module, category_id));
                    applications.push(AppEntry {
                        id,
                        name,
                        category_id: category_id as u8,
                        category,
                    });
                }
                Catalog {
                    ndpi_version: cstr_lossy(sys::ndpi_revision()),
                    num_protocols: n,
                    applications,
                }
            }
        }
    }

    impl Drop for NdpiEngine {
        fn drop(&mut self) {
            unsafe { sys::ndpi_exit_detection_module(self.module) };
        }
    }

    impl Drop for NdpiFlow {
        fn drop(&mut self) {
            unsafe { sys::ndpi_free_flow(self.flow) };
        }
    }

    fn pick_app(p: &sys::ndpi_protocol) -> u16 {
        if p.app_protocol != 0 {
            p.app_protocol
        } else {
            p.master_protocol
        }
    }

    fn cstr_lossy(p: *const std::os::raw::c_char) -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}
