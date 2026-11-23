//! The app's own few strings (menu, native errors) in the system language. The interface itself is the
//! tenant's frontend, which carries its own translations. English is the fallback for any other language.

use std::sync::OnceLock;

pub fn language() -> &'static str {
    static LANG: OnceLock<String> = OnceLock::new();
    LANG.get_or_init(|| language_of(&sys_locale::get_locale().unwrap_or_default()))
}

/// "es-PE" / "es_ES.UTF-8" -> "es". Anything else the app has no strings for -> "en".
pub fn language_of(locale: &str) -> String {
    let code = locale.split(['-', '_', '.']).next().unwrap_or("").to_ascii_lowercase();
    if code == "es" { "es".into() } else { "en".into() }
}

/// Picks the string for the system language. Add a parameter here when a third language is added,
/// so the compiler points at every string that still needs it.
pub fn tr(es: &'static str, en: &'static str) -> &'static str {
    if language() == "es" { es } else { en }
}

#[cfg(test)]
mod tests {
    use super::language_of;

    #[test]
    fn spanish_in_any_region_and_english_for_everything_else() {
        for locale in ["es", "es-PE", "es_ES.UTF-8", "ES-mx"] {
            assert_eq!(language_of(locale), "es", "{locale}");
        }
        for locale in ["en-US", "pt-BR", "fr", "", "eo"] {
            assert_eq!(language_of(locale), "en", "{locale}");
        }
    }
}
