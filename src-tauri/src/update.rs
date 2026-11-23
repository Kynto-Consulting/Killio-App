//! Updating the app from inside the app.
//!
//! Every published build carries a number (the CI run that built it). The release keeps a small
//! `latest.json` next to the installers: the newest build's number, what changed, and the SHA-256 of each
//! installer. The app compares that number with its own.
//!
//! The page can ask for a check or an install but chooses nothing: the address is fixed here, so a
//! server's page can only ever make the app install Killio App's own published build.
//!
//! Installing: on Windows the installer is downloaded, checked against the manifest's SHA-256, started,
//! and the app closes so it can be replaced. On the other systems the installer opens in the system's
//! browser and the person finishes there (a .dmg to drag, a package to install, an APK to accept).
//!
//! Trust: `latest.json` is signed in CI with Killio App's release key (ed25519) and the app carries the
//! public half. A manifest without a valid signature is ignored, so whoever can only alter the files of
//! the release cannot make the app install something else: the installer must match a SHA-256 that the
//! signed manifest lists. (This is the app's own check; the installers are still not code-signed for
//! Windows SmartScreen or macOS Gatekeeper, which needs certificates bought from Microsoft and Apple.)

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Webview};

use crate::{commands::require_trusted, config::Store, i18n::tr};

/// Public half of the release key. The private half lives only in the repository's CI secrets.
const RELEASE_KEY: &str = "d3477247ac2f68fa74a0ae863a487070aae65d3fb3848534112a0a625415abac";

/// Whether `signature` (base64) is the release key's signature of `message`.
pub fn signed_by_release_key(message: &[u8], signature: &str) -> bool {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        let Ok(value) = u8::from_str_radix(&RELEASE_KEY[i * 2..i * 2 + 2], 16) else { return false };
        *byte = value;
    }
    let Ok(key) = VerifyingKey::from_bytes(&key) else { return false };
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(signature.trim()) else { return false };
    let Ok(signature) = Signature::from_slice(&raw) else { return false };
    key.verify(message, &signature).is_ok()
}

const RELEASE: &str = "https://github.com/Kynto-Consulting/Killio-App/releases/download/app-latest/";
#[cfg(windows)]
const MAX_INSTALLER: u64 = 300 * 1024 * 1024;

/// This build's number; 0 for a build made outside CI (a developer's own).
pub fn current_build() -> u64 {
    option_env!("KILLIO_BUILD").and_then(|b| b.trim().parse().ok()).unwrap_or(0)
}

#[derive(Deserialize)]
struct Manifest {
    build: u64,
    #[serde(default)]
    commit: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    #[cfg_attr(not(windows), allow(dead_code))]
    sha256: std::collections::HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: u64,
    latest: u64,
    available: bool,
    commit: String,
    date: String,
    notes: Vec<String>,
    /// "install": the app replaces itself; "download": the installer opens in the browser.
    mode: &'static str,
}

/// The installer this copy of the app would use.
fn asset() -> &'static str {
    if cfg!(target_os = "windows") {
        "Killio-windows-setup.exe"
    } else if cfg!(target_os = "macos") {
        "Killio-macos.dmg"
    } else if cfg!(target_os = "android") {
        "Killio-android.apk"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "Killio-linux.AppImage"
    } else {
        "Killio-linux.deb"
    }
}

fn manifest() -> Result<Manifest, String> {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).redirects(5).build();
    let unreachable = || tr("No se pudo consultar la última versión.", "Could not check the latest version.").to_string();
    let text = agent.get(&format!("{RELEASE}latest.json")).call().map_err(|_| unreachable())?.into_string().map_err(|e| e.to_string())?;
    let signature = agent.get(&format!("{RELEASE}latest.json.sig")).call().map_err(|_| unreachable())?.into_string().map_err(|e| e.to_string())?;
    if !signed_by_release_key(text.as_bytes(), &signature) {
        return Err(tr("La última versión publicada no está firmada por Killio; se ignora.", "The latest published version is not signed by Killio; it is ignored.").into());
    }
    serde_json::from_str(&text).map_err(|_| tr("La información de la última versión no es válida.", "The latest version's information is not valid.").to_string())
}

pub fn is_newer(latest: u64, current: u64) -> bool {
    latest > current
}

#[tauri::command]
pub async fn update_check(window: Webview, store: State<'_, Store>) -> Result<UpdateInfo, String> {
    require_trusted(&window, &store)?;
    tauri::async_runtime::spawn_blocking(|| {
        let latest = manifest()?;
        let current = current_build();
        Ok(UpdateInfo {
            current,
            latest: latest.build,
            available: is_newer(latest.build, current),
            commit: latest.commit.chars().filter(char::is_ascii_hexdigit).take(40).collect(),
            date: latest.date.chars().take(40).collect(),
            notes: latest.notes.into_iter().take(30).map(|n| n.chars().take(200).collect()).collect(),
            mode: if cfg!(windows) { "install" } else { "download" },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn download_and_start(app: &AppHandle) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    let latest = manifest()?;
    let expected = latest.sha256.get(asset()).cloned().ok_or_else(|| tr("Esta versión no trae instalador para este sistema.", "This version has no installer for this system.").to_string())?;
    let failed = || tr("No se pudo descargar la actualización.", "Could not download the update.").to_string();

    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(15)).redirects(5).build();
    let response = agent.get(&format!("{RELEASE}{}", asset())).call().map_err(|_| failed())?;
    let dir = std::env::temp_dir().join("killio-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("Killio-setup-{}.exe", latest.build));
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut reader = response.into_reader().take(MAX_INSTALLER + 1);
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buffer).map_err(|_| failed())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hash.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
    }
    drop(file);
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if total > MAX_INSTALLER || !got.eq_ignore_ascii_case(expected.trim()) {
        let _ = std::fs::remove_file(&path);
        return Err(tr("La descarga no coincide con la versión publicada; no se instaló nada.", "The download does not match the published version; nothing was installed.").into());
    }
    // The installer takes over: it needs this program closed to replace it.
    std::process::Command::new(&path).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// Installs the newest published build (Windows) or opens its installer in the browser (elsewhere).
#[tauri::command]
pub async fn update_install(app: AppHandle, window: Webview, store: State<'_, Store>) -> Result<(), String> {
    require_trusted(&window, &store)?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || download_and_start(&app)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(format!("{RELEASE}{}", asset()), None::<&str>).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{asset, is_newer, signed_by_release_key, Manifest};

    #[test]
    fn only_the_release_key_signs_a_manifest() {
        let signature = "x0QZ+FfcIi8NnXWhroRBEgjeKqi3ZZ78ZMxkPKs3I9S8kXtnjSjw1mmb2N83m/g/0EGcSq7dDVuHMs/oW63sAw==";
        assert!(signed_by_release_key(b"killio-test", signature));
        assert!(!signed_by_release_key(b"killio-tesT", signature), "another message");
        assert!(!signed_by_release_key(b"killio-test", &signature.replace("x0QZ", "x0QA")), "another signature");
        assert!(!signed_by_release_key(b"killio-test", ""));
        assert!(!signed_by_release_key(b"killio-test", "not base64 !!"));
    }

    #[test]
    fn only_a_higher_build_number_is_an_update() {
        assert!(is_newer(12, 11));
        assert!(!is_newer(12, 12));
        assert!(!is_newer(11, 12));
        // A developer's own build (0) is older than anything published.
        assert!(is_newer(1, 0));
    }

    #[test]
    fn reads_the_manifest_and_tolerates_missing_parts() {
        let full: Manifest = serde_json::from_str(r#"{"build":7,"commit":"abc","date":"2026-01-01","notes":["a","b"],"sha256":{"Killio-windows-setup.exe":"00"}}"#).unwrap();
        assert_eq!((full.build, full.notes.len(), full.sha256.len()), (7, 2, 1));
        let bare: Manifest = serde_json::from_str(r#"{"build":3}"#).unwrap();
        assert_eq!((bare.build, bare.notes.len()), (3, 0));
        assert!(serde_json::from_str::<Manifest>(r#"{"notes":[]}"#).is_err());
        assert!(asset().starts_with("Killio-"));
    }
}
