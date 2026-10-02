/**
 * Where a browser sign-in starts, and where it is told to come back to.
 *
 * The file under test is the `.web` half of a platform pair, so it is imported
 * by its real name: on a native run the sibling stub is what `../cookie-sign-in`
 * resolves to, and the stub has nothing to assert about.
 */
import {
  buildCookieSignInUrl,
  DEFAULT_LOGIN_RETURN,
  loginReturnPath,
  sameOriginPath
} from '../src/features/onboarding/cookie-sign-in.web'
import { loadHermieWebConfig } from '../src/gateway/web-config'

jest.mock('../src/gateway/web-config', () => ({ loadHermieWebConfig: jest.fn() }))

const loadConfig = loadHermieWebConfig as jest.MockedFunction<typeof loadHermieWebConfig>

const config = (loginReturn: string) => ({ gatewayHost: 'hermes.example.com', loginReturn, version: '0.2.0' })

beforeEach(() => {
  loadConfig.mockReset()
  loadConfig.mockResolvedValue(config(DEFAULT_LOGIN_RETURN))
})

describe('the landing path', () => {
  it('keeps a path on this origin', () => {
    expect(sameOriginPath('/hermie')).toBe('/hermie')
    expect(sameOriginPath('/hermie/back?from=login')).toBe('/hermie/back?from=login')
    // Trimmed the way the server trims it, so a stray space in a unit file
    // means the same thing on both sides.
    expect(sameOriginPath(' /hermie ')).toBe('/hermie')
  })

  it('refuses everything that names a host, and falls back to the root', () => {
    for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example', 'hermie', '', '/hermie evil']) {
      expect(sameOriginPath(hostile)).toBe('/')
    }
  })

  it('falls back to the root when there is no answer at all', () => {
    expect(sameOriginPath(undefined)).toBe('/')
    expect(sameOriginPath(null)).toBe('/')
  })
})

describe('the sign-in URL', () => {
  it('carries the provider and the landing path to the gateway’s own door', () => {
    const url = new URL(buildCookieSignInUrl('https://hermes.example.com:9443', 'self-hosted', '/hermie'))

    expect(url.origin).toBe('https://hermes.example.com:9443')
    expect(url.pathname).toBe('/auth/login')
    expect(url.searchParams.get('provider')).toBe('self-hosted')
    expect(url.searchParams.get('next')).toBe('/hermie')
  })

  it('leaves the provider off when the gateway offers only one', () => {
    const url = new URL(buildCookieSignInUrl('https://hermes.example.com', undefined, '/'))

    expect(url.searchParams.has('provider')).toBe(false)
    expect(url.searchParams.get('next')).toBe('/')
  })

  it('sends no next= at all when the landing path is empty on purpose', () => {
    const url = new URL(buildCookieSignInUrl('https://app.example.com', 'sso', ''))

    expect(url.searchParams.has('next')).toBe(false)
    expect(url.searchParams.get('provider')).toBe('sso')
  })

  it('never puts a foreign host in next=, however it was asked to', () => {
    const url = new URL(buildCookieSignInUrl('https://hermes.example.com', 'self-hosted', '//evil.example'))

    expect(url.searchParams.get('next')).toBe('/')
  })
})

describe('what the server asked for', () => {
  it('uses the configured return path when the caller names none', async () => {
    loadConfig.mockResolvedValue(config('/hermie'))

    await expect(loginReturnPath()).resolves.toBe('/hermie')
  })

  it('asks for no next= when the server configured none (--pass-host)', async () => {
    loadConfig.mockResolvedValue(config(''))

    await expect(loginReturnPath()).resolves.toBe('')
  })

  it('prefers an explicit path, and does not ask the server for one', async () => {
    await expect(loginReturnPath('/chats')).resolves.toBe('/chats')
    expect(loadConfig).not.toHaveBeenCalled()
  })

  it('falls back to the root when the server answers nothing', async () => {
    loadConfig.mockResolvedValue(null)

    await expect(loginReturnPath()).resolves.toBe('/')
  })

  it('does not hold the button hostage to a request that never answers', async () => {
    jest.useFakeTimers()
    loadConfig.mockReturnValue(new Promise(() => undefined))

    const pending = loginReturnPath()
    jest.advanceTimersByTime(2_000)

    await expect(pending).resolves.toBe('/')
    jest.useRealTimers()
  })
})
