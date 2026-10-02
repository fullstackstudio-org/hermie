//! The Hermie desktop shell.
//!
//! One window, one webview, pointed at a Hermie Web instance — see
//! `docs/adr/0027-desktop-is-a-webview-over-hermie-web.md` for why this shape
//! and not a bundled export.
//!
//! What is here so far: the window (Task 1) and the bridge — the marker the
//! page feature-detects, the six commands it may call, and the origin guard that
//! decides whether the page asking is the app (Task 2, `bridge.rs`). The gateway
//! list's persistence and the connect page, the navigation policy,
//! notifications, the full menu and deep links are later tasks; each of the
//! stubbed commands names the one that finishes it.

mod bridge;
mod gateways;

use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager, Runtime, Webview, Wry};

use gateways::{GatewayList, GatewayState};

/// The version of the `window.__HERMIE_DESKTOP__` marker's own shape.
///
/// Separate from `bridge::BRIDGE_VERSION` on purpose: the marker says "a Hermie
/// shell is hosting this page, and here is which desktop", which the app uses to
/// decide whether to pause its socket and which modifier `command` means —
/// answers it needs even against a shell whose bridge it cannot reach. The
/// bridge version describes the commands. They can move independently.
const MARKER_VERSION: u32 = 1;

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(marker_plugin())
        .manage(GatewayState::new(GatewayList::at_launch()))
        .invoke_handler(tauri::generate_handler![
            bridge::hermie_shell_info,
            bridge::hermie_set_menu,
            bridge::hermie_notify,
            bridge::hermie_set_badge,
            bridge::hermie_open_gateways,
            bridge::hermie_close_handled
        ]);

    // Desktop-only: the plugin does not build for the mobile targets Tauri
    // also supports (see the matching `[target.'cfg(...)'.dependencies]` in
    // Cargo.toml).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the running window rather than opening
            // a second one. Task 6 forwards the deep link a second launch's
            // argv carries on Windows/Linux through this same hook; Task 1
            // only needs the "one running instance" half.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
            grant_configured_gateways(app);
            navigate_to_active_gateway(app)?;
            Ok(())
        })
        .run(context())
        .expect("error while running the Hermie desktop shell");
}

/// The app's baked-in context: `tauri.conf.json`, the assets, and — the reason
/// this is a function rather than a macro call at the one use site — the
/// resolved ACL manifest.
pub fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// The marker the app page feature-detects, injected before any page script.
///
/// `window.__HERMIE_DESKTOP__ = { version, platform }`, and nothing else. The
/// app reads it through `expo/hermie/src/platform/desktop-shell.ts`, treats its
/// absence as "not in the shell", and treats every bridge call as optional.
///
/// A plugin because a window declared in `tauri.conf.json` has no place to hang
/// an initialization script, and `js_init_script` is the one hook that runs on
/// every top-level navigation — which is what this needs: the shell navigates
/// its one webview from the connect page to Hermie Web and, during a sign-in
/// chain, to an identity provider and back. A marker set once at startup would
/// be gone by the time the app page loaded.
///
/// **Not "top frame only", whatever the flag says.** `js_init_script` asks for
/// `for_main_frame_only: true`, and WKWebView and WebKitGTK honour it — but
/// wry's WebView2 backend implements init scripts with
/// `AddScriptToExecuteOnDocumentCreated`, which runs in **every frame** and does
/// not consult that flag. So on Windows a third-party iframe inside the app page
/// sees this marker, and Tauri's own globals besides.
///
/// That is an accepted residual, not a hole. The marker is an announcement, not
/// a credential, and an `invoke` from such a frame is refused before any command
/// runs: the ACL matches the CALLING frame's origin against the grants
/// `bridge::grant` made, and a foreign frame's origin is not among them. What
/// leaks is "this page is inside Hermie's desktop shell".
///
/// It runs on pages that are not the app, too: the identity provider's, the
/// connect page's. Same answer — nothing is gated on it.
fn marker_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let marker = serde_json::json!({
        "version": MARKER_VERSION,
        "platform": bridge::Platform::current(),
    });

    tauri::plugin::Builder::new("hermie-marker")
        .js_init_script(format!(
            "window.__HERMIE_DESKTOP__ = Object.freeze({marker});"
        ))
        .build()
}

/// May the page currently in this webview be sent one of the shell's events?
///
/// The emit-time half of the two layers, and the second of them. The first is
/// the ACL: a page on an origin the shell has not granted cannot call
/// `plugin:event|listen` at all, so it holds no listener and there is nothing
/// for an emit to reach — not the shell's four events and not Tauri's own window
/// events either.
///
/// This check is what covers the window in between: the shell emits from a menu
/// click, an OS notification or a deep link, and the page that is loaded when
/// that happens is whatever the last navigation left there — an identity
/// provider's page mid-sign-in, say, whose own listener the ACL refused but
/// whose presence the emitter has no other way to notice.
///
/// Separate from the emit so it can be unit-tested; `false` when the URL cannot
/// be read, like every other failure here.
pub(crate) fn should_emit<R: Runtime>(webview: &Webview<R>) -> bool {
    let Ok(url) = webview.url() else {
        return false;
    };

    bridge::origin_allowed(&url, &webview.state::<GatewayState>().urls())
}

/// Emit one of the shell's events to the app page — and only to the app page.
///
/// Silent when [`should_emit`] says no: there is no caller to report to (the
/// shell emits from a menu click or an OS event, not from a request), and a
/// dropped event is exactly the intended outcome.
///
/// Unused until Tasks 5 and 6 emit the four events; it lives here now because it
/// is the other half of this task's contract and the place where forgetting the
/// check would be invisible.
#[allow(dead_code)]
pub(crate) fn emit_to_app<R: Runtime, S: Serialize + Clone>(
    webview: &Webview<R>,
    event: &str,
    payload: S,
) {
    if !should_emit(webview) {
        return;
    }

    // Label-scoped rather than `emit`: `emit` reaches every webview in the app,
    // and "every webview" is a set this shell intends to keep at one but should
    // not depend on. `labeled` matches whatever kind of target the page's
    // `listen()` registered under this label, which is the page itself.
    let _ = webview.emit_to(EventTarget::labeled(webview.label()), event, payload);
}

/// Give every configured Hermie Web its own runtime capability.
///
/// **Before the window is navigated anywhere**, which is the ordering that
/// matters: the ACL is what decides whether a page may use the bridge, and the
/// first page the shell loads must already be covered by it.
///
/// Every entry, not only the active one — `bridge::grant` says why.
///
/// A grant that fails is logged and skipped rather than fatal. The failure
/// direction is the safe one: that gateway's page simply cannot reach the
/// bridge, and the app treats an unreachable bridge as "not in a shell" already.
///
/// Nothing here removes a grant, because Tauri cannot: `add_capability` has no
/// inverse. That is why Task 3's `gateways::forget` clears the browsing data and
/// calls `AppHandle::restart()` instead of trying to undo this.
fn grant_configured_gateways(app: &tauri::App) {
    let entries = app
        .state::<GatewayState>()
        .read(|list| list.entries().to_vec())
        .unwrap_or_default();

    for entry in &entries {
        if let Err(error) = bridge::grant(app, entry) {
            eprintln!("gateway {} was not granted the bridge: {error}", entry.id);
        }
    }
}

/// Point the window at the active gateway, if there is one.
///
/// In Task 2 the list holds at most the one entry `HERMIE_WEB_URL` names, so
/// this is still the dev path Task 1 had — but it now goes through the same
/// `GatewayList` the origin guard reads, which is the property that matters:
/// the page the window is navigated to and the page the bridge trusts come from
/// one source. Task 3 replaces the list's contents, not this function's shape.
///
/// With nothing configured the window stays on the bundled `connect.html`
/// placeholder rather than opening blank.
fn navigate_to_active_gateway(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let Some(url) = app
        .state::<GatewayState>()
        .read(|list| list.active().map(|entry| entry.url.clone()))
        .flatten()
    else {
        return Ok(());
    };

    if let Some(window) = app.get_webview_window("main") {
        window.navigate(url)?;
    }

    Ok(())
}

/// The App and Edit menus.
///
/// Edit is not decorative: without native roles for Cut/Copy/Paste, ⌘C and
/// ⌘V never reach the webview at all (plan D6) — this is the one thing Task 1
/// must get right for the drag-select-and-copy acceptance criterion to mean
/// anything. The rest of the native menu (Gateway, Window, Help, the page's
/// own Chats section from `hermie_set_menu`) is Task 6; this is only enough
/// for the window to behave like an ordinary macOS app.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, "Hermie")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu])
        .build()
}

#[cfg(test)]
mod acl;
