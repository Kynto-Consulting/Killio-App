use std::{fs, path::PathBuf, sync::Mutex};

use crate::i18n::tr;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

pub const DEFAULT_TENANT_URL: &str = "https://killio.dev/";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Tenant {
    pub name: String,
    pub url: String,
}

/// A signed-in account as the tenant's frontend reported it. Profile only: tokens never leave the
/// tenant's own page, so this index can list accounts across tenants without holding any secret.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Origin of the tenant the account belongs to. Set by the app, never taken from the page.
    #[serde(default)]
    pub tenant: String,
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

pub const MAX_ACCOUNTS_PER_TENANT: usize = 20;

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().filter(|c| !c.is_control()).take(max).collect()
}

/// What a page reported, cleaned up and stamped with the tenant it really came from.
pub fn sanitize_accounts(tenant: &str, reported: Vec<Account>) -> Vec<Account> {
    let mut seen = std::collections::HashSet::new();
    reported
        .into_iter()
        .filter_map(|a| {
            let id = clip(&a.id, 80);
            if id.is_empty() || !seen.insert(id.clone()) {
                return None;
            }
            Some(Account {
                tenant: tenant.to_string(),
                id,
                name: clip(&a.name, 120),
                email: clip(&a.email, 200),
                avatar_url: a.avatar_url.map(|u| clip(&u, 500)).filter(|u| u.starts_with("https://")),
            })
        })
        .take(MAX_ACCOUNTS_PER_TENANT)
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub tenants: Vec<Tenant>,
    /// URL of the tenant opened last; the app goes straight to it on start.
    pub current: Option<String>,
    /// Accounts signed in on any tenant, for the cross-tenant account switcher.
    #[serde(default)]
    pub accounts: Vec<Account>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tenants: vec![Tenant { name: "Killio".into(), url: DEFAULT_TENANT_URL.into() }],
            current: None,
            accounts: Vec::new(),
        }
    }
}

#[derive(Default)]
pub struct Store {
    pub config: Mutex<Config>,
    path: Mutex<Option<PathBuf>>,
    /// Where the launcher lives (differs per platform), captured at start.
    pub launcher_url: Mutex<Option<Url>>,
}

impl Store {
    pub fn load(&self, app: &AppHandle) {
        let Ok(dir) = app.path().app_config_dir() else { return };
        let path = dir.join("config.json");
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<Config>(&raw) {
                *self.config.lock().unwrap() = config;
            }
        }
        *self.path.lock().unwrap() = Some(path);
    }

    pub fn save(&self) {
        let Some(path) = self.path.lock().unwrap().clone() else { return };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(raw) = serde_json::to_string_pretty(&*self.config.lock().unwrap()) {
            let _ = fs::write(path, raw);
        }
    }

    pub fn snapshot(&self) -> Config {
        self.config.lock().unwrap().clone()
    }
}

fn is_local_host(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

/// "killio.dev" -> "https://killio.dev/". Only the origin is kept. Plain http is
/// accepted for a local development server and nothing else.
pub fn normalize_tenant_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(tr("Escribe la URL del servidor.", "Type the server URL.").into());
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let parsed = Url::parse(&with_scheme).map_err(|_| tr("La URL no es válida.", "The URL is not valid.").to_string())?;
    let host = parsed.host_str().ok_or_else(|| tr("La URL no tiene dominio.", "The URL has no host.").to_string())?;
    match parsed.scheme() {
        "https" => {}
        "http" if is_local_host(host) => {}
        "http" => return Err(tr("Usa https:// (http solo se permite en localhost).", "Use https:// (http is only allowed on localhost).").into()),
        _ => return Err(tr("La URL debe empezar con https://", "The URL must start with https://").into()),
    }
    let mut origin = parsed.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    let _ = origin.set_username("");
    let _ = origin.set_password(None);
    Ok(origin)
}

pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_https_and_keeps_only_the_origin() {
        assert_eq!(normalize_tenant_url("killio.dev").unwrap().as_str(), "https://killio.dev/");
        assert_eq!(normalize_tenant_url(" https://a.example.com/login?x=1#y ").unwrap().as_str(), "https://a.example.com/");
        assert_eq!(normalize_tenant_url("https://user:pw@a.example.com").unwrap().as_str(), "https://a.example.com/");
    }

    #[test]
    fn http_only_for_local_development() {
        assert_eq!(normalize_tenant_url("http://localhost:3000").unwrap().as_str(), "http://localhost:3000/");
        assert!(normalize_tenant_url("http://a.example.com").is_err());
        assert!(normalize_tenant_url("file:///c:/x").is_err());
        assert!(normalize_tenant_url("javascript://x").is_err());
        assert!(normalize_tenant_url("   ").is_err());
    }

    #[test]
    fn reported_accounts_are_stamped_with_the_real_tenant_and_cleaned() {
        let account = |id: &str, tenant: &str, avatar: Option<&str>| Account {
            tenant: tenant.into(),
            id: id.into(),
            name: "  Ana\n".into(),
            email: "ana@example.com".into(),
            avatar_url: avatar.map(Into::into),
        };
        let out = sanitize_accounts(
            "https://a.example.com/",
            vec![
                account("u1", "https://evil.example.com/", Some("https://cdn.example.com/a.png")),
                account("u1", "", None),          // duplicate id
                account("  ", "", None),          // no id
                account("u2", "", Some("javascript:alert(1)")),
            ],
        );
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|a| a.tenant == "https://a.example.com/"));
        assert_eq!(out[0].name, "Ana");
        assert_eq!(out[0].avatar_url.as_deref(), Some("https://cdn.example.com/a.png"));
        assert_eq!(out[1].avatar_url, None);

        let many = (0..50).map(|i| account(&format!("u{i}"), "", None)).collect();
        assert_eq!(sanitize_accounts("https://a.example.com/", many).len(), MAX_ACCOUNTS_PER_TENANT);
    }

    #[test]
    fn a_config_saved_before_accounts_existed_still_loads() {
        let old = r#"{"tenants":[{"name":"Killio","url":"https://killio.dev/"}],"current":null}"#;
        assert!(serde_json::from_str::<Config>(old).unwrap().accounts.is_empty());
    }

    #[test]
    fn origin_comparison_ignores_path_but_not_host_or_port() {
        let a = Url::parse("https://killio.dev/b/1").unwrap();
        assert!(same_origin(&a, &Url::parse("https://killio.dev:443/").unwrap()));
        assert!(!same_origin(&a, &Url::parse("https://evil.killio.dev/").unwrap()));
        assert!(!same_origin(&a, &Url::parse("http://killio.dev/").unwrap()));
        assert!(!same_origin(&a, &Url::parse("https://killio.dev:8443/").unwrap()));
    }
}
