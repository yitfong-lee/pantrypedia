fn main() {
    // The frontend in `../src` is baked into the binary by `generate_context!`,
    // so it is a real build input - but cargo has no way of knowing that. Without
    // this line, editing HTML/CSS/JS and rebuilding silently ships the OLD
    // interface: cargo sees no Rust change, skips the compile, and the build
    // finishes in seconds having only re-patched the exe with bundle metadata.
    //
    // Watching the directory fixes that permanently. (A directory path is
    // watched recursively.)
    println!("cargo:rerun-if-changed=../src");

    // Same story for the bundled catalog: `include_str!("../data/seed.json")`
    // in lib.rs makes seed.json a build input too. Without this, regenerating
    // the recipes would not trigger a recompile and the old catalog would ship.
    println!("cargo:rerun-if-changed=../data");

    tauri_build::build()
}
