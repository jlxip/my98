fn main() {
    let lib = pkg_config::Config::new().cargo_metadata(false).atleast_version("4.8").probe("slirp").expect("Install libslirp development headers (Debian: libslirp-dev libglib2.0-dev; macOS: brew install libslirp)");
    let mut c = cc::Build::new();
    c.file("c/bridge.c")
        .warnings(true)
        .flag_if_supported("-std=c11");
    for path in lib.include_paths {
        c.include(path);
    }
    c.compile("my98_slirp");
    // GNU ld needs the dependent archive before its shared libraries.
    pkg_config::Config::new()
        .atleast_version("4.8")
        .probe("slirp")
        .unwrap();
    println!("cargo:rerun-if-changed=c/bridge.c");
}
