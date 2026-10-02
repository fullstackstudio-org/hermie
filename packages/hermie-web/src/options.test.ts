import { describe, expect, it } from 'vitest'

import { encodeLocalSecret, hashLocalSecret } from './admin/access'
import {
  canonicalGatewayPath,
  DEFAULT_GATEWAY_URL,
  isSameOriginPath,
  normalizeLoginReturn,
  oidcRouteDecision,
  resolveOptions,
  splitRequestTarget
} from './options'

/**
 * The option that decides where a finished sign-in lands. Everything it refuses
 * is a way to hand the gateway a `next=` that leaves this origin — and while the
 * gateway checks that again, an install whose unit file says something unsafe
 * should fail at start rather than quietly redirect somewhere else.
 */
describe('the login return path', () => {
  it('defaults to the root', () => {
    expect(resolveOptions({ env: {} }).loginReturn).toBe('/')
    expect(normalizeLoginReturn('')).toBe('/')
    expect(normalizeLoginReturn('   ')).toBe('/')
  })

  it('keeps a path on this origin, trimmed', () => {
    expect(normalizeLoginReturn('/hermie')).toBe('/hermie')
    expect(normalizeLoginReturn(' /hermie/back ')).toBe('/hermie/back')
    expect(normalizeLoginReturn('/hermie?from=login')).toBe('/hermie?from=login')
  })

  it('refuses anything that could name another host', () => {
    for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example', 'hermie', '/a b']) {
      expect(isSameOriginPath(hostile)).toBe(false)
      expect(() => normalizeLoginReturn(hostile)).toThrow(/--login-return/)
    }
  })

  it('refuses a control character, which no header could carry anyway', () => {
    expect(() => normalizeLoginReturn('/hermie\nSet-Cookie: x=1')).toThrow(/--login-return/)
  })

  it('is read from the environment when no flag gives one', () => {
    expect(resolveOptions({ env: { HERMIE_LOGIN_RETURN: '/hermie' } }).loginReturn).toBe('/hermie')
  })

  it('lets the flag beat the environment', () => {
    expect(resolveOptions({ env: { HERMIE_LOGIN_RETURN: '/from-env' }, loginReturn: '/from-flag' }).loginReturn).toBe(
      '/from-flag'
    )
  })
})

/**
 * Every option a container has to be configured through entirely from the
 * environment — the point of this whole file: a Kubernetes Deployment sets
 * env vars, never `args`. One test per flag would be a lot of ceremony for the
 * same `??` chain, so this checks the full set at once, then the two things
 * that matter beyond plain string passthrough: precedence, and validation.
 */
describe('container configuration from the environment', () => {
  it('resolves every option from environment variables alone, with no flags at all', () => {
    const options = resolveOptions({
      env: {
        HERMIE_GATEWAY_URL: 'http://hermes:9119',
        HERMIE_PORT: '8080',
        HERMIE_HOST: '0.0.0.0',
        HERMIE_PUBLIC_URL: 'https://hermie.example.com',
        HERMIE_STATIC_DIR: '/srv/hermie-web/web',
        HERMIE_LOGIN_RETURN: '/hermie',
        HERMIE_INSTALL_ROOT: '/opt/hermie-web',
        HERMIE_SELF_UPDATE: '0',
        HERMIE_CACHE_MAX_MB: '128',
        HERMIE_PUSH: '1',
        HERMIE_GATEWAY_TOKEN: 'a-token',
        HERMIE_STATE_DIR: '/var/lib/hermie-web',
        HERMIE_VAPID_SUBJECT: 'mailto:ops@example.com',
        HERMIE_PUSH_SERVER_REQUESTS: '1',
        HERMIE_ALLOW_INSECURE_OIDC: '1'
      }
    })

    expect(options.gatewayUrl).toBe('http://hermes:9119/')
    expect(options.gatewayConfigured).toBe(true)
    expect(options.port).toBe(8080)
    expect(options.host).toBe('0.0.0.0')
    expect(options.publicUrl).toBe('https://hermie.example.com')
    expect(options.staticDir).toBe('/srv/hermie-web/web')
    expect(options.loginReturn).toBe('/hermie')
    expect(options.installRoot).toBe('/opt/hermie-web')
    expect(options.selfUpdate).toBe(false)
    expect(options.cacheMaxMb).toBe(128)
    expect(options.push).toBe(true)
    expect(options.gatewayToken).toBe('a-token')
    expect(options.stateDir).toBe('/var/lib/hermie-web')
    expect(options.vapidSubject).toBe('mailto:ops@example.com')
    expect(options.pushServerRequests).toBe(true)
    expect(options.allowInsecureOidc).toBe(true)
  })

  it('defaults to the built-in gateway when neither a flag nor the environment sets one', () => {
    const options = resolveOptions({ env: {} })

    expect(options.gatewayUrl).toBe(`${DEFAULT_GATEWAY_URL}/`)
    expect(options.gatewayConfigured).toBe(false)
  })

  it('lets a flag beat the environment for every option, not only the gateway', () => {
    const options = resolveOptions({
      env: { HERMIE_PORT: '8080', HERMIE_HOST: '0.0.0.0', HERMIE_PUSH: '1' },
      port: '9999',
      host: '10.0.0.1',
      push: false
    })

    expect(options.port).toBe(9999)
    expect(options.host).toBe('10.0.0.1')
    expect(options.push).toBe(false)
  })

  it.each(['yes', 'true', '1', 'YES', ' yes '])('accepts %s as an "on" boolean environment value', value => {
    expect(resolveOptions({ env: { HERMIE_PUSH: value } }).push).toBe(true)
  })

  it.each(['no', 'false', '0', 'NO', ' no '])('accepts %s as an "off" boolean environment value', value => {
    expect(resolveOptions({ env: { HERMIE_PUSH: value } }).push).toBe(false)
  })

  it('fails at start on an invalid boolean environment value, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_PUSH: 'sure' } })).toThrow(/HERMIE_PUSH/)
    expect(() => resolveOptions({ env: { HERMIE_ALLOW_INSECURE_OIDC: 'enabled' } })).toThrow(
      /HERMIE_ALLOW_INSECURE_OIDC/
    )
  })

  it('fails at start on an invalid HERMIE_PORT, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_PORT: 'not-a-port' } })).toThrow(/HERMIE_PORT/)
    expect(() => resolveOptions({ env: { HERMIE_PORT: '99999' } })).toThrow(/HERMIE_PORT/)
  })

  it('fails at start on an invalid HERMIE_GATEWAY_URL, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_GATEWAY_URL: 'not a url' } })).toThrow(/HERMIE_GATEWAY_URL/)
  })

  it('fails at start on an invalid HERMIE_CACHE_MAX_MB, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_CACHE_MAX_MB: '-5' } })).toThrow(/HERMIE_CACHE_MAX_MB/)
  })

  it('still lets a bad --port flag name itself, not just the environment variable', () => {
    expect(() => resolveOptions({ env: {}, port: 'nope' })).toThrow(/--port/)
  })
})

describe('HERMIE_OIDC', () => {
  it('defaults to on, unchanged from before the flag existed', () => {
    expect(resolveOptions({ env: {} }).oidc).toBe(true)
  })

  it('reads off from the environment', () => {
    expect(resolveOptions({ env: { HERMIE_OIDC: '0' } }).oidc).toBe(false)
    expect(resolveOptions({ env: { HERMIE_OIDC: 'false' } }).oidc).toBe(false)
    expect(resolveOptions({ env: { HERMIE_OIDC: 'no' } }).oidc).toBe(false)
  })

  it('lets a flag override the environment', () => {
    expect(resolveOptions({ env: { HERMIE_OIDC: '0' }, oidc: true }).oidc).toBe(true)
    expect(resolveOptions({ env: { HERMIE_OIDC: '1' }, oidc: false }).oidc).toBe(false)
  })

  it('fails at start on an invalid value, naming the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_OIDC: 'sure' } })).toThrow(/HERMIE_OIDC/)
  })
})

describe('--pass-host', () => {
  it('is off by default, and on from the flag or HERMIE_PASS_HOST', () => {
    expect(resolveOptions({ env: {} }).passHost).toBe(false)
    expect(
      resolveOptions({ env: { HERMIE_PASS_HOST: '1', HERMIE_WEB_PUBLIC_URL: 'https://app.example.com' } }).passHost
    ).toBe(true)
    expect(resolveOptions({ env: {}, passHost: true, webPublicUrl: 'https://app.example.com/x' })).toMatchObject({
      passHost: true,
      webPublicUrl: 'https://app.example.com'
    })
  })

  it('needs Hermie Web’s own public URL, and says which variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_PASS_HOST: '1' } })).toThrow(/HERMIE_WEB_PUBLIC_URL/)
  })

  it('wants that URL with its scheme, rather than guessing one', () => {
    expect(() => resolveOptions({ env: { HERMIE_WEB_PUBLIC_URL: 'app.example.com' } })).toThrow(/scheme/)
    expect(() => resolveOptions({ env: { HERMIE_WEB_PUBLIC_URL: 'ftp://app.example.com' } })).toThrow(/scheme/)
  })

  it('leaves --public-url meaning the gateway’s own address', () => {
    const options = resolveOptions({
      env: {},
      publicUrl: 'https://hermes.example.com',
      passHost: true,
      webPublicUrl: 'https://app.example.com'
    })

    expect(options.publicUrl).toBe('https://hermes.example.com')
    expect(options.webPublicUrl).toBe('https://app.example.com')
  })

  it('defaults loginReturn to none under --pass-host, and to / without it', () => {
    expect(resolveOptions({ env: {}, passHost: true, webPublicUrl: 'https://app.example.com' }).loginReturn).toBe('')
    expect(resolveOptions({ env: {} }).loginReturn).toBe('/')
  })

  it('still honours an explicit loginReturn under --pass-host', () => {
    expect(
      resolveOptions({ env: {}, passHost: true, webPublicUrl: 'https://app.example.com', loginReturn: '/hermie' })
        .loginReturn
    ).toBe('/hermie')
  })
})

/**
 * The decision half of `--no-oidc`'s path handling. The gateway's ASGI server
 * decodes a path exactly once before it routes; `canonicalGatewayPath` makes
 * that same single pass for the decision and refuses anything a second pass
 * could still change. What is FORWARDED is the raw target, untouched — see
 * `no-oidc-proxy.test.ts` for that half, end to end.
 */
describe('canonicalGatewayPath', () => {
  it('leaves an already-plain path alone', () => {
    expect(canonicalGatewayPath('/auth/login')).toBe('/auth/login')
    expect(canonicalGatewayPath('/')).toBe('/')
  })

  it('decodes a single percent-escape per segment, the way the gateway does', () => {
    expect(canonicalGatewayPath('/auth/%6cogin')).toBe('/auth/login')
    expect(canonicalGatewayPath('/auth/%6Cogin')).toBe('/auth/login')
    expect(canonicalGatewayPath('/auth/%63allback')).toBe('/auth/callback')
  })

  it('drops empty segments, so a trailing or doubled slash reads as the route it would otherwise be', () => {
    expect(canonicalGatewayPath('/auth/login/')).toBe('/auth/login')
    expect(canonicalGatewayPath('/auth/login///')).toBe('/auth/login')
    expect(canonicalGatewayPath('/auth//login')).toBe('/auth/login')
  })

  it('refuses a segment whose decoding hides an extra slash or backslash', () => {
    expect(canonicalGatewayPath('/auth/%2Flogin')).toBeNull()
    expect(canonicalGatewayPath('/auth/%5clogin')).toBeNull()
    expect(canonicalGatewayPath('/auth\\login')).toBeNull()
  })

  it('refuses a segment that one decode leaves still decodable or re-parsable', () => {
    // Harmless after exactly one pass — and a bypass the moment anything
    // decodes or re-parses it again, which is what an earlier version did.
    expect(canonicalGatewayPath('/auth/%256cogin')).toBeNull()
    expect(canonicalGatewayPath('/auth/login%3Fprovider=oidc')).toBeNull()
    expect(canonicalGatewayPath('/auth/login%23x')).toBeNull()
  })

  it('refuses a dot segment, encoded or not', () => {
    expect(canonicalGatewayPath('/auth/./login')).toBeNull()
    expect(canonicalGatewayPath('/auth/x/../login')).toBeNull()
    expect(canonicalGatewayPath('/auth/%2e/login')).toBeNull()
    expect(canonicalGatewayPath('/auth/x/%2E%2e/login')).toBeNull()
  })

  it('refuses a malformed escape rather than guessing what it meant', () => {
    expect(canonicalGatewayPath('/auth/%')).toBeNull()
    expect(canonicalGatewayPath('/auth/%zz')).toBeNull()
    expect(canonicalGatewayPath('/auth/%c0')).toBeNull()
  })

  it('refuses a raw control character, space or non-ASCII byte', () => {
    expect(canonicalGatewayPath('/auth/login\n')).toBeNull()
    expect(canonicalGatewayPath('/auth/log in')).toBeNull()
    expect(canonicalGatewayPath('/auth/lögin')).toBeNull()
  })

  it('refuses a control character hidden behind a percent-escape too', () => {
    expect(canonicalGatewayPath('/auth/%0alogin')).toBeNull()
  })

  it('leaves the rest of an /api path as sent, so a name there may carry an encoded %, ? or #', () => {
    expect(canonicalGatewayPath('/api/profiles/caf%C3%A9')).toBe('/api/profiles/caf%C3%A9')
    expect(canonicalGatewayPath('/api/files/a%3Fb%23c%25d.txt')).toBe('/api/files/a%3Fb%23c%25d.txt')
    expect(canonicalGatewayPath('/api/files/100%25.txt')).toBe('/api/files/100%25.txt')
    expect(canonicalGatewayPath('/api/files/r%C3%A9sum%C3%A9%20v2.txt')).toBe('/api/files/r%C3%A9sum%C3%A9%20v2.txt')
    expect(canonicalGatewayPath('/api/files/a.b..c')).toBe('/api/files/a.b..c')
    expect(canonicalGatewayPath('/%61pi/files/a%3Fb')).toBe('/api/files/a%3Fb')
    expect(canonicalGatewayPath('/api')).toBe('/api')
    expect(canonicalGatewayPath('/api/')).toBe('/api/')
  })

  it('still refuses under /api whatever could move the path out of it at a hop that decodes again', () => {
    for (const path of [
      '/%61pi/../auth/login',
      '/api/%2e%2e/auth/login',
      '/api/..%2fauth/login',
      '/api/%2E%2E%2Fauth%2Flogin',
      '/api/..%5cauth/login',
      '/api/%252e%252e/auth/login',
      '/api/%25252e%25252e/auth/login',
      '/api/./x',
      '/api/files/a%2Fb',
      '/api/files/a%252Fb',
      '/api/files/a%0ab',
      '/api/files/%zz',
      '/api/%EF%BC%8E%EF%BC%8E/auth/login',
      '/api/%25EF%25BC%258E%25EF%25BC%258E/auth/login',
      '/api/%E2%80%A4%E2%80%A4/auth/login',
      '/api/%EF%BC%8F..%EF%BC%8Fauth',
      '/api/..;/auth/login',
      '/api/..%3B/auth/login',
      '/api/files/a;b'
    ]) {
      expect(canonicalGatewayPath(path), path).toBeNull()
    }
  })

  it('stays strict for the sign-in surface outside /auth too', () => {
    expect(canonicalGatewayPath('/login%3Fnext=x')).toBeNull()
    expect(canonicalGatewayPath('/logout/%2e%2e')).toBeNull()
    expect(canonicalGatewayPath('/ap%69%2F..%2Fauth/login')).toBeNull()
  })

  it('keeps an encoded non-ASCII name outside /api too', () => {
    expect(canonicalGatewayPath('/auth/caf%C3%A9')).toBe('/auth/café')
  })
})

describe('splitRequestTarget', () => {
  it('splits at the first question mark, as the gateway’s own parser does', () => {
    expect(splitRequestTarget('/auth/native/authorize?provider=a?b')).toEqual({
      path: '/auth/native/authorize',
      query: 'provider=a?b'
    })
    expect(splitRequestTarget('/api/status')).toEqual({ path: '/api/status', query: '' })
  })

  it('refuses anything but an origin-form target of visible ASCII', () => {
    expect(splitRequestTarget('http://evil.example/auth/login')).toBeNull()
    expect(splitRequestTarget('//evil.example/auth/login')).toBeNull()
    expect(splitRequestTarget('/auth/login#x')).toBeNull()
    expect(splitRequestTarget('/auth/login?x=1#y')).toBeNull()
    expect(splitRequestTarget('/auth/log in')).toBeNull()
    expect(splitRequestTarget('*')).toBeNull()
  })
})

describe('oidcRouteDecision', () => {
  const params = (query = ''): URLSearchParams => new URLSearchParams(query)
  const PASSWORD = { name: 'self-hosted', supportsPassword: true }
  const SSO = { name: 'okta', supportsPassword: false }

  it('refuses the start and callback routes outright, whatever the query says', () => {
    expect(oidcRouteDecision('/auth/login', params('provider=self-hosted'), [PASSWORD])).toBe('refuse')
    expect(oidcRouteDecision('/auth/login', params(), [])).toBe('refuse')
    expect(oidcRouteDecision('/auth/callback', params('code=x&state=y'), [])).toBe('refuse')
  })

  it('leaves everything else under /auth and /api alone, the gateway’s own /login form included', () => {
    expect(oidcRouteDecision('/auth/password-login', params(), [])).toBe('allow')
    expect(oidcRouteDecision('/auth/logout', params(), [])).toBe('allow')
    expect(oidcRouteDecision('/api/auth/me', params(), [])).toBe('allow')
    expect(oidcRouteDecision('/login', params(), [])).toBe('allow')
  })

  describe('/auth/native/authorize', () => {
    const decide = (query: string, providers: { name: string; supportsPassword: boolean }[]) =>
      oidcRouteDecision('/auth/native/authorize', params(query), providers)

    it('refuses a named provider that does not take a password', () => {
      expect(decide('provider=okta', [PASSWORD, SSO])).toBe('refuse')
    })

    it('refuses a named provider the gateway does not list', () => {
      expect(decide('provider=nobody', [PASSWORD])).toBe('refuse')
    })

    it('allows a named provider that takes a password', () => {
      expect(decide('provider=self-hosted', [PASSWORD, SSO])).toBe('allow')
    })

    it('allows an empty provider only when the gateway’s one provider takes a password', () => {
      expect(decide('', [PASSWORD])).toBe('allow')
      expect(decide('provider=', [PASSWORD])).toBe('allow')
      expect(decide('', [SSO])).toBe('refuse')
      expect(decide('', [PASSWORD, SSO])).toBe('refuse')
      expect(decide('', [])).toBe('refuse')
    })

    it('refuses every provider when the gateway’s list could not be read', () => {
      expect(decide('provider=self-hosted', [])).toBe('refuse')
    })

    it('calls a repeated provider ambiguous, since the gateway binds the LAST one', () => {
      expect(decide('provider=self-hosted&provider=okta', [PASSWORD, SSO])).toBe('ambiguous')
      expect(decide('provider=self-hosted&%70rovider=okta', [PASSWORD, SSO])).toBe('ambiguous')
      expect(decide('provider=self-hosted&provider=self-hosted', [PASSWORD])).toBe('ambiguous')
    })
  })
})

describe('HERMIE_ADMINS', () => {
  it('defaults to nobody', () => {
    expect(resolveOptions({ env: {} }).admins).toEqual([])
  })

  it('splits, trims and drops empty entries from the environment', () => {
    expect(resolveOptions({ env: { HERMIE_ADMINS: ' ada@example.invalid ,, grace@example.invalid,' } }).admins).toEqual(
      ['ada@example.invalid', 'grace@example.invalid']
    )
  })

  it('lets a flag beat the environment', () => {
    expect(
      resolveOptions({ env: { HERMIE_ADMINS: 'ada@example.invalid' }, admins: ['grace@example.invalid'] }).admins
    ).toEqual(['grace@example.invalid'])
  })

  it('accepts an already-split list and still validates each entry', () => {
    expect(resolveOptions({ env: {}, admins: [' ada@example.invalid ', ''] }).admins).toEqual(['ada@example.invalid'])
  })

  it('refuses control characters, naming the flag and the variable', () => {
    expect(() => resolveOptions({ env: { HERMIE_ADMINS: 'ada\u0000@example.invalid' } })).toThrow(/HERMIE_ADMINS/)
    expect(() => resolveOptions({ env: {}, admins: ['ada\u0000@example.invalid'] })).toThrow(/--admins/)
  })

  it('refuses an absurdly long id', () => {
    expect(() => resolveOptions({ env: { HERMIE_ADMINS: 'a'.repeat(400) } })).toThrow(/HERMIE_ADMINS/)
  })
})

/**
 * The relay allow-list. It is the only thing that decides where a relay
 * request goes, so its default and its refusals are pinned rather than assumed.
 */
describe('HERMIE_PUSH_RELAYS', () => {
  it('defaults to the project’s own relay and nothing else', () => {
    expect(resolveOptions({ env: {} }).pushRelays).toEqual(['https://push.hermie.dev'])
  })

  it('replaces the default rather than adding to it', () => {
    expect(
      resolveOptions({ env: { HERMIE_PUSH_RELAYS: ' https://relay.example.org/ , https://RELAY.example.org' } })
        .pushRelays
    ).toEqual(['https://relay.example.org'])
  })

  it('reads an empty value as an empty list, which turns relay delivery off', () => {
    expect(resolveOptions({ env: { HERMIE_PUSH_RELAYS: '' } }).pushRelays).toEqual([])
  })

  it('lets a flag beat the environment', () => {
    expect(
      resolveOptions({ env: { HERMIE_PUSH_RELAYS: 'https://a.example.org' }, pushRelays: 'https://b.example.org' })
        .pushRelays
    ).toEqual(['https://b.example.org'])
  })

  it('refuses anything that is not an https origin, naming the flag and the variable', () => {
    for (const bad of [
      'http://push.hermie.dev',
      'https://push.hermie.dev/v1/send',
      'push.hermie.dev',
      'https://user@push.hermie.dev'
    ]) {
      expect(() => resolveOptions({ env: { HERMIE_PUSH_RELAYS: bad } })).toThrow(/--push-relays.*HERMIE_PUSH_RELAYS/)
    }
  })
})

describe('HERMIE_PUSH_IGNORE_PLUGIN', () => {
  it('defaults to deferring to the gateway plugin', () => {
    expect(resolveOptions({ env: {} }).pushIgnorePlugin).toBe(false)
  })

  it('is read from the environment and from the flag', () => {
    expect(resolveOptions({ env: { HERMIE_PUSH_IGNORE_PLUGIN: '1' } }).pushIgnorePlugin).toBe(true)
    expect(resolveOptions({ env: {}, pushIgnorePlugin: true }).pushIgnorePlugin).toBe(true)
    expect(() => resolveOptions({ env: { HERMIE_PUSH_IGNORE_PLUGIN: 'maybe' } })).toThrow(/HERMIE_PUSH_IGNORE_PLUGIN/)
  })
})

describe('HERMIE_LOCAL_ADMIN_PASSWORD_HASH', () => {
  it('is unset by default', () => {
    expect(resolveOptions({ env: {} }).localAdminPasswordHash).toBeNull()
  })

  it('decodes a hash `hash-secret` would have produced', () => {
    const encoded = encodeLocalSecret(hashLocalSecret('a long enough phrase'))

    expect(resolveOptions({ env: { HERMIE_LOCAL_ADMIN_PASSWORD_HASH: encoded } }).localAdminPasswordHash).toEqual(
      decodeItBack(encoded)
    )
  })

  it('refuses anything that is not that exact shape — most of all a plaintext password', () => {
    expect(() => resolveOptions({ env: { HERMIE_LOCAL_ADMIN_PASSWORD_HASH: 'a long enough phrase' } })).toThrow(
      /HERMIE_LOCAL_ADMIN_PASSWORD_HASH/
    )
  })
})

function decodeItBack(encoded: string): { salt: string; hash: string } {
  const [salt, hash] = encoded.split(':')

  return { salt: salt ?? '', hash: hash ?? '' }
}
