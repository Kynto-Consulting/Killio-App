fn main() {
    // Declaring the commands generates an `allow-<command>` permission for each, which is what
    // lets the capability grant them to the tenant's (remote) pages.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_info",
            "app_state",
            "probe_tenant",
            "open_tenant",
            "remove_tenant",
            "switch_tenant",
            "capture_screenshot",
            "open_external",
            "report_accounts",
            "list_accounts",
            "open_account",
            "list_apps",
            "open_app",
        ]),
    ))
    .expect("failed to run tauri-build");
}
