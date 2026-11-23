//! `killio://` links: how something outside the app hands control back to it.
//!
//! The one link today is the end of a sign-in with Google, Microsoft or Bloomx. The app opens the provider
//! in the person's own browser (where they are already signed in), and when the browser comes back to the
//! server's page that page answers with `killio://auth/social?code=…&server=…`. The app then finishes the
//! sign-in on the server's own page, inside the window, where the secret that started it is kept.
//!
//! The link carries only a one-time code that is useless without that secret, and it is honoured only for
//! the server the app is connected to, so a link from anywhere else cannot move the window to another site.

use url::Url;

use crate::config::same_origin;

/// Where to take the window for a `killio://` link, or `None` when the link is not one the app accepts.
pub fn destination(link: &str, current_tenant: Option<&str>) -> Option<Url> {
    let link = Url::parse(link).ok()?;
    if link.scheme() != "killio" || link.host_str() != Some("auth") || link.path().trim_end_matches('/') != "/social" {
        return None;
    }
    let param = |name: &str| link.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let code = param("code")?;
    let plain = !code.is_empty() && code.len() <= 512 && code.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c));
    if !plain {
        return None;
    }
    let tenant = Url::parse(current_tenant?).ok()?;
    let server = Url::parse(&param("server")?).ok()?;
    if !same_origin(&tenant, &server) {
        return None;
    }
    let mut target = tenant.join("login/social").ok()?;
    target.query_pairs_mut().append_pair("code", &code);
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::destination;

    const TENANT: Option<&str> = Some("https://www.killio.dev/");

    #[test]
    fn a_sign_in_link_for_the_connected_server_goes_to_its_callback_page() {
        let to = destination("killio://auth/social?code=abc-DEF_123.~&server=https%3A%2F%2Fwww.killio.dev", TENANT).unwrap();
        assert_eq!(to.as_str(), "https://www.killio.dev/login/social?code=abc-DEF_123.%7E");
    }

    #[test]
    fn links_for_another_server_or_with_no_server_are_ignored() {
        assert!(destination("killio://auth/social?code=abc&server=https%3A%2F%2Fevil.example.com", TENANT).is_none());
        assert!(destination("killio://auth/social?code=abc", TENANT).is_none());
        assert!(destination("killio://auth/social?code=abc&server=https%3A%2F%2Fwww.killio.dev", None).is_none());
        // Same site over plain http is another origin.
        assert!(destination("killio://auth/social?code=abc&server=http%3A%2F%2Fwww.killio.dev", TENANT).is_none());
    }

    #[test]
    fn anything_that_is_not_the_sign_in_link_is_ignored() {
        for link in [
            "killio://open?url=https://evil.example.com",
            "killio://auth/other?code=abc&server=https%3A%2F%2Fwww.killio.dev",
            "https://auth/social?code=abc&server=https%3A%2F%2Fwww.killio.dev",
            "killio://auth/social?server=https%3A%2F%2Fwww.killio.dev",
            "killio://auth/social?code=&server=https%3A%2F%2Fwww.killio.dev",
            "not a link",
        ] {
            assert!(destination(link, TENANT).is_none(), "{link}");
        }
    }

    #[test]
    fn the_code_cannot_carry_another_address_or_parameters() {
        for code in ["a%26returnTo%3D%2F%2Fevil", "a%23frag", "a%2F..%2F..%2Fadmin", "a%20b", "%3Cscript%3E"] {
            let link = format!("killio://auth/social?code={code}&server=https%3A%2F%2Fwww.killio.dev");
            assert!(destination(&link, TENANT).is_none(), "{code}");
        }
    }
}
