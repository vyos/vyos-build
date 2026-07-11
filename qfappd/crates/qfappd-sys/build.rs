//! Build-time bindgen against the system libndpi and libnetfilter_conntrack.
//!
//! Nothing is vendored: headers and libraries come from the build host
//! (libndpi >= 4.8 installed from source under /usr/local per the QuartzFire
//! image contract; libnetfilter_conntrack from Debian). Without the `ndpi` /
//! `nfct` features this script does nothing, so the crate is inert on
//! non-Linux dev machines.

fn main() {
    #[cfg(any(feature = "ndpi", feature = "nfct"))]
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());

    #[cfg(feature = "ndpi")]
    {
        let ndpi_include = std::env::var("NDPI_INCLUDE_DIR")
            .unwrap_or_else(|_| "/usr/local/include/ndpi".into());
        let ndpi_libdir =
            std::env::var("NDPI_LIB_DIR").unwrap_or_else(|_| "/usr/local/lib".into());
        println!("cargo:rerun-if-env-changed=NDPI_INCLUDE_DIR");
        println!("cargo:rerun-if-env-changed=NDPI_LIB_DIR");
        println!("cargo:rustc-link-search=native={ndpi_libdir}");
        println!("cargo:rustc-link-lib=ndpi");

        bindgen::Builder::default()
            .header_contents("ndpi_wrapper.h", "#include <ndpi_api.h>\n")
            .clang_arg(format!("-I{ndpi_include}"))
            .clang_arg("-I/usr/local/include")
            // Everything the classify/catalog wrappers touch; structs come in
            // transitively via these signatures.
            .allowlist_function("ndpi_init_detection_module")
            .allowlist_function("ndpi_exit_detection_module")
            .allowlist_function("ndpi_finalize_initialization")
            .allowlist_function("ndpi_detection_get_sizeof_ndpi_flow_struct")
            .allowlist_function("ndpi_detection_process_packet")
            .allowlist_function("ndpi_detection_giveup")
            .allowlist_function("ndpi_extra_dissection_possible")
            .allowlist_function("ndpi_free_flow")
            .allowlist_function("ndpi_get_proto_name")
            .allowlist_function("ndpi_get_proto_category")
            .allowlist_function("ndpi_category_get_name")
            .allowlist_function("ndpi_get_num_supported_protocols")
            .allowlist_function("ndpi_get_proto_defaults")
            .allowlist_function("ndpi_revision")
            .allowlist_function("ndpi_confidence_get_name")
            .allowlist_type("ndpi_protocol")
            .allowlist_type("ndpi_flow_struct")
            .allowlist_type("ndpi_detection_module_struct")
            .allowlist_type("ndpi_protocol_category_t")
            .allowlist_type("ndpi_confidence_t")
            .derive_default(true)
            .layout_tests(false)
            .generate()
            .expect("bindgen for libndpi failed — are the nDPI >= 4.8 headers installed under /usr/local/include/ndpi (or $NDPI_INCLUDE_DIR)?")
            .write_to_file(out_dir.join("ndpi_bindings.rs"))
            .expect("write ndpi bindings");
    }

    #[cfg(feature = "nfct")]
    {
        println!("cargo:rustc-link-lib=netfilter_conntrack");
        bindgen::Builder::default()
            .header_contents(
                "nfct_wrapper.h",
                "#include <libnetfilter_conntrack/libnetfilter_conntrack.h>\n",
            )
            .allowlist_function("nfct_open")
            .allowlist_function("nfct_close")
            .allowlist_function("nfct_new")
            .allowlist_function("nfct_destroy")
            .allowlist_function("nfct_set_attr_u8")
            .allowlist_function("nfct_set_attr_u16")
            .allowlist_function("nfct_set_attr_u32")
            .allowlist_function("nfct_set_attr")
            .allowlist_function("nfct_get_attr_u32")
            .allowlist_function("nfct_query")
            .allowlist_function("nfct_callback_register")
            .allowlist_function("nfct_callback_unregister")
            .allowlist_type("nf_conntrack_attr")
            .allowlist_type("nf_conntrack_query")
            .allowlist_type("nfct_callback")
            .allowlist_type("nfct_handle")
            // Attribute ids and the UPDATE query verb used by the mark writer.
            .allowlist_var("ATTR_L3PROTO")
            .allowlist_var("ATTR_L4PROTO")
            .allowlist_var("ATTR_ORIG_IPV4_SRC")
            .allowlist_var("ATTR_ORIG_IPV4_DST")
            .allowlist_var("ATTR_ORIG_IPV6_SRC")
            .allowlist_var("ATTR_ORIG_IPV6_DST")
            .allowlist_var("ATTR_ORIG_PORT_SRC")
            .allowlist_var("ATTR_ORIG_PORT_DST")
            .allowlist_var("ATTR_MARK")
            .allowlist_var("ATTR_MARK_MASK")
            .allowlist_var("NFCT_Q_UPDATE")
            // Flat `pub const NAME: alias = ..;` for every enum member, with NO
            // enum-name prefix, so `nfct::ATTR_MARK` / `nfct::NFCT_Q_UPDATE`
            // resolve (bindgen otherwise emits `nf_conntrack_attr_ATTR_MARK`).
            .default_enum_style(bindgen::EnumVariation::Consts)
            .prepend_enum_name(false)
            .layout_tests(false)
            .generate()
            .expect("bindgen for libnetfilter_conntrack failed — is libnetfilter-conntrack-dev installed?")
            .write_to_file(out_dir.join("nfct_bindings.rs"))
            .expect("write nfct bindings");
    }
}
