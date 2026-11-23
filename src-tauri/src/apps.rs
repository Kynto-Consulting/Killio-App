// The module compiles everywhere so the commands keep one signature; only desktops call into it.
#![cfg_attr(not(desktop), allow(dead_code))]
//! Installed applications on a desktop: what the agent's `list_installed_apps`, `search_app` and
//! `open_installed_app` tools work with. Each system keeps its launchable apps in a different place:
//!   Windows  Start Menu shortcuts (.lnk), for all users and for this user
//!   macOS    .app bundles in the Applications folders
//!   Linux    .desktop entries (freedesktop.org)
//! An app is identified by the path found here; opening is only allowed for a path a fresh scan returns,
//! so a page can never use this to open an arbitrary file.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct InstalledApp {
    pub label: String,
    /// Opaque id to pass back to `open_installed_app` (the tool's schema calls it "package").
    pub package: String,
}

const MAX_DEPTH: usize = 4;
const MAX_APPS: usize = 600;

fn walk(dir: &Path, depth: usize, visit: &mut dyn FnMut(&Path) -> bool) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // `visit` returns true when it took the entry (so a macOS .app folder is not descended into).
        if !visit(&path) && path.is_dir() {
            walk(&path, depth + 1, visit);
        }
    }
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

fn stem(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().trim().to_string()
}

/// Uninstallers, help files and the like live next to the real shortcut; they are noise in an app list.
fn is_noise(label: &str) -> bool {
    let lower = label.to_lowercase();
    ["uninstall", "desinstalar", "readme", "release notes", "license", "documentation", "help", "website"].iter().any(|w| lower.contains(w))
}

/// `Name=` of the `[Desktop Entry]` section, unless the entry is hidden from menus.
pub fn desktop_entry_name(contents: &str) -> Option<String> {
    let mut in_entry = false;
    let mut name = None;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if line == "NoDisplay=true" || line == "Hidden=true" || line == "Type=Link" || line == "Type=Directory" {
            return None;
        }
        if name.is_none() {
            if let Some(value) = line.strip_prefix("Name=") {
                name = Some(value.trim().to_string());
            }
        }
    }
    name.filter(|n| !n.is_empty())
}

fn roots() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let env = |key: &str| std::env::var_os(key).map(PathBuf::from);
    if cfg!(target_os = "windows") {
        if let Some(d) = env("ProgramData") { dirs.push(d.join("Microsoft/Windows/Start Menu/Programs")); }
        if let Some(d) = env("APPDATA") { dirs.push(d.join("Microsoft/Windows/Start Menu/Programs")); }
    } else if cfg!(target_os = "macos") {
        dirs.push("/Applications".into());
        dirs.push("/System/Applications".into());
        if let Some(home) = env("HOME") { dirs.push(home.join("Applications")); }
    } else {
        dirs.push("/usr/share/applications".into());
        dirs.push("/usr/local/share/applications".into());
        dirs.push("/var/lib/flatpak/exports/share/applications".into());
        dirs.push("/var/lib/snapd/desktop/applications".into());
        if let Some(home) = env("HOME") {
            dirs.push(home.join(".local/share/applications"));
            dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
        }
    }
    dirs
}

/// Every launchable app, one per name, sorted by name.
pub fn list() -> Vec<InstalledApp> {
    // Keyed by lower-case label: the same app is often in both the all-users and the per-user folder.
    let mut found: BTreeMap<String, InstalledApp> = BTreeMap::new();
    for root in roots() {
        walk(&root, 0, &mut |path| {
            let label = if cfg!(target_os = "windows") {
                if !has_extension(path, "lnk") { return false; }
                stem(path)
            } else if cfg!(target_os = "macos") {
                if !has_extension(path, "app") { return false; }
                stem(path)
            } else {
                if !has_extension(path, "desktop") { return false; }
                match fs::read_to_string(path).ok().and_then(|c| desktop_entry_name(&c)) {
                    Some(name) => name,
                    None => return true,
                }
            };
            if !label.is_empty() && !is_noise(&label) && found.len() < MAX_APPS {
                found.entry(label.to_lowercase()).or_insert(InstalledApp { label, package: path.to_string_lossy().into_owned() });
            }
            true
        });
    }
    found.into_values().collect()
}

/// The path to open for `package`, only if a scan right now still lists it.
pub fn resolve(package: &str) -> Option<PathBuf> {
    list().into_iter().find(|app| app.package == package).map(|app| PathBuf::from(app.package))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_name_of_a_desktop_entry_and_skips_hidden_ones() {
        assert_eq!(desktop_entry_name("[Desktop Entry]\nType=Application\nName=Files\nName[es]=Archivos\nExec=nautilus\n").as_deref(), Some("Files"));
        assert_eq!(desktop_entry_name("[Desktop Entry]\nName=Hidden\nNoDisplay=true\n"), None);
        assert_eq!(desktop_entry_name("[Desktop Action New]\nName=New Window\n"), None);
        assert_eq!(desktop_entry_name("[Desktop Entry]\nName=App\n[Desktop Action x]\nName=Other\nNoDisplay=true\n").as_deref(), Some("App"));
        assert_eq!(desktop_entry_name(""), None);
    }

    #[test]
    fn uninstallers_and_help_files_are_not_apps() {
        assert!(is_noise("Uninstall Foo"));
        assert!(is_noise("Foo Help"));
        assert!(!is_noise("Spotify"));
    }

    #[test]
    fn only_listed_apps_can_be_resolved() {
        assert_eq!(resolve("C:/Windows/System32/cmd.exe"), None);
        assert_eq!(resolve("/bin/sh"), None);
        assert_eq!(resolve(""), None);
    }
}
