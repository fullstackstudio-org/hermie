/**
 * The web-only advert readers, against the fake gateway's advert (which
 * `packages/fake-gateway/src/web-advert.test.ts` keeps in the plugin's shape)
 * and against the ways a real one can be short of it.
 */
import { PLUGIN_ADVERT } from '@hermie/fake-gateway'
import { pluginAdvert, pluginAdvertOf } from '@hermie/gateway-client/plugin'
import { describe, expect, it } from 'vitest'

import {
  bundledWebClient,
  webClientAdvertOf,
  webClientSwitchedOff,
  webModuleState,
  webPluginAdvert,
  webPluginAdvertOf,
  webPushAdvertOf,
  webPushPublicKey
} from './advert'

const without = (value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

const withCapabilities = (keep: (capability: string) => boolean): Record<string, unknown> => ({
  ...PLUGIN_ADVERT,
  capabilities: (PLUGIN_ADVERT.capabilities as string[]).filter(keep)
})

const withModule = (state: string): Record<string, unknown> => ({
  ...PLUGIN_ADVERT,
  modules: { ...(PLUGIN_ADVERT.modules as Record<string, string>), web: state }
})

const roster = (...rows: { name: string; is_default?: boolean; advert?: unknown }[]) => ({
  profiles: rows.map(row => ({
    name: row.name,
    path: `/profiles/${row.name}`,
    ...(row.is_default ? { is_default: true } : {}),
    ...(row.advert === undefined ? {} : { ui_meta: { 'hermie-plugin': row.advert } })
  }))
})

describe('reading the advert', () => {
  it('is the package’s reading plus the two blocks', () => {
    const advert = webPluginAdvertOf(PLUGIN_ADVERT)

    expect(advert).toMatchObject(pluginAdvertOf(PLUGIN_ADVERT) as object)
    expect(advert?.web).toEqual({
      path: '/dashboard-plugins/hermie/app/index.html',
      version: '0.2.0',
      commit: '0123456789ab',
      files: 37,
      bytes: 1_432_211
    })
    expect(advert?.webPush?.publicKey).toHaveLength(87)
  })

  it('refuses what the package refuses, whatever blocks ride along', () => {
    expect(webPluginAdvertOf({ ...PLUGIN_ADVERT, v: 2 })).toBeNull()
    expect(webPluginAdvertOf(null)).toBeNull()
    expect(webPluginAdvertOf([PLUGIN_ADVERT])).toBeNull()
  })

  it('reads an older plugin, with no blocks, as an advert with none', () => {
    const advert = webPluginAdvertOf(without(PLUGIN_ADVERT, 'web', 'webPush'))

    expect(advert).not.toBeNull()
    expect(advert?.web).toBeNull()
    expect(advert?.webPush).toBeNull()
  })

  it('drops a malformed block and keeps the rest', () => {
    const advert = webPluginAdvertOf({ ...PLUGIN_ADVERT, web: 'yes', webPush: { publicKey: 42 } })

    expect(advert?.web).toBeNull()
    expect(advert?.webPush).toBeNull()
    expect(advert?.capabilities).toContain('web.client')
  })
})

describe('the web block', () => {
  it('needs an absolute path and fills what is missing with nothing', () => {
    expect(webClientAdvertOf({ path: 'dashboard-plugins/hermie/app/index.html' })).toBeNull()
    expect(webClientAdvertOf({ version: '0.2.0' })).toBeNull()
    expect(webClientAdvertOf({ path: '/app/index.html' })).toEqual({
      path: '/app/index.html',
      version: '',
      commit: '',
      files: 0,
      bytes: 0
    })
  })

  it('takes a commit only as lower-case hex, and counts only as whole non-negative numbers', () => {
    expect(
      webClientAdvertOf({ path: '/a', commit: 'not a commit', files: -1, bytes: Number.POSITIVE_INFINITY })
    ).toMatchObject({ commit: '', files: 0, bytes: 0 })
    expect(webClientAdvertOf({ path: '/a', commit: 'abc123', files: 3.7, bytes: 10 })).toMatchObject({
      commit: 'abc123',
      files: 3,
      bytes: 10
    })
  })
})

describe('the Web Push block', () => {
  it('takes only an uncompressed P-256 point in base64url', () => {
    const key = (PLUGIN_ADVERT.webPush as { publicKey: string }).publicKey

    expect(webPushAdvertOf({ publicKey: key })).toEqual({ publicKey: key })
    // Padded, standard alphabet, compressed, or cut short: none of them is a key to subscribe with.
    expect(webPushAdvertOf({ publicKey: `${key}=` })).toBeNull()
    expect(webPushAdvertOf({ publicKey: `${key.slice(0, 86)}+` })).toBeNull()
    expect(webPushAdvertOf({ publicKey: `A${key.slice(1)}` })).toBeNull()
    expect(webPushAdvertOf({ publicKey: key.slice(0, 43) })).toBeNull()
    expect(webPushAdvertOf({})).toBeNull()
  })
})

describe('what the client asks', () => {
  it('finds the bundled client and the key on the fake’s advert', () => {
    const advert = webPluginAdvertOf(PLUGIN_ADVERT)

    expect(bundledWebClient(advert)?.version).toBe('0.2.0')
    expect(webPushPublicKey(advert)).toBe((PLUGIN_ADVERT.webPush as { publicKey: string }).publicKey)
    expect(webModuleState(advert)).toBe('on')
    expect(webClientSwitchedOff(advert)).toBe(false)
  })

  it('trusts a block only beside its capability', () => {
    expect(bundledWebClient(webPluginAdvertOf(withCapabilities(entry => entry !== 'web.client')))).toBeNull()
    expect(webPushPublicKey(webPluginAdvertOf(withCapabilities(entry => entry !== 'push.webpush.key')))).toBeNull()
  })

  it('reads an operator’s off as off, and only that', () => {
    const off = webPluginAdvertOf(withModule('off'))

    expect(webClientSwitchedOff(off)).toBe(true)
    expect(bundledWebClient(off)).toBeNull()
    expect(webClientSwitchedOff(webPluginAdvertOf(withModule('planned')))).toBe(false)
    // A plugin too old to know the module, and no plugin at all, are not a refusal.
    const older = webPluginAdvertOf({ ...PLUGIN_ADVERT, modules: { push: 'on' } })

    expect(webModuleState(older)).toBe('unknown')
    expect(webClientSwitchedOff(older)).toBe(false)
    expect(webClientSwitchedOff(null)).toBe(false)
    expect(bundledWebClient(null)).toBeNull()
    expect(webPushPublicKey(null)).toBeNull()
  })
})

describe('the advert off a roster', () => {
  it('chooses the row the package chooses: the default profile wins', () => {
    const other = { ...PLUGIN_ADVERT, version: '0.1.0', web: { path: '/elsewhere/index.html' } }
    const rows = roster(
      { name: 'researcher', advert: other },
      { name: 'writer', is_default: true, advert: PLUGIN_ADVERT }
    )

    expect(webPluginAdvert(rows)?.version).toBe(pluginAdvert(rows)?.version)
    expect(webPluginAdvert(rows)?.web?.path).toBe('/dashboard-plugins/hermie/app/index.html')
  })

  it('falls back to the first readable advert, and is null without one', () => {
    const rows = roster({ name: 'a' }, { name: 'b', advert: { v: 9 } }, { name: 'c', advert: PLUGIN_ADVERT })

    expect(webPluginAdvert(rows)?.version).toBe('0.2.0')
    expect(webPluginAdvert(rows.profiles)?.version).toBe('0.2.0')
    expect(webPluginAdvert(roster({ name: 'a' }))).toBeNull()
    expect(webPluginAdvert(null)).toBeNull()
    expect(webPluginAdvert({})).toBeNull()
  })
})
