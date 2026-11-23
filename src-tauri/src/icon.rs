//! The window's icon (taskbar, dock, alt-tab) follows the server the app is connected to: the server's
//! own icon while on it, the app's when on the launcher. Desktop only.

use std::{io::Read, sync::Mutex, time::Duration};

use tauri::{image::Image, AppHandle, Manager};

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

fn apply(app: &AppHandle, icon: Option<Image<'static>>) {
    let Some(icon) = icon.or_else(|| app.default_window_icon().map(|i| i.clone().to_owned())) else { return };
    if let Some(window) = app.get_window("main") {
        let _ = window.set_icon(icon);
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
