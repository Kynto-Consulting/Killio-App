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
  // ── Rules the app keeps by itself ─────────────────────────────────────────
  // A server may run a frontend older than the app (or one not redeployed yet), so the two rules the
  // app promises do not rely on the page: no marketing landing, and the logo on the sign-in pages opens
  // the server picker. A frontend that already does this simply never triggers them.
  var isLauncher = location.protocol === "tauri:" || location.hostname === "tauri.localhost";
  var AUTH_PAGES = /^\/(login|signup|forgot-password|verify-otp|change-password)(\/|$)/;
  function signedIn() { return /(?:^|;\s*)killio_token=[^;]+/.test(document.cookie); }
  function skipLanding() {
    if (!isLauncher && location.pathname === "/" && !signedIn()) location.replace("/login");
  }
  if (!isLauncher) {
    skipLanding(); // before the page draws anything
    // In-page navigation (the frontend's router) does not reload the page: watch the address too.
    ["pushState", "replaceState"].forEach(function (name) {
      var original = history[name];
      history[name] = function () {
        var result = original.apply(this, arguments);
        setTimeout(skipLanding, 0);
        return result;
      };
    });
    window.addEventListener("popstate", function () { setTimeout(skipLanding, 0); });
    document.addEventListener("click", function (event) {
      if (!AUTH_PAGES.test(location.pathname) || event.defaultPrevented) return;
      var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!link || link.getAttribute("href") !== "/") return;
      event.preventDefault();
      event.stopPropagation();
      invoke("switch_tenant");
    }, true);
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
    // Apps installed on this computer (desktop).
    listApps: function () { return invoke("list_apps"); },
    openApp: function (pkg) { return invoke("open_app", { package: pkg }); },
    openAccount: function (tenant, accountId) { return invoke("open_account", { tenant: tenant, accountId: accountId }); },
  };
})();
