/**
 * Input/output vectors for the pure functions of `@hermie/gateway-client`, in
 * the form a Swift port reproduces byte for byte.
 *
 *   npx tsx packages/gateway-client/scripts/dump-vectors.ts --out <dir>
 *
 * writes `<dir>/gateway/vectors/<module>.json` for each module below and
 * nothing else. Each file is an array of
 *
 *   { "fn": "<exported name>", "args": [...], "result": <json> }
 *   { "fn", "args", "throws": true, "error": { "kind", "message" } }   (the call threw)
 *
 * in the order they are listed in this script. `error` is present when the
 * thrown value was a `GatewayError`; it carries the classification and the
 * message so a port can match the text as well as the fact of the throw. An
 * entry may also carry:
 *
 *   - `note`    how a non-obvious argument is encoded, or a behaviour to watch;
 *   - `random`  the value `Math.random()` returned during the call;
 *   - `result` absent  the function returned `undefined` (a note says so).
 *
 * Conventions for arguments that are not JSON:
 *
 *   - bytes are lowercase hex strings;
 *   - a `Set` result is a sorted array;
 *   - an `undefined` argument is written `null` (JSON has no undefined); every
 *     function recorded here treats the two alike;
 *   - errors given to a function are plain descriptors (see `probe-hints`).
 *
 * Everything is deterministic: no clock, no randomness (the one function that
 * draws a random number is called with `Math.random` pinned), no host names
 * that name a real person or organisation. The values are written through
 * `prettyJson`, so two runs produce identical bytes.
 *
 * NOT recorded, because the argument is a function, a class or the network and
 * cannot be described as data:
 *
 *   - `GatewayConnection` (connection.ts), `UiMetaSync` (ui-meta.ts): classes
 *     that need a socket / gateway object;
 *   - `searchSessions` (session-search.ts): needs an http object; its request
 *     path is `URLSearchParams` over `q`, `limit` (clamped to 1..100) and
 *     `profile`, which `buildAuthorizeUrl`'s vectors already exercise for the
 *     encoding;
 *   - `requestText` (fetch-json.ts): performs a fetch;
 *
 * `reconnectBackoffDelayMs` is recorded too, although it lives in the vendored
 * `@hermes/shared` module: `defaultBackoffDelayMs` is built on it.
 *
 * Behaviour that depends on the WHATWG URL parser (`new URL`) in these vectors:
 * `normalizeBaseUrl`, `wsUrlFor`, `apiUrl`, `originOf`, `gatewayKeyOf`,
 * `accessUserScript`, `frontDoorHeaders` and `frontDoorWithheld` (via
 * `originOf`: a secure scheme still needs an address it can read), `buildAuthorizeUrl`,
 * `parseLoopbackRedirect`, `isLoopbackUrl`, `redirectSeen` and `redirectError`. Entries
 * whose note starts with "WHATWG quirk" depend
 * on a parser detail (default-port stripping, IPv4 shorthand, punycode, path
 * dot-segments, tab/newline stripping, opaque origins).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { prettyJson, toJson } from '../../../scripts/golden/canonical-json'
import { reconnectBackoffDelayMs } from '@hermes/shared/reconnect-backoff'
import { authorIdOf, authorStampOf, authorViaOf, ownAuthorOf } from '../src/author-id'
import { bytesToBase64 } from '../src/base64'
import {
  assertDesktopContract,
  DEFAULT_RPC_TIMEOUT_MS,
  DIAL_FAILURE_RECENT_MS,
  defaultBackoffDelayMs,
  FIRST_SESSION_TIMEOUT_MS,
  MIN_DESKTOP_CONTRACT,
  OFFLINE_GRACE_MS,
  PROMPT_SUBMIT_TIMEOUT_MS,
  PROTOCOL_LADDER_FLOOR,
  READY_TIMEOUT_MS,
  RECONNECT_CAP_MS,
  rpcTimeoutMs
} from '../src/connection'
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  looksLikeCertificateFailure,
  looksLikeTlsFailure,
  parseJsonBody,
  parseJsonObject,
  redirectError,
  redirectSeen,
  REFUSED_LOCATION_HEADER
} from '../src/fetch-json'
import {
  accessUserScript,
  CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET,
  CF_ACCESS_INCOMPLETE,
  CF_ACCESS_PRESENT,
  describeFrontDoor,
  frontDoorHeaders,
  frontDoorWithheld,
  isFrontDoorComplete,
  NO_FRONT_DOOR,
  originOf,
  REDACTED,
  redactHeaders
} from '../src/front-door'
import { gatewayKeyOf, isGatewayKey } from '../src/gateway-key'
import { classifyHost, hostOfAddress, isExposedCleartext } from '../src/host-privacy'
import {
  base64url,
  buildAuthorizeUrl,
  createPkce,
  isLoopbackRedirect,
  isLoopbackUrl,
  parseLoopbackRedirect,
  REDIRECT_URI
} from '../src/pkce'
import {
  hasPluginCapability,
  HERMIE_PLUGIN_KEY,
  PLUGIN_CAPABILITIES,
  PLUGIN_CONTRACT_VERSION,
  pluginAdvert,
  pluginAdvertOf,
  pluginModuleOn
} from '../src/plugin'
import { classifyProbeFailure } from '../src/probe-hints'
import {
  adoptedPushTypes,
  effectivePushTypes,
  foreignPushRows,
  noPushTypes,
  noTypeWanted,
  PUSH_PER_BOT_KEY,
  PUSH_RELAY_ORIGIN,
  PUSH_RELAY_PLATFORMS,
  PUSH_SECTION_KEY,
  PUSH_SECTION_VERSION,
  PUSH_SEEN_TTL_SECONDS,
  PUSH_TYPES,
  pushAddressOf,
  pushPerBotOf,
  pushRelayAllowed,
  pushRelayOriginOf,
  pushRowFor,
  pushSeenOf,
  pushSectionFor,
  pushStampOf,
  pushTypesOf,
  type PushType
} from '../src/push'
import {
  parseSessionSearch,
  plainSnippet,
  SESSION_SEARCH_LIMIT_CAP,
  SNIPPET_MATCH_CLOSE,
  SNIPPET_MATCH_OPEN,
  sessionSearchHitOf,
  snippetSegments,
  tidySnippet
} from '../src/session-search'
import { GatewayError, isGatewayError, type GatewayErrorKind } from '../src/types'
import {
  APP_UPDATED_AT,
  appKeyFor,
  appStampOf,
  BOT_MARKER_KEY,
  HERMIE_APP_KEY,
  HERMIE_APP_SECTION_VERSION,
  HERMIE_KEY,
  HERMIE_SECTION_VERSION,
  inheritedFromLegacy,
  readSection
} from '../src/ui-meta'
import {
  apiUrl,
  AUTH_PICTURE_PATH,
  authPicturePath,
  BLOCKED_HEADER_NAMES,
  GATEWAY_WS_PATH,
  hasExplicitScheme,
  isBlockedHeaderName,
  normalizeBaseUrl,
  normalizeHeader,
  normalizeHeaders,
  wsUrlFor
} from '../src/url'

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Any function: arguments are checked by the vectors, not by the compiler. */
type AnyFn = (...args: never[]) => unknown

interface Entry {
  fn: string
  args: unknown[]
  result?: unknown
  throws?: true
  error?: { kind: string; message: string }
  random?: number
  note?: string
}

interface CallOptions {
  note?: string
  random?: number
}

class Vectors {
  readonly entries: Entry[] = []

  constructor(readonly module: string) {}

  /** Call `impl` with `args` and record what happened. `fn` is the exported name. */
  call(fn: string, impl: AnyFn, args: readonly unknown[], options: CallOptions = {}): void {
    const entry: Entry = { fn, args: [...args] }

    try {
      const result = (impl as (...a: unknown[]) => unknown)(...args)

      if (result === undefined) {
        entry.note = [options.note, 'result omitted: the function returned undefined'].filter(Boolean).join('; ')
      } else {
        entry.result = result

        if (options.note) {
          entry.note = options.note
        }
      }
    } catch (error) {
      entry.throws = true

      if (isGatewayError(error)) {
        entry.error = { kind: error.kind, message: error.message }
      }

      if (options.note) {
        entry.note = options.note
      }
    }

    if (options.random !== undefined) {
      entry.random = options.random
    }

    this.entries.push(entry)
  }

  /** `call` over a list of argument lists, with an optional note per list. */
  each(fn: string, impl: AnyFn, inputs: readonly (readonly unknown[])[], notes: Record<string, string> = {}): void {
    for (const args of inputs) {
      const first = args[0]
      const note = typeof first === 'string' ? notes[first] : undefined

      this.call(fn, impl, args, note === undefined ? {} : { note })
    }
  }

  /** Put a note on the first entry recorded for `fn`; a typo in `fn` is an error, not a silent no-op. */
  noteFor(fn: string, note: string): void {
    const entry = this.entries.find(item => item.fn === fn)

    if (!entry) {
      throw new Error(`no entry recorded for ${fn}`)
    }

    entry.note = [note, entry.note].filter(Boolean).join('; ')
  }

  /** A constant is an entry with no arguments. */
  constant(name: string, value: unknown, note = 'constant'): void {
    this.entries.push({ fn: name, args: [], result: value, note })
  }
}

/** Run `run` with `Math.random` returning `value`. */
function withRandom<T>(value: number, run: () => T): T {
  const original = Math.random

  Math.random = () => value

  try {
    return run()
  } finally {
    Math.random = original
  }
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const bytesFromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], pair => Number.parseInt(pair, 16))

const sequence = (length: number, at: (index: number) => number): Uint8Array =>
  Uint8Array.from({ length }, (_value, index) => at(index) & 255)

/** `[['a'], ['b']]` from `['a', 'b']`. */
const single = (values: readonly unknown[]): unknown[][] => values.map(value => [value])

// ---------------------------------------------------------------------------
// url.json
// ---------------------------------------------------------------------------

const WHATWG = 'WHATWG quirk: '

/** Inputs whose result hangs on a detail of the URL parser, with what the detail is. */
const URL_QUIRKS: Record<string, string> = {
  'https://example.com:443': `${WHATWG}the default port of the scheme is dropped from host`,
  'http://example.com:80/x': `${WHATWG}the default port of the scheme is dropped from host`,
  'https://example.com:443/hermes///': `${WHATWG}the default port of the scheme is dropped from host`,
  'http://example.com:80': `${WHATWG}the default port of the scheme is dropped from host`,
  'https://user:pw@example.com/hermes': 'userinfo is not part of url.host, so it is dropped',
  'https://user:pw@example.com': 'userinfo is not part of url.host, so it is dropped',
  'https://example.com/a/./b/../c': `${WHATWG}dot segments in the path are resolved`,
  'https://example.com/a b': `${WHATWG}a space in the path is percent-encoded`,
  'https://example.com/ü': `${WHATWG}non-ASCII path characters are percent-encoded as UTF-8`,
  'https://bücher.example': `${WHATWG}an IDN host becomes punycode`,
  'http://127.1': `${WHATWG}IPv4 shorthand is expanded to a dotted quad`,
  'mailto:a@b.example': `${WHATWG}no "://" so https:// is prefixed, and "mailto:a@" parses as userinfo`,
  'https://exam\nple.com': `${WHATWG}tab and newline are stripped from the input before parsing`,
  'https:///example.com': `${WHATWG}extra slashes after a special scheme are skipped`,
  'EXAMPLE.com': `${WHATWG}the host is lowercased`,
  'HTTPS://Example.COM/Path': `${WHATWG}scheme and host are lowercased, the path keeps its case`,
  'https://example.com/%7Efoo': 'percent-escapes in the path are kept as written',
  'https://example.com/hermes%2F/': 'percent-escapes in the path are kept as written'
}

const url = new Vectors('url')

url.each(
  'hasExplicitScheme',
  hasExplicitScheme,
  single([
    'https://example.com',
    '  http://example.com  ',
    'HTTP://example.com',
    'Https://example.com',
    'example.com',
    'example.com:9119',
    'localhost:3000',
    '',
    '   ',
    'ws://example.com',
    'wss://example.com',
    'file:///etc/passwd',
    'foo+bar.baz-1://x',
    'a://',
    '1http://example.com',
    '://example.com',
    'http:/example.com',
    'http:example.com',
    'mailto:a@b.example',
    'https://',
    'https //example.com',
    ' \t\nhttps://example.com',
    '\u00a0https://example.com'
  ]),
  {
    '\u00a0https://example.com': 'trim() removes a no-break space; a port that trims differently would disagree'
  }
)

const BASE_URLS: string[] = [
  'gateway.example.net',
  'http://localhost:9119',
  'https://example.com/hermes/?x=1#frag',
  'https://example.com///',
  '  example.com  ',
  'ws://example.com',
  'file:///etc/passwd',
  '   ',
  '',
  'HTTPS://Example.COM/Path',
  'example.com:9119',
  'localhost:3000',
  '[::1]:9119',
  'http://[::1]:9119/',
  'http://[fd7a:115c:a1e0::1]:9119',
  'https://example.com:443',
  'http://example.com:80/x',
  'https://example.com:8443/',
  'https://user:pw@example.com/hermes',
  '10.0.0.5',
  '192.168.1.20:9119',
  'http://127.0.0.1:9119',
  'my-box.local',
  'something.ts.net',
  'example.com/hermes/',
  'https://example.com/a//b/',
  'https://example.com/a b',
  'https://example.com/ü',
  'https://example.com/a/./b/../c',
  'https://example.com/Hermes',
  'https://example.com/%7Efoo',
  'https://example.com/hermes%2F/',
  'https://bücher.example',
  'https://example.com?x=1',
  'https://example.com#x',
  'https://example.com/?',
  'https://example.com/#',
  'http://example.com./',
  'https://',
  'http://:9119',
  'foo://bar',
  'ftp://example.com',
  'mailto:a@b.example',
  'javascript:alert(1)',
  'http:example.com',
  'https://example.com:99999',
  'http://127.1',
  'https://exa mple.com',
  'HTTP://example.com',
  'https://exam\nple.com',
  'https:///example.com',
  '\tgateway.example.net\n'
]

url.each('normalizeBaseUrl', normalizeBaseUrl, single(BASE_URLS), URL_QUIRKS)

url.each(
  'wsUrlFor',
  wsUrlFor,
  single([
    'https://example.com',
    'http://127.0.0.1:9119',
    'https://example.com/hermes/',
    'example.com',
    'http://[::1]:9119',
    'ws://example.com',
    '',
    'https://example.com:443/hermes///',
    'HTTP://Example.com',
    'localhost:3000',
    'http://example.com:80',
    'https://user:pw@example.com',
    'http://192.168.1.20:9119/prefix',
    'https://gateway.example.net/a b'
  ]),
  URL_QUIRKS
)

url.each(
  'apiUrl',
  apiUrl,
  [
    ['https://example.com/hermes', '/api/status'],
    ['https://example.com', 'api/status'],
    ['https://example.com', '/api/status'],
    ['https://example.com/', '/api/status'],
    ['example.com', 'api/status'],
    ['https://example.com/hermes', '/'],
    ['https://example.com', ''],
    ['https://example.com', '?x=1'],
    ['https://example.com', '//double'],
    ['https://example.com/hermes', '/api/sessions/search?q=a%20b&limit=5'],
    ['https://example.com/prefix?q=1#f', '/x'],
    ['http://127.0.0.1:9119', '/api/auth/picture?id=a%3Ab'],
    ['ws://example.com', '/a'],
    ['', '/a'],
    ['http://[::1]:9119/hermes/', '/api/ws']
  ],
  {}
)

url.each(
  'authPicturePath',
  authPicturePath,
  single([
    'authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40',
    'basic:alice',
    'a b/c?d=e&f#g',
    'é',
    '',
    'x:y+z',
    "~'()*!",
    '😀',
    'provider:user@example.com',
    '%already',
    '日本語'
  ]),
  { "~'()*!": "encodeURIComponent leaves ~ ! * ' ( ) unescaped and escapes everything else outside A-Za-z0-9 - _ ." }
)

url.each(
  'isBlockedHeaderName',
  isBlockedHeaderName,
  single([
    'Authorization',
    'host',
    'Cookie',
    'Content-Length',
    'X-Hermes-Session-Token',
    ' Host ',
    'HOST',
    'Te',
    'Origin',
    'Referer',
    'Connection',
    'Upgrade',
    'Transfer-Encoding',
    'Trailer',
    'Content-Type',
    'X-Custom',
    'Proxy-Authorization',
    'CF-Access-Client-Id',
    '',
    'x-hermes-session-token ',
    '\u00a0host'
  ]),
  { '\u00a0host': 'trim() removes a no-break space, so this is "host"' }
)

url.each(
  'normalizeHeader',
  normalizeHeader,
  [
    ['CF-Access-Client-Id', ' abc\r\ndef '],
    ['CF-Access-Client-Secret', 'secret-abc'],
    ['bad header', 'x'],
    ['bad:header', 'x'],
    ['', 'x'],
    ['   ', 'x'],
    ['Authorization', 'x'],
    ['host', 'x'],
    ['Cookie', 'x'],
    ['Content-Length', 'x'],
    ['X-Hermes-Session-Token', 'x'],
    [' Origin ', 'x'],
    ['X-Custom', ''],
    ['X-Custom', '   '],
    ['X-Custom', 'a\nb\rc'],
    ['X-Custom', '\r\n'],
    ['X-Custom', 'a  b'],
    ['X-Custom', '\ta\t'],
    ['X-Custom', '\u00a0abc\ufeff'],
    [' X-Custom ', 'v'],
    ["X-Tok!#$%&'*+.^_`|~-0aZ", 'v'],
    ['X-Ünicode', 'v'],
    ['X Custom', 'v'],
    ['X-Custom\u00a0', 'v'],
    ['X-Custom()', 'v'],
    ['X/Custom', 'v'],
    ['X-Custom', 'ünïcode ✓'],
    ['x-lower', 'v'],
    ['X-A\nB', 'v']
  ],
  {}
)

url.each(
  'normalizeHeaders',
  normalizeHeaders,
  [
    [undefined],
    [{}],
    [{ 'CF-Access-Client-Secret': 'shh' }],
    [{ 'CF-Access-Client-Id': ' abc\r\n ', 'CF-Access-Client-Secret': 'secret-abc' }],
    [{ 'X-A': '1', 'x-a': '2' }],
    [{ 'X-Custom': 'a\nb' }],
    [{ 'X-Ok': 'v', Authorization: 'nope' }],
    [{ 'bad header': 'v' }],
    [{ ' X-Padded ': ' v ' }]
  ],
  {}
)

url.noteFor('normalizeHeaders', 'args[0] null stands for an undefined map (the argument is optional)')

url.constant('BLOCKED_HEADER_NAMES', [...BLOCKED_HEADER_NAMES].sort(), 'constant; a Set, listed sorted')
url.constant('GATEWAY_WS_PATH', GATEWAY_WS_PATH)
url.constant('AUTH_PICTURE_PATH', AUTH_PICTURE_PATH)

// ---------------------------------------------------------------------------
// host-privacy.json
// ---------------------------------------------------------------------------

const hostPrivacy = new Vectors('host-privacy')

const HOST_QUIRKS: Record<string, string> = {
  'http://example.com/path@foo':
    'the authority ends at the first "/", "?" or "#"; an "@" after it is path, not credentials, so this reads host "example.com"',
  'http://example.com#frag@x':
    'the path/query/fragment cut runs before the credentials cut, so this reads host "example.com"',
  'http://public.example/@10.0.0.1': 'an "@" in the path cannot name the host: public, not private',
  'http://public.example\\@10.0.0.1':
    'a "\\" ends the authority like "/" (the URL standard reads it as "/" for http, https, ws and wss), so the "@" after it is path: public.example',
  'public.example\\@127.0.0.1:9119': 'a "\\" ends the authority even without a scheme',
  'http://10.0.0.1\n.example.com':
    'every ASCII tab, LF and CR is removed first, as the URL parser does: the host is 10.0.0.1.example.com, a name',
  'http://pub\tlic.example/': 'every ASCII tab, LF and CR is removed first, as the URL parser does',
  'http://public.example\t@10.0.0.1':
    'the tab is removed, and what is left has its "@" inside the authority: credentials, so the host is 10.0.0.1, which is what the URL parser reads too',
  'http://user@host@example.com/': 'the LAST "@" within the authority wins',
  'http://user@host@example.com/x@y': 'the LAST "@" within the authority wins; the one in the path is ignored',
  'http://host:99:88': 'two or more colons and no brackets: the whole authority is the host, no port cut',
  'İSTANBUL.example': 'toLowerCase is Unicode-aware: İ (U+0130) lowercases to "i" + U+0307',
  'ÉXAMPLE.COM': 'toLowerCase is Unicode-aware',
  '\t example.com \n': 'trim() first',
  '010.0.0.1': 'leading zeros are read as decimal: 010 is 10, so this is RFC 1918',
  '::0.0.0.1': 'a trailing dotted quad is two hextets, so this expands to ::1 and reads as loopback',
  '2130706433': 'a bare number has no dot, so it is a name with no dots, not an address',
  '.ts.net': 'endsWith(".ts.net") matches a host that is only the suffix',
  '.local': 'endsWith(".local") matches a host that is only the suffix',
  'fe80::1%eth0': 'a zone id is not a hextet, so the literal fails to parse and every unreadable host reads public',
  '::ffff:7f00:1': 'IPv4-mapped in hextet form: 127.0.0.1',
  '::FFFF:127.0.0.1': 'IPv4-mapped, uppercase'
}

hostPrivacy.each(
  'hostOfAddress',
  hostOfAddress,
  single([
    'https://example.com/hermes?x=1',
    'example.com:9119',
    'example.com',
    'HTTP://Hermes.Tail-Example.TS.NET./',
    'http://[fd7a:115c:a1e0::1]:9119/api',
    'fd7a:115c:a1e0::1',
    'http://user:pass@192.168.1.4:9119',
    '',
    '   ',
    'EXAMPLE.COM',
    'example.com:9119/path',
    'http://example.com:9119?x=1',
    'http://example.com#frag',
    'http://[::1]:9119',
    '[::1]',
    '::1',
    'http://[::1',
    '[]',
    'user@host',
    'user:pass@host:80',
    'http://user@host@example.com/',
    'http://example.com/path@foo',
    'http://example.com#frag@x',
    'http://public.example/@10.0.0.1',
    'http://public.example?next=@127.0.0.1',
    'http://user@host@example.com/x@y',
    'example.com.',
    'example.com..',
    'a.ts.net.',
    'http://:9119',
    'host:',
    'http://host:99:88',
    '1.2.3.4:80',
    'ftp://x/',
    '://',
    '://example.com',
    'a://b://c',
    'example.com?x=1',
    'example.com#x',
    'ÉXAMPLE.COM',
    'İSTANBUL.example',
    '\t example.com \n',
    'http://10.0.0.5:9119/hermes',
    'https://[2606:4700:4700::1111]:443/',
    '[2606:4700:4700::1111]:443',
    'something.ts.net:8443',
    'http://my-box.local:9119',
    'http://127.0.0.1',
    'localhost',
    'LOCALHOST:3000',
    'http://public.example\\@10.0.0.1',
    'http://public.example\\path',
    'public.example\\@127.0.0.1:9119',
    'http://10.0.0.1\n.example.com',
    'http://pub\tlic.example/',
    'http://public.example\t@10.0.0.1',
    'http://exa\r\nmple.com:9119/x',
    ' \thttp://example.com \n'
  ]),
  HOST_QUIRKS
)

const CLASSIFY_INPUTS = [
  // IPv4
  'http://127.0.0.1:9119',
  '127.13.2.9',
  '126.255.255.255',
  '128.0.0.1',
  '10.0.0.1',
  '10.0.0.5',
  '192.168.2.250:9119',
  '192.168.1.20',
  '192.169.0.1',
  '192.167.255.255',
  '172.16.0.1',
  '172.31.255.254',
  '172.15.0.1',
  '172.32.0.1',
  '169.254.1.1',
  '169.254.169.254',
  '169.253.0.1',
  '100.101.102.103',
  '100.64.0.0',
  '100.127.255.255',
  '100.63.0.1',
  '100.128.0.1',
  '100.100.100.100',
  '8.8.8.8',
  '0.0.0.0',
  '255.255.255.255',
  '999.1.1.1',
  '256.0.0.1',
  '1.2.3',
  '1.2.3.4.5',
  '010.0.0.1',
  '0x7f.0.0.1',
  '2130706433',
  '127.0.0.1.',
  'http://user:pass@192.168.1.4:9119',
  'http://10.0.0.5:9119/hermes',
  'http://public.example/@10.0.0.1',
  'http://public.example/x@127.0.0.1:9119',
  'http://public.example\\@10.0.0.1',
  'http://public.example\\x@127.0.0.1:9119',
  'http://10.0.0.1\n.example.com',
  'http://127.0.0.1\t.example.com',
  // IPv6
  'http://[::1]:9119',
  '0:0:0:0:0:0:0:1',
  '::1',
  '::',
  'fd7a:115c:a1e0::1',
  'FD7A:115C:A1E0:AB12:4843:CD96:6265:1',
  'fd7a:115c:a1e1::1',
  'fd12:3456:789a::1',
  'fc00::1',
  'fc00::',
  'fdff:ffff::1',
  'fe00::1',
  'fe80::1',
  'febf::1',
  'fec0::1',
  'fe80::1%eth0',
  '2606:4700:4700::1111',
  '[2606:4700:4700::1111]:443',
  '2001:db8::1',
  '1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7::8',
  '12345::1',
  '::ffff:192.168.1.10',
  '::ffff:8.8.8.8',
  '::ffff:10.0.0.1',
  '::ffff:100.64.0.1',
  '::ffff:169.254.0.1',
  '::ffff:7f00:1',
  '::FFFF:127.0.0.1',
  '::ffff:999.1.1.1',
  '::0.0.0.1',
  'fd7a::115c::a1e0',
  'fdzz::1',
  '::1::2',
  ':::',
  'http://[fd7a:115c:a1e0::1]:9119',
  '[fe80::1]:80',
  'http://[::1',
  // names
  'http://localhost:9119',
  'gateway.localhost',
  'localhost',
  'LOCALHOST',
  'localhost.',
  'localhost.example.com',
  'hermes.tailnet-example.ts.net',
  'https://Hermes.Tailnet-Example.TS.NET/',
  'something.ts.net',
  'ts.net',
  '.ts.net',
  'studio.local',
  'my-box.local',
  'my-box.local.',
  '.local',
  'local',
  'hermes',
  'http://hermes:9119',
  'a_b',
  'hermes.lab.internal',
  'http://Hermes.Lab.Internal:9119/',
  'internal',
  'a.internal',
  'hermes.notinternal',
  'http://public.example/@hermes.ts.net',
  'hermes.example.com',
  'hermes.tailnet.example.org',
  'example.com',
  'gateway.example.net',
  'https://gateway.example.net:8443/hermes',
  '',
  '   ',
  'http://',
  '[]'
]

hostPrivacy.each('classifyHost', classifyHost, single(CLASSIFY_INPUTS), HOST_QUIRKS)

hostPrivacy.each(
  'isExposedCleartext',
  isExposedCleartext,
  single([
    'http://hermes.example.com',
    'HTTP://hermes.example.com',
    'https://hermes.example.com',
    'http://100.101.102.103:9119',
    'http://hermes.tailnet-example.ts.net',
    'http://hermes.lab.internal',
    'http://127.0.0.1:9119',
    '  http://example.com',
    'http://localhost',
    'http://[::1]:9119',
    'http://[2606:4700:4700::1111]',
    'http://192.168.1.20',
    'http://10.0.0.5:9119',
    'http://8.8.8.8',
    'example.com',
    '',
    'http://',
    'ws://example.com',
    'http://my-box.local',
    'something.ts.net',
    'http://something.ts.net',
    'http://example.com:9119/hermes',
    'http://user@example.com',
    'http://172.15.0.1',
    'http://172.16.0.1',
    'http://100.63.0.1',
    'http://hermes',
    'httpx://example.com',
    'http:/example.com',
    'http://public.example/@10.0.0.1'
  ]),
  { '  http://example.com': 'trim() before the scheme test, and the scheme test is case-insensitive' }
)

// ---------------------------------------------------------------------------
// gateway-key.json and front-door.json
// ---------------------------------------------------------------------------

const ORIGIN_QUIRKS: Record<string, string> = {
  'https://example.com:443/': `${WHATWG}the default port is dropped from the origin`,
  'http://example.com:80': `${WHATWG}the default port is dropped from the origin`,
  'https://bücher.example/': `${WHATWG}an IDN host becomes punycode`,
  'mailto:a@b.example': `${WHATWG}a non-special scheme has an opaque origin, serialised "null" (a non-empty string)`,
  'file:///tmp/x': `${WHATWG}a file: URL has an opaque origin, serialised "null"`,
  'about:blank': `${WHATWG}an opaque origin, serialised "null"`,
  'http://127.1/': `${WHATWG}IPv4 shorthand is expanded to a dotted quad`,
  'http://0x7f.0.0.1/': `${WHATWG}hex IPv4 parts are read as numbers`,
  'http://2130706433/': `${WHATWG}a single decimal number is an IPv4 address`,
  'https:example.com': `${WHATWG}a special scheme without slashes still has an authority`,
  'http:\\\\example.com': `${WHATWG}backslashes count as slashes after a special scheme`,
  '  https://example.com/ ': `${WHATWG}leading and trailing spaces and C0 controls are stripped`,
  'blob:https://example.com/0000': `${WHATWG}a blob: URL's origin is the origin of the URL inside it`,
  'https://example.com:99999': `${WHATWG}a port above 65535 is a parse failure`,
  'https://exa mple.com': `${WHATWG}a space in the host is a parse failure`,
  'HTTP://EXAMPLE.COM': `${WHATWG}scheme and host are lowercased`,
  'https://example.com./': `${WHATWG}a trailing dot on the host is kept`,
  'https://user:pw@example.com/': 'userinfo is not part of the origin',
  'ws://example.com:80/': `${WHATWG}ws is a special scheme with default port 80`,
  'wss://example.com:443/api/ws': `${WHATWG}wss is a special scheme with default port 443`
}

const ORIGIN_INPUTS = [
  'https://Gateway.Example.com:8443/hermes',
  'https://gateway.example.com:8443',
  'https://gateway.example.com:9443',
  'http://gateway.example.com:8443',
  'https://other.example.com:8443',
  'https://example.com:443/',
  'http://example.com:80',
  'https://example.com/hermes/api/ws?x=1#f',
  'https://user:pw@example.com/',
  'http://127.0.0.1:9119/x',
  'http://[::1]:9119/x',
  'http://[FD7A:115C:A1E0::1]:9119/',
  'https://my-box.local',
  'https://something.ts.net',
  'https://bücher.example/',
  'ws://example.com:80/',
  'wss://example.com:443/api/ws',
  'wss://gateway.example.net:8443/api/ws',
  'HTTP://EXAMPLE.COM',
  'https://example.com./',
  'mailto:a@b.example',
  'file:///tmp/x',
  'about:blank',
  'blob:https://example.com/0000',
  'http://127.1/',
  'http://0x7f.0.0.1/',
  'http://2130706433/',
  'https:example.com',
  'http:\\\\example.com',
  '  https://example.com/ ',
  'https://example.com:99999',
  'https://exa mple.com',
  'gateway.example.com',
  'example.com:9119',
  'localhost:3000',
  '//example.com',
  '/hermes',
  ''
]

const gatewayKey = new Vectors('gateway-key')

gatewayKey.each('gatewayKeyOf', gatewayKeyOf, single(ORIGIN_INPUTS), {
  ...ORIGIN_QUIRKS,
  'https://gateway.example.com:8443':
    'the published vector: FNV-1a 64-bit over the UTF-8 bytes of the origin, 16 lowercase hex digits',
  'gateway.example.com': 'no scheme: not a URL, so the key is the empty string',
  'mailto:a@b.example': `${WHATWG}an opaque origin, serialised "null": it names no gateway, so the key is the empty string`,
  'example.com:9119': `${WHATWG}parses as the scheme "example.com:", whose origin is opaque ("null"), so the key is the empty string`,
  'localhost:3000': `${WHATWG}parses as the scheme "localhost:", whose origin is opaque ("null"), so the key is the empty string`
})

gatewayKey.each(
  'isGatewayKey',
  isGatewayKey,
  single([
    'bf796761db84e312',
    '0000000000000000',
    'ffffffffffffffff',
    '',
    'NOTHEX0000000000',
    'BF796761DB84E312',
    'bf796761db84e31',
    'bf796761db84e3123',
    'bf796761db84e312\n',
    ' bf796761db84e312',
    'bf796761db84e31g',
    '٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠',
    null,
    123,
    true,
    ['bf796761db84e312'],
    { key: 'bf796761db84e312' }
  ]),
  {
    'bf796761db84e312\n':
      'JS $ has no end-of-line leniency; a regex engine whose $ also matches before a final newline would say true'
  }
)

const frontDoor = new Vectors('front-door')

frontDoor.each('originOf', originOf, single(ORIGIN_INPUTS), ORIGIN_QUIRKS)

const ACCESS = {
  kind: 'cloudflare_access',
  clientId: 'client-id-123.access',
  clientSecret: 'secret-abc',
  origin: 'https://gateway.example.com'
}

const GATEWAY = 'https://gateway.example.com'

const FRONT_DOORS: [string, unknown][] = [
  ['complete', ACCESS],
  ['none', NO_FRONT_DOOR],
  ['empty secret', { ...ACCESS, clientSecret: '' }],
  ['blank id', { ...ACCESS, clientId: '   ' }],
  ['empty id', { ...ACCESS, clientId: '' }],
  ['padded id', { ...ACCESS, clientId: '  client-id-123.access\n' }],
  ['padded secret', { ...ACCESS, clientSecret: ' padded ' }],
  ['whitespace-only secret', { ...ACCESS, clientSecret: ' ' }],
  ['no-break-space id', { ...ACCESS, clientId: '\u00a0' }],
  ['other origin', { ...ACCESS, origin: 'https://other.example.net' }],
  ['unicode secret', { ...ACCESS, clientSecret: 'sécret ✓' }]
]

for (const [label, door] of FRONT_DOORS) {
  frontDoor.call('isFrontDoorComplete', isFrontDoorComplete, [door], { note: label })
}

const ADDRESSES = [
  GATEWAY,
  'wss://gateway.example.com/api/ws',
  'http://gateway.example.com',
  'ws://gateway.example.com/api/ws',
  'gateway.example.com',
  'HTTPS://Gateway.Example.com',
  '  https://gateway.example.com',
  'WSS://gateway.example.com/api/ws',
  'https://127.0.0.1:9119',
  'http://127.0.0.1:9119',
  'http://something.ts.net',
  'https',
  'https:gateway.example.com',
  'wss://',
  'https://',
  'https://:443/',
  '',
  '   ',
  'ftp://gateway.example.com',
  'https://gateway.example.com:8443/hermes'
]

for (const [label, door] of FRONT_DOORS) {
  for (const address of [GATEWAY, 'http://gateway.example.com']) {
    frontDoor.call('frontDoorHeaders', frontDoorHeaders, [door, address], { note: label })
  }
}

for (const address of ADDRESSES.slice(1)) {
  frontDoor.call('frontDoorHeaders', frontDoorHeaders, [ACCESS, address])
}

for (const [label, door] of FRONT_DOORS) {
  for (const address of [GATEWAY, 'http://gateway.example.com']) {
    frontDoor.call('frontDoorWithheld', frontDoorWithheld, [door, address], { note: label })
  }
}

for (const address of ADDRESSES.slice(1)) {
  frontDoor.call('frontDoorWithheld', frontDoorWithheld, [ACCESS, address])
}

frontDoor.each(
  'describeFrontDoor',
  describeFrontDoor,
  single([
    { 'CF-Access-Client-Id': 'client-id-123.access', 'CF-Access-Client-Secret': 'secret-abc' },
    { 'cf-access-client-id': 'a', 'CF-ACCESS-CLIENT-SECRET': 'b' },
    { 'CF-Access-Client-Id': 'a' },
    { 'CF-Access-Client-Secret': 'b' },
    {},
    { 'X-Other': 'value' },
    { 'CF-Access-Client-Id': '', 'CF-Access-Client-Secret': 'b' },
    { 'CF-Access-Client-Id': 'a', 'CF-Access-Client-Secret': '' },
    { 'CF-Access-Client-Id': '', 'CF-Access-Client-Secret': '' },
    { 'CF-Access-Client-Id': ' ', 'CF-Access-Client-Secret': ' ' },
    { 'cf-access-client-id': 'a', 'X-Other': 'z' },
    { 'Cf-Acces-Client-Id': 'a', 'Cf-Access-Client-Secret': 'b' },
    { 'CF-Access-Client-Id': 'a', 'CF-Access-Client-Secret': 'b', 'X-Proxy-Shared-Secret': 'c' }
  ]),
  {}
)

frontDoor.each(
  'redactHeaders',
  redactHeaders,
  single([
    {
      'CF-Access-Client-Id': 'client-id-123.access',
      'CF-Access-Client-Secret': 'secret-abc',
      'X-Proxy-Shared-Secret': 'a secret this package never heard of'
    },
    { 'Cf-Acces-Client-Id': 'x' },
    { 'X-Empty': '' },
    { 'X-Blank': ' ' },
    {},
    { 'X-Long': 'a'.repeat(200), 'X-Short': 'a' }
  ]),
  {}
)

const SCRIPT_CASES: [string, unknown, string][] = [
  ['complete', ACCESS, GATEWAY],
  ['complete, wss address', ACCESS, 'wss://gateway.example.com/api/ws'],
  ['complete, upper-case address with port and path', ACCESS, 'HTTPS://Gateway.Example.com:8443/hermes'],
  [
    'padded id is trimmed, padded secret is not',
    { ...ACCESS, clientId: ' client-id-123.access ', clientSecret: ' secret-abc ' },
    GATEWAY
  ],
  ['secret that would close a string literal', { ...ACCESS, clientSecret: '";window.stolen=1;var x="' }, GATEWAY],
  [
    'secret with a backslash, control characters, U+2028, non-ASCII and an emoji',
    { ...ACCESS, clientSecret: 'a\\b\n\t\u0001\u2028é😀/' },
    GATEWAY
  ],
  ['no front door', NO_FRONT_DOOR, GATEWAY],
  ['cleartext gateway', ACCESS, 'http://gateway.example.com'],
  ['not an address', ACCESS, 'not an address'],
  ['empty address', ACCESS, ''],
  ['incomplete front door', { ...ACCESS, clientSecret: '' }, GATEWAY],
  ['https scheme without a parseable origin', ACCESS, 'https://exa mple.com']
]

for (const [label, door, address] of SCRIPT_CASES) {
  frontDoor.call('accessUserScript', accessUserScript, [door, address], {
    note:
      label === 'secret with a backslash, control characters, U+2028, non-ASCII and an emoji'
        ? `${label}. Values are embedded as JSON.stringify string literals: only " \\ and control characters are escaped (\\b \\f \\n \\r \\t, else lowercase \\u00xx); U+2028, non-ASCII and "/" are written as is`
        : label
  })
}

frontDoor.constant('CF_ACCESS_CLIENT_ID', CF_ACCESS_CLIENT_ID)
frontDoor.constant('CF_ACCESS_CLIENT_SECRET', CF_ACCESS_CLIENT_SECRET)
frontDoor.constant('CF_ACCESS_PRESENT', CF_ACCESS_PRESENT)
frontDoor.constant('CF_ACCESS_INCOMPLETE', CF_ACCESS_INCOMPLETE)
frontDoor.constant('REDACTED', REDACTED)
frontDoor.constant('NO_FRONT_DOOR', NO_FRONT_DOOR)

// ---------------------------------------------------------------------------
// backoff.json
// ---------------------------------------------------------------------------

const backoff = new Vectors('backoff')

for (const [name, value] of Object.entries({
  READY_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  PROMPT_SUBMIT_TIMEOUT_MS,
  FIRST_SESSION_TIMEOUT_MS,
  RECONNECT_CAP_MS,
  PROTOCOL_LADDER_FLOOR,
  OFFLINE_GRACE_MS,
  DIAL_FAILURE_RECENT_MS,
  MIN_DESKTOP_CONTRACT
})) {
  backoff.constant(name, value)
}

backoff.each(
  'rpcTimeoutMs',
  rpcTimeoutMs,
  [
    ['prompt.submit', true],
    ['prompt.submit', false],
    ['session.resume', false],
    ['session.create', false],
    ['session.resume', true],
    ['session.create', true],
    ['profiles.list', false],
    ['profiles.list', true],
    ['', false],
    ['', true],
    ['PROMPT.SUBMIT', false],
    ['Session.Resume', false],
    ['session.resume ', false],
    ['session.info', false],
    ['prompt.steer', true]
  ],
  {}
)

const RANDOMS = [0, 0.5, 0.999999]

const DEFAULT_BACKOFF_NOTE =
  '`random` is the value Math.random() returned during the call. result = ceiling * (0.5 + 0.5 * random) with ceiling = min(15000, 300 * 2^attempt); evaluate in IEEE double in this order'

for (let attempt = 0; attempt <= 12; attempt += 1) {
  for (const random of RANDOMS) {
    backoff.call(
      'defaultBackoffDelayMs',
      (value: number) => withRandom(random, () => defaultBackoffDelayMs(value)),
      [attempt],
      { note: attempt === 0 && random === 0 ? DEFAULT_BACKOFF_NOTE : undefined, random }
    )
  }
}

const LADDER_NOTE =
  'from @hermes/shared/reconnect-backoff (what defaultBackoffDelayMs is built on). jitter:false returns the ceiling min(capMs, baseDelayMs * 2^min(max(0, trunc(attempt)), 32)); defaults base 300, cap 15000. With jitter, result = random * ceiling and `random` is the value Math.random() returned'

for (let attempt = 0; attempt <= 12; attempt += 1) {
  backoff.call(
    'reconnectBackoffDelayMs',
    reconnectBackoffDelayMs,
    [attempt, { capMs: RECONNECT_CAP_MS, jitter: false }],
    {
      note: attempt === 0 ? `${LADDER_NOTE}. This option set is the one the connection uses.` : undefined
    }
  )
}

for (const [attempt, options] of [
  [0, { jitter: false }],
  [5, { jitter: false }],
  [10, { jitter: false }],
  [6, { baseDelayMs: 100, capMs: 1000, jitter: false }],
  [0, { baseDelayMs: 100, capMs: 1000, jitter: false }],
  [3, { baseDelayMs: 0, jitter: false }],
  [-1, { jitter: false }],
  [-100, { jitter: false }],
  [2.9, { jitter: false }],
  [2.1, { jitter: false }],
  [-0.5, { jitter: false }],
  [31, { jitter: false }],
  [32, { jitter: false }],
  [33, { jitter: false }],
  [1000, { jitter: false }],
  [4, { capMs: 0, jitter: false }],
  [4, { baseDelayMs: 300, capMs: 700, jitter: false }]
] as [number, Record<string, unknown>][]) {
  backoff.call('reconnectBackoffDelayMs', reconnectBackoffDelayMs, [attempt, options], {
    note: attempt === 2.9 ? 'attempt is truncated toward zero' : undefined
  })
}

for (const attempt of [0, 3, 6, 12]) {
  for (const random of RANDOMS) {
    backoff.call(
      'reconnectBackoffDelayMs',
      (value: number, options: Record<string, unknown>) =>
        withRandom(random, () => reconnectBackoffDelayMs(value, options as never)),
      [attempt, { capMs: RECONNECT_CAP_MS }],
      { random }
    )
  }
}

backoff.each(
  'assertDesktopContract',
  assertDesktopContract,
  [
    [{ desktop_contract: 7 }],
    [{ desktop_contract: 8 }],
    [{ desktop_contract: 9 }],
    [{ desktop_contract: '9' }],
    [{ desktop_contract: '7' }],
    [{ desktop_contract: 6 }],
    [{ desktop_contract: '6' }],
    [{ desktop_contract: 0 }],
    [{ desktop_contract: -1 }],
    [{ desktop_contract: '  8 ' }],
    [{ desktop_contract: '8abc' }],
    [{ desktop_contract: '7.9' }],
    [{ desktop_contract: 7.5 }],
    [{ desktop_contract: 6.9 }],
    [{ desktop_contract: 'abc' }],
    [{ desktop_contract: '' }],
    [{ desktop_contract: null }],
    [{ desktop_contract: true }],
    [{ desktop_contract: [7] }],
    [{}],
    [null],
    [{ model: 'x' }],
    [{ lazy: true, model: 'x' }, 7],
    [{ lazy: true, model: 'x' }, 9],
    [{ lazy: true, model: 'x' }],
    [{ lazy: true, model: 'x' }, null],
    [{ lazy: true, model: 'x' }, 6],
    [{ lazy: true, model: 'x' }, 7.5],
    [{ lazy: true, model: 'x' }, '7'],
    [{ lazy: true, desktop_contract: 5 }, 7],
    [{ lazy: true, desktop_contract: 8 }, 6],
    [{ lazy: true, desktop_contract: 'x' }, 9],
    [{ lazy: 'true', model: 'x' }, 7],
    [{ lazy: false, model: 'x' }, 7],
    [{ desktop_contract: 7 }, 3],
    [{ desktop_contract: 8, lazy: true, model: 'x' }, null],
    [null, 7],
    [{}, 9]
  ],
  {}
)

backoff.noteFor(
  'assertDesktopContract',
  'info is a SessionLiveInfo-like object (only desktop_contract and lazy are read); known is optional. A string desktop_contract is read with parseInt(s, 10): leading whitespace and trailing junk are tolerated ("8abc" is 8). A number is taken as is (7.5 stays 7.5). Result is the contract checked, or null when a lazy resume was let through on trust. Throws an incompatible GatewayError'
)

// ---------------------------------------------------------------------------
// pkce.json
// ---------------------------------------------------------------------------

const pkce = new Vectors('pkce')

const hexCases: [string, string][] = [
  ['', 'zero bytes'],
  ['00', 'one byte'],
  ['ff', 'one byte, base64 "/w==" so base64url "_w"'],
  ['fe', 'one byte, base64url "_g"'],
  ['0000', 'two bytes'],
  ['fbff', 'two bytes giving "+" and "/" in standard base64: "+/8=" so base64url "-_8"'],
  ['fbef', 'two bytes giving "+" in standard base64'],
  ['000000', 'three bytes, no padding'],
  ['fbefbe', 'three bytes giving "++++" in standard base64, so "----"'],
  ['ffffff', 'three bytes giving "////" in standard base64, so "____"'],
  ['fffffe', 'three bytes'],
  ['00000000', 'four bytes'],
  [hexOf(sequence(31, index => index * 7 + 3)), '31 bytes'],
  [hexOf(sequence(32, index => index * 7 + 3)), '32 bytes (a verifier)'],
  [hexOf(sequence(33, index => index * 7 + 3)), '33 bytes'],
  [hexOf(sequence(24, index => index * 53 + 5)), '24 bytes (a state)'],
  [hexOf(sequence(32, index => index * 37 + 11)), '32 bytes'],
  [hexOf(sequence(32, () => 0xff)), '32 bytes of 0xff'],
  [hexOf(sequence(256, index => index)), 'all 256 byte values; contains every "+" and "/" position']
]

for (const [hex, note] of hexCases) {
  pkce.call('base64url', (value: string) => base64url(bytesFromHex(value)), [hex], {
    note: hex === '' ? `args[0] is the input bytes as a lowercase hex string. ${note}` : note
  })
}

const CREATE_PKCE_NOTE =
  'args[0] gives the two byte sequences the injected randomBytes returned, as lowercase hex: first call randomBytes(32) -> verifierBytesHex, second call randomBytes(24) -> stateBytesHex. verifier = base64url(verifier bytes); challenge = base64url(SHA-256 of the ASCII/UTF-8 bytes of the verifier STRING, not of the raw bytes); state = base64url(state bytes)'

const pkceCases: [string, string, string][] = [
  [hexOf(sequence(32, index => index * 37 + 11)), hexOf(sequence(24, index => index * 53 + 5)), 'pattern A'],
  [
    hexOf(sequence(32, index => index * 7 + 3)),
    hexOf(sequence(24, index => index * 7 + 3)),
    'the byte pattern pkce.test.ts uses'
  ],
  [hexOf(sequence(32, () => 0)), hexOf(sequence(24, () => 0)), 'all zero bytes'],
  [hexOf(sequence(32, () => 0xff)), hexOf(sequence(24, () => 0xff)), 'all 0xff bytes: verifier and state are all "_"'],
  [hexOf(sequence(32, index => index)), hexOf(sequence(24, index => 255 - index)), 'ascending and descending'],
  [
    hexOf(
      Uint8Array.from([
        116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
        91, 88, 5, 88, 83, 132, 141, 121
      ])
    ),
    hexOf(sequence(24, index => index)),
    'RFC 7636 Appendix B: these 32 octets give the verifier dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk and the challenge E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  ]
]

pkceCases.forEach(([verifierBytesHex, stateBytesHex, note], index) => {
  pkce.call(
    'createPkce',
    (spec: { verifierBytesHex: string; stateBytesHex: string }) => {
      const queue = [bytesFromHex(spec.verifierBytesHex), bytesFromHex(spec.stateBytesHex)]

      return createPkce(length => {
        const next = queue.shift()

        if (!next || next.length !== length) {
          throw new Error(`createPkce asked for ${length} bytes, vector has ${next?.length}`)
        }

        return next
      })
    },
    [{ verifierBytesHex, stateBytesHex }],
    { note: index === 0 ? `${CREATE_PKCE_NOTE}. ${note}` : note }
  )
})

// The RFC 7636 Appendix B vector is the one fixed point outside this code.
{
  const rfc = pkce.entries.find(entry => entry.fn === 'createPkce' && entry.note?.startsWith('RFC 7636'))
  const result = rfc?.result as { verifier: string; challenge: string } | undefined

  if (
    result?.verifier !== 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' ||
    result.challenge !== 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  ) {
    throw new Error('createPkce does not reproduce the RFC 7636 Appendix B vector')
  }
}

pkce.constant('REDIRECT_URI', REDIRECT_URI)

pkce.each(
  'buildAuthorizeUrl',
  buildAuthorizeUrl,
  [
    ['https://example.com', { provider: 'self-hosted', challenge: 'chal', state: 'st8' }],
    ['https://example.com/hermes', { challenge: 'c', state: 's' }],
    ['http://127.0.0.1:9119', { challenge: 'c', state: 's' }],
    ['http://gateway.example.net:9119/', { provider: 'authentik', challenge: 'c', state: 's' }],
    ['gateway.example.net', { challenge: 'c', state: 's' }],
    ['https://example.com', { provider: '', challenge: 'c', state: 's' }],
    ['https://example.com', { provider: 'a b&c=d', challenge: 'c', state: 's' }],
    [
      'https://example.com',
      { challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', state: 'dBjftJeZ4CVP-mJ92K27uhbUJU1p1r_wW' }
    ],
    ['https://example.com', { challenge: 'c', state: 's', redirectUri: 'http://[::1]:1234/cb' }],
    ['https://example.com', { challenge: 'c', state: 's', redirectUri: 'hermie://auth/callback?x=1&y=2' }],
    ['https://example.com', { challenge: 'c', state: 'ünï ✓😀' }],
    ['https://example.com', { challenge: "a~b*c-d.e_f!g'h(i)j", state: 'a+b/c=d' }],
    ['https://example.com', { challenge: '', state: '' }],
    ['https://example.com/prefix/', { provider: 'p', challenge: 'c', state: 's' }],
    ['https://example.com?x=1#f', { challenge: 'c', state: 's' }],
    ['https://example.com:443', { challenge: 'c', state: 's' }],
    ['ws://example.com', { challenge: 'c', state: 's' }],
    ['', { challenge: 'c', state: 's' }]
  ],
  {}
)

pkce.noteFor(
  'buildAuthorizeUrl',
  'query order: provider (only when non-empty), code_challenge, code_challenge_method=S256, redirect_uri (default REDIRECT_URI), state. The query is serialised by URLSearchParams (application/x-www-form-urlencoded): space is "+", and only A-Z a-z 0-9 * - . _ stay unescaped; everything else, including ~ ! \' ( ) / :, is %XX over UTF-8, uppercase hex. The base goes through normalizeBaseUrl and gets "/auth/native/authorize" appended'
)

pkce.each(
  'isLoopbackRedirect',
  isLoopbackRedirect,
  single([
    'http://127.0.0.1:38007/callback?code=a',
    'http://[::1]:38007/callback',
    'http://127.0.0.1/callback',
    'http://localhost:38007/callback',
    'https://127.0.0.1:38007/callback',
    'https://example.com/auth/callback',
    'HTTP://127.0.0.1:38007/callback',
    'http://127.0.0.1:38007',
    'http://127.0.0.1/',
    'http://127.0.0.1:/x',
    'http://127.0.0.2:1/',
    'http://[::1]/',
    'http://[::1]:38007/',
    'http://127.0.0.1.example.com/',
    'http://127.0.0.1@evil.example.com/',
    ' http://127.0.0.1:38007/callback',
    '',
    'http://127.0.0.1:99999999999/x',
    'http://127.0.0.1:0/x',
    'http://127.0.0.1:65535/x',
    'http://127.0.0.1:65536/x',
    'http://[::1]:99999/x',
    'http://127.0.0.1:000038007/x',
    'http://0.0.0.0:38007/callback',
    'http://[::2]:38007/callback',
    'http://127.0.0.1:38007/callback#frag',
    'http://127.0.0.1:38007?code=a',
    REDIRECT_URI
  ]),
  {
    'http://127.0.0.1:38007': 'no path: the pattern needs a "/" right after the host and optional port',
    'http://127.0.0.1:99999999999/x': 'a port is one to five digits and at most 65535, as the URL parser takes it',
    'http://127.0.0.1:65536/x': 'one above the highest port',
    'http://127.0.0.1:000038007/x':
      'more than five digits is refused even when the value is a valid port; the URL parser would accept the leading zeros'
  }
)

pkce.each(
  'isLoopbackUrl',
  isLoopbackUrl,
  single([
    REDIRECT_URI,
    'http://127.0.0.1:38007/callback?code=a&state=b',
    'http://127.0.0.1:000038007/callback?code=a&state=b',
    'http://127.0.0.1:0038007/callback',
    'http://127.0.0.1:65536/callback',
    'http://127.0.0.1:99999999999/callback',
    'http://127.0.0.1:/callback',
    'http://127.0.0.1',
    'http://127.0.0.2:38007/callback',
    'http://127.255.255.255/',
    'http://126.255.255.255/',
    'http://128.0.0.1/',
    'http://127.1:38007/callback',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://2130706433/',
    'http://0.0.0.0:38007/callback',
    'http://0/',
    'http://localhost:38007/callback',
    'http://LOCALHOST./',
    'http://sub.localhost/',
    'http://localhost.example.com/',
    'http://[::1]:38007/callback',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:0.0.0.0]/',
    'http://[::]/',
    'http://[::2]/',
    'http://[fe80::1]/',
    'https://127.0.0.1:38007/callback',
    'HTTP://127.0.0.1:38007/callback',
    'ws://127.0.0.1:38007/',
    'ftp://127.0.0.1/',
    'file:///etc/hosts',
    'hermie://127.0.0.1/callback',
    'http://127.0.0.1.example.com/',
    'http://127.0.0.1@evil.example.com/',
    'http://evil.example.com@127.0.0.1/',
    'http://127.0.0.1\\@evil.example.com/',
    'http://127.0.0.1\t:38007/callback',
    'http://127.0.0.1%2e1/',
    ' http://127.0.0.1:38007/callback ',
    'https://idp.example.com/login?next=http://127.0.0.1:38007/',
    'https://hermes.example.com/auth/native/authorize',
    'http://10.0.0.1/',
    'not a url',
    ''
  ]),
  {
    'http://127.0.0.1:000038007/callback?code=a&state=b':
      'the URL parser reads leading zeros away: port 38007, and isLoopbackRedirect does not recognise it as the callback',
    'http://127.0.0.1:65536/callback': 'not a URL (port above 65535), so not a place to load',
    'http://127.1:38007/callback': 'WHATWG quirk: IPv4 shorthand, 127.0.0.1',
    'http://0x7f.0.0.1/': 'WHATWG quirk: a hex part, 127.0.0.1',
    'http://0177.0.0.1/': 'WHATWG quirk: an octal part, 127.0.0.1',
    'http://2130706433/': 'WHATWG quirk: one number is a whole IPv4 address, 127.0.0.1',
    'http://0.0.0.0:38007/callback': 'the unspecified address: a connect to it lands on loopback on Linux and Android',
    'http://0/': 'WHATWG quirk: 0.0.0.0',
    'http://[::ffff:127.0.0.1]/': 'WHATWG quirk: serialised [::ffff:7f00:1], IPv4-mapped loopback',
    'http://[::ffff:0.0.0.0]/': 'WHATWG quirk: serialised [::ffff:0:0], IPv4-mapped unspecified',
    'http://[::]/': 'the unspecified IPv6 address',
    'http://evil.example.com@127.0.0.1/': 'the userinfo is dropped: the host is 127.0.0.1',
    'http://127.0.0.1\\@evil.example.com/': 'WHATWG quirk: "\\" is "/" for http, so the host is 127.0.0.1',
    'http://127.0.0.1\t:38007/callback': 'WHATWG quirk: tab removed before parsing',
    'http://127.0.0.1%2e1/':
      'WHATWG quirk: the host is percent-decoded first, so it reads 127.0.0.1.1, which is not an address and fails to parse',
    'https://127.0.0.1:38007/callback': 'https counts too: a page there would be on this device just the same',
    'ws://127.0.0.1:38007/': 'only http and https are places a web view loads'
  }
)

pkce.each(
  'parseLoopbackRedirect',
  parseLoopbackRedirect,
  single([
    'http://127.0.0.1:38007/callback?code=abc&state=xyz',
    'http://127.0.0.1:38007/callback?error=access_denied&error_description=Nope',
    'http://127.0.0.1:38007/callback',
    'http://127.0.0.1:38007/callback?code=abc',
    'http://127.0.0.1:38007/callback?state=xyz',
    'http://127.0.0.1:38007/callback?code=&state=xyz',
    'http://127.0.0.1:38007/callback?code=abc&state=',
    'http://127.0.0.1:38007/callback?error=access_denied',
    'http://127.0.0.1:38007/callback?error=&code=abc&state=xyz',
    'http://127.0.0.1:38007/callback?code=abc&state=xyz&error=server_error&error_description=Boom',
    'http://127.0.0.1:38007/callback?error_description=Nope',
    'http://127.0.0.1:38007/callback?code=a&code=b&state=x&state=y',
    'http://127.0.0.1:38007/callback?code=a%20b%2Bc&state=x%2Fy',
    'http://127.0.0.1:38007/callback?code=a+b&state=x+y',
    'http://127.0.0.1:38007/callback?error=bad&error_description=Too+bad%2C%20really',
    'http://127.0.0.1:38007/callback?code=%C3%A9%F0%9F%98%80&state=s',
    'http://127.0.0.1:38007/callback?code=%ZZ&state=s',
    'http://127.0.0.1:38007/callback?code=abc&state=xyz#frag',
    'http://127.0.0.1:38007/callback#code=abc&state=xyz',
    'http://[::1]:38007/callback?code=abc&state=xyz',
    'http://localhost:38007/callback?code=abc&state=xyz',
    'https://example.com/auth/callback?code=abc&state=xyz',
    'http://127.0.0.1:38007/other?code=abc&state=xyz',
    'http://127.0.0.1:1234/callback?code=abc&state=xyz',
    'hermie://auth/callback?code=abc&state=xyz',
    'http://127.0.0.1:38007/callback?code=abc&state=xyz&extra=1',
    'http://127.0.0.1:000038007/callback?code=abc&state=xyz',
    'http://127.0.0.1:65536/callback?code=abc&state=xyz',
    'http://127.0.0.1:99999999999/callback?code=abc&state=xyz',
    'http://127.0.0.1:38007/callback?&&code=abc&&state=xyz&&',
    'http://127.0.0.1:38007/callback?CODE=abc&STATE=xyz',
    'not a url',
    '',
    '/callback?code=abc&state=xyz',
    '?code=abc&state=xyz'
  ]),
  {
    'http://127.0.0.1:38007/callback?code=a+b&state=x+y': 'URLSearchParams decodes "+" as a space',
    'http://127.0.0.1:38007/callback?code=%ZZ&state=s':
      'a malformed percent-escape is kept literally by URLSearchParams',
    'http://127.0.0.1:38007/callback?code=a&code=b&state=x&state=y': 'get() returns the first of a repeated key',
    'http://127.0.0.1:38007/callback?error=&code=abc&state=xyz': 'an empty error is falsy, so it is not an error',
    'http://127.0.0.1:38007/callback#code=abc&state=xyz': 'only the query is read, never the fragment',
    'https://example.com/auth/callback?code=abc&state=xyz':
      'parse does not check host, scheme or path; isLoopbackRedirect does',
    'hermie://auth/callback?code=abc&state=xyz': 'a non-special scheme still parses and still has a query',
    'http://127.0.0.1:000038007/callback?code=abc&state=xyz':
      'the URL parser accepts leading zeros in a port, so this parses; isLoopbackRedirect refuses it and isLoopbackUrl does not',
    'http://127.0.0.1:65536/callback?code=abc&state=xyz': 'a port above 65535 is not a URL: throws',
    'http://127.0.0.1:99999999999/callback?code=abc&state=xyz': 'a port above 65535 is not a URL: throws',
    'not a url': 'throws a protocol GatewayError whose message embeds the input'
  }
)

// ---------------------------------------------------------------------------
// probe-hints.json
// ---------------------------------------------------------------------------

interface ErrorDescriptor {
  class: 'GatewayError' | 'Error'
  kind?: GatewayErrorKind
  message: string
  status?: number
  closeCode?: number
  redirectedTo?: string
  redirectedOrigin?: string
  hint?: string
  sawLandingPage?: boolean
}

/** Build the real error a descriptor stands for; anything that is not a descriptor passes through. */
function errorFrom(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('class' in value)) {
    return value
  }

  const descriptor = value as ErrorDescriptor

  if (descriptor.class === 'Error') {
    return new Error(descriptor.message)
  }

  return new GatewayError(descriptor.kind as GatewayErrorKind, descriptor.message, {
    ...(descriptor.status === undefined ? {} : { status: descriptor.status }),
    ...(descriptor.closeCode === undefined ? {} : { closeCode: descriptor.closeCode }),
    ...(descriptor.redirectedTo === undefined ? {} : { redirectedTo: descriptor.redirectedTo }),
    ...(descriptor.redirectedOrigin === undefined ? {} : { redirectedOrigin: descriptor.redirectedOrigin }),
    ...(descriptor.hint === undefined ? {} : { hint: descriptor.hint }),
    ...(descriptor.sawLandingPage === undefined ? {} : { sawLandingPage: descriptor.sawLandingPage })
  })
}

const probeHints = new Vectors('probe-hints')

const gatewayError = (
  kind: GatewayErrorKind,
  extra: Omit<ErrorDescriptor, 'class' | 'kind' | 'message'> = {}
): ErrorDescriptor => ({ class: 'GatewayError', kind, message: `a ${kind} failure`, ...extra })

const PRIVATE_ADDRESSES = [
  'https://10.0.0.4:9119',
  'http://100.71.2.9:9119',
  'https://hermes.tailnet-name.ts.net',
  'http://hermes.internal',
  'http://hermes.local',
  'http://hermes',
  'http://169.254.4.4',
  'http://192.168.1.20:9119',
  'http://[fd7a:115c:a1e0::1]:9119',
  'http://[fd12:3456:789a::1]:9119',
  'http://[fe80::1]:9119',
  'my-box.local:9119',
  'something.ts.net'
]

const OTHER_ADDRESSES = [
  'https://hermes.example.com',
  'https://hermes.example.org',
  'http://localhost:9119',
  'http://127.0.0.1:9119',
  'http://[::1]:9119',
  'https://8.8.8.8',
  '',
  'gateway.example.net'
]

const probeCases: [ErrorDescriptor | string | null, { address: string; network?: string }][] = []

probeCases.push([gatewayError('not_hermes', { sawLandingPage: true }), { address: 'https://10.0.0.4' }])

for (const address of [...PRIVATE_ADDRESSES, ...OTHER_ADDRESSES]) {
  probeCases.push([gatewayError('not_hermes', { sawLandingPage: true }), { address }])
}

for (const address of ['https://10.0.0.4', 'https://hermes.example.com']) {
  probeCases.push([gatewayError('not_hermes', { sawLandingPage: false }), { address }])
  probeCases.push([gatewayError('not_hermes'), { address }])
}

for (const network of [undefined, 'wifi', 'cellular', 'other', 'unknown']) {
  for (const address of ['https://hermes.tailnet-name.ts.net', 'https://hermes.example.com', 'http://localhost:9119']) {
    probeCases.push([gatewayError('network'), network === undefined ? { address } : { address, network }])
  }
}

for (const address of [...PRIVATE_ADDRESSES, ...OTHER_ADDRESSES]) {
  probeCases.push([gatewayError('network'), { address, network: 'cellular' }])
}

probeCases.push([
  gatewayError('network', { sawLandingPage: true }),
  { address: 'https://10.0.0.4', network: 'cellular' }
])
probeCases.push([gatewayError('network', { status: 502 }), { address: 'https://10.0.0.4', network: 'cellular' }])
probeCases.push([gatewayError('timeout'), { address: 'https://10.0.0.4', network: 'cellular' }])
probeCases.push([gatewayError('network'), { address: 'https://hermes.example.org', network: 'cellular' }])

probeCases.push([gatewayError('redirect', { redirectedTo: 'hermes.other.example' }), { address: 'https://a.example' }])
probeCases.push([gatewayError('redirect'), { address: 'https://a.example' }])
probeCases.push([gatewayError('redirect', { redirectedTo: '' }), { address: 'https://a.example' }])
probeCases.push([gatewayError('redirect', { redirectedTo: 'x.example' }), { address: 'https://10.0.0.4' }])
probeCases.push([
  gatewayError('redirect', { redirectedTo: 'x.example' }),
  { address: 'https://10.0.0.4', network: 'cellular' }
])
probeCases.push([
  gatewayError('redirect', { redirectedTo: 'other.example', redirectedOrigin: 'https://other.example:8443' }),
  { address: 'https://a.example' }
])
probeCases.push([
  gatewayError('redirect', { redirectedTo: 'fd00::1', redirectedOrigin: 'http://[fd00::1]:9119' }),
  { address: 'https://a.example' }
])
probeCases.push([
  gatewayError('redirect', { redirectedTo: 'a.example', redirectedOrigin: 'http://a.example' }),
  { address: 'https://a.example' }
])
probeCases.push([
  gatewayError('redirect', { redirectedTo: 'other.example', redirectedOrigin: '' }),
  { address: 'https://a.example' }
])
probeCases.push([
  gatewayError('redirect', { redirectedOrigin: 'https://other.example' }),
  { address: 'https://a.example' }
])

for (const status of [401, 403]) {
  probeCases.push([gatewayError('auth', { status }), { address: 'https://hermes.example.com' }])
}

probeCases.push([gatewayError('auth', { status: 401 }), { address: 'https://10.0.0.4', network: 'cellular' }])
probeCases.push([gatewayError('auth'), { address: 'https://hermes.example.com' }])
probeCases.push([gatewayError('auth', { status: 500 }), { address: 'https://hermes.example.com' }])
probeCases.push([gatewayError('auth', { status: 404 }), { address: 'https://hermes.example.com' }])
probeCases.push([gatewayError('auth', { closeCode: 4401 }), { address: 'https://hermes.example.com' }])

for (const kind of ['tls', 'server', 'config', 'incompatible', 'protocol'] as const) {
  probeCases.push([gatewayError(kind), { address: 'https://10.0.0.4', network: 'cellular' }])
}

probeCases.push([gatewayError('timeout'), { address: 'https://hermes.tailnet-name.ts.net', network: 'cellular' }])
probeCases.push([gatewayError('server', { status: 500, hint: 'something' }), { address: 'https://10.0.0.4' }])
probeCases.push([
  { class: 'Error', message: 'boom' },
  { address: 'https://10.0.0.4', network: 'cellular' }
])
probeCases.push([null, { address: 'https://10.0.0.4', network: 'cellular' }])
probeCases.push(['network', { address: 'https://10.0.0.4', network: 'cellular' }])

probeCases.forEach(([descriptor, options], index) => {
  probeHints.call(
    'classifyProbeFailure',
    (error: unknown, opts: unknown) => classifyProbeFailure(errorFrom(error), opts as never),
    [descriptor, options],
    {
      note:
        index === 0
          ? 'args[0] is a descriptor of the error, built into the real class by the script: {"class":"GatewayError","kind":<GatewayErrorKind>,"message":...,"status"?,"closeCode"?,"redirectedTo"?,"redirectedOrigin"?,"hint"?,"sawLandingPage"?}, {"class":"Error","message":...} for a plain Error, or a bare JSON value (null, a string) passed through unchanged. args[1] is the options object as is; options.network is absent when unreported. A field absent from the descriptor is undefined on the error'
          : undefined
    }
  )
})

// ---------------------------------------------------------------------------
// author-id.json
// ---------------------------------------------------------------------------

const authorId = new Vectors('author-id')

const PY_STRIPPED: number[] = [
  0x09,
  0x0a,
  0x0b,
  0x0c,
  0x0d,
  0x1c,
  0x1d,
  0x1e,
  0x1f,
  0x20,
  0x85,
  0xa0,
  0x1680,
  ...Array.from({ length: 11 }, (_value, index) => 0x2000 + index),
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000
]

const PY_KEPT: number[] = [0xfeff, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0x00, 0x2800]

const hexPoint = (point: number): string => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`

authorId.each(
  'authorIdOf',
  authorIdOf,
  [
    [{ provider: 'authentik', userId: '7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40' }],
    [{ provider: 'basic', userId: 'alice' }],
    [{ provider: 'authentik', userId: 'alice' }],
    [{ provider: '\tAuthentik ', userId: '  Alice \n' }],
    [{ provider: 'Basic', userId: 'Alice' }],
    [{ provider: '\u001cbasic\u0085', userId: '\u001falice' }],
    [{ provider: 'basic', userId: '\uFEFFalice' }],
    [{ userId: 'alice' }],
    [{ provider: 'basic' }],
    [{}],
    [{ provider: '   ', userId: 'alice' }],
    [{ provider: 'basic', userId: '' }],
    [{ provider: 'basic', userId: ' \t\n ' }],
    [{ provider: '', userId: '' }],
    [{ provider: 'a:b', userId: 'c:d' }],
    [{ provider: 'basic', userId: 'alex@example.com' }],
    [{ provider: 'oidc', userId: 'ünï-✓-😀' }],
    [{ provider: ' basic ', userId: 'a b' }],
    [{ provider: 'basic', userId: 'a\u00a0b' }],
    [{ provider: null, userId: 'alice' }],
    [{ provider: 'basic', userId: null }]
  ],
  {}
)

for (const point of PY_STRIPPED) {
  const character = String.fromCodePoint(point)

  authorId.call('authorIdOf', authorIdOf, [{ provider: 'basic', userId: `${character}alice${character}` }], {
    note: `${hexPoint(point)} at both ends of userId: stripped, because Python's str.isspace() is true for it`
  })
}

for (const point of PY_KEPT) {
  const character = String.fromCodePoint(point)

  authorId.call('authorIdOf', authorIdOf, [{ provider: 'basic', userId: `${character}alice${character}` }], {
    note: `${hexPoint(point)} at both ends of userId: kept, because Python's str.isspace() is false for it`
  })
}

authorId.each(
  'ownAuthorOf',
  ownAuthorOf,
  [
    [{ provider: 'authentik', userId: '7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40', displayName: ' Alex Moreno ' }],
    [{ provider: 'authentik', userId: '7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40', displayName: '' }],
    [{ provider: 'authentik', userId: '7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40', displayName: '   ' }],
    [{ provider: 'authentik', userId: 'alice' }],
    [{ provider: '', userId: 'alice', displayName: 'Alice' }],
    [{ provider: 'basic', userId: '', displayName: 'Alice' }],
    [{ provider: 'basic', userId: 'alice', displayName: '\u001cAlice\u0085' }],
    [{ provider: 'basic', userId: 'alice', displayName: '\uFEFFAlice' }],
    [{ provider: 'basic', userId: 'alice', displayName: 'Alex  Moreno' }],
    [{ provider: 'basic', userId: 'alice', displayName: 'Álex 😀' }],
    [{ provider: 'basic', userId: 'alice', displayName: null }],
    [{ provider: ' basic ', userId: ' alice ', displayName: ' Alice ' }],
    [{}]
  ],
  {}
)

// The agent marker (`author.via` / `replayed_by.via`; contract/gateway/mcp.md): the same cleaning rule
// the transcript engine applies to a history row, for a stamp read from anywhere else.
authorId.each(
  'authorViaOf',
  authorViaOf,
  [
    [{ kind: 'mcp', client: 'Claude Code' }],
    [{ kind: 'mcp', client: 'Claude Code', version: '2.1', extra: { a: 1 } }],
    [{ kind: 'api', client: 'Zapier' }],
    [{ kind: ' mcp ', client: '  Claude   Code  ' }],
    [{ kind: 'mcp', client: 'Claude\u202e \u200bCode\n*Pro*' }],
    [{ kind: 'mcp', client: '𝒞'.repeat(200) }],
    [{ kind: 'mcp', client: 'x'.repeat(80) }],
    [{ kind: 'mcp', client: 'x'.repeat(81) }],
    [{ kind: 'mcp', client: ' \u200b\n ' }],
    [{ kind: 'mcp', client: '' }],
    [{ kind: 'mcp', client: 7 }],
    [{ kind: 'mcp' }],
    [{ client: 'Claude Code' }],
    [{ kind: '', client: 'Claude Code' }],
    [{ kind: 7, client: 'Claude Code' }],
    ['mcp'],
    [[]],
    [null],
    [{}]
  ],
  {}
)

authorId.each(
  'authorStampOf',
  authorStampOf,
  [
    [{ id: 'oidc:user-a', name: 'Robin' }],
    [{ id: 'oidc:user-a' }],
    [{ id: 'oidc:user-a', name: 'Robin', via: { kind: 'mcp', client: 'Claude Code' } }],
    [{ id: 'oidc:user-a', name: 'Robin', via: { kind: 'mcp', client: 'Claude Code', version: '2.1' }, locale: 'nl' }],
    [{ id: 'oidc:user-a', name: 'Robin', via: 'mcp' }],
    [{ id: 'oidc:user-a', name: 'Robin', via: { kind: 'mcp', client: ' ' } }],
    [{ id: 'oidc:user-a', name: '', via: { kind: 'mcp', client: 'Claude Code' } }],
    [{ id: 'oidc:user-a', name: 7 }],
    [{ id: '', via: { kind: 'mcp', client: 'Claude Code' } }],
    [{ id: 7 }],
    [{ via: { kind: 'mcp', client: 'Claude Code' } }],
    ['oidc:user-a'],
    [[]],
    [null]
  ],
  {}
)

// ---------------------------------------------------------------------------
// push.json
// ---------------------------------------------------------------------------

const push = new Vectors('push')

const typesOn = (...on: PushType[]): Record<PushType, boolean> =>
  Object.fromEntries(PUSH_TYPES.map(type => [type, on.includes(type)])) as Record<PushType, boolean>

const ALL_ON = typesOn(...PUSH_TYPES)
const ALL_OFF = typesOn()

const NOW = 1_790_001_453
const EXPO = { transport: 'expo', token: 'ExponentPushToken[test-0001]' }
const WEBPUSH = {
  transport: 'webpush',
  endpoint: 'https://push.example.com/send/abc123',
  keys: { p256dh: 'BP-test-p256dh-key', auth: 'test-auth-secret' }
}

push.constant('PUSH_TYPES', [...PUSH_TYPES], 'constant; the order is the order the switches are drawn in')
push.constant('PUSH_SECTION_VERSION', PUSH_SECTION_VERSION)
push.constant('PUSH_SECTION_KEY', PUSH_SECTION_KEY)
push.constant('PUSH_PER_BOT_KEY', PUSH_PER_BOT_KEY)
push.constant('PUSH_SEEN_TTL_SECONDS', PUSH_SEEN_TTL_SECONDS)
push.constant(
  'PUSH_RELAY_ORIGIN',
  PUSH_RELAY_ORIGIN,
  'constant; the default and initial content of every sender allow-list'
)
push.constant('PUSH_RELAY_PLATFORMS', [...PUSH_RELAY_PLATFORMS])

push.each(
  'effectivePushTypes',
  effectivePushTypes,
  [
    [ALL_ON],
    [ALL_OFF],
    [ALL_ON, {}],
    [ALL_ON, { message: false }],
    [ALL_OFF, { turn_done: true }],
    [typesOn('message', 'request'), { message: false, cron: true }],
    [
      ALL_ON,
      {
        message: false,
        request: false,
        cron: false,
        cron_done: false,
        cron_failed: false,
        turn_done: false,
        turn_failed: false
      }
    ],
    [
      ALL_OFF,
      {
        message: true,
        request: true,
        cron: true,
        cron_done: true,
        cron_failed: true,
        turn_done: true,
        turn_failed: true
      }
    ],
    [ALL_ON, { message: 'no', request: 0, cron: null, cron_done: [], cron_failed: {} }],
    [ALL_ON, { dm: false, unknown: false }],
    [typesOn('cron_failed'), { cron_failed: false, turn_failed: true }]
  ],
  {}
)

push.noteFor(
  'effectivePushTypes',
  'args[1] (the per-chat overrides) is optional. A non-boolean override value is ignored'
)

push.each(
  'pushStampOf',
  pushStampOf,
  single([
    0, 1, 999, 1000, 1001, 1999, 1500, 60_000, 1_790_001_453_999, 1_790_001_453_000, 0.5, -1, -1000, -1001,
    123_456_789_012
  ]),
  {}
)

push.call('noPushTypes', noPushTypes, [], { note: 'every type false, keys in PUSH_TYPES order' })

push.each(
  'pushTypesOf',
  pushTypesOf,
  single([
    null,
    {},
    { message: true },
    { message: 'true' },
    { message: 1 },
    { message: false },
    ALL_ON,
    ALL_OFF,
    { turn_done: true, cron_failed: true, dm: true },
    [],
    [true],
    'message',
    42,
    true,
    { message: true, request: null, cron: 'yes', turn_failed: true }
  ]),
  {}
)

push.each(
  'adoptedPushTypes',
  adoptedPushTypes,
  [
    [{}, ALL_ON],
    [null, ALL_ON],
    [{ message: false }, ALL_ON],
    [{ message: false, cron_done: false }, ALL_ON],
    [{ message: true }, ALL_OFF],
    [{}, ALL_OFF],
    [{ message: 'false', request: 0, cron: null }, ALL_ON],
    [{ message: 'false', request: 0, cron: null }, ALL_OFF],
    [ALL_OFF, ALL_ON],
    [ALL_ON, ALL_OFF],
    [{}, typesOn('message', 'request')],
    [{ turn_done: false }, typesOn('turn_done', 'turn_failed')],
    [[], ALL_ON],
    ['x', ALL_ON],
    [{ dm: false }, ALL_ON],
    [{}, { message: 'yes', request: 1 }]
  ],
  {}
)

push.noteFor(
  'adoptedPushTypes',
  'a boolean present in stored wins; an absent or non-boolean key takes defaults[type] === true'
)

push.each(
  'noTypeWanted',
  noTypeWanted,
  single([
    ALL_OFF,
    ALL_ON,
    typesOn('message'),
    typesOn('turn_failed'),
    {},
    { message: 'yes' },
    { message: 1 },
    { message: true },
    { dm: true }
  ]),
  {}
)

const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  installationId: 'install-aaaa',
  gatewayKey: 'bf796761db84e312',
  address: EXPO,
  platform: 'ios',
  types: typesOn('message', 'request', 'turn_done'),
  preview: false,
  updatedAt: NOW,
  ...overrides
})

push.each(
  'pushRowFor',
  pushRowFor,
  single([
    registration(),
    registration({ address: WEBPUSH, platform: 'web', preview: true }),
    registration({ gatewayKey: '' }),
    registration({ gatewayKey: undefined }),
    registration({ types: ALL_ON, preview: true, platform: 'android' }),
    registration({ types: ALL_OFF }),
    registration({ updatedAt: 0 }),
    registration({ platform: '' }),
    registration({ installationId: '' }),
    registration({ address: { transport: 'expo', token: '' } }),
    registration({
      address: {
        transport: 'webpush',
        endpoint: 'https://push.example.com/send/abc',
        keys: { p256dh: 'k', auth: 'a', extra: 'x' }
      }
    })
  ]),
  {}
)

const RELAY = {
  transport: 'relay',
  relay: 'https://push.hermie.dev',
  handle: 'h_test-handle-0001',
  secret: 'test-send-secret-0001'
}

push.each(
  'pushRowFor',
  pushRowFor,
  single([
    registration({ address: RELAY }),
    registration({ address: RELAY, platform: 'macos', gatewayKey: '' }),
    registration({ address: { ...RELAY, enc: { alg: 'chacha20-poly1305', key: 'k', kid: 1, future: [1] } } }),
    registration({ address: { ...RELAY, enc: null } })
  ]),
  {}
)

push.noteFor(
  'pushRowFor',
  'installationId is not part of the row. gatewayKey is omitted when empty or absent. An expo address gives token; a webpush address gives endpoint + keys{p256dh,auth}; a relay address gives relay + handle + secret, plus enc exactly as given when it is not undefined (null is carried); never two of them'
)

const relayRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  transport: 'relay',
  relay: 'https://push.hermie.dev',
  handle: 'h_test-handle-0001',
  secret: 'test-send-secret-0001',
  platform: 'ios',
  types: { message: true },
  preview: false,
  updatedAt: NOW,
  ...overrides
})

push.each(
  'pushAddressOf',
  pushAddressOf,
  single([
    relayRow(),
    relayRow({ platform: 'macos' }),
    relayRow({ enc: { alg: 'chacha20-poly1305', key: 'k', kid: 1 } }),
    relayRow({ relay: 'https://push.hermie.dev/' }),
    relayRow({ relay: 'https://PUSH.hermie.dev' }),
    relayRow({ v: 2 }),
    relayRow({ v: '1' }),
    relayRow({ relay: 'http://push.hermie.dev' }),
    relayRow({ relay: 'https://push.hermie.dev/v1/send' }),
    relayRow({ relay: 'https://push.hermie.dev:443' }),
    relayRow({ relay: 'https://user:pass@push.hermie.dev' }),
    relayRow({ relay: 'https://push.hermie.dev?x=1' }),
    relayRow({ relay: '' }),
    relayRow({ relay: undefined }),
    relayRow({ handle: '' }),
    relayRow({ handle: 7 }),
    relayRow({ handle: 'h', secret: 'A-_z09' }),
    relayRow({ handle: 'h'.repeat(200), secret: 's'.repeat(200) }),
    relayRow({ handle: 'h'.repeat(201) }),
    relayRow({ secret: 's'.repeat(201) }),
    relayRow({ handle: 'h_with space' }),
    relayRow({ handle: 'h_plus+' }),
    relayRow({ secret: 'pad=' }),
    relayRow({ secret: 'slash/' }),
    relayRow({ handle: 'h_\u00e9' }),
    relayRow({ secret: '' }),
    relayRow({ secret: undefined }),
    relayRow({ platform: 'android' }),
    relayRow({ platform: undefined }),
    relayRow({ token: 'ExponentPushToken[test-0001]' }),
    relayRow({ token: '' }),
    relayRow({ endpoint: 'https://push.example.com/send/abc123' }),
    { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0001]' },
    { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0001]', endpoint: '' },
    { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0001]', endpoint: 'https://push.example.com/x' },
    { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0001]', handle: 'h_x', secret: 's' },
    { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0001]', handle: '' },
    { v: 1, transport: 'expo', token: '' },
    { v: 1, ...WEBPUSH },
    { v: 1, ...WEBPUSH, token: '' },
    { v: 1, ...WEBPUSH, token: 'ExponentPushToken[test-0001]' },
    { v: 1, ...WEBPUSH, handle: 'h_x' },
    { v: 1, ...WEBPUSH, keys: { p256dh: 'p' } },
    { v: 1, transport: 'fcm', token: 'x' },
    { v: 1 },
    null,
    [],
    'relay'
  ]),
  {}
)

push.noteFor(
  'pushAddressOf',
  'the reader every sender applies to a row before using it. v must be 1. expo: non-empty token, no non-empty endpoint, no handle key at all. webpush: non-empty endpoint, p256dh and auth, no non-empty token, no handle key. relay: pushRelayOriginOf(relay) non-empty, handle and secret each matching ^[A-Za-z0-9_-]{1,200}$, platform ios or macos, and NO token or endpoint key at all (even empty); enc is carried as-is when present. Anything else is null. The allow-list is not applied here'
)

push.each(
  'pushRelayOriginOf',
  pushRelayOriginOf,
  single([
    'https://push.hermie.dev',
    'https://push.hermie.dev/',
    'https://PUSH.Hermie.DEV',
    'HTTPS://push.hermie.dev',
    'https://relay.example.org:8443',
    'https://relay.example.org:8443/',
    'https://push.hermie.dev:443',
    'https://push.hermie.dev//',
    'https://push.hermie.dev/.',
    'https://push.hermie.dev/v1/send',
    'https://push.hermie.dev?',
    'https://push.hermie.dev/?x=1',
    'https://push.hermie.dev#x',
    'https://user@push.hermie.dev',
    'https://user:pass@push.hermie.dev',
    'http://push.hermie.dev',
    'wss://push.hermie.dev',
    'push.hermie.dev',
    ' https://push.hermie.dev',
    'https://push.hermie.dev ',
    'https://127.0.0.1',
    'https://[::1]',
    '',
    null,
    42
  ]),
  {}
)

push.noteFor(
  'pushRelayOriginOf',
  'the WHATWG URL origin when the input is https, has no credentials, and its lowercased spelling is exactly that origin or that origin plus one "/"; otherwise "". So a default port, a path, a query or fragment marker, surrounding space or any other rewrite the parser would make is refused'
)

push.each(
  'pushRelayAllowed',
  pushRelayAllowed,
  [
    ['https://push.hermie.dev', ['https://push.hermie.dev']],
    ['https://push.hermie.dev/', ['https://push.hermie.dev']],
    ['https://push.hermie.dev', ['https://PUSH.hermie.dev/']],
    ['https://relay.example.org', ['https://push.hermie.dev', 'https://relay.example.org']],
    ['https://push.hermie.dev.evil.example', ['https://push.hermie.dev']],
    ['https://evil.example', ['https://push.hermie.dev']],
    ['http://push.hermie.dev', ['http://push.hermie.dev']],
    ['https://push.hermie.dev', []],
    ['https://push.hermie.dev', ['not a url']],
    ['', ['https://push.hermie.dev']]
  ],
  {}
)

push.noteFor(
  'pushRelayAllowed',
  'true when pushRelayOriginOf(args[0]) is non-empty and equals pushRelayOriginOf of some entry of the allow-list args[1]'
)

const SECTION_WITH_ROWS = {
  push: {
    registrations: {
      'install-aaaa': { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0001]' },
      'install-bbbb': { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0002]' },
      'install-cccc': { v: 7, someFutureField: true },
      'install-nul': null,
      'install-str': 'not an object',
      'install-num': 5,
      'install-arr': [1, 2],
      '': { v: 1 }
    },
    seen: { 'install-aaaa': 1 }
  }
}

push.each(
  'foreignPushRows',
  foreignPushRows,
  [
    [SECTION_WITH_ROWS, 'install-aaaa'],
    [SECTION_WITH_ROWS, 'install-zzzz'],
    [SECTION_WITH_ROWS, ''],
    [null, 'install-aaaa'],
    [{}, 'install-aaaa'],
    [[], 'install-aaaa'],
    ['push', 'install-aaaa'],
    [{ push: null }, 'install-aaaa'],
    [{ push: [] }, 'install-aaaa'],
    [{ push: {} }, 'install-aaaa'],
    [{ push: { registrations: null } }, 'install-aaaa'],
    [{ push: { registrations: [] } }, 'install-aaaa'],
    [{ push: { registrations: 'x' } }, 'install-aaaa'],
    [{ push: { registrations: { 'install-aaaa': { v: 1 } } } }, 'install-aaaa'],
    [{ push: { registrations: { 'install-bbbb': { v: 1 } } } }, 'install-aaaa'],
    [{ other: { registrations: { 'install-bbbb': { v: 1 } } } }, 'install-aaaa'],
    [{ push: { registrations: { 'install-bbbb': 0, 'install-cccc': false, 'install-dddd': '' } } }, 'install-aaaa'],
    [
      {
        push: {
          registrations: {
            'install-mac': relayRow({
              enc: { alg: 'chacha20-poly1305', key: 'k', kid: 1 },
              futureField: { kept: true }
            })
          }
        }
      },
      'install-aaaa'
    ]
  ],
  {}
)

push.noteFor(
  'foreignPushRows',
  'rows are carried unvalidated (any non-null JSON value, even an unreadable one); dropped: the empty id, this installation own id, null. undefined cannot occur in JSON. args[1] is the own installationId'
)

push.each(
  'pushSeenOf',
  pushSeenOf,
  single([
    null,
    {},
    { push: null },
    { push: {} },
    { push: { seen: null } },
    { push: { seen: [] } },
    { push: { seen: { 'install-aaaa': 1_790_001_453 } } },
    { push: { seen: { 'install-aaaa': { bot: 'researcher', at: 1_790_001_453 } } } },
    { push: { seen: { 'install-aaaa': { at: 1_790_001_453 } } } },
    { push: { seen: { 'install-aaaa': { bot: 5, at: 1_790_001_453 } } } },
    { push: { seen: { 'install-aaaa': 1_790_001_453.9 } } },
    { push: { seen: { 'install-aaaa': { bot: 'x', at: 1_790_001_453.9 } } } },
    { push: { seen: { 'install-aaaa': 0 } } },
    { push: { seen: { 'install-aaaa': -5 } } },
    { push: { seen: { 'install-aaaa': 0.5 } } },
    { push: { seen: { 'install-aaaa': { bot: 'x', at: 0 } } } },
    { push: { seen: { 'install-aaaa': { bot: 'x', at: -1 } } } },
    { push: { seen: { 'install-aaaa': { bot: 'x', at: '1790001453' } } } },
    { push: { seen: { 'install-aaaa': '1790001453' } } },
    { push: { seen: { 'install-aaaa': true } } },
    { push: { seen: { 'install-aaaa': null } } },
    { push: { seen: { 'install-aaaa': [1] } } },
    { push: { seen: { '': 1_790_001_453, 'install-bbbb': { bot: 'writer', at: 1_790_001_000 } } } },
    { push: { seen: { 'install-aaaa': 1_790_001_453, 'install-bbbb': { bot: '', at: 5 }, 'install-cccc': 'x' } } },
    { other: { seen: { 'install-aaaa': 1 } } }
  ]),
  {}
)

push.noteFor(
  'pushSeenOf',
  'a bare number n > 0 becomes {bot:"",at:floor(n)} (0.5 becomes at:0: the test is n > 0, then floor); an object needs a number at > 0; anything else is dropped; bot is "" unless a string'
)

const perBotSection = (perBot: unknown): unknown => ({ push: { perBot } })

push.each(
  'pushPerBotOf',
  pushPerBotOf,
  single([
    null,
    {},
    { push: null },
    { push: {} },
    { push: { perBot: null } },
    { push: { perBot: [] } },
    perBotSection({ researcher: { message: false } }),
    perBotSection({ researcher: { message: false, cron: true }, writer: { turn_done: true } }),
    perBotSection({ researcher: { message: 'no', request: 1, cron: null } }),
    perBotSection({ researcher: {} }),
    perBotSection({ researcher: { dm: true, unknown: true } }),
    perBotSection({ researcher: { dm: true, request: false } }),
    perBotSection({ '': { message: true } }),
    perBotSection({ researcher: 'x', writer: null, third: [], fourth: 5 }),
    perBotSection({ researcher: [true] }),
    perBotSection({
      researcher: {
        message: true,
        request: true,
        cron: true,
        cron_done: true,
        cron_failed: true,
        turn_done: true,
        turn_failed: true
      }
    }),
    { other: { perBot: { researcher: { message: false } } } }
  ]),
  {}
)

push.noteFor(
  'pushPerBotOf',
  'only boolean values under the known PUSH_TYPES survive; a bot with nothing left is dropped, and so is an empty bot name'
)

const ownRegistration = registration()

push.each(
  'pushSectionFor',
  pushSectionFor,
  single([
    { others: {}, own: null, seen: {}, now: NOW },
    { others: {}, own: registration({ types: ALL_OFF }), seen: {}, now: NOW },
    { others: {}, own: registration({ installationId: '' }), seen: {}, now: NOW },
    { others: {}, own: ownRegistration, seen: {}, now: NOW },
    { others: {}, own: registration({ address: WEBPUSH, platform: 'web', preview: true }), seen: {}, now: NOW },
    {
      others: { 'install-bbbb': { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0002]' } },
      own: null,
      seen: {},
      now: NOW
    },
    {
      others: { 'install-bbbb': { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0002]' } },
      own: ownRegistration,
      seen: {},
      now: NOW
    },
    { others: { 'install-aaaa': { v: 1, stale: true } }, own: ownRegistration, seen: {}, now: NOW },
    { others: { 'install-aaaa': { v: 1, stale: true } }, own: registration({ types: ALL_OFF }), seen: {}, now: NOW },
    { others: { 'install-cccc': { v: 7, someFutureField: true } }, own: null, seen: {}, now: NOW },
    {
      others: { 'install-mac': relayRow({ enc: { kid: 1 }, futureField: true }) },
      own: registration({ address: RELAY }),
      seen: {},
      now: NOW
    },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'researcher', at: NOW } }, now: NOW },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'researcher', at: NOW } }, now: NOW, perChat: true },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'researcher', at: NOW } }, now: NOW, perChat: false },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: '', at: NOW } }, now: NOW, perChat: true },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'x', at: NOW - 86_400 } }, now: NOW },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'x', at: NOW - 86_401 } }, now: NOW },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'x', at: NOW + 3600 } }, now: NOW },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'x', at: 0 } }, now: NOW },
    { others: {}, own: null, seen: { 'install-aaaa': { bot: 'x', at: -5 } }, now: NOW },
    {
      others: {},
      own: null,
      seen: {
        'install-aaaa': { bot: 'a', at: NOW },
        'install-bbbb': { bot: 'b', at: NOW - 90_000 },
        'install-cccc': { bot: 'c', at: NOW - 100 }
      },
      now: NOW,
      perChat: true
    },
    { others: {}, own: null, seen: {}, perBot: { researcher: { message: false } }, now: NOW },
    { others: {}, own: null, seen: {}, perBot: { researcher: {} }, now: NOW },
    { others: {}, own: null, seen: {}, perBot: { '': { message: false } }, now: NOW },
    { others: {}, own: null, seen: {}, perBot: {}, now: NOW },
    {
      others: {},
      own: null,
      seen: {},
      perBot: { researcher: { message: false, cron: true }, writer: { turn_done: true }, empty: {} },
      now: NOW
    },
    {
      others: { 'install-bbbb': { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0002]' } },
      own: ownRegistration,
      seen: { 'install-aaaa': { bot: 'researcher', at: NOW }, 'install-bbbb': { bot: '', at: NOW - 5 } },
      perBot: { researcher: { cron: false } },
      now: NOW,
      perChat: true
    },
    {
      others: { 'install-bbbb': { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0002]' } },
      own: ownRegistration,
      seen: { 'install-aaaa': { bot: 'researcher', at: NOW } },
      perBot: { researcher: { cron: false } },
      now: NOW
    }
  ]),
  {}
)

push.noteFor(
  'pushSectionFor',
  'args[0] is the PushSectionInput object; now is epoch seconds and is the only clock input (no Date.now is read). Result is absent (undefined) when there is nothing to say. Own row is written only with a non-empty installationId and at least one type on, and replaces an others row of the same id. seen entries are kept when at > 0 and now - at <= 86400 (a future stamp is kept); the shape is {bot,at} when perChat is true, a bare at otherwise. perBot is omitted when empty'
)

// ---------------------------------------------------------------------------
// ui-meta.json
// ---------------------------------------------------------------------------

const uiMeta = new Vectors('ui-meta')

uiMeta.constant('HERMIE_KEY', HERMIE_KEY)
uiMeta.constant('HERMIE_APP_KEY', HERMIE_APP_KEY)
uiMeta.constant('BOT_MARKER_KEY', BOT_MARKER_KEY)
uiMeta.constant('HERMIE_SECTION_VERSION', HERMIE_SECTION_VERSION)
uiMeta.constant('HERMIE_APP_SECTION_VERSION', HERMIE_APP_SECTION_VERSION)
uiMeta.constant('APP_UPDATED_AT', APP_UPDATED_AT)

uiMeta.each(
  'appKeyFor',
  appKeyFor,
  single([
    'owner',
    'alice',
    'authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40',
    '',
    'a:b:c',
    ' padded ',
    'ünï',
    'basic:alice'
  ]),
  {}
)

uiMeta.each(
  'appStampOf',
  appStampOf,
  single([
    null,
    { v: 1 },
    { v: 1, updatedAt: 1_790_000_000 },
    { v: 1, updatedAt: 1_790_000_000.9 },
    { v: 1, updatedAt: 0 },
    { v: 1, updatedAt: 0.5 },
    { v: 1, updatedAt: 1 },
    { v: 1, updatedAt: -5 },
    { v: 1, updatedAt: '1790000000' },
    { v: 1, updatedAt: true },
    { v: 1, updatedAt: null },
    { v: 1, updatedAt: [1] },
    { v: 1, updatedAt: 1_790_000_000_000 },
    { v: 1, themeChoice: 'midnight', updatedAt: 42 },
    {}
  ]),
  {}
)

uiMeta.noteFor('appStampOf', 'args[0] null stands for a missing section (null; an undefined section reads the same)')

uiMeta.each(
  'inheritedFromLegacy',
  inheritedFromLegacy,
  single([
    { v: 1 },
    { v: 1, themeChoice: 'midnight', order: ['researcher', 'writer'], updatedAt: 1_790_000_000 },
    { v: 1, push: { registrations: { 'install-aaaa': { v: 1 } } }, context: { users: {} }, themeChoice: 'sand' },
    { v: 1, push: { registrations: {} } },
    { v: 1, context: { users: {} } },
    { v: 5, themeChoice: 'sand' },
    { v: 0, themeChoice: 'sand' },
    { themeChoice: 'sand' },
    { v: '1', themeChoice: 'sand' },
    { v: 1, nested: { push: 1, context: 2 }, folders: [{ name: 'Work', bots: ['writer'] }] },
    { v: 1, perBot: { researcher: { message: false } } },
    { v: 1, Push: 1, CONTEXT: 2 }
  ]),
  {}
)

uiMeta.noteFor(
  'inheritedFromLegacy',
  'copy with v forced to 1; the top-level keys "push" and "context" are removed, every other key (nested ones included) is kept as is, and key matching is case-sensitive'
)

const READ_KEY = 'hermie-app:owner'

uiMeta.each(
  'readSection',
  readSection,
  [
    [{ [READ_KEY]: { v: 1, themeChoice: 'midnight' } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: 1 } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: 2 } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: 2 } }, READ_KEY, 2],
    [{ [READ_KEY]: { v: 3 } }, READ_KEY, 2],
    [{ [READ_KEY]: { v: 0 } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: -1 } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: '1' } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: null } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: true } }, READ_KEY, 1],
    [{ [READ_KEY]: { themeChoice: 'midnight' } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: 1.5 } }, READ_KEY, 2],
    [{ [READ_KEY]: { v: 0.5 } }, READ_KEY, 1],
    [{ [READ_KEY]: { v: 1.5 } }, READ_KEY, 1],
    [{ hermie: { v: 1, archived: true, colour: '#336699' } }, 'hermie', 1],
    [{ hermie: { v: 1 }, 'hermes-bots': { v: 1 } }, 'hermes-bots', 1],
    [{ hermie: { v: 1 } }, READ_KEY, 1],
    [{ [READ_KEY]: 'string' }, READ_KEY, 1],
    [{ [READ_KEY]: ['v'] }, READ_KEY, 1],
    [{ [READ_KEY]: null }, READ_KEY, 1],
    [{ [READ_KEY]: 5 }, READ_KEY, 1],
    [{ [READ_KEY]: {} }, READ_KEY, 1],
    [null, READ_KEY, 1],
    [{}, READ_KEY, 1],
    [[], READ_KEY, 1],
    [[{ v: 1 }], '0', 1],
    ['hermie-app', READ_KEY, 1],
    [42, READ_KEY, 1],
    [{ [READ_KEY]: { v: 1 } }, '', 1],
    [{ '': { v: 1 } }, '', 1],
    [{ [READ_KEY]: { v: 1 } }, READ_KEY, 0]
  ],
  {}
)

uiMeta.noteFor(
  'readSection',
  'args: [bag, key, known]. Returns bag[key] untouched when it is an object (not an array) with a number v where 0 < v <= known, else null. v is only required to be a number: 0.5 and 1.5 pass (a non-integer between 0 and known is accepted)'
)

// There is no pure merge helper in ui-meta.ts: the merge lives inside the UiMetaSync
// class (reconcile / withPendingKept), which needs a gateway object and is out of scope.

// ---------------------------------------------------------------------------
// session-search.json
// ---------------------------------------------------------------------------

const sessionSearch = new Vectors('session-search')

sessionSearch.constant('SESSION_SEARCH_LIMIT_CAP', SESSION_SEARCH_LIMIT_CAP)
sessionSearch.constant('SNIPPET_MATCH_OPEN', SNIPPET_MATCH_OPEN)
sessionSearch.constant('SNIPPET_MATCH_CLOSE', SNIPPET_MATCH_CLOSE)

const FULL_ROW = {
  session_id: 'stored-researcher-0001',
  lineage_root: 'stored-researcher-0000',
  snippet: 'the >>>invoice<<< service',
  role: 'user',
  title: 'Invoices',
  last_active: 1_790_001_453.5,
  started_at: 1_790_000_000,
  session_started: 1_789_999_000,
  message_count: 12,
  archived: true
}

sessionSearch.each(
  'sessionSearchHitOf',
  sessionSearchHitOf,
  single([
    FULL_ROW,
    { snippet: 'orphan' },
    { session_id: 's1', snippet: 'kept' },
    { id: 's2', snippet: 'by id' },
    { session_id: 's1', id: 's2' },
    { session_id: '   ', id: 's2' },
    { session_id: '', id: '' },
    { session_id: 5, id: 's2' },
    { session_id: ' padded ', title: '  Hello  ' },
    { session_id: 's', last_active: 3, session_started: 1, started_at: 2 },
    { session_id: 's', session_started: 1, started_at: 2 },
    { session_id: 's', session_started: 1 },
    { session_id: 's', last_active: 0, started_at: 2 },
    { session_id: 's', last_active: '3', started_at: 2 },
    { session_id: 's', last_active: null, started_at: 2 },
    { session_id: 's', last_active: -4 },
    { session_id: 's', message_count: 0 },
    { session_id: 's', message_count: '3' },
    { session_id: 's', message_count: 2.5 },
    { session_id: 's', archived: true },
    { session_id: 's', archived: 'true' },
    { session_id: 's', archived: 1 },
    { session_id: 's', archived: false },
    { session_id: 's', snippet: 7 },
    { session_id: 's', snippet: '' },
    { session_id: 's', snippet: '  spaced  ' },
    { session_id: 's', role: '   ', title: '', lineage_root: ' ' },
    { session_id: 's', role: 'assistant', lineage_root: 'root-1' },
    { session_id: 's', extra: 'ignored' },
    { session_id: 'ünï-✓', title: 'Ünï 😀' },
    null,
    'string',
    5,
    true,
    [],
    [{ session_id: 's' }],
    {}
  ]),
  {}
)

sessionSearch.noteFor(
  'sessionSearchHitOf',
  'optional fields are omitted from the result when absent; text fields keep their original (untrimmed) value and count as absent only when blank after trim; at = last_active ?? started_at ?? session_started (a number, even 0 or negative); archived is true only for the boolean true; snippet is "" unless a string'
)

sessionSearch.each(
  'parseSessionSearch',
  parseSessionSearch,
  single([
    { results: [{ snippet: 'orphan' }, { session_id: 's1', snippet: 'kept' }] },
    { results: [] },
    { results: [FULL_ROW, { session_id: 's2' }, null, 'x', 5, [], { id: 's3' }] },
    null,
    { detail: 'Search failed' },
    { results: 'no' },
    { results: {} },
    { results: null },
    { results: { 0: { session_id: 's' } } },
    [],
    [{ session_id: 's' }],
    'results',
    42,
    {},
    { results: [{ session_id: 'a' }, { session_id: 'b' }, { session_id: 'a' }] }
  ]),
  {}
)

sessionSearch.noteFor(
  'parseSessionSearch',
  'args[0] undefined is encoded as null; rows are read in order and unreadable rows are dropped; duplicates are kept'
)

sessionSearch.each(
  'snippetSegments',
  snippetSegments,
  single([
    'the >>>invoice<<< service',
    'cat a >>> b',
    '',
    'no markers',
    '>>>a<<<',
    '>>>a<<<>>>b<<<',
    'x >>>a<<< y >>>b<<< z',
    'only <<< close',
    'only >>> open',
    '>>><<<',
    '>>>a>>>b<<<c<<<',
    '>>>a<<< >>> tail',
    'é>>>ü<<<ñ',
    'line one\n>>>two<<<\nline three',
    '>>>   <<<',
    '<<<>>>',
    '>>>>>>a<<<',
    '>>>a<<<<<<',
    '>>>😀<<<',
    '>>>a<<<b>>>',
    '>>',
    '>>>',
    '<<<'
  ]),
  {
    '>>><<<': 'an empty match is a segment with empty text and match true',
    '>>>a>>>b<<<c<<<': 'the first opener pairs with the first closer after it; the inner opener is just text',
    '>>>>>>a<<<': 'the first opener at index 0 pairs with the first closer; the text between is ">>>a"'
  }
)

sessionSearch.each(
  'tidySnippet',
  tidySnippet,
  single([
    '  the >>>invoic<<<e\n\nservice"}',
    '>>>invoices<<< there."}',
    'sent {"a":1} along',
    '',
    '   ',
    '"}',
    '{"a":1}',
    '{"a":1,"b":2}',
    '[1, 2, 3]',
    '\\n\\n',
    ',,,hello,,,',
    ' : hello : ',
    'one\n\n  two',
    'a\u00a0\u00a0b',
    'a\u0085b',
    '\ufeffhello\ufeff',
    '\u2028a\u2029',
    '\u3000a\u3000',
    '\u200ba\u200b',
    'a\tb\vc\fd\re',
    '{ "quoted": "text" }',
    'plain text',
    ' } ',
    '">>>a<<<"',
    '"a"',
    'ünï ✓ 😀',
    ': , \\ [ ] { } "'
  ]),
  {
    'a\u00a0\u00a0b': 'JS \\s and trim() cover Unicode White_Space plus U+FEFF, but not U+0085 or U+001C..U+001F',
    'a\u0085b': 'U+0085 is NOT matched by JS \\s, so it survives',
    '\ufeffhello\ufeff': 'U+FEFF IS matched by JS \\s and trim()',
    '\u200ba\u200b': 'U+200B is not whitespace in JS',
    'a\tb\vc\fd\re': 'every run of \\s becomes one space'
  }
)

sessionSearch.each(
  'plainSnippet',
  plainSnippet,
  single([
    '>>>invoices<<< there."}',
    'sent {"a":1} along',
    'one\n\n  two',
    '',
    'the >>>invoice<<< service',
    'cat a >>> b',
    '  >>>a<<<  ',
    '{"x": ">>>match<<< here"}',
    '>>>a<<< and >>>b<<<',
    '>>>"quoted"<<<',
    '"}>>>a<<<{"',
    '>>>a<<<}',
    '>>><<<',
    'only >>> open',
    '"only <<< close"',
    'ünï >>>✓<<< 😀'
  ]),
  {}
)

// ---------------------------------------------------------------------------
// plugin.json
// ---------------------------------------------------------------------------

const plugin = new Vectors('plugin')

plugin.constant('HERMIE_PLUGIN_KEY', HERMIE_PLUGIN_KEY)
plugin.constant('PLUGIN_CONTRACT_VERSION', PLUGIN_CONTRACT_VERSION)
plugin.constant('PLUGIN_CAPABILITIES', PLUGIN_CAPABILITIES, 'constant; an object of name -> capability string')

const ADVERT = {
  v: 1,
  version: '0.2.0',
  capabilities: ['push.expo', 'push.type.turn_done', 'context.system_prompt'],
  modules: { push: 'on', context: 'on', presence: 'planned' },
  limits: { payloadBytes: 3500, contextChars: 1200 },
  updatedAt: 1_790_001_453
}

plugin.each(
  'pluginAdvertOf',
  pluginAdvertOf,
  single([
    ADVERT,
    {
      ...ADVERT,
      relayOrigins: [
        'https://push.hermie.dev/',
        'http://relay.example.org',
        'https://relay.example.org',
        'https://PUSH.hermie.dev',
        'https://relay.example.org/v1/send',
        42
      ]
    },
    { ...ADVERT, relayOrigins: 'https://push.hermie.dev' },
    { ...ADVERT, v: 2 },
    { ...ADVERT, v: '1' },
    { ...ADVERT, v: true },
    { ...ADVERT, v: 0 },
    { ...ADVERT, v: -1 },
    { ...ADVERT, v: 1.5 },
    { ...ADVERT, v: null },
    { version: '0.2.0' },
    null,
    'hermie-plugin',
    42,
    true,
    [ADVERT],
    [],
    { v: 1 },
    { v: 1, version: 5 },
    { v: 1, version: '' },
    { ...ADVERT, capabilities: ['push.expo'] },
    { ...ADVERT, capabilities: ['b', 'a', 'b', 'a', 'c'] },
    { ...ADVERT, capabilities: ['b', 'B', 'a', 'é', 'Z', 'z', 'ä', 'Á'] },
    { ...ADVERT, capabilities: ['x', 1, null, true, ['y'], { z: 1 }, 'w'] },
    { ...ADVERT, capabilities: [] },
    { ...ADVERT, capabilities: 'push.expo' },
    { ...ADVERT, capabilities: { 0: 'push.expo' } },
    { ...ADVERT, capabilities: null },
    { ...ADVERT, modules: { push: 'off', presence: 'planned' } },
    { ...ADVERT, modules: { push: 'on', bad: 5, worse: null, nested: { a: 1 }, flag: true, list: ['on'] } },
    { ...ADVERT, modules: [] },
    { ...ADVERT, modules: ['on'] },
    { ...ADVERT, modules: 'on' },
    { ...ADVERT, modules: null },
    { ...ADVERT, limits: { payloadBytes: 3500, nested: { a: [1, 2] }, text: 'x' } },
    { ...ADVERT, limits: [] },
    { ...ADVERT, limits: ['x'] },
    { ...ADVERT, limits: 'x' },
    { ...ADVERT, limits: null },
    { ...ADVERT, updatedAt: 1_790_001_453.9 },
    { ...ADVERT, updatedAt: '1790001453' },
    { ...ADVERT, updatedAt: -1.5 },
    { ...ADVERT, updatedAt: 0 },
    { ...ADVERT, updatedAt: null },
    { ...ADVERT, updatedAt: true },
    { ...ADVERT, extra: 'ignored' },
    {
      v: 1,
      version: '1.0.0',
      capabilities: ['push.expo', 'push.webpush'],
      modules: { push: 'on' },
      limits: {},
      updatedAt: 1
    }
  ]),
  {}
)

plugin.noteFor(
  'pluginAdvertOf',
  'result is null or {version, capabilities, modules, limits, relayOrigins, updatedAt}. relayOrigins: pushRelayOriginOf of each entry of an array, empty results dropped, de-duplicated in first-seen order; a non-array gives []. v must be a JSON integer 1..PLUGIN_CONTRACT_VERSION (1.5 and "1" are refused). capabilities: strings only, de-duplicated, sorted by UTF-16 code unit (so uppercase before lowercase, and non-ASCII after ASCII); a non-array gives []. modules: only string values. limits: a shallow copy of an object, [] otherwise. updatedAt: floor of a finite number, else 0'
)

const row = (name: string, meta: unknown, isDefault?: unknown): Record<string, unknown> => ({
  name,
  ...(isDefault === undefined ? {} : { is_default: isDefault }),
  ui_meta: meta
})

const ROW_ADVERT = { [HERMIE_PLUGIN_KEY]: ADVERT }
const OLD_ADVERT = { ...ADVERT, version: '0.0.1' }

plugin.each(
  'pluginAdvert',
  pluginAdvert,
  single([
    [row('writer', { 'hermes-bots': {} }), row('researcher', { 'hermes-bots': {}, [HERMIE_PLUGIN_KEY]: ADVERT }, true)],
    [row('writer', ROW_ADVERT), row('researcher', { 'hermes-bots': {} }, true)],
    [row('writer', { [HERMIE_PLUGIN_KEY]: OLD_ADVERT }), row('researcher', ROW_ADVERT, true)],
    [row('writer', { [HERMIE_PLUGIN_KEY]: OLD_ADVERT }, false), row('researcher', ROW_ADVERT, false)],
    [row('writer', ROW_ADVERT, true), row('researcher', { [HERMIE_PLUGIN_KEY]: OLD_ADVERT }, true)],
    [row('writer', { [HERMIE_PLUGIN_KEY]: OLD_ADVERT }), row('researcher', ROW_ADVERT)],
    [row('researcher', { 'hermes-bots': {} }, true)],
    [row('researcher', { [HERMIE_PLUGIN_KEY]: { ...ADVERT, v: 2 } }, true), row('writer', ROW_ADVERT)],
    [row('researcher', { [HERMIE_PLUGIN_KEY]: 'x' }, true), row('writer', ROW_ADVERT)],
    [row('researcher', null, true), row('writer', ROW_ADVERT)],
    [row('researcher', [], true), row('writer', ROW_ADVERT)],
    [row('researcher', ROW_ADVERT, 'true')],
    [row('researcher', ROW_ADVERT, 1), row('writer', { [HERMIE_PLUGIN_KEY]: OLD_ADVERT }, true)],
    [{ name: 'noMeta' }, row('writer', ROW_ADVERT)],
    [null, row('writer', ROW_ADVERT)],
    [],
    [ROW_ADVERT],
    [{ ...row('writer', ROW_ADVERT) }, 'x', 5],
    { profiles: [row('writer', ROW_ADVERT)] },
    { profiles: [row('writer', { [HERMIE_PLUGIN_KEY]: OLD_ADVERT }), row('researcher', ROW_ADVERT, true)] },
    { profiles: [] },
    { profiles: null },
    { profiles: 'x' },
    { profiles: {} },
    {},
    null,
    'x',
    42
  ]),
  {}
)

plugin.noteFor(
  'pluginAdvert',
  'args[0] is a roster: either an array of profile rows or {profiles: [rows]}; only name, is_default and ui_meta are read. The first valid advert on a row with is_default === true (boolean true) wins; otherwise the first valid advert on any row. Rows that are not objects, or whose ui_meta is not an object, are skipped. null/undefined/anything else gives null'
)

const ADVERTS_PARSED = {
  full: {
    version: '0.2.0',
    capabilities: ['context.system_prompt', 'push.expo', 'push.type.turn_done'],
    modules: { context: 'on', presence: 'planned', push: 'on' },
    limits: { contextChars: 1200, payloadBytes: 3500 },
    updatedAt: 1_790_001_453
  },
  empty: { version: '', capabilities: [], modules: {}, limits: {}, updatedAt: 0 },
  off: {
    version: '0.2.0',
    capabilities: ['push.expo'],
    modules: { push: 'off', context: 'planned' },
    limits: {},
    updatedAt: 1
  }
}

plugin.each(
  'hasPluginCapability',
  hasPluginCapability,
  [
    [ADVERTS_PARSED.full, 'push.expo'],
    [ADVERTS_PARSED.full, 'push.type.turn_done'],
    [ADVERTS_PARSED.full, 'push.webpush'],
    [ADVERTS_PARSED.full, 'push.relay'],
    [{ ...ADVERTS_PARSED.full, capabilities: ['push.expo', 'push.relay'] }, 'push.relay'],
    [ADVERTS_PARSED.full, 'PUSH.EXPO'],
    [ADVERTS_PARSED.full, 'push.expo '],
    [ADVERTS_PARSED.full, 'push'],
    [ADVERTS_PARSED.full, ''],
    [ADVERTS_PARSED.empty, 'push.expo'],
    [ADVERTS_PARSED.empty, ''],
    [null, 'push.expo'],
    [null, ''],
    [ADVERTS_PARSED.off, PLUGIN_CAPABILITIES.pushExpo],
    [ADVERTS_PARSED.full, PLUGIN_CAPABILITIES.contextPrompt],
    [ADVERTS_PARSED.full, PLUGIN_CAPABILITIES.memoryBrowse]
  ],
  {}
)

plugin.noteFor(
  'hasPluginCapability',
  'args[0] is a parsed PluginAdvert (the result shape of pluginAdvertOf) or null; exact, case-sensitive string match.'
)

plugin.each(
  'pluginModuleOn',
  pluginModuleOn,
  [
    [ADVERTS_PARSED.full, 'push'],
    [ADVERTS_PARSED.full, 'context'],
    [ADVERTS_PARSED.full, 'presence'],
    [ADVERTS_PARSED.full, 'missing'],
    [ADVERTS_PARSED.full, 'PUSH'],
    [ADVERTS_PARSED.full, ''],
    [ADVERTS_PARSED.off, 'push'],
    [ADVERTS_PARSED.off, 'context'],
    [ADVERTS_PARSED.empty, 'push'],
    [null, 'push'],
    [{ ...ADVERTS_PARSED.full, modules: { push: 'ON' } }, 'push'],
    [{ ...ADVERTS_PARSED.full, modules: { push: ' on' } }, 'push']
  ],
  {}
)

// ---------------------------------------------------------------------------
// base64.json
// ---------------------------------------------------------------------------

const base64 = new Vectors('base64')

const BASE64_CASES: [string, string][] = [
  ['', 'zero bytes: empty string'],
  ['4d', 'one byte: two "=" of padding'],
  ['4d61', 'two bytes: one "=" of padding'],
  ['4d616e', 'one full triplet: no padding'],
  [
    hexOf(new TextEncoder().encode('Man is distinguished')),
    'the textbook example, ASCII bytes of "Man is distinguished"'
  ],
  ['00', 'byte 0'],
  ['ff', 'byte 255'],
  ['fb', 'one byte, "+" in the first sextet pair'],
  ['fbff', 'two bytes: standard alphabet "+/8="'],
  ['fbefbe', 'three bytes: "++++"'],
  ['ffffff', 'three bytes: "////"'],
  ['00010203fafbfcfdfeff80402010', 'arbitrary bytes'],
  ['00000000', 'four bytes'],
  ['0000000000', 'five bytes'],
  ['000000000000', 'six bytes'],
  [hexOf(sequence(256, index => index)), 'all 256 byte values in order'],
  [hexOf(sequence(1000, index => index * 31 + 7)), 'a longer buffer']
]

for (const [hex, note] of BASE64_CASES) {
  base64.call('bytesToBase64', (value: string) => bytesToBase64(bytesFromHex(value)), [hex], {
    note: hex === '' ? `args[0] is the input bytes as a lowercase hex string. ${note}` : note
  })
}

// ---------------------------------------------------------------------------
// fetch-json.json
// ---------------------------------------------------------------------------

const fetchJson = new Vectors('fetch-json')

fetchJson.constant('DEFAULT_HTTP_TIMEOUT_MS', DEFAULT_HTTP_TIMEOUT_MS)

const FAILURE_MESSAGES = [
  'ssl',
  'SSL error',
  'The certificate for this server is invalid',
  'TLS handshake failed',
  'tls',
  'TLS',
  'Tls',
  'NSURLErrorDomain -1200',
  'x-1200y',
  'NSURLErrorDomain -1202',
  'code -1203.',
  'error(-1204)',
  'x-1205',
  '-1206',
  '-1201',
  '-1207',
  '-12020',
  '-1202x',
  '-1202_',
  '-120',
  '1202',
  'self signed',
  'self-signed certificate',
  'SELF-SIGNED',
  'self_signed',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'untrusted',
  'UNTRUSTED root',
  'Network request failed',
  'fetch failed',
  'Could not reach the gateway',
  'classless',
  'outlets',
  '',
  '   ',
  'cert',
  'certificat',
  'CERTIFICATE_VERIFY_FAILED',
  'unable to verify the first certificate',
  'handshake failure',
  'ünï ✓ tls 😀'
]

fetchJson.each('looksLikeTlsFailure', looksLikeTlsFailure, single(FAILURE_MESSAGES), {
  classless: 'substring match: "classless" contains "ssl"',
  'NSURLErrorDomain -1202': 'a certificate failure that is NOT a TLS failure by this predicate (no "-1200")',
  'x-1200y': 'plain substring "-1200", no word boundary',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'underscores are not "self signed" and "cert" is not "certificate"'
})

fetchJson.each('looksLikeCertificateFailure', looksLikeCertificateFailure, single(FAILURE_MESSAGES), {
  '-12020': 'the pattern is -120[2-6] followed by a word boundary; a digit after it is not a boundary',
  '-1202_': '"_" is a word character, so there is no boundary',
  '-1202x': 'a letter is a word character, so there is no boundary',
  'x-1205': 'nothing is required before the "-"',
  'code -1203.': '"." is a non-word character, so there is a boundary'
})

const JSON_URL = 'https://gateway.example.net/api/status'

const JSON_BODIES = [
  '{"a":1}',
  '[1,2]',
  '1',
  '"s"',
  'null',
  'true',
  'false',
  '{}',
  '[]',
  '',
  '   ',
  '<html>',
  '{bad',
  ' {"a":1} ',
  '\n{"a":1}\n',
  '\ufeff{"a":1}',
  '{"a":1}{"b":2}',
  '{"a":1,}',
  '{"a":NaN}',
  "{'a':1}",
  '{"a":1e2}',
  '{"a":1.0}',
  '{"a":1.5,"b":-2,"c":0}',
  '{"a":-0}',
  '{"big":12345678901234567890}',
  '{"a":1,"a":2}',
  '{"":1}',
  '{"é":"\\u00e9\\n\\t\\"","emoji":"\\ud83d\\ude00"}',
  '{"nested":{"list":[1,"two",null,true,{"x":[]}]}}',
  '{"a":"\\/"}',
  '[1,2,3,]',
  '{"a":01}',
  '{"a":.5}',
  '{"a":+1}',
  '{"a":"\t"}',
  'undefined',
  'Infinity',
  '"unterminated',
  '{"a":1} trailing'
]

const JSON_NOTES: Record<string, string> = {
  '\ufeff{"a":1}': 'a UTF-8 BOM is not JSON whitespace: JSON.parse refuses it',
  '{"a":1,"a":2}': 'duplicate keys: the last one wins',
  '{"a":1e2}': 'numbers are IEEE doubles: 1e2 is 100',
  '{"a":1.0}': 'numbers are IEEE doubles: 1.0 is 1 (the result carries no integer/float distinction)',
  '{"a":-0}': '-0 is written 0 by the canonical encoding',
  '{"big":12345678901234567890}': 'a number beyond 2^53 loses precision: it is the double nearest to it',
  '{"a":"\\/"}': '"\\/" is a legal JSON escape for "/"',
  '{"a":"\t"}': 'a raw tab inside a string is not legal JSON',
  ' {"a":1} ': 'JSON.parse skips leading and trailing JSON whitespace (space, tab, LF, CR)'
}

for (const kind of ['protocol', 'not_hermes'] as const) {
  fetchJson.each(
    'parseJsonBody',
    parseJsonBody,
    JSON_BODIES.map(body => [body, JSON_URL, kind]),
    kind === 'protocol' ? JSON_NOTES : {}
  )
}

for (const kind of ['protocol', 'not_hermes'] as const) {
  fetchJson.each(
    'parseJsonObject',
    parseJsonObject,
    JSON_BODIES.map(body => [body, JSON_URL, kind]),
    kind === 'protocol' ? JSON_NOTES : {}
  )
}

fetchJson.noteFor(
  'parseJsonBody',
  'args: [text, url, kind]. Throws a GatewayError of the given kind whose message embeds the url. The result is the parsed JSON value'
)

fetchJson.call('parseJsonObject', parseJsonObject, ['[1]', '', 'protocol'], {
  note: 'empty url: the message starts with a space'
})
fetchJson.call('parseJsonBody', parseJsonBody, ['x', 'https://[::1]:9119/api/status?x=1', 'not_hermes'])

fetchJson.constant('REFUSED_LOCATION_HEADER', REFUSED_LOCATION_HEADER)

interface ResponseDescriptor {
  status: number
  type?: string
  url?: string
  headers?: Record<string, string>
}

/** A response a descriptor stands for: `headers.get` is a case-insensitive lookup in the map. */
function responseFrom(descriptor: ResponseDescriptor) {
  const headers = descriptor.headers

  return {
    status: descriptor.status,
    ...(descriptor.type === undefined ? {} : { type: descriptor.type }),
    ...(descriptor.url === undefined ? {} : { url: descriptor.url }),
    ...(headers === undefined
      ? {}
      : {
          headers: {
            get: (name: string) =>
              Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null
          }
        })
  }
}

const REDIRECT_SEEN_CASES: [ResponseDescriptor, string][] = [
  [{ status: 200, url: 'https://gw.example/api/x' }, 'https://gw.example/api/x'],
  [{ status: 200, url: '' }, 'https://gw.example/api/x'],
  [{ status: 200 }, 'https://gw.example/api/x'],
  [{ status: 200, url: 'https://gw.example:443/api/y' }, 'https://gw.example/api/x'],
  [{ status: 200, url: 'https://GW.example/api/x/' }, 'https://gw.example/api/x'],
  [{ status: 200, url: 'https://other.example/api/x' }, 'https://gw.example/api/x'],
  [{ status: 200, url: 'http://gw.example/api/x' }, 'https://gw.example/api/x'],
  [{ status: 200, url: 'https://gw.example:8443/api/x' }, 'https://gw.example/api/x'],
  [{ status: 200, url: 'https://gw.example/api/x' }, 'http://gw.example/api/x'],
  [{ status: 200, url: 'not a url' }, 'https://gw.example/api/x'],
  [{ status: 200, url: 'https://other.example/' }, 'not a url'],
  [{ status: 0, type: 'opaqueredirect', url: '' }, 'https://gw.example/api/x'],
  [{ status: 0, type: 'opaqueredirect', url: 'https://gw.example/api/x' }, 'https://gw.example/api/x'],
  [{ status: 301, headers: { Location: 'https://other.example/api/x' } }, 'https://gw.example/api/x'],
  [{ status: 302, headers: { location: '/api/y' } }, 'https://gw.example/api/x'],
  [{ status: 303, headers: { location: '//other.example:8443/z' } }, 'https://gw.example/api/x'],
  [{ status: 307, headers: { location: 'http://[fd00::1]:9119/api/x' } }, 'https://gw.example/api/x'],
  [{ status: 308, headers: {} }, 'https://gw.example/api/x'],
  [{ status: 308 }, 'https://gw.example/api/x'],
  [{ status: 302, headers: { location: 'http://exa mple.com/' } }, 'https://gw.example/api/x'],
  [
    {
      status: 302,
      url: 'https://gw.example/api/x',
      headers: { 'X-Hermie-Refused-Location': 'https://other.example/a' }
    },
    'https://gw.example/api/x'
  ],
  [
    {
      status: 302,
      headers: { location: 'https://first.example/', 'x-hermie-refused-location': 'https://second.example/' }
    },
    'https://gw.example/api/x'
  ],
  [{ status: 304, headers: { location: 'https://other.example/' } }, 'https://gw.example/api/x'],
  [{ status: 300, headers: { location: 'https://other.example/' } }, 'https://gw.example/api/x'],
  [{ status: 305, headers: { location: 'https://other.example/' } }, 'https://gw.example/api/x']
]

for (const [descriptor, requested] of REDIRECT_SEEN_CASES) {
  fetchJson.call(
    'redirectSeen',
    (response: ResponseDescriptor, url: string) => redirectSeen(responseFrom(response), url),
    [descriptor, requested]
  )
}

fetchJson.noteFor(
  'redirectSeen',
  'args[0] describes the response: {status, type?, url?, headers?}; headers is a map read case-insensitively, as Headers.get reads it, and an absent field is absent on the response. args[1] is the URL that was requested. The result is {target} (the redirect target resolved against the requested URL, "" when hidden or unparseable) or null. Order: an opaque redirect, then a 301/302/303/307/308 (Location, else the refused-location header), then an origin that differs from the requested one; an empty url, or an unparseable requested URL, claims nothing, while a url with no readable origin is a redirect with target ""'
)

const REDIRECT_ERROR_CASES: [string, string, number | null][] = [
  ['https://gw.example/api/status', 'https://other.example/api/status', 200],
  ['https://gw.example/api/status', 'https://other.example:8443/api/status', 301],
  ['https://gw.example/api/status', 'http://gw.example/api/status', 200],
  ['https://gw.example/api/status', 'https://gw.example:8443/api/status', 302],
  ['http://gw.example/api/status', 'https://gw.example/api/status', 301],
  ['http://127.0.0.1:9119/api/x', 'http://127.0.0.1:9120/api/x', 307],
  ['https://gw.example/api/x', 'http://[fd00::1]:9119/api/x', 308],
  ['https://[fd00::1]/api/x', 'https://[fd00::2]/api/x', 302],
  ['https://gw.example/api/x', 'https://gw.example/api/y', 302],
  ['https://gw.example/api/x', '', 0],
  ['https://gw.example/api/x', '', 302],
  ['https://gw.example/api/x', 'not a url', 302],
  ['https://GW.Example./api/x', 'https://gw.example/api/x', null]
]

for (const [requested, target, status] of REDIRECT_ERROR_CASES) {
  fetchJson.call(
    'redirectError',
    (url: string, to: string, code: number | null) => {
      const error = redirectError(url, to, code ?? undefined)

      return {
        kind: error.kind,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.redirectedTo === undefined ? {} : { redirectedTo: error.redirectedTo }),
        ...(error.redirectedOrigin === undefined ? {} : { redirectedOrigin: error.redirectedOrigin })
      }
    },
    [requested, target, status]
  )
}

fetchJson.noteFor(
  'redirectError',
  'args: [requested URL, target ("" when unknown), status (null for undefined)]. The function RETURNS a GatewayError; the result here is its fields, a field absent when undefined. status is omitted when 0 or absent. redirectedTo is the WHATWG hostname without IPv6 brackets; redirectedOrigin is the WHATWG origin. The sentence depends on what changed: no readable target, another host, https to http on the same host, another scheme or port, or nothing about the origin at all'
)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const MODULES: [string, Vectors][] = [
  ['url', url],
  ['host-privacy', hostPrivacy],
  ['gateway-key', gatewayKey],
  ['front-door', frontDoor],
  ['backoff', backoff],
  ['pkce', pkce],
  ['probe-hints', probeHints],
  ['author-id', authorId],
  ['push', push],
  ['ui-meta', uiMeta],
  ['session-search', sessionSearch],
  ['plugin', plugin],
  ['base64', base64],
  ['fetch-json', fetchJson]
]

function main(argv: readonly string[]): number {
  const flag = argv.indexOf('--out')
  const out = flag >= 0 ? argv[flag + 1] : undefined

  if (!out || out.startsWith('--')) {
    process.stderr.write('usage: npx tsx packages/gateway-client/scripts/dump-vectors.ts --out <dir>\n')

    return 1
  }

  const directory = resolve(out, 'gateway', 'vectors')
  let total = 0

  mkdirSync(directory, { recursive: true })

  for (const [name, vectors] of MODULES) {
    // A NotJsonError here names the entry (`<module>[<index>].args[0]...`): fix the vector, never drop it.
    toJson(vectors.entries, name)

    const file = join(directory, `${name}.json`)

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, prettyJson(vectors.entries))

    total += vectors.entries.length
  }

  process.stdout.write(`wrote ${total} vectors in ${MODULES.length} files to ${directory}\n`)

  return 0
}

process.exitCode = main(process.argv.slice(2))
