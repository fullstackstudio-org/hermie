/**
 * Who the gateway says this page's reader is.
 *
 * Ported from the Expo app's `__tests__/device-context.test.ts`. The `hydrate`
 * cases are gone with `hydrate` (it only cleaned up a key this client never
 * wrote); the cases for `uiMetaUserIdOf` are new.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createDeviceContextStore, effectiveDisplayName, OWNER_USER_ID, uiMetaUserIdOf } from './device-context'

let context = createDeviceContextStore()
const store = () => context.getState()

beforeEach(() => {
  context = createDeviceContextStore()
})

describe('setIdentity', () => {
  it('records who the gateway says this is', () => {
    store().setIdentity({ gated: true, userId: 'oidc:7f3a', displayName: 'Sebas', email: '' })

    expect(store().userId).toBe('oidc:7f3a')
    expect(store().displayName).toBe('Sebas')
    expect(store().gated).toBe(true)
  })

  it('is a no-op when nothing about the identity actually changed', () => {
    const identity = { gated: true, userId: 'oidc:7f3a', displayName: 'Sebas', email: '' }

    store().setIdentity(identity)
    const first = store()
    store().setIdentity(identity)

    expect(store()).toBe(first)
  })

  it('cleans what it stores: collapsed whitespace, capped lengths', () => {
    store().setIdentity({ gated: true, userId: ' a  b ', displayName: 'x'.repeat(200), email: '' })

    expect(store().userId).toBe('a b')
    expect(store().displayName).toHaveLength(80)
  })
})

describe('retire and reset', () => {
  it('retire forgets the identity', () => {
    store().setIdentity({ gated: true, userId: 'oidc:7f3a', displayName: 'Sebas', email: '' })
    store().retire()

    expect(store().userId).toBe('')
    expect(store().gated).toBe(false)
  })
})

/**
 * The key's user id must be the same string every client of this person
 * builds, so it is the Expo app's derivation exactly: the gateway's id, else
 * the address, raw.
 */
describe('uiMetaUserIdOf', () => {
  it('is the gateway’s user id', () => {
    expect(uiMetaUserIdOf({ userId: 'tester@example.invalid', email: 'other@example.invalid' })).toBe(
      'tester@example.invalid'
    )
  })

  it('falls back to the address', () => {
    expect(uiMetaUserIdOf({ userId: '', email: 'sebas@example.invalid' })).toBe('sebas@example.invalid')
  })

  it('is empty, the local-only path, when the gateway named nobody', () => {
    expect(uiMetaUserIdOf({ userId: '', email: '' })).toBe('')
    expect(uiMetaUserIdOf(null)).toBe('')
  })

  it('is not cleaned, because the other clients do not clean it', () => {
    expect(uiMetaUserIdOf({ userId: ' a  b ' })).toBe(' a  b ')
  })
})

describe('effectiveDisplayName', () => {
  const name = (patch: { displayName?: string; email?: string; userId?: string }): string =>
    effectiveDisplayName({ displayName: '', email: '', userId: '', ...patch })

  it('is the gateway’s own display name when there is one', () => {
    expect(name({ displayName: 'Sebas', email: 'sebas@example.invalid', userId: 'oidc:7f3a' })).toBe('Sebas')
  })

  it('falls back to the local part of the address', () => {
    expect(name({ email: 'sebas@example.invalid', userId: 'oidc:7f3a' })).toBe('sebas')
  })

  it('falls back last to the user id, with the provider prefix taken off', () => {
    expect(name({ userId: 'authentik:7f3a-ce10' })).toBe('7f3a-ce10')
  })

  it('leaves a subject that is a URL alone rather than cutting at its scheme', () => {
    expect(name({ userId: 'https://issuer.example/users/7f3a' })).toBe('https://issuer.example/users/7f3a')
  })

  it('shows the owner id of a gateway with no accounts as it is', () => {
    expect(name({ userId: OWNER_USER_ID })).toBe(OWNER_USER_ID)
  })

  it('is empty only when the gateway has named nobody at all', () => {
    expect(name({})).toBe('')
  })

  it('is cut at its cap', () => {
    expect(name({ displayName: 'a'.repeat(200) })).toHaveLength(80)
  })
})
