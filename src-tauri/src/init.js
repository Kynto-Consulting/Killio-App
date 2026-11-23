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
  // The rules are for the server the user chose, not for a site the window is passing through (a sign-in
  // provider). The app answers `app_info` only to the chosen server, so that answer is the test.
  var onServer = false;
  function skipLanding() {
    if (onServer && location.pathname === "/" && !signedIn()) location.replace("/login");
  }
  if (!isLauncher) {
    invoke("app_info").then(function () { onServer = true; skipLanding(); }, function () {});
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
      if (!onServer || !AUTH_PAGES.test(location.pathname) || event.defaultPrevented) return;
      var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!link || link.getAttribute("href") !== "/") return;
      event.preventDefault();
      event.stopPropagation();
      invoke("switch_tenant");
    }, true);
  }

  // ── Title bar and shortcuts ───────────────────────────────────────────────
  // The window has no system frame and no menu. The page tells the app its colour, name and icon so the
  // app's own title bar reads as part of it, and the shortcuts the menu used to carry live here.
  var lastChrome = "";
  function reportChrome() {
    if (!document.body) return;
    var color = getComputedStyle(document.body).backgroundColor;
    if (!color || /rgba\(0, 0, 0, 0\)|transparent/.test(color)) color = getComputedStyle(document.documentElement).backgroundColor;
    var link = document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"]');
    // Active listening: the page says whether it offers it and whether the microphone is on, so the title
    // bar can show a microphone button that is impossible to miss while it records.
    var listening = typeof window.__killioListeningState === "boolean" ? window.__killioListeningState : null;
    var chrome = isLauncher
      ? { color: color, name: "Killio", icon: null, listening: null }
      : { color: color, name: (document.title || "").split(/\s[|·—-]\s/)[0].trim() || location.hostname, icon: link ? link.href : location.origin + "/favicon.ico", listening: listening };
    var key = JSON.stringify(chrome);
    if (key === lastChrome) return;
    lastChrome = key;
    invoke("set_chrome", { chrome: chrome }).catch(function () { lastChrome = ""; });
  }
  document.addEventListener("DOMContentLoaded", reportChrome);
  window.addEventListener("load", reportChrome);
  setInterval(reportChrome, 1000); // theme switches, title changes and the microphone state after load

  window.addEventListener("keydown", function (event) {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    var key = (event.key || "").toLowerCase();
    if (key === "t") { event.preventDefault(); invoke("switch_tenant"); }
    if (key === "s") { event.preventDefault(); invoke("save_screenshot"); }
  }, true);

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
    // A system notification, for what the server routes through the app instead of the browser's web push.
    notify: function (notification) { return invoke("notify", { title: notification.title, body: notification.body || null }); },
    // Updating the app itself: is there a newer published build, what changed, and install it.
    checkUpdate: function () { return invoke("update_check"); },
    installUpdate: function () { return invoke("update_install"); },
    // The phone's own hardware and system apps (Android): setAlarm, setTimer, flashlight, listApps, openApp.
    device: function (action, payload) { return invoke("device_action", { action: action, payload: payload || {} }); },
    openAccount: function (tenant, accountId) { return invoke("open_account", { tenant: tenant, accountId: accountId }); },
    // The person's own Claude Code as AI provider (desktop). The page sends Anthropic Messages requests
    // through the app and reads the stream by polling; it never sees the bridge's address or key.
    claude: {
      status: function () { return invoke("claude_status"); },
      start: function () { return invoke("claude_start"); },
      stop: function () { return invoke("claude_stop"); },
      models: function () { return invoke("claude_models"); },
      send: function (request) { return invoke("claude_send", { request: request }); },
      poll: function (id) { return invoke("claude_poll", { id: id }); },
      cancel: function (id) { return invoke("claude_cancel", { id: id }); },
    },
  };
})();
