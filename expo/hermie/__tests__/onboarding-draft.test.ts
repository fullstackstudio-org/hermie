import type { ProbeResult, TokenSet } from '@hermie/gateway-client'

import {
  authModeOf,
  configFromDraft,
  connectionPayloadKey,
  emptyDraft,
  hasCredential,
  headerError,
  headerRecord,
  isTestCurrent,
  newHeaderRow,
  type OnboardingDraft
} from '../src/features/onboarding'

const GATED: ProbeResult = {
  version: '2026.9.14',
  authRequired: true,
  authFlows: ['cookie', 'native_pkce'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }],
  supportsNativePkce: true
}

const TOKENS: TokenSet = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 4102444800,
  provider: 'self-hosted',
  userId: 'tester@example.invalid'
}

function gatedDraft(): OnboardingDraft {
  return {
    ...emptyDraft(),
    rawAddress: 'hermes.example.com',
    baseUrl: 'https://hermes.example.com',
    probe: GATED,
    provider: GATED.providers[0] ?? null,
    tokens: TOKENS
  }
}

describe('extra headers', () => {
  it('strips CR and LF out of a value so a paste cannot smuggle a second header', () => {
    const rows = [newHeaderRow('CF-Access-Client-Id', 'abc\r\nX-Evil: yes')]

    expect(headerRecord(rows)).toEqual({ 'CF-Access-Client-Id': 'abcX-Evil: yes' })
  })

  it('rejects a name that is not a token, and one the transport owns', () => {
    expect(headerError(newHeaderRow('Bad Name', 'v'))).toContain('not a valid header name')
    expect(headerError(newHeaderRow('Authorization', 'v'))).toContain('cannot be an extra header')
    expect(headerError(newHeaderRow('', ''))).toBeNull()
  })

  it('leaves invalid and unnamed rows out of what actually travels', () => {
    expect(headerRecord([newHeaderRow('', 'v'), newHeaderRow('Bad Name', 'v'), newHeaderRow('X-Ok', 'v')])).toEqual({
      'X-Ok': 'v'
    })
  })

  it('orders the record so the same rows always produce the same payload key', () => {
    const a = headerRecord([newHeaderRow('B', '2'), newHeaderRow('A', '1')])
    const b = headerRecord([newHeaderRow('A', '1'), newHeaderRow('B', '2')])

    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('the connection test payload key', () => {
  it('holds while nothing that was tested changes', () => {
    const draft = gatedDraft()
    const tested = { ...draft, test: { key: connectionPayloadKey(draft), userDisplayName: 'Fake Tester', botCount: 2 } }

    expect(isTestCurrent(tested)).toBe(true)
  })

  it.each([
    ['the address', (draft: OnboardingDraft) => ({ ...draft, baseUrl: 'https://other.example.com' })],
    ['an extra header', (draft: OnboardingDraft) => ({ ...draft, headers: [newHeaderRow('X-Ok', 'v')] })],
    ['the token', (draft: OnboardingDraft) => ({ ...draft, tokens: { ...TOKENS, accessToken: 'access-2' } })],
    [
      'the provider',
      (draft: OnboardingDraft) => ({
        ...draft,
        provider: { name: 'other', displayName: 'Other', supportsPassword: false }
      })
    ]
  ])('breaks when %s changes', (_label, mutate) => {
    const draft = gatedDraft()
    const tested = { ...draft, test: { key: connectionPayloadKey(draft), userDisplayName: 'Fake Tester', botCount: 2 } }

    expect(isTestCurrent(mutate(tested))).toBe(false)
  })
})

describe('draft shape', () => {
  it('reads a gated gateway as native PKCE and an ungated one as session token', () => {
    expect(authModeOf(GATED)).toBe('native_pkce')
    expect(authModeOf({ ...GATED, authRequired: false })).toBe('session_token')
    expect(authModeOf(null)).toBe('session_token')
  })

  it('needs tokens when gated and a non-blank token when not', () => {
    expect(hasCredential(gatedDraft())).toBe(true)
    expect(hasCredential({ ...gatedDraft(), tokens: null })).toBe(false)

    const ungated = { ...emptyDraft(), probe: { ...GATED, authRequired: false } }
    expect(hasCredential(ungated)).toBe(false)
    expect(hasCredential({ ...ungated, sessionToken: '   ' })).toBe(false)
    expect(hasCredential({ ...ungated, sessionToken: 'tok' })).toBe(true)
  })

  it('keeps the provider out of the stored config for a session-token gateway', () => {
    const ungated = { ...gatedDraft(), probe: { ...GATED, authRequired: false } }

    expect(configFromDraft(ungated)).toEqual({
      baseUrl: 'https://hermes.example.com',
      authMode: 'session_token',
      version: '2026.9.14'
    })
  })

  it('stores what Settings has to show for a gated gateway', () => {
    const draft = gatedDraft()
    const tested = { ...draft, test: { key: connectionPayloadKey(draft), userDisplayName: 'Fake Tester', botCount: 2 } }

    expect(configFromDraft(tested)).toEqual({
      baseUrl: 'https://hermes.example.com',
      authMode: 'native_pkce',
      provider: 'self-hosted',
      providerDisplayName: 'Self-Hosted OIDC',
      version: '2026.9.14',
      userDisplayName: 'Fake Tester'
    })
  })
})
