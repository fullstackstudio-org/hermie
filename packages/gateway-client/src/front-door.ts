/**
 * Header-based front doors: a proxy that stands in front of the gateway and
 * wants a credential of its own before it will pass anything through.
 *
 * Cloudflare Access is the one this names, because it is the one people
 * actually put in front of a self-hosted gateway and because its service-token
 * scheme is a pair of headers and nothing else — no redirect, no cookie, no
 * round trip. Everything below is deliberately just a way of PRODUCING those
 * two headers: the transport already carries arbitrary extra headers on every
 * REST call, every WebSocket dial and the probe, so a front door is a preset
 * over an input that exists rather than a second code path beside it. Anything
 * else that works the same way — a shared-secret header on a reverse proxy — is
 * the `custom` preset, which is the same field pair without the labels.
 *
 * Two rules are enforced here rather than left to a caller:
 *
 *  - **https only.** A service token is a long-lived bearer credential for a
 *    whole tenant, and Hermie deliberately supports cleartext on a tailnet
 *    (ADR-0014). Those two do not belong on the same wire, so the headers are
 *    withheld on an `http://` gateway — which is not a silent failure, because
 *    the address step says so before anything is saved.
 *  - **The secret is never printed.** `redactHeaders` is what anything that
 *    shows headers must go through, and `describeFrontDoor` is the whole of
 *    what the auth timeline is allowed to say about them.
 */

/** Cloudflare's own spelling. `normalizeHeader` keeps the case it is given. */
export const CF_ACCESS_CLIENT_ID = 'CF-Access-Client-Id'
export const CF_ACCESS_CLIENT_SECRET = 'CF-Access-Client-Secret'

/** How the auth timeline says a front door is configured, and all it may say. */
export const CF_ACCESS_PRESENT = 'cf-access: present'

/** Said when one of the pair is set and the other is not — which never works. */
export const CF_ACCESS_INCOMPLETE = 'cf-access: incomplete'

/** What a redacted header value is replaced with. Never the value, never its length. */
export const REDACTED = 'present'

export type FrontDoorKind = 'none' | 'cloudflare_access'

/**
 * The preset, as the wizard holds it and the secret store keeps it.
 *
 * `origin` is not decoration. A service token is issued for one hostname's
 * Access application, and a stored token that followed the app to a different
 * gateway would be sent to a host that never asked for it. It is written at
 * save time and checked at load time; a mismatch drops the record.
 */
export interface CloudflareAccessFrontDoor {
  kind: 'cloudflare_access'
  clientId: string
  clientSecret: string
  /** `https://host[:port]` of the gateway this was entered for. */
  origin: string
}

export type FrontDoor = { kind: 'none' } | CloudflareAccessFrontDoor

export const NO_FRONT_DOOR: FrontDoor = { kind: 'none' }

/** `https://host:port` of an address, lowercased, or `''` when it is not a URL. */
export function originOf(address: string): string {
  try {
    return new URL(address).origin.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Does this address carry a scheme that encrypts?
 *
 * Read off the string rather than through `new URL`, because a WebSocket URL is
 * also asked and both schemes have to be named explicitly — the point is that
 * an address with NO scheme, or one this package does not recognise, answers
 * false and the credentials stay home. So does one with no host (`wss://`):
 * the scheme alone says nothing about where the credentials would go.
 */
function isSecure(address: string): boolean {
  const trimmed = address.trim().toLowerCase()

  return (trimmed.startsWith('https://') || trimmed.startsWith('wss://')) && originOf(trimmed) !== ''
}

/**
 * Is this front door complete enough to send?
 *
 * Both halves or neither. Cloudflare rejects a request carrying one of the two,
 * so a half-filled form is worth catching in the wizard rather than as a 403.
 */
export function isFrontDoorComplete(frontDoor: FrontDoor): frontDoor is CloudflareAccessFrontDoor {
  return frontDoor.kind === 'cloudflare_access' && frontDoor.clientId.trim() !== '' && frontDoor.clientSecret !== ''
}

/**
 * The headers this front door adds for a gateway at `baseUrl`.
 *
 * Empty for a cleartext gateway, on purpose and never silently: see the module
 * note, and `strings.onboarding.address.frontDoor.insecure` for what the reader
 * is told instead.
 */
export function frontDoorHeaders(frontDoor: FrontDoor, baseUrl: string): Record<string, string> {
  if (!isFrontDoorComplete(frontDoor) || !isSecure(baseUrl)) {
    return {}
  }

  return {
    [CF_ACCESS_CLIENT_ID]: frontDoor.clientId.trim(),
    [CF_ACCESS_CLIENT_SECRET]: frontDoor.clientSecret
  }
}

/** True when a configured front door is being withheld because the gateway is cleartext. */
export function frontDoorWithheld(frontDoor: FrontDoor, baseUrl: string): boolean {
  return isFrontDoorComplete(frontDoor) && !isSecure(baseUrl)
}

function valueOf(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value
    }
  }

  return ''
}

/**
 * The one sentence the auth timeline and the developer screen may print about a
 * front door.
 *
 * Presence, never the values, and never a prefix of them: a client id is
 * `<32 hex>.access` and is not itself a secret, but printing it beside a
 * redacted secret invites the next person to print "just the first few
 * characters" of the other one too. Empty string when there is no front door,
 * so a caller can render nothing rather than "none".
 */
export function describeFrontDoor(headers: Record<string, string>): string {
  const id = valueOf(headers, CF_ACCESS_CLIENT_ID) !== ''
  const secret = valueOf(headers, CF_ACCESS_CLIENT_SECRET) !== ''

  if (id && secret) {
    return CF_ACCESS_PRESENT
  }

  return id || secret ? CF_ACCESS_INCOMPLETE : ''
}

/**
 * Every header value replaced by the fact that there is one.
 *
 * Applied to the WHOLE map rather than to the two names above, because the
 * custom preset exists precisely so people can put their own proxy's secret in
 * a header this package has never heard of. A redaction list is a list somebody
 * forgets to add to; this one has nothing to forget.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    out[name] = value === '' ? '' : REDACTED
  }

  return out
}

/**
 * The document-start script that puts the Access headers on the sign-in page's
 * own `fetch` and `XMLHttpRequest` calls.
 *
 * **Why a script at all.** A web view's `source.headers` applies to the load the
 * app initiates and to nothing the page does afterwards, and the gateway's
 * `/login` form posts with `fetch`. Without this the form's POST arrives at the
 * Access edge with no service token and is answered with Access's own login
 * page, inside a web view that is showing a sign-in already.
 *
 * **What it deliberately cannot reach.** A TOP-LEVEL navigation is not a
 * `fetch`. `/auth/native/authorize` redirects to the identity provider and the
 * provider redirects back, and neither of those requests is one this script or
 * `source.headers` can touch. An Access policy covering `/auth/*` and `/login`
 * therefore cannot be satisfied by a service token from inside the web view at
 * all — which is what ADR-0004 already asks operators to exempt, and ADR-0021
 * records why the exemption is not optional.
 *
 * **Scoping.** The script attaches the headers only when the page's own origin
 * AND the request's resolved origin are both the gateway's. A sign-in page that
 * has navigated to the identity provider is a different origin, and the token
 * must not follow it there — the same leak `webViewMayCarryHeaders` refuses on
 * Android for `source.headers`.
 *
 * Returns `''` when there is nothing to inject, which is a valid value for
 * `injectedJavaScriptBeforeContentLoaded`.
 */
export function accessUserScript(frontDoor: FrontDoor, baseUrl: string): string {
  const headers = frontDoorHeaders(frontDoor, baseUrl)
  const id = headers[CF_ACCESS_CLIENT_ID]
  const secret = headers[CF_ACCESS_CLIENT_SECRET]
  const origin = originOf(baseUrl)

  if (id === undefined || secret === undefined || !origin) {
    return ''
  }

  /*
    Every value crosses into JavaScript as a JSON string literal.

    `JSON.stringify` of a string is a JavaScript string literal for every input,
    including quotes, backslashes and line separators, so a pasted secret cannot
    close the literal and run as code. The names are constants in this file and
    are embedded the same way for one reason: so there is no "this one is safe
    because I typed it" exception for the next person to copy.
  */
  const literal = (value: string): string => JSON.stringify(value)

  return `(function () {
  var origin = ${literal(origin)};
  var name1 = ${literal(CF_ACCESS_CLIENT_ID)};
  var name2 = ${literal(CF_ACCESS_CLIENT_SECRET)};
  var value1 = ${literal(id)};
  var value2 = ${literal(secret)};
  function mine(input) {
    try {
      var url = input;
      if (url && typeof url === 'object' && typeof url.url === 'string') { url = url.url; }
      if (typeof url !== 'string') { return false; }
      return window.location.origin === origin && new URL(url, window.location.href).origin === origin;
    } catch (error) {
      return false;
    }
  }
  var fetchBefore = window.fetch;
  if (fetchBefore) {
    window.fetch = function (input, init) {
      if (mine(input)) {
        var options = init || {};
        var source = options.headers;
        if (source === undefined && input && typeof input === 'object' && input.headers) { source = input.headers; }
        var headers = new Headers(source || undefined);
        headers.set(name1, value1);
        headers.set(name2, value2);
        options.headers = headers;
        return fetchBefore.call(this, input, options);
      }
      return fetchBefore.call(this, input, init);
    };
  }
  var openBefore = XMLHttpRequest.prototype.open;
  var sendBefore = XMLHttpRequest.prototype.send;
  var eligible = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    eligible.set(this, mine(url));
    return openBefore.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (eligible.get(this) === true) {
      this.setRequestHeader(name1, value1);
      this.setRequestHeader(name2, value2);
    }
    return sendBefore.apply(this, arguments);
  };
  true;
})();`
}
