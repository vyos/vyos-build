// With the `libloc` feature: compile src/shim.c against the installed libloc
// headers and link the shared library. The shim exists so every libloc API
// detail (enum values, FILE* handling, header path) is checked by the C
// compiler at package build time instead of being duplicated as unchecked
// `extern` declarations — a mismatch is a build failure, never runtime UB.
//
// `cc`/`ar` are invoked directly (no cc-rs dependency): the deb build runs in
// a Debian container where both are guaranteed, and the feature is never
// enabled on dev machines without them.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src/shim.c");
    if env::var_os("CARGO_FEATURE_LIBLOC").is_none() {
        return;
    }

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let obj = out.join("shim.o");
    let lib = out.join("libqzgeoshim.a");

    let cc = env::var("CC").unwrap_or_else(|_| "cc".into());
    let status = Command::new(&cc)
        .args(["-O2", "-Wall", "-Werror", "-fPIC", "-c", "src/shim.c", "-o"])
        .arg(&obj)
        .status()
        .expect("running the C compiler (feature libloc needs cc + libloc-dev)");
    assert!(status.success(), "compiling src/shim.c failed");

    let status = Command::new("ar")
        .arg("crs")
        .arg(&lib)
        .arg(&obj)
        .status()
        .expect("running ar");
    assert!(status.success(), "archiving shim.o failed");

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=qzgeoshim");
    println!("cargo:rustc-link-lib=dylib=loc");
}
