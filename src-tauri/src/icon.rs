//! The running app's icon follows the server it is connected to: the server's own icon while on it, the
//! app's when on the launcher. Desktop only, and only while the app runs: the icon of the installed
//! program (shortcuts, Start menu, Finder, a pinned taskbar button when closed) is the file's own.
//!
//! Each system keeps the icon in a different place: Windows shows the window's *big* icon in the taskbar
//! and Alt-Tab (the small one only in a system title bar, which this window does not have); macOS shows
//! the application's icon in the Dock; Linux shows the window's icon (X11; Wayland takes it from the
//! installed .desktop file and cannot be changed from here). The tray icon follows on all three.

use std::{io::Read, sync::Mutex, time::Duration};

use tauri::{image::Image, AppHandle};

/// Address of the icon the window shows now (`None`: the app's own).
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

const MAX_BYTES: u64 = 1024 * 1024;
const SIDE: u32 = 128;

fn fetch(url: &str) -> Option<Vec<u8>> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).redirects(3).build();
    let response = agent.get(url).call().ok()?;
    let mut bytes = Vec::new();
    // One byte more than allowed, to tell "exactly at the limit" from "too big".
    response.into_reader().take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_BYTES).then_some(bytes)
}

/// Decodes whatever format the server uses (png, ico, jpeg, webp) into a small square RGBA image.
pub fn decode(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let image = image::load_from_memory(bytes).ok()?;
    let image = image.resize_to_fill(SIDE, SIDE, image::imageops::FilterType::Lanczos3).to_rgba8();
    let (width, height) = image.dimensions();
    Some((image.into_raw(), width, height))
}

/// The same picture as a PNG file, the form Windows and macOS take an icon in.
#[cfg(any(windows, target_os = "macos"))]
fn png(icon: &Image<'_>) -> Option<Vec<u8>> {
    let picture = image::RgbaImage::from_raw(icon.width(), icon.height(), icon.rgba().to_vec())?;
    let mut out = std::io::Cursor::new(Vec::new());
    picture.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Windows: the taskbar and Alt-Tab show the window's big icon, which `set_icon` leaves untouched.
#[cfg(windows)]
fn set_big_icon(window: &tauri::Window, png: &[u8]) {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn CreateIconFromResourceEx(bits: *const u8, size: u32, icon: i32, version: u32, cx: i32, cy: i32, flags: u32) -> *mut c_void;
        fn SendMessageW(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
        fn DestroyIcon(icon: *mut c_void) -> i32;
    }
    const WM_SETICON: u32 = 0x0080;
    const ICON_BIG: usize = 1;
    let Ok(handle) = window.hwnd() else { return };
    // SAFETY: `png` outlives the call, which copies it; the window handle is the live window's own.
    unsafe {
        let icon = CreateIconFromResourceEx(png.as_ptr(), png.len() as u32, 1, 0x0003_0000, 0, 0, 0);
        if icon.is_null() {
            return;
        }
        let previous = SendMessageW(handle.0 as *mut c_void, WM_SETICON, ICON_BIG, icon as isize);
        if previous != 0 {
            DestroyIcon(previous as *mut c_void);
        }
    }
}

/// macOS: the Dock shows the application's icon, not the window's.
#[cfg(target_os = "macos")]
fn set_dock_icon(app: &AppHandle, png: Vec<u8>) {
    let _ = app.run_on_main_thread(move || {
        use objc2::{AnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;
        let Some(main) = MainThreadMarker::new() else { return };
        let data = NSData::with_bytes(&png);
        if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
            #[allow(unused_unsafe)]
            unsafe {
                NSApplication::sharedApplication(main).setApplicationIconImage(Some(&image))
            };
        }
    });
}

fn apply(app: &AppHandle, icon: Option<Image<'static>>) {
    let Some(icon) = icon.or_else(|| app.default_window_icon().map(|i| i.clone().to_owned())) else { return };
    if let Some(tray) = app.tray_by_id(crate::tray::TRAY) {
        let _ = tray.set_icon(Some(icon.clone()));
    }
    #[cfg(any(windows, target_os = "macos"))]
    let file = png(&icon);
    if let Some(window) = crate::main_window(app) {
        #[cfg(windows)]
        if let Some(file) = &file {
            set_big_icon(&window, file);
        }
        let _ = window.set_icon(icon);
    }
    #[cfg(target_os = "macos")]
    if let Some(file) = file {
        set_dock_icon(app, file);
    }
}

/// Makes the window show the icon at `url` (or the app's own when `None`). Returns at once; the
/// download happens in the background and a server without a usable icon keeps the app's.
pub fn follow(app: &AppHandle, url: Option<String>) {
    {
        let mut current = CURRENT.lock().unwrap();
        if *current == url {
            return;
        }
        *current = url.clone();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let icon = url.as_deref().and_then(fetch).and_then(|bytes| decode(&bytes)).map(|(rgba, w, h)| Image::new_owned(rgba, w, h));
        // The server may have changed again while this one was downloading.
        if *CURRENT.lock().unwrap() == url {
            apply(&app, icon);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_an_icon_to_a_small_square_and_rejects_garbage() {
        let png = include_bytes!("../icons/128x128@2x.png");
        let (rgba, width, height) = decode(png).expect("the app's own icon decodes");
        assert_eq!((width, height), (128, 128));
        assert_eq!(rgba.len(), 128 * 128 * 4);
        assert!(decode(b"not an image").is_none());
        assert!(decode(&[]).is_none());
    }
}
