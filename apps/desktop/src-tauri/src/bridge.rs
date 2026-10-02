//! The bridge: the six commands the app page may call, the runtime capability
//! that decides WHO may call them, and the in-command guard that is the second
//! layer behind it.
//!
//! # The ACL is the boundary (plan D5, revised 2026-09-22)
//!
//! The shell navigates one webview across origins on purpose. Signing in walks
//! through an identity provider's pages, Cloudflare Access's page, or Hermie
//! Web's own OIDC issuer, and every one of those is a page the shell loaded. So
//! "which page is asking" is a question that has to be answered per call, and
//! only one component in Tauri can answer it honestly:
//!
//! - `RuntimeAuthority::resolve_access` runs *before* the command and matches
//!   `InvokeRequest.url`, which is the **calling frame's** URL — read from the
//!   IPC request's `Origin` header on the fetch path and from wry's
//!   message-source URI on the `postMessage` fallback, neither of which page
//!   script can set.
//! - A command only ever sees `webview.url()`, which is the **top frame**. That
//!   is a different question, and the answers come apart in two ways that
//!   matter: a cross-origin iframe on Windows (wry's WebView2 backend runs init
//!   scripts in every frame), and a page that fires calls and then navigates the
//!   window to a configured origin so the in-flight calls land after the
//!   navigation commits.
//!
//! Therefore there is **no static capability for remote origins**. For every
//! entry in the gateway list the shell registers one runtime capability
//! `remote-app:<id>` — [`grant`] — whose `remote` pattern is exactly that
//! entry's normalised origin and whose permissions are exactly
//! [`REMOTE_PERMISSIONS`]. A page on an origin nobody configured therefore
//! cannot reach a `hermie_*` command, and cannot call `plugin:event|listen`
//! either, so it holds no listener and receives no event — not the shell's four
//! and not Tauri's own window events.
//!
//! A capability cannot be withdrawn, which is why forgetting a gateway restarts
//! the shell (Task 3 owns `gateways::forget`; the invariant it keeps is "the set
//! of granted origins equals the stored list at every moment a page can run").
//!
//! # The guard is the second layer, and it can only refuse
//!
//! [`guard`] runs inside every command and makes two checks:
//!
//! 1. the **top frame** must be on a configured origin — this is what refuses
//!    the reverse framing shape, a configured Hermie Web embedded inside an
//!    unconfigured top page;
//! 2. if the request carries an `Origin` header, it must name a configured
//!    origin too.
//!
//! The header may only ever *refuse*. On the fetch path it is browser-set and
//! script-proof (`Origin` is a forbidden header name), but on the `postMessage`
//! fallback — which Tauri takes whenever the fetch to the `ipc` scheme fails,
//! for instance under a page CSP whose `connect-src` blocks it — the headers are
//! whatever the page put in `invoke`'s options, and a command cannot tell which
//! path a request took. A forged header can make the forger's own call stricter,
//! never looser. What the guard gives up is proving the calling frame; that
//! proof is the ACL's, which is why [`grant`] is not optional.
//!
//! # The shape of an answer
//!
//! A command that runs answers `{ ok: true, … }` or `{ ok: false, reason }` and
//! never rejects. An `invoke` the ACL refused *does* reject, with Tauri's own
//! error — and the app-side facade
//! (`expo/hermie/src/platform/desktop-shell.ts`) already treats a rejection and
//! an `{ ok: false }` alike, as "no". A refusal is a fact about the caller, not
//! an error the caller can do anything about.

use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::utils::acl::RemoteUrlPattern;
use tauri::{Manager, Runtime, Url, Webview};

use crate::gateways::{GatewayEntry, GatewayState};

/// The window a granted capability is scoped to. The shell has exactly one.
const MAIN_WINDOW: &str = "main";

/// The whole permission surface a configured Hermie Web origin gets, and the
/// only place it is written down.
///
/// Six bridge commands and the two event commands. Nothing else: no
/// `core:window`, no `core:webview`, no `core:path`, no `opener`, no `fs`, no
/// `dialog`, no `notification` — the shell's own `hermie_notify` wraps the
/// notification plugin so the page never holds it.
///
/// `core:event:allow-listen` cannot be scoped to event names, so a configured
/// app page can also listen to Tauri's own window events (`tauri://focus`,
/// `tauri://resize`, …). That is accepted and documented: it is the app, and
/// none of those payloads carries anything the app does not already know.
pub const REMOTE_PERMISSIONS: [&str; 8] = [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-hermie-shell-info",
    "allow-hermie-set-menu",
    "allow-hermie-notify",
    "allow-hermie-set-badge",
    "allow-hermie-open-gateways",
    "allow-hermie-close-handled",
];

/// The bridge contract's version, reported as `bridge` by `hermie_shell_info`.
///
/// The app keys its behaviour on this, not on the shell's release version: an
/// incompatible change bumps it and the app keeps the old path for one release
/// (the same rule the Swift module follows for "an older binary under a newer
/// bundle").
pub const BRIDGE_VERSION: u32 = 1;

/// The events the shell emits to the app page. Only through
/// `crate::emit_to_app`, which checks the origin first.
///
/// Written down here in Task 2 because they are half of the bridge contract the
/// app-side facade is built against; Tasks 5 and 6 are what emit them.
#[allow(dead_code)]
pub mod events {
    /// A menu accelerator resolved to one of the page's own `SHORTCUTS` rows.
    pub const SHORTCUT: &str = "hermie://shortcut";
    /// A `hermie://…` deep link, from the OS or from a notification click.
    pub const LINK: &str = "hermie://link";
    /// The active gateway changed; sent before the navigation.
    pub const GATEWAY: &str = "hermie://gateway";
    /// The window regained focus.
    pub const FOCUS: &str = "hermie://focus";
}

/// Which desktop the shell is running on, in the marker's own spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

impl Platform {
    /// The platform this binary was built for.
    ///
    /// Anything that is neither macOS nor Windows answers `Linux`, because what
    /// the app does with this is pick the `command` modifier (⌘ on macOS, Ctrl
    /// elsewhere) and draw platform-appropriate copy. A FreeBSD build running
    /// WebKitGTK wants every answer the Linux build gets, and "unknown" would
    /// only give the app a fourth case to get wrong.
    pub fn current() -> Self {
        match std::env::consts::OS {
            "macos" => Self::Macos,
            "windows" => Self::Windows,
            _ => Self::Linux,
        }
    }
}

/// Why a command refused. One variant today; later tasks add their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    /// The calling webview is not on a configured Hermie Web origin.
    Origin,
}

/// `{ ok: false, reason }` — the only failure shape the page ever sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Refusal {
    ok: bool,
    reason: Reason,
}

impl Refusal {
    fn new(reason: Reason) -> Self {
        Self { ok: false, reason }
    }
}

/// `{ ok: true }` — what a command with nothing to report answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Ack {
    ok: bool,
}

impl Ack {
    fn new() -> Self {
        Self { ok: true }
    }
}

/// `{ ok: true, … }` or `{ ok: false, reason }`, flattened into one JSON object
/// either way so the page reads `ok` first and nothing else until it is true.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Reply<T> {
    Accepted(T),
    Refused(Refusal),
}

impl<T> Reply<T> {
    fn refused(reason: Reason) -> Self {
        Self::Refused(Refusal::new(reason))
    }
}

/// `hermie_shell_info`'s answer: everything the app needs to know that it is in
/// the shell and which gateway the shell believes it is showing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    ok: bool,
    /// The shell's own version — `apps/desktop`'s, which `set-version.mjs`
    /// keeps equal to the app's. Not the version of the page, which is Hermie
    /// Web's business and may legitimately differ.
    version: &'static str,
    platform: Platform,
    bridge: u32,
    /// `None` when no gateway is configured, which in Task 2 means
    /// `HERMIE_WEB_URL` was not set — the guard has then already refused, so
    /// the page never sees this.
    gateway_id: Option<String>,
    gateway_name: Option<String>,
}

/// The titles the page's own strings supply for the native menu.
///
/// Deserialized here rather than passed through as opaque JSON so the contract
/// is checked at the boundary: a page that sends the wrong shape is refused by
/// Tauri's own argument deserialization before any menu is rebuilt. Mirrors
/// `MenuBarTitles` in `expo/hermie/src/platform/desktop-shortcuts.shared.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarTitles {
    pub chats: String,
    pub search: String,
    pub settings: String,
    pub close: String,
    pub new_conversation: String,
    pub toggle_sidebar: String,
}

/// One OS notification the page asks for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// The transcript event id, so the shell can drop a repeat.
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    /// A `hermie://…` URL to emit back when the notification is clicked. Parsed
    /// as a URL before it is used (Task 5); never executed.
    pub link: Option<String>,
}

/// An origin as the guard compares them: `scheme://host:port`.
///
/// `None` for anything that is not http(s), which is deliberate and is what
/// refuses `about:blank`, `data:` documents, `file://`, and the shell's own
/// local pages on `tauri://localhost` — none of those is a configured Hermie
/// Web, and the shell's pages have their own capability rather than borrowing
/// the app's.
///
/// Normalisation, all of it needed for the comparison to mean what it says:
///
/// - the scheme is lowercased (`HTTPS://…` is the same origin as `https://…`);
/// - the host is lowercased, because DNS is case-insensitive and
///   `HERMES.example.com` is the same machine;
/// - the port is always explicit, so a configured `https://host` and a webview
///   on `https://host:443` match — the `url` crate drops a default port, which
///   would otherwise make those two different strings.
pub fn origin_of(url: &Url) -> Option<String> {
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }

    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default()?;

    Some(format!("{scheme}://{host}:{port}"))
}

/// May a page on `current` use the bridge?
///
/// Origin only: scheme, host and port. A configured entry may carry a path
/// prefix (`https://host/hermie`) and the app navigates within it, so comparing
/// paths would refuse the app on its second screen. Cookies, storage and the
/// same-origin policy are all drawn at the origin too, so this is the same line
/// the browser already draws around the session — nothing narrower would be
/// enforceable and nothing wider would be honest.
///
/// An empty list refuses everything. That is the state of a shell with no
/// configured Hermie Web, and "no" is the only safe answer there.
pub fn origin_allowed(current: &Url, configured: &[Url]) -> bool {
    let Some(origin) = origin_of(current) else {
        return false;
    };

    configured
        .iter()
        .filter_map(origin_of)
        .any(|allowed| allowed == origin)
}

/// The capability pattern for one configured entry: its origin, and nothing
/// else.
///
/// A `RemoteUrlPattern` is a URLPattern constructor string, not a URL, so the
/// spelling is load-bearing in two places:
///
/// - **the port is written only when it is not the scheme's default.** A
///   URLPattern with no port component matches the default port only, and a
///   `Url` drops a default port when it parses, so `https://host` is the
///   pattern that matches both `https://host/` and `https://host:443/` while
///   `https://host:443` matches neither (the URL it is tested against never
///   carries the `:443` back).
/// - **no path component.** `RemoteUrlPattern`'s parser rewrites an empty or
///   `/` pathname to `*`, so the pattern covers every page of the entry —
///   which is what an origin means, and what the reader configured.
///
/// `None` for anything that is not an http(s) URL with a host. Everything that
/// reaches here has been through [`crate::gateways::validate`], which also
/// refuses the host shapes a pattern could not carry honestly.
pub fn origin_pattern(url: &Url) -> Option<String> {
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }

    // `Url::host_str` keeps an IPv6 host's brackets, which is what the pattern
    // wants: URLPattern's hostname component is compared against the URL's
    // serialised host, brackets and all. The colons inside them have to be
    // escaped, though — in a URLPattern constructor string a bare `:` opens a
    // named group, and `http://[::1]:9120` is a tokenizer error rather than a
    // loopback address (verified against urlpattern 0.3.0).
    let host = escape_ipv6(&url.host_str()?.to_ascii_lowercase());

    Some(match url.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

/// `[::1]` → `[\:\:1]`, and anything else unchanged.
///
/// Only the bracketed IPv6 form can contain a colon: [`crate::gateways::validate`]
/// refuses every other host character that URLPattern would read as syntax, so
/// this is the one escape the pattern needs.
fn escape_ipv6(host: &str) -> String {
    if host.starts_with('[') {
        host.replace(':', "\\:")
    } else {
        host.to_string()
    }
}

/// Grant one configured gateway the bridge, and only that gateway.
///
/// One capability per entry, identified `remote-app:<id>`, `local(false)` so it
/// can never reach the shell's own pages, scoped to the one window, matching
/// exactly that entry's origin, carrying exactly [`REMOTE_PERMISSIONS`].
///
/// Called from `setup()` for every entry the list holds at launch — before the
/// window is navigated anywhere, so the first page load already has its grant —
/// and from `gateways::add` for a new entry (Task 3), after it is validated and
/// stored. Every entry is granted, not only the active one: switching is a
/// navigation, and a call from the page that was live a moment ago is still the
/// app's.
///
/// The pattern is parsed as a `RemoteUrlPattern` here first. `add_capability`
/// parses it internally and unwraps, so a pattern that does not parse would
/// panic — at a reader's launch, with their address in the message. Refusing it
/// as an error instead means the worst case is one gateway that does not work.
///
/// [`crate::gateways::validate`] runs again here too, even though every caller
/// today (`setup()`, and Task 3's `gateways::add`) has already run it. This
/// function is the one place a bad entry becomes a granted capability, so it is
/// the one place the invariant has to hold on its own rather than be inherited
/// from whoever calls it — a later caller that forgets to validate first must
/// still fail closed, not grant.
pub fn grant<R: Runtime>(app: &impl Manager<R>, entry: &GatewayEntry) -> tauri::Result<()> {
    crate::gateways::validate(entry.url.as_str())
        .map_err(|invalid| tauri::Error::InvalidWebviewUrl(invalid.message()))?;

    let Some(pattern) = origin_pattern(&entry.url) else {
        return Err(tauri::Error::InvalidWebviewUrl(
            "a gateway URL with no http(s) origin cannot be granted the bridge",
        ));
    };

    if pattern.parse::<RemoteUrlPattern>().is_err() {
        return Err(tauri::Error::InvalidWebviewUrl(
            "this gateway's origin is not a URL pattern the ACL can carry",
        ));
    }

    let capability = REMOTE_PERMISSIONS.iter().fold(
        CapabilityBuilder::new(format!("remote-app:{}", entry.id))
            .local(false)
            .window(MAIN_WINDOW)
            .remote(pattern),
        |capability, permission| capability.permission(*permission),
    );

    app.add_capability(capability)
}

/// The second layer, inside every command. See the module documentation for why
/// it is the second and not the first.
///
/// 1. the top frame must be on a configured origin;
/// 2. an `Origin` header, if the request carries one, must name a configured
///    origin too — a header that is absent is fine, a header that is present
///    and does not parse is not.
///
/// A webview whose URL cannot be read is refused: the guard's failure direction
/// is always "no".
pub fn guard<R: Runtime>(webview: &Webview<R>, request: &tauri::ipc::Request<'_>) -> bool {
    let configured = webview.state::<GatewayState>().urls();

    let Ok(top_frame) = webview.url() else {
        return false;
    };

    if !origin_allowed(&top_frame, &configured) {
        return false;
    }

    match request.headers().get("Origin") {
        None => true,
        Some(header) => header
            .to_str()
            .ok()
            .and_then(|raw| Url::parse(raw).ok())
            .is_some_and(|origin| origin_allowed(&origin, &configured)),
    }
}

/// Run `accepted` only if the call passes the guard.
///
/// Every command goes through here, which is the point: a command that forgets
/// the guard is a command that does not compile into this shape.
fn guarded<R, T>(
    webview: &Webview<R>,
    request: &tauri::ipc::Request<'_>,
    accepted: impl FnOnce() -> T,
) -> Reply<T>
where
    R: Runtime,
{
    if guard(webview, request) {
        Reply::Accepted(accepted())
    } else {
        Reply::refused(Reason::Origin)
    }
}

/// `{ version, platform, bridge, gatewayId, gatewayName }`.
///
/// The app's whole feature detection: a reply means the bridge is there, is
/// reachable from this page, and speaks version `bridge`.
#[tauri::command]
pub fn hermie_shell_info<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Reply<ShellInfo> {
    guarded(&webview, &request, || {
        // Read inside the closure, not before it: a refused caller learns
        // nothing about the gateway list, not even by timing.
        let gateway = webview
            .state::<GatewayState>()
            .read(|list| {
                list.active()
                    .map(|entry| (entry.id.clone(), entry.name.clone()))
            })
            .flatten();

        let (gateway_id, gateway_name) = match gateway {
            Some((id, name)) => (Some(id), Some(name)),
            None => (None, None),
        };

        ShellInfo {
            ok: true,
            version: env!("CARGO_PKG_VERSION"),
            platform: Platform::current(),
            bridge: BRIDGE_VERSION,
            gateway_id,
            gateway_name,
        }
    })
}

/// Rebuild the native Chats menu from the page's own titles and chat list.
///
/// Stubbed in Task 2: the contract exists, the guard runs, and Task 6 builds
/// the menu. Accepting and doing nothing is the right stub — the app already
/// treats `setMenuBar` as something that may reach nothing (it does on a phone),
/// so a shell that answers `ok` and draws no menu is a state the app handles.
#[tauri::command]
pub fn hermie_set_menu<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
    titles: MenuBarTitles,
    chats: Vec<String>,
) -> Reply<Ack> {
    let _ = (titles, chats);
    guarded(&webview, &request, Ack::new)
}

/// Raise an OS notification. Stubbed in Task 2; Task 5 wires the plugin.
#[tauri::command]
pub fn hermie_notify<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
    notification: Notification,
) -> Reply<Ack> {
    let _ = notification;
    guarded(&webview, &request, Ack::new)
}

/// Set the dock badge / taskbar overlay / tray tooltip. Stubbed; Task 5.
#[tauri::command]
pub fn hermie_set_badge<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
    count: Option<u32>,
) -> Reply<Ack> {
    let _ = count;
    guarded(&webview, &request, Ack::new)
}

/// Show the shell's gateway picker. Stubbed; Task 3 navigates to
/// `connect.html?pick=1`.
#[tauri::command]
pub fn hermie_open_gateways<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Reply<Ack> {
    guarded(&webview, &request, Ack::new)
}

/// The page's answer to a `close` shortcut: `false` means nothing was open and
/// the shell should hide the window. Stubbed; Task 6.
#[tauri::command]
pub fn hermie_close_handled<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
    handled: bool,
) -> Reply<Ack> {
    let _ = handled;
    guarded(&webview, &request, Ack::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test URL")
    }

    fn configured() -> Vec<Url> {
        vec![
            url("https://hermes.example.com:9443/"),
            url("http://127.0.0.1:9120/"),
        ]
    }

    #[test]
    fn a_configured_origin_is_allowed() {
        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/chat/researcher"),
            &configured()
        ));
        assert!(origin_allowed(
            &url("http://127.0.0.1:9120/"),
            &configured()
        ));
    }

    #[test]
    fn a_different_port_on_the_same_host_is_refused() {
        assert!(!origin_allowed(
            &url("https://hermes.example.com:9444/"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("https://hermes.example.com/"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("http://127.0.0.1:9121/"),
            &configured()
        ));
    }

    #[test]
    fn a_different_scheme_on_the_same_host_and_port_is_refused() {
        // An operator who moved their Hermie Web behind TLS has to say so; a
        // plaintext page on the same host:port is not the same origin and is
        // not the session the cookie belongs to.
        assert!(!origin_allowed(
            &url("http://hermes.example.com:9443/"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("https://127.0.0.1:9120/"),
            &configured()
        ));
    }

    #[test]
    fn an_unconfigured_host_is_refused() {
        assert!(!origin_allowed(&url("https://example.com/"), &configured()));
        // The one that matters most in practice: an identity provider's page,
        // reached by a legitimate top-level navigation the shell allows.
        assert!(!origin_allowed(
            &url("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
            &configured()
        ));
        // And a host that merely ends in a configured one.
        assert!(!origin_allowed(
            &url("https://evil-hermes.example.com:9443/"),
            &configured()
        ));
        // …or has it as a suffix through a subdomain of its own.
        assert!(!origin_allowed(
            &url("https://hermes.example.com.attacker.test:9443/"),
            &configured()
        ));
    }

    #[test]
    fn the_shells_own_local_pages_are_refused_by_the_remote_guard() {
        // `connect.html` and `offline.html` have their own capability
        // (`local-pages.json`); they must not reach the app's bridge, and on
        // Windows/Linux their origin is a real http one, so this is not an
        // accident of scheme parsing.
        assert!(!origin_allowed(
            &url("tauri://localhost/connect.html"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("http://tauri.localhost/connect.html"),
            &configured()
        ));
        assert!(!origin_allowed(&url("about:blank"), &configured()));
        assert!(!origin_allowed(&url("file:///etc/passwd"), &configured()));
        assert!(!origin_allowed(&url("data:text/html,<p>hi"), &configured()));
    }

    #[test]
    fn an_empty_list_refuses_every_page() {
        assert!(!origin_allowed(
            &url("https://hermes.example.com:9443/"),
            &[]
        ));
        assert!(!origin_allowed(&url("http://127.0.0.1:9120/"), &[]));
    }

    #[test]
    fn a_default_port_matches_whether_or_not_it_was_written_out() {
        let configured = vec![url("https://hermes.example.com/")];

        assert!(origin_allowed(
            &url("https://hermes.example.com/"),
            &configured
        ));
        assert!(origin_allowed(
            &url("https://hermes.example.com:443/login"),
            &configured
        ));

        let spelled_out = vec![url("http://hermes.example.com:80/")];
        assert!(origin_allowed(
            &url("http://hermes.example.com/x"),
            &spelled_out
        ));
    }

    #[test]
    fn the_host_is_compared_case_insensitively() {
        assert!(origin_allowed(
            &url("https://HERMES.EXAMPLE.COM:9443/"),
            &configured()
        ));
        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/"),
            &[url("https://HERMES.Example.Com:9443/")]
        ));
    }

    #[test]
    fn a_path_prefix_on_the_configured_entry_does_not_narrow_the_origin() {
        let configured = vec![url("https://hermes.example.com:9443/hermie/")];

        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/hermie/chat"),
            &configured
        ));
        assert!(origin_allowed(
            &url("https://hermes.example.com:9443/"),
            &configured
        ));
    }

    #[test]
    fn credentials_and_fragments_do_not_change_the_origin() {
        // `Url` keeps userinfo out of the origin, and Task 3 refuses a typed
        // URL that carries any. Neither may be a way past the comparison.
        assert!(origin_allowed(
            &url("https://user:pass@hermes.example.com:9443/#/chat"),
            &configured()
        ));
        assert!(!origin_allowed(
            &url("https://user:pass@example.com/#hermes.example.com:9443"),
            &configured()
        ));
    }

    #[test]
    fn an_ipv6_loopback_keeps_its_brackets_on_both_sides() {
        let configured = vec![url("http://[::1]:9120/")];

        assert!(origin_allowed(&url("http://[::1]:9120/chat"), &configured));
        assert!(!origin_allowed(&url("http://[::1]:9121/"), &configured));
    }

    #[test]
    fn origin_of_normalises_what_it_accepts_and_rejects_the_rest() {
        assert_eq!(
            origin_of(&url("HTTPS://Hermes.Example.COM/x")).as_deref(),
            Some("https://hermes.example.com:443")
        );
        assert_eq!(
            origin_of(&url("http://127.0.0.1:9120/")).as_deref(),
            Some("http://127.0.0.1:9120")
        );
        assert_eq!(origin_of(&url("tauri://localhost/index.html")), None);
        assert_eq!(origin_of(&url("hermie://chat/researcher")), None);
        assert_eq!(origin_of(&url("about:blank")), None);
    }

    #[test]
    fn a_refusal_serialises_as_ok_false_with_a_reason() {
        let refused: Reply<Ack> = Reply::refused(Reason::Origin);

        assert_eq!(
            serde_json::to_string(&refused).expect("serialise"),
            r#"{"ok":false,"reason":"origin"}"#
        );
    }

    #[test]
    fn an_ack_serialises_as_ok_true_and_nothing_else() {
        let accepted = Reply::Accepted(Ack::new());

        assert_eq!(
            serde_json::to_string(&accepted).expect("serialise"),
            r#"{"ok":true}"#
        );
    }

    #[test]
    fn shell_info_serialises_flat_and_in_the_pages_spelling() {
        let info = Reply::Accepted(ShellInfo {
            ok: true,
            version: "0.1.0",
            platform: Platform::Macos,
            bridge: BRIDGE_VERSION,
            gateway_id: Some("dev".into()),
            gateway_name: Some("127.0.0.1".into()),
        });

        assert_eq!(
            serde_json::to_string(&info).expect("serialise"),
            r#"{"ok":true,"version":"0.1.0","platform":"macos","bridge":1,"gatewayId":"dev","gatewayName":"127.0.0.1"}"#
        );
    }

    #[test]
    fn every_event_name_is_one_tauri_will_accept_and_the_app_subscribes_to() {
        // Tauri refuses an event name with a character outside
        // `[alphanumeric]`, `-`, `/`, `:` and `_` (`event::is_event_name_valid`),
        // and the refusal is a runtime error from `emit`, which `emit_to_app`
        // deliberately swallows — so a typo here would be silent. These must
        // also match the strings in
        // `expo/hermie/src/platform/desktop-shell.ts`.
        let names = [
            events::SHORTCUT,
            events::LINK,
            events::GATEWAY,
            events::FOCUS,
        ];

        for name in names {
            assert!(name.starts_with("hermie://"), "{name} is not namespaced");
            assert!(
                name.chars().all(|c| c.is_alphanumeric()
                    || c == '-'
                    || c == '/'
                    || c == ':'
                    || c == '_'),
                "{name} has a character Tauri will refuse"
            );
        }

        assert_eq!(names.len(), 4, "the contract has four events");
    }

    // ---- origin_pattern (Revision 2026-09-22, decisions 1 and 5) ----

    fn pattern(raw: &str) -> RemoteUrlPattern {
        origin_pattern(&url(raw))
            .expect("an http(s) origin")
            .parse()
            .expect("a pattern the ACL can carry")
    }

    #[test]
    fn a_pattern_writes_the_port_only_when_it_is_not_the_schemes_default() {
        assert_eq!(
            origin_pattern(&url("https://hermes.example.com/")).as_deref(),
            Some("https://hermes.example.com")
        );
        // `Url` drops a default port when it parses, so writing `:443` into the
        // pattern would produce one that matches nothing.
        assert_eq!(
            origin_pattern(&url("https://hermes.example.com:443/")).as_deref(),
            Some("https://hermes.example.com")
        );
        assert_eq!(
            origin_pattern(&url("https://hermes.example.com:9443/hermie")).as_deref(),
            Some("https://hermes.example.com:9443")
        );
        assert_eq!(
            origin_pattern(&url("http://127.0.0.1:9120/")).as_deref(),
            Some("http://127.0.0.1:9120")
        );
        assert_eq!(
            origin_pattern(&url("http://hermes.example.com:80/")).as_deref(),
            Some("http://hermes.example.com")
        );
    }

    #[test]
    fn a_pattern_lowercases_the_host_and_refuses_anything_without_an_origin() {
        assert_eq!(
            origin_pattern(&url("HTTPS://Hermes.Example.COM/x")).as_deref(),
            Some("https://hermes.example.com")
        );
        assert_eq!(origin_pattern(&url("tauri://localhost/index.html")), None);
        assert_eq!(origin_pattern(&url("hermie://chat/researcher")), None);
        assert_eq!(origin_pattern(&url("about:blank")), None);
        assert_eq!(origin_pattern(&url("file:///etc/passwd")), None);
    }

    #[test]
    fn every_pattern_matches_its_own_origin_and_no_neighbour() {
        // The property the whole trust model rests on: `add_capability` matches
        // the CALLING frame's URL against exactly this pattern, so a pattern
        // that is wider than its origin is a hole and a pattern that is narrower
        // is a shell that refuses its own app.
        let configured = pattern("https://hermes.example.com:9443/");

        assert!(configured.test(&url("https://hermes.example.com:9443/")));
        assert!(configured.test(&url("https://hermes.example.com:9443/chat/researcher")));
        assert!(configured.test(&url("https://hermes.example.com:9443/login?next=/")));
        assert!(configured.test(&url("https://hermes.example.com:9443/#/chat")));

        assert!(!configured.test(&url("https://hermes.example.com:9444/")));
        assert!(!configured.test(&url("https://hermes.example.com/")));
        assert!(!configured.test(&url("http://hermes.example.com:9443/")));
        assert!(!configured.test(&url("https://hermes.example.com.:9443/")));
        assert!(!configured.test(&url("https://evil-hermes.example.com:9443/")));
        assert!(!configured.test(&url("https://hermes.example.com.attacker.test:9443/")));
        assert!(!configured.test(&url("https://sub.hermes.example.com:9443/")));
    }

    #[test]
    fn a_default_port_pattern_matches_the_origin_written_either_way() {
        let configured = pattern("https://hermes.example.com/");

        assert!(configured.test(&url("https://hermes.example.com/")));
        assert!(configured.test(&url("https://hermes.example.com:443/login")));
        assert!(!configured.test(&url("https://hermes.example.com:9443/")));
    }

    #[test]
    fn an_ipv6_host_has_its_colons_escaped_so_the_pattern_parses_at_all() {
        // Verified against urlpattern 0.3.0: `http://[::1]:9120` is a tokenizer
        // error (`InvalidName`) because a bare `:` opens a named group, so an
        // unescaped IPv6 entry would have been a gateway that could never be
        // granted. The escaped form parses and matches.
        assert_eq!(
            origin_pattern(&url("http://[::1]:9120/")).as_deref(),
            Some(r"http://[\:\:1]:9120")
        );
        // The `url` crate normalises a v4-mapped address; the pattern follows
        // it, because it is built from the parsed host and not from the text.
        assert_eq!(
            origin_pattern(&url("http://[::ffff:127.0.0.1]:9120/")).as_deref(),
            Some(r"http://[\:\:ffff\:7f00\:1]:9120")
        );
    }

    #[test]
    fn localhost_and_the_loopback_address_are_two_patterns() {
        let named = pattern("http://localhost:9120/");
        let numeric = pattern("http://127.0.0.1:9120/");
        let ipv6 = pattern("http://[::1]:9120/");

        assert!(named.test(&url("http://localhost:9120/")));
        assert!(!named.test(&url("http://127.0.0.1:9120/")));
        assert!(!named.test(&url("http://[::1]:9120/")));

        assert!(numeric.test(&url("http://127.0.0.1:9120/")));
        assert!(!numeric.test(&url("http://localhost:9120/")));

        assert!(ipv6.test(&url("http://[::1]:9120/")));
        assert!(!ipv6.test(&url("http://127.0.0.1:9120/")));
        assert!(!ipv6.test(&url("http://[::1]:9121/")));
    }

    #[test]
    fn every_address_the_validator_accepts_becomes_a_pattern_that_parses() {
        // `add_capability` parses the pattern internally and unwraps, so a shape
        // the validator lets through but the pattern parser does not would be a
        // panic at a reader's launch. `grant` checks this too; this is the list.
        for raw in [
            "https://hermes.example.com",
            "https://hermes.example.com:9443",
            "https://hermes.example.com:9443/hermie",
            "http://127.0.0.1:9120",
            "http://localhost:9120",
            "http://[::1]:9120",
            "https://xn--bcher-kva.example:8443",
        ] {
            let accepted = crate::gateways::validate(raw).expect("the validator accepts it");
            let built = origin_pattern(&accepted).expect("an origin");

            let parsed: RemoteUrlPattern = built
                .parse()
                .unwrap_or_else(|_| panic!("{built} is not a pattern the ACL can carry"));
            assert!(parsed.test(&accepted), "{built} does not match {accepted}");
        }
    }

    #[test]
    fn the_permission_list_is_the_eight_the_plan_pins() {
        assert_eq!(
            REMOTE_PERMISSIONS,
            [
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "allow-hermie-shell-info",
                "allow-hermie-set-menu",
                "allow-hermie-notify",
                "allow-hermie-set-badge",
                "allow-hermie-open-gateways",
                "allow-hermie-close-handled",
            ]
        );
    }

    #[test]
    fn the_platform_marker_spells_the_three_the_app_branches_on() {
        assert_eq!(
            serde_json::to_string(&Platform::Macos).expect("serialise"),
            r#""macos""#
        );
        assert_eq!(
            serde_json::to_string(&Platform::Windows).expect("serialise"),
            r#""windows""#
        );
        assert_eq!(
            serde_json::to_string(&Platform::Linux).expect("serialise"),
            r#""linux""#
        );
    }
}
