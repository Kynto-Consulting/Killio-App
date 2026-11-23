mod apps;
mod commands;
mod config;
mod claude;
mod deeplink;
mod i18n;
#[cfg(desktop)]
mod icon;
#[cfg(desktop)]
mod tray;

use tauri::{Manager, WebviewUrl};

const INIT_SCRIPT: &str = include_str!("init.js");

/// Label of the webview that shows the launcher and then the tenant's frontend.
pub const CONTENT: &str = "content";
/// Label of the app's own title bar (desktop only).
pub const TITLEBAR: &str = "titlebar";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Desktop: a `killio://` link starts a second copy of the program. Keep one window: the second copy
    // passes its link to the running one and exits.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        tray::reveal(app);
    }));
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_killio_device::init())
        .plugin(tauri_plugin_notification::init())
        .manage(config::Store::default())
        .manage(claude::Bridge::default());
    #[cfg(desktop)]
    let builder = builder.manage(tray::Background::default());
    builder
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_state,
            commands::probe_tenant,
            commands::open_tenant,
            commands::remove_tenant,
            commands::switch_tenant,
            commands::capture_screenshot,
            commands::save_screenshot,
            commands::open_external,
            commands::report_accounts,
            commands::list_accounts,
            commands::open_account,
            commands::list_apps,
            commands::open_app,
            commands::set_chrome,
            commands::chrome_action,
            claude::claude_status,
            claude::claude_start,
            claude::claude_stop,
            claude::claude_models,
            claude::claude_send,
            claude::claude_poll,
            claude::claude_cancel,
            commands::device_action,
            commands::notify,
        ])
        .setup(|app| {
            let store = app.state::<config::Store>();
            store.load(app.handle());
            // The system language goes first so the launcher and the native messages agree.
            let init = format!("window.__KILLIO_LANG__={:?};{}", i18n::language(), INIT_SCRIPT);

            #[cfg(all(desktop, not(target_os = "linux")))]
            desktop::build(app, &init)?;
            // Linux has both arrangements so they can be compared on a real desktop: the framed one by
            // default, the frameless one with KILLIO_FRAMELESS=1.
            #[cfg(target_os = "linux")]
            if std::env::var("KILLIO_FRAMELESS").as_deref() == Ok("1") {
                desktop::build(app, &init)?;
            } else {
                linux::build(app, &init)?;
            }

            // The way back to a window that keeps listening after being closed (see tray.rs).
            #[cfg(desktop)]
            tray::build(app)?;

            // A phone has no window chrome to replace: one full-screen webview.
            #[cfg(mobile)]
            tauri::WebviewWindowBuilder::new(app, CONTENT, WebviewUrl::App("index.html".into()))
                .initialization_script(&init)
                .build()?;

            // `killio://` links (see deeplink.rs).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installers register the scheme; this also covers a copy run without installing.
                #[cfg(any(target_os = "windows", target_os = "linux"))]
                let _ = app.deep_link().register_all();
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for link in event.urls() {
                        let current = handle.state::<config::Store>().config.lock().unwrap().current.clone();
                        let Some(target) = deeplink::destination(link.as_str(), current.as_deref()) else { continue };
                        if let Some(content) = handle.get_webview(CONTENT) {
                            let _ = content.navigate(target);
                        }
                        #[cfg(desktop)]
                        tray::reveal(&handle);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Killio App")
        .run(|app, event| {
            // Closing the window while listening keeps the app in the tray instead of ending it.
            #[cfg(desktop)]
            if let tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { api, .. }, .. } = &event {
                if tray::keep_in_background(app) {
                    api.prevent_close();
                }
            }
            // The Claude bridge is a child of the app: it never outlives it.
            if let tauri::RunEvent::Exit = event {
                app.state::<claude::Bridge>().stop();
            }
        });
}

/// The app's window, whichever way this system builds it (see `desktop` and `linux`).
#[cfg(desktop)]
pub fn main_window(app: &tauri::AppHandle) -> Option<tauri::Window> {
    app.get_window("main").or_else(|| app.get_window(CONTENT))
}

/// Linux: one webview in a window with the system's own frame, and the app's controls in a menu.
/// The plain arrangement, kept as the default on Linux until the frameless one (`desktop`) is seen
/// working on real Linux desktops; set KILLIO_FRAMELESS=1 to try that one.
#[cfg(target_os = "linux")]
mod linux {
    use tauri::{
        menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
        App, WebviewWindowBuilder,
    };

    use super::{WebviewUrl, CONTENT};
    use crate::i18n::tr;

    pub fn build(app: &mut App, init: &str) -> tauri::Result<()> {
        let window = WebviewWindowBuilder::new(app, CONTENT, WebviewUrl::App("index.html".into()))
            .initialization_script(init)
            .title("Killio")
            .inner_size(1280.0, 800.0)
            .min_inner_size(380.0, 560.0)
            .build()?;

        let handle = app.handle();
        // The ids are the same actions the title bar's buttons send on the other systems.
        let item = |id: &str, label: &str, key: Option<&str>| {
            let builder = MenuItemBuilder::with_id(id, label);
            match key {
                Some(key) => builder.accelerator(key).build(handle),
                None => builder.build(handle),
            }
        };
        let killio = SubmenuBuilder::new(handle, "Killio")
            .item(&item("home", tr("Ir al inicio", "Go to the start page"), Some("Alt+Home"))?)
            .item(&item("back", tr("Atrás", "Back"), Some("Alt+Left"))?)
            .item(&item("reload", tr("Recargar", "Reload"), Some("CmdOrCtrl+R"))?)
            .separator()
            .item(&item("servers", tr("Cambiar de servidor…", "Switch server…"), Some("CmdOrCtrl+Shift+T"))?)
            .separator()
            .item(&item("listen", tr("Escucha activa", "Active listening"), None)?)
            .item(&item("screenshot", tr("Guardar captura de pantalla", "Save screenshot"), Some("CmdOrCtrl+Shift+S"))?)
            .separator()
            .quit()
            .build()?;
        let edit = SubmenuBuilder::new(handle, tr("Editar", "Edit")).undo().redo().separator().cut().copy().paste().select_all().build()?;
        window.set_menu(MenuBuilder::new(handle).item(&killio).item(&edit).build()?)?;

        app.on_menu_event(|app, event| {
            if let Some(frame) = super::main_window(app) {
                let _ = crate::commands::run_chrome_action(app, &frame, event.id().as_ref());
            }
        });
        Ok(())
    }
}

/// Windows and macOS: no system frame and no menu bar. A slim title bar of the app's own sits on top
/// and the page gets everything below it, as two separate webviews. The page therefore keeps its real
/// viewport and never has to make room for the app's chrome, whatever frontend version it is.
#[cfg(desktop)]
mod desktop {
    use tauri::{webview::WebviewBuilder, window::WindowBuilder, App, LogicalPosition, LogicalSize, Window, WindowEvent};

    use super::{WebviewUrl, CONTENT, TITLEBAR};

    /// Height of the title bar, in logical pixels.
    const BAR: f64 = 34.0;

    fn layout(window: &Window) {
        let Ok(scale) = window.scale_factor() else { return };
        let Ok(size) = window.inner_size() else { return };
        let size = size.to_logical::<f64>(scale);
        for webview in window.webviews() {
            let (y, height) = if webview.label() == TITLEBAR { (0.0, BAR) } else { (BAR, (size.height - BAR).max(0.0)) };
            let _ = webview.set_position(LogicalPosition::new(0.0, y));
            let _ = webview.set_size(LogicalSize::new(size.width, height));
        }
    }

    pub fn build(app: &mut App, init: &str) -> tauri::Result<()> {
        let builder = WindowBuilder::new(app, "main").title("Killio").inner_size(1280.0, 800.0).min_inner_size(380.0, 560.0);
        // macOS keeps its own window buttons, drawn over our title bar; the other systems get ours.
        #[cfg(target_os = "macos")]
        let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.decorations(false);
        let window = builder.build()?;

        let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
        window.add_child(
            WebviewBuilder::new(TITLEBAR, WebviewUrl::App("titlebar.html".into()))
                .initialization_script(&format!("window.__KILLIO_LANG__={:?};", crate::i18n::language())),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(size.width, BAR),
        )?;
        window.add_child(
            WebviewBuilder::new(CONTENT, WebviewUrl::App("index.html".into())).initialization_script(init),
            LogicalPosition::new(0.0, BAR),
            LogicalSize::new(size.width, (size.height - BAR).max(0.0)),
        )?;

        let resized = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
                layout(&resized);
            }
        });
        layout(&window);
        Ok(())
    }
}
