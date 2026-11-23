//! Running in the background (desktop): while active listening is on, closing the window hides it
//! instead of ending the app, and the app stays reachable from an icon in the system tray. With
//! listening off, closing the window ends the app as before.
//!
//! The microphone is never left on silently: each time the window is hidden with listening on, the
//! system shows a notification saying so, and the tray icon's text says it for as long as it lasts.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

use crate::i18n::tr;

const TRAY: &str = "killio";

/// Whether the page reports the microphone on (see `commands::set_chrome`).
#[derive(Default)]
pub struct Background {
    listening: AtomicBool,
}

impl Background {
    pub fn listening(&self) -> bool {
        self.listening.load(Ordering::Relaxed)
    }
}

/// The page said whether it is listening: remember it and say it on the tray icon.
pub fn set_listening(app: &AppHandle, on: bool) {
    let changed = app.state::<Background>().listening.swap(on, Ordering::Relaxed) != on;
    if changed {
        if let Some(tray) = app.tray_by_id(TRAY) {
            let text = if on { tr("Killio — escuchando", "Killio — listening") } else { "Killio" };
            let _ = tray.set_tooltip(Some(text));
        }
    }
}

/// Brings the window back, wherever it was (hidden in the tray, minimised, behind others).
pub fn reveal(app: &AppHandle) {
    if let Some(window) = crate::main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The window was asked to close. Returns true when the app stays alive in the tray instead.
pub fn keep_in_background(app: &AppHandle) -> bool {
    if !app.state::<Background>().listening() {
        return false;
    }
    if let Some(window) = crate::main_window(app) {
        let _ = window.hide();
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(tr("Killio sigue escuchando", "Killio is still listening"))
        .body(tr(
            "La escucha activa sigue encendida en segundo plano. Ábrelo o ciérralo desde el icono de la bandeja.",
            "Active listening stays on in the background. Open or quit it from the tray icon.",
        ))
        .show();
    true
}

pub fn build(app: &mut App) -> tauri::Result<()> {
    let handle = app.handle();
    let show = MenuItemBuilder::with_id("tray-show", tr("Abrir Killio", "Open Killio")).build(handle)?;
    let listen = MenuItemBuilder::with_id("tray-listen", tr("Activar o detener la escucha", "Turn listening on or off")).build(handle)?;
    let quit = MenuItemBuilder::with_id("tray-quit", tr("Salir", "Quit")).build(handle)?;
    let menu = MenuBuilder::new(handle).item(&show).item(&listen).separator().item(&quit).build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY)
        .tooltip("Killio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => reveal(app),
            "tray-listen" => {
                if let Some(content) = app.get_webview(crate::CONTENT) {
                    let _ = content.eval("window.__killioListening && window.__killioListening.toggle()");
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                reveal(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
