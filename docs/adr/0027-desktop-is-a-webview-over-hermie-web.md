# 0027. The desktop shell loads a remote Hermie Web URL, not a bundled export

- Status: Accepted, amended 2026-10-03 by [0030](0030-web-client-served-by-the-plugin.md) (the shell loads the gateway's client URL instead of a Hermie Web address)
- Date: 2026-09-22
- See also: [0029](0029-expo-native-and-the-contract-directory.md), which keeps the shell and plans to drop its macOS build once
  the native Mac app is public

## Context

`apps/desktop` (Tauri 2) is a downloadable app for macOS, Windows and Linux, built to fix what the
iPad-build Mac app cannot do — drag-select and copy text ("`Text selectable` does not select") — and
to bring Hermie to Windows and Linux for the first time, on Intel Macs included. It needs a webview
pointed at something. Two shapes were weighed for what that something is.

**(a) Remote: the window navigates to a Hermie Web URL an operator already runs**, the same origin
the browser build already serves from, cookies and all — exactly what happens today in Safari or
Chrome.

**(b) Bundled: the browser export ships inside the app** and talks to a gateway directly, the way
[ADR-0015](0015-web-variant-on-its-own-port.md) rejected for the browser itself, except now from a
Tauri custom scheme (`tauri://localhost` on macOS, `http://tauri.localhost` on Windows/Linux) instead
of a real origin.

| Concern                                              | (a) remote Hermie Web                                                                                             | (b) bundled export → gateway                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORS / cookies                                       | Same origin as the proxy: works as in Safari.                                                                     | Custom scheme is cross-origin to the gateway; the gateway refuses a WebSocket whose `Origin`/`Host` it does not know (DNS-rebinding guard, `docs/web.md`). Every request would have to go through Rust with rewritten headers — a re-implementation of Hermie Web's proxy inside the app. |
| OIDC redirect URIs                                   | The chain ends on `dashboard.public_url`, which is Hermie Web's own host; the webview follows it like a browser.  | A local proxy would set the PKCE cookie on `127.0.0.1` while the callback lands on the public host: exactly the "Missing PKCE state cookie" failure `docs/web.md` already documents. Only native PKCE over a real loopback listener works — a third auth mode the app would need to grow. |
| Cloudflare Access                                    | In front of Hermie Web already; the Access page is one more page in the chain, unmodified.                        | Service-token headers would have to be attached to every request from Rust; feasible, but another native-only path with nothing upstream to lean on.                                                                                                                                      |
| Offline start                                        | None: the shell shows its own offline page and retries.                                                           | The shell paints, but nothing works without the gateway either way — no real advantage.                                                                                                                                                                                                   |
| Update cadence                                       | The UI updates when the operator updates Hermie Web, which already self-updates; the shell itself updates rarely. | Every UI fix would be a desktop release on three platforms, on top of the web and native releases the same fix already needs.                                                                                                                                                             |
| Built-in OIDC issuer, admin, message cache, branding | All there, unchanged — Hermie Web was built for exactly this client.                                              | Absent; each would need its own native reimplementation.                                                                                                                                                                                                                                  |

## Decision

**The desktop shell loads a Hermie Web URL, over `https://` (or `http://` to a loopback/tailnet
host), the same way a browser tab does. It never talks to a gateway directly.**

The shell keeps a list of Hermie Web URLs (`gateways.json`) and navigates its one webview to the
active one; switching is a navigation, and cookies are per origin, so two Hermie Webs keep two
independent sessions. The app running inside that webview keeps believing its gateway is
`window.location.origin`, exactly as it does today in a browser tab — nothing about how the app
authenticates, proxies or renders changes for the shell to exist. A small bridge
(`window.__HERMIE_DESKTOP__`, a handful of `hermie_*` commands, narrowly capability-scoped — see
[desktop.md](../desktop.md)) is the only thing the shell adds on top, and every part of it is
feature-detected so the same app build runs unmodified in a browser, on native, and in the shell.

A Hermie Web is required. That is not a new requirement this decision introduces — it is already
the recommended self-host route per [ADR-0025](0025-hermie-web-is-a-service-layer.md) — but it does
mean the shell cannot point at a bare gateway, and the first-run screen has to ask for a Hermie Web
address rather than a gateway one.

Direct-to-gateway (option b) is not ruled out forever. It is recorded as a possible v2 ("native PKCE
over a real loopback listener, a Rust-side transport") if people who do not want to run a Hermie Web
ask for it. Nothing in this decision forecloses building it later as an additional mode; it is simply
not what v1 does, because every auth path the app already has works unchanged under (a) and none of
them do under (b) without new native-only code.

## Consequences

- **The shell is thin.** It is a window, a menu, a gateway list, notifications and a bridge — not a
  second implementation of anything the app or Hermie Web already do. Most of what makes the desktop
  app useful (auth, the message cache, branding, the admin UI) it gets for free, and keeps getting
  for free as Hermie Web grows.
- **An operator's Hermie Web has to be running and reachable for the app to do anything at all.**
  There is no offline-first mode and no local demo; the offline page and Retry are the whole answer
  to "the gateway is down", by design.
- **Identity providers that police "embedded webviews" by user agent are still a risk**, exactly as
  they are for any webview-based client. The shell mirrors the platform's default browser family in
  its user agent for this reason; if a provider still refuses, that is a known v1 limit, and
  system-browser sign-in is the v2 answer, not a native rewrite of the auth flow.
- **The shell owns no credential.** The webview's own persistent storage is the session, the same as
  Safari's; "Forget" is remove-entry-and-clear-browsing-data, not a sign-out API the shell has to
  implement.
- **A future direct-to-gateway mode, if it is ever built, is additive.** It would be a second kind of
  gateway-list entry, not a replacement for this one — operators who are happy running a Hermie Web
  are not asked to change anything.
