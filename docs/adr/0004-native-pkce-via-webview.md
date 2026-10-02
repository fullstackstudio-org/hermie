# 0004. Native PKCE sign-in through an intercepted web view redirect

- Status: Accepted
- Date: 2026-09-19
- See also: [0028](0028-native-apps-on-apple-platforms.md), whose native apps keep this sign-in unchanged

## Context

A gated Hermes gateway reports `auth_required: true` on its public `/api/status` and advertises the
flows it supports in `auth_flows`. The one that suits a mobile app is `native_pkce`: RFC 8252
("OAuth 2.0 for Native Apps") with PKCE and a loopback redirect. The alternative it also advertises,
`cookie`, is the browser dashboard's session-cookie flow, which a native client cannot carry across
a WebSocket dial.

The gateway is the authorization server in this flow, not merely a resource server. The upstream
identity provider issues a client id bound to the gateway's own origin and only accepts redirect
URIs on that origin, so a phone cannot be a direct client of it. The gateway therefore brokers:
`GET /auth/native/authorize` starts an upstream round trip, and `POST /auth/native/token` exchanges
the resulting one-time code plus the client's PKCE verifier for bearer tokens that are returned in
the response body. No cookie is set on the native path.

Two constraints come from the gateway's own validation, in
`hermes_cli/dashboard_auth/routes.py`:

- The redirect URI must be `http://` on a loopback **IP literal**. `localhost` is rejected outright,
  citing RFC 8252 §8.3, because a public route that accepted an arbitrary host would be an open
  redirect leaking a live authorization code.
- `code_challenge_method` must be `S256`; a missing or plain challenge is a 400.

The awkward case is a password provider — a gateway whose identity provider has a username/password
form rather than an upstream redirect. It would be easy to assume this needs a second code path.
It does not. At lines 279-283 the authorize route, having already registered the pending broker
authorization, sends a password provider to its own `/login` form with the broker state riding in
the gateway's PKCE cookie:

```python
if getattr(p, "supports_password", False):
    _audit(request, AuditEvent.NATIVE_AUTHORIZE_START, provider=p.name)
    resp = RedirectResponse(url=f"{_prefix(request)}/login", status_code=302)
    _set_pkce(resp, request, {"provider": p.name, "broker": broker_state})
    return resp
```

and at lines 411-418 the password-login handler finishes that same brokered flow, clearing the PKCE
cookie and setting **no** session cookie when the login was native:

```python
target, native = _complete_login(
    request, body.provider, session, broker_state=broker_state, next_raw=body.next)
resp = JSONResponse({"ok": True, "next": target})
if native:
    clear_pkce_cookie(resp, use_https=detect_https(request), prefix=_prefix(request))
else:
    _set_session(resp, request, session)
```

`_complete_login` returns the loopback `redirect_uri?code=…&state=…` as the target. So a password
login and an upstream redirect login end at the same place, with the same one-time code, and neither
leaves a usable cookie behind.

That leaves the question of _where_ the user sees the provider's page. The options were a system
browser with a real loopback listener, `expo-web-browser`'s authentication session, and an in-app
web view whose navigation is intercepted.

A real loopback listener is the RFC's own suggestion and is what Hermes Desktop does, but a mobile
app cannot bind a listening socket on iOS. `expo-web-browser` would work for redirect-based
providers but hands control to Safari or Chrome Custom Tabs, where an operator's Cloudflare Access
policy and a password form both behave differently from what the app can observe.

## Decision

Hermie signs in with **native PKCE inside an in-app `react-native-webview`, intercepting the
loopback redirect before it is loaded**. Nothing listens on the loopback port; the redirect is a
value to read, not a request to serve.

The client generates its own verifier (32 random bytes, base64url, 43 characters), challenge
(base64url of SHA-256 over the verifier) and `state` (24 random bytes, 32 characters), opens
`/auth/native/authorize`, and uses the web view's `onShouldStartLoadWithRequest` to match
`^http://(127\.0\.0\.1|\[::1\])(:\d+)?/`. On a match it reads `code`/`state` (or
`error`/`error_description`), returns `false` so the navigation never happens, and exchanges the code
over HTTPS.

The default redirect URI is `http://127.0.0.1:38007/callback`.

**Password providers ride the same flow.** There is no separate username/password path in the client:
the web view simply renders the gateway's `/login` form, and the flow ends at the same loopback
redirect. The web view therefore needs JavaScript enabled, and is configured with `incognito` and
without shared cookies so a sign-in never reuses or leaves browser state.

## Consequences

- One code path covers redirect-based and password-based providers. The provider list is only used
  to label buttons, not to choose a mechanism.
- Identity providers that refuse embedded web views — Google most prominently — cannot be used this
  way. This is a documented limitation, not something the client can work around; such a gateway
  needs a provider that permits embedded sign-in.
- An operator running Cloudflare Access in front of the gateway must exempt `/auth/*` and `/login`,
  or the access proxy's own login page appears inside the web view. The onboarding wizard's error
  mapping names this explicitly when `/api/status` answers 401 or 403.
- Tokens live in the app's secret store and never in a cookie jar, so signing out is deleting three
  keys rather than clearing a web view's storage.
- Android is the weak spot, and not because of rendering: its WebView re-sends `source.headers` on a
  cross-origin redirect, so a gateway configured with extra request headers would leak them to the
  identity provider. There the fallback is the system browser plus pasting the failed loopback URL
  back into the app. The parser is shared, so the fallback costs a text field and no new protocol
  code, and it is reachable deliberately on every platform in case a web view cannot render.
