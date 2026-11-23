mod apps;
mod commands;
mod config;
mod deeplink;
mod i18n;
#[cfg(desktop)]
mod icon;

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
        if let Some(window) = app.get_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(config::Store::default())
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
        ])
        .setup(|app| {
            let store = app.state::<config::Store>();
            store.load(app.handle());
            // The system language goes first so the launcher and the native messages agree.
            let init = format!("window.__KILLIO_LANG__={:?};{}", i18n::language(), INIT_SCRIPT);

            #[cfg(desktop)]
            desktop::build(app, &init)?;

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
                        if let Some(window) = handle.get_window("main") {
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Killio App");
}

/// The desktop window: no system frame and no menu bar. A slim title bar of the app's own sits on top
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
