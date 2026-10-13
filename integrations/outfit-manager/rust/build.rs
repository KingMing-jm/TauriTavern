use std::path::PathBuf;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") { return; }
    assert_eq!(std::env::var("CARGO_CFG_TARGET_ARCH").as_deref(), Ok("aarch64"), "The Outfit Android bundle is arm64-v8a only");
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest path")).join("../../..");
    let mobile = root.join(".outfit-build/node-mobile");
    let library = mobile.join("bin/arm64-v8a");
    let shim = root.join("integrations/outfit-manager/node-mobile.cpp");
    assert!(library.join("libnode.so").is_file(), "Run node scripts/outfit/prepare.mjs android-arm64 first");
    assert!(mobile.join("include/node/node.h").is_file(), "Node Mobile headers are missing");
    cc::Build::new().cpp(true).file(&shim).include(mobile.join("include/node"))
        .flag_if_supported("-std=c++17").flag_if_supported("-fPIC")
        .cpp_link_stdlib("c++_shared").compile("tt_outfit_node");
    println!("cargo:rustc-link-search=native={}", library.display());
    println!("cargo:rustc-link-lib=dylib=node");
    println!("cargo:rerun-if-changed={}", shim.display());
    println!("cargo:rerun-if-changed={}", library.join("libnode.so").display());
}
