#[cfg(desktop)]
mod apps;
mod commands;
mod config;
mod i18n;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const INIT_SCRIPT: &str = include_str!("init.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            commands::open_external,
            commands::report_accounts,
            commands::list_accounts,
            commands::open_account,
            commands::list_apps,
            commands::open_app,
        ])
        .setup(|app| {
            let store = app.state::<config::Store>();
            store.load(app.handle());

            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                // The system language goes first so the launcher and the native messages agree.
                .initialization_script(&format!("window.__KILLIO_LANG__={:?};{}", i18n::language(), INIT_SCRIPT));
            #[cfg(desktop)]
            let builder = builder.title("Killio").inner_size(1280.0, 800.0).min_inner_size(380.0, 560.0);
            let window = builder.build()?;

            #[cfg(desktop)]
            desktop_menu::install(app.handle(), &window)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Killio App");
}

#[cfg(desktop)]
mod desktop_menu {
    use tauri::{
        menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
        AppHandle, Manager, WebviewWindow,
    };

    use crate::commands;
    use crate::i18n::tr;

    pub fn install(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
        let switch = MenuItemBuilder::with_id("switch_tenant", tr("Cambiar de servidor…", "Switch server…"))
            .accelerator("CmdOrCtrl+Shift+T")
            .build(app)?;
        let reload = MenuItemBuilder::with_id("reload", tr("Recargar", "Reload")).accelerator("CmdOrCtrl+R").build(app)?;
        let shot = MenuItemBuilder::with_id("screenshot", tr("Guardar captura de pantalla", "Save screenshot"))
            .accelerator("CmdOrCtrl+Shift+S")
            .build(app)?;
        let killio = SubmenuBuilder::new(app, "Killio")
            .item(&switch)
            .item(&reload)
            .separator()
            .item(&shot)
            .separator()
            .quit()
            .build()?;
        let edit = SubmenuBuilder::new(app, tr("Editar", "Edit")).undo().redo().separator().cut().copy().paste().select_all().build()?;
        let menu = MenuBuilder::new(app).item(&killio).item(&edit).build()?;
        window.set_menu(menu)?;

        app.on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else { return };
            match event.id().as_ref() {
                "switch_tenant" => {
                    let _ = commands::go_to_launcher(&window, "switch");
                }
                "reload" => {
                    let _ = window.eval("window.location.reload()");
                }
                "screenshot" => {
                    let app = app.clone();
                    std::thread::spawn(move || commands::save_screenshot_to_pictures(&app));
                }
                _ => {}
            }
        });
        Ok(())
    }
}
