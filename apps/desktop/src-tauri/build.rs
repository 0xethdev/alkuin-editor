fn main() {
    // `telemetry.rs` reads these with `option_env!`. Cargo tracks that through
    // dep-info for the crate itself; declaring them here as well makes the
    // dependency explicit and covers the build script's own outputs.
    println!("cargo::rerun-if-env-changed=WRITER_POSTHOG_KEY");
    println!("cargo::rerun-if-env-changed=WRITER_POSTHOG_HOST");
    // `account.rs` bakes these into a signed build with `option_env!`.
    println!("cargo::rerun-if-env-changed=REDLINE_SUPABASE_URL");
    println!("cargo::rerun-if-env-changed=REDLINE_SUPABASE_ANON_KEY");
    // Public history base URL. Unset or the placeholder keeps sync off.
    println!("cargo::rerun-if-env-changed=ALKUIN_HISTORY_URL");

    history_server_tests();

    tauri_build::build()
}

/// The sync tests that run a real history server are not in this repository, because the
/// server is not. A build that has them names their file in ALKUIN_HISTORY_SERVER_TESTS,
/// and `commands/history.rs` then includes it in its test module.
fn history_server_tests() {
    println!("cargo::rustc-check-cfg=cfg(history_server_tests)");
    println!("cargo::rerun-if-env-changed=ALKUIN_HISTORY_SERVER_TESTS");
    let Some(file) = std::env::var_os("ALKUIN_HISTORY_SERVER_TESTS") else {
        return;
    };
    let file = std::path::PathBuf::from(file);
    assert!(
        file.is_file(),
        "ALKUIN_HISTORY_SERVER_TESTS names no file: {}",
        file.display()
    );
    println!("cargo::rustc-cfg=history_server_tests");
}
