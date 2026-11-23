use std::time::Duration;

use crate::i18n::tr;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::config::{normalize_tenant_url, sanitize_accounts, same_origin, Account, Config, Store, Tenant};

/// Who is calling. Remote pages can reach the IPC, so every command decides here
/// whether the page that called is one the user chose.
#[derive(PartialEq)]
enum Caller {
    Launcher,
    Tenant,
    Other,
}

fn is_launcher_url(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn caller(window: &WebviewWindow, store: &Store) -> Caller {
    let Ok(url) = window.url() else { return Caller::Other };
    if is_launcher_url(&url) {
        return Caller::Launcher;
    }
    let current = store.config.lock().unwrap().current.clone();
    match current.and_then(|c| Url::parse(&c).ok()) {
        Some(tenant) if same_origin(&url, &tenant) => Caller::Tenant,
        _ => Caller::Other,
    }
}

fn require_launcher(window: &WebviewWindow, store: &Store) -> Result<(), String> {
    if caller(window, store) == Caller::Launcher { Ok(()) } else { Err(tr("Solo disponible desde el selector de servidor.", "Only available from the server picker.").into()) }
}

fn require_trusted(window: &WebviewWindow, store: &Store) -> Result<(), String> {
    if caller(window, store) == Caller::Other { Err(tr("Esta página no puede usar funciones nativas.", "This page cannot use native features.").into()) } else { Ok(()) }
}

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    platform: &'static str,
    features: Vec<&'static str>,
    tenant: Option<String>,
}

#[tauri::command]
pub fn app_info(app: AppHandle, window: WebviewWindow, store: State<Store>) -> Result<AppInfo, String> {
    require_trusted(&window, &store)?;
    let mut features = vec!["switchTenant", "openExternal", "accounts"];
    if cfg!(desktop) {
        features.push("screenshot");
        features.push("apps");
    }
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        features,
        tenant: store.config.lock().unwrap().current.clone(),
    })
}

#[tauri::command]
pub fn app_state(window: WebviewWindow, store: State<Store>) -> Result<Config, String> {
    require_launcher(&window, &store)?;
    // The launcher's address differs per platform (tauri://localhost, http://tauri.localhost…):
    // remember the real one the first time the launcher talks to us, to come back to it later.
    if let Ok(mut url) = window.url() {
        url.set_fragment(None);
        *store.launcher_url.lock().unwrap() = Some(url);
    }
    Ok(store.snapshot())
}

/// A redirect is only followed between `example.com` and `www.example.com`; a redirect to some
/// other host (a sign-in provider, say) must not become the tenant.
fn same_site_ignoring_www(a: &Url, b: &Url) -> bool {
    let bare = |u: &Url| u.host_str().map(|h| h.strip_prefix("www.").unwrap_or(h).to_string());
    a.scheme() == b.scheme() && bare(a) == bare(b) && a.port_or_known_default() == b.port_or_known_default()
}

/// The address the tenant really lives at (a site may redirect, e.g. to `www.`), or `None` when it
/// does not answer. Any HTTP status counts as an answer: the server is there.
#[tauri::command]
pub async fn probe_tenant(window: WebviewWindow, store: State<'_, Store>, url: String) -> Result<Option<String>, String> {
    require_launcher(&window, &store)?;
    let target = normalize_tenant_url(&url)?;
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(6)).redirects(4).build();
        match agent.get(target.as_str()).call() {
            // Keep the redirect target only if it is still an acceptable tenant address.
            Ok(response) => Some(
                normalize_tenant_url(response.get_url())
                    .ok()
                    .filter(|landed| same_site_ignoring_www(landed, &target))
                    .unwrap_or(target)
                    .to_string(),
            ),
            Err(ureq::Error::Status(_, _)) => Some(target.to_string()),
            Err(_) => None,
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(resolved)
}

/// Remember the tenant and take the window to it. Login, OAuth and the rest are the tenant's own frontend.
/// `replaces` is the address the user picked when the tenant turned out to live at another one.
#[tauri::command]
pub fn open_tenant(
    window: WebviewWindow,
    store: State<Store>,
    url: String,
    name: Option<String>,
    replaces: Option<String>,
) -> Result<(), String> {
    require_launcher(&window, &store)?;
    let target = normalize_tenant_url(&url)?;
    {
        let mut config = store.config.lock().unwrap();
        let key = target.to_string();
        let label = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        if let Some(old) = replaces.filter(|old| *old != key) {
            let already_listed = config.tenants.iter().any(|t| t.url == key);
            if already_listed {
                config.tenants.retain(|t| t.url != old);
            } else if let Some(entry) = config.tenants.iter_mut().find(|t| t.url == old) {
                entry.url = key.clone();
            }
        }
        match config.tenants.iter_mut().find(|t| t.url == key) {
            Some(existing) => {
                if let Some(label) = label {
                    existing.name = label;
                }
            }
            None => config.tenants.push(Tenant {
                name: label.unwrap_or_else(|| target.host_str().unwrap_or("Tenant").to_string()),
                url: key.clone(),
            }),
        }
        config.current = Some(key);
    }
    store.save();
    // The app never shows the marketing landing: it starts at sign-in, and the frontend sends a
    // signed-in user on to their workspace.
    let start = target.join("login").unwrap_or(target);
    window.navigate(start).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_tenant(window: WebviewWindow, store: State<Store>, url: String) -> Result<Config, String> {
    require_launcher(&window, &store)?;
    {
        let mut config = store.config.lock().unwrap();
        config.tenants.retain(|t| t.url != url);
        config.accounts.retain(|a| a.tenant != url);
        if config.current.as_deref() == Some(url.as_str()) {
            config.current = None;
        }
    }
    store.save();
    Ok(store.snapshot())
}

/// Back to the launcher. `reason` tells it why ("switch": do not auto-open the last tenant).
pub fn go_to_launcher(window: &WebviewWindow, reason: &str) -> Result<(), String> {
    let store = window.state::<Store>();
    let mut url = store.launcher_url.lock().unwrap().clone().ok_or(tr("Selector no disponible.", "The server picker is not available."))?;
    url.set_fragment(Some(reason));
    window.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn switch_tenant(window: WebviewWindow, store: State<Store>) -> Result<(), String> {
    require_trusted(&window, &store)?;
    go_to_launcher(&window, "switch")
}

fn require_tenant(window: &WebviewWindow, store: &Store) -> Result<String, String> {
    if caller(window, store) != Caller::Tenant {
        return Err(tr("Solo disponible desde el servidor conectado.", "Only available from the connected server.").into());
    }
    store.config.lock().unwrap().current.clone().ok_or_else(|| tr("No hay servidor conectado.", "No server is connected.").to_string())
}

/// The tenant's page tells the app which accounts are signed in on it. Replaces that tenant's list.
#[tauri::command]
pub fn report_accounts(window: WebviewWindow, store: State<Store>, accounts: Vec<Account>) -> Result<(), String> {
    let tenant = require_tenant(&window, &store)?;
    let cleaned = sanitize_accounts(&tenant, accounts);
    {
        let mut config = store.config.lock().unwrap();
        let unchanged = config.accounts.iter().filter(|a| a.tenant == tenant).eq(cleaned.iter());
        if unchanged {
            return Ok(());
        }
        config.accounts.retain(|a| a.tenant != tenant);
        config.accounts.extend(cleaned);
    }
    store.save();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedAccount {
    #[serde(flatten)]
    account: Account,
    tenant_name: String,
    /// True when the account belongs to the server the window is on.
    here: bool,
}

/// Every account signed in on any server, for the account switcher.
#[tauri::command]
pub fn list_accounts(window: WebviewWindow, store: State<Store>) -> Result<Vec<ListedAccount>, String> {
    require_trusted(&window, &store)?;
    let config = store.snapshot();
    Ok(config
        .accounts
        .iter()
        // An account whose server was removed from the list is not offered.
        .filter_map(|a| {
            let tenant = config.tenants.iter().find(|t| t.url == a.tenant)?;
            Some(ListedAccount { account: a.clone(), tenant_name: tenant.name.clone(), here: config.current.as_deref() == Some(a.tenant.as_str()) })
        })
        .collect())
}

/// Go to another server already on the list and ask its page to switch to one of its accounts.
/// The account id travels in the URL fragment, which is not sent to the server.
#[tauri::command]
pub fn open_account(window: WebviewWindow, store: State<Store>, tenant: String, account_id: String) -> Result<(), String> {
    require_trusted(&window, &store)?;
    let target = {
        let mut config = store.config.lock().unwrap();
        if !config.accounts.iter().any(|a| a.tenant == tenant && a.id == account_id) {
            return Err(tr("Esa cuenta ya no está guardada.", "That account is no longer saved.").into());
        }
        let known = config.tenants.iter().any(|t| t.url == tenant);
        if !known {
            return Err(tr("Ese servidor ya no está en la lista.", "That server is no longer on the list.").into());
        }
        config.current = Some(tenant.clone());
        Url::parse(&tenant).map_err(|_| tr("URL no válida.", "The URL is not valid.").to_string())?
    };
    store.save();
    let mut start = target;
    start.set_fragment(Some(&format!("killio-account={account_id}")));
    window.navigate(start).map_err(|e| e.to_string())
}

/// Links a page may hand to the system. Web, mail and phone links everywhere; each system's own schemes
/// (its settings app, Apple Shortcuts) only on that system.
fn allowed_scheme(scheme: &str) -> bool {
    if matches!(scheme, "http" | "https" | "mailto" | "tel" | "sms") {
        return true;
    }
    match scheme {
        "ms-settings" => cfg!(target_os = "windows"),
        "x-apple.systempreferences" => cfg!(target_os = "macos"),
        "shortcuts" => cfg!(any(target_os = "macos", target_os = "ios")),
        _ => false,
    }
}

/// Apps installed on this computer, for the agent's app tools. Desktop only.
#[tauri::command]
pub async fn list_apps(window: WebviewWindow, store: State<'_, Store>) -> Result<Vec<crate::apps::InstalledApp>, String> {
    require_trusted(&window, &store)?;
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(crate::apps::list).await.map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        Err(tr("No disponible en este dispositivo.", "Not available on this device.").into())
    }
}

/// Opens one of the apps `list_apps` returned. Anything else is refused.
#[tauri::command]
pub fn open_app(app: AppHandle, window: WebviewWindow, store: State<Store>, package: String) -> Result<(), String> {
    require_trusted(&window, &store)?;
    #[cfg(desktop)]
    {
        let path = crate::apps::resolve(&package).ok_or(tr("Esa aplicación no está instalada.", "That app is not installed."))?;
        if cfg!(target_os = "linux") {
            // A .desktop entry is launched by its id, not opened as a file (that would show it in an editor).
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            std::process::Command::new("gtk-launch").arg(id).spawn().map(|_| ()).map_err(|e| e.to_string())
        } else {
            app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, package);
        Err(tr("No disponible en este dispositivo.", "Not available on this device.").into())
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, window: WebviewWindow, store: State<Store>, url: String) -> Result<(), String> {
    require_trusted(&window, &store)?;
    let parsed = Url::parse(&url).map_err(|_| tr("URL no válida.", "The URL is not valid.").to_string())?;
    if !allowed_scheme(parsed.scheme()) {
        return Err(tr("Ese tipo de enlace no se puede abrir en este dispositivo.", "That kind of link cannot be opened on this device.").into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Screenshot {
    mime: &'static str,
    width: u32,
    height: u32,
    /// PNG bytes, base64.
    data: String,
}

#[cfg(desktop)]
fn capture_primary_png() -> Result<(Vec<u8>, u32, u32), String> {
    use xcap::Monitor;
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or(tr("No se encontró ninguna pantalla.", "No screen was found."))?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let (width, height) = (image.width(), image.height());
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), xcap::image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok((png, width, height))
}

/// Screenshot of the primary screen, for the page to attach (agent tool, chat, cards…).
#[tauri::command]
pub async fn capture_screenshot(window: WebviewWindow, store: State<'_, Store>) -> Result<Screenshot, String> {
    require_trusted(&window, &store)?;
    #[cfg(desktop)]
    {
        use base64::Engine;
        let (png, width, height) = tauri::async_runtime::spawn_blocking(capture_primary_png)
            .await
            .map_err(|e| e.to_string())??;
        Ok(Screenshot { mime: "image/png", width, height, data: base64::engine::general_purpose::STANDARD.encode(png) })
    }
    #[cfg(not(desktop))]
    {
        Err(tr("La captura de pantalla aún no está disponible en este dispositivo.", "Screenshots are not available on this device yet.").into())
    }
}

/// Menu action: save a screenshot under Pictures/Killio and tell the page where it went.
#[cfg(desktop)]
pub fn save_screenshot_to_pictures(app: &AppHandle) {
    use tauri::Emitter;
    let result = (|| -> Result<String, String> {
        let (png, _, _) = capture_primary_png()?;
        let dir = app.path().picture_dir().map_err(|e| e.to_string())?.join("Killio");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("killio-{stamp}.png"));
        std::fs::write(&path, png).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })();
    let _ = match result {
        Ok(path) => app.emit("killio://screenshot-saved", path),
        Err(error) => app.emit("killio://screenshot-failed", error),
    };
}
