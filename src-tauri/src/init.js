// Injected by Killio App into every page it loads, before the page's own scripts.
// The frontend reads `window.__KILLIO_APP__` to know it runs inside the app and
// calls `window.killioApp.*` for native features. Rust rejects every call that
// does not come from the launcher or the chosen tenant.
(function () {
  if (window.__KILLIO_APP__) return;
  function invoke(cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || !internals.invoke) return Promise.reject(new Error("Killio App bridge unavailable"));
    return internals.invoke(cmd, args || {});
  }
  window.__KILLIO_APP__ = { shell: "tauri", bridge: 1 };
  window.killioApp = {
    isApp: true,
    info: function () { return invoke("app_info"); },
    switchTenant: function () { return invoke("switch_tenant"); },
    captureScreenshot: function () { return invoke("capture_screenshot"); },
    openExternal: function (url) { return invoke("open_external", { url: url }); },
    // Accounts across servers. Only profile data crosses; tokens stay in each server's own page.
    reportAccounts: function (accounts) { return invoke("report_accounts", { accounts: accounts }); },
    listAccounts: function () { return invoke("list_accounts"); },
    openAccount: function (tenant, accountId) { return invoke("open_account", { tenant: tenant, accountId: accountId }); },
  };
})();
