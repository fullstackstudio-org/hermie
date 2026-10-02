/**
 * Reading the gateway plugin's advert.
 *
 * Everything here is one rule or another out of the plugin's own
 * `contract.py`, and the reason they are rules rather than conventions is that
 * nobody updates a plugin: a gateway that was set up once and works is a
 * gateway nobody logs into again, so every future version of this app will meet
 * plugins older than itself for as long as the product exists.
 *
 *  - a capability is a STRING, so an older plugin simply offers less and a
 *    newer one adds strings this build does not ask for;
 *  - an advert whose `v` is from the future yields nothing, because a shape you
 *    do not know is not a shape you guess at;
 *  - an absent advert, a disabled plugin and no plugin at all are one state.
 */
import { PLUGIN_ADVERT } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'

import {
  hasPluginCapability,
  HERMIE_PLUGIN_KEY,
  PLUGIN_CAPABILITIES,
  pluginAdvert,
  pluginAdvertOf,
  pluginModuleOn
} from './plugin'

const row = (name: string, meta: Record<string, unknown>, isDefault = false) =>
  ({ name, is_default: isDefault, ui_meta: meta }) as never

describe('one advert', () => {
  it('reads the shape the plugin publishes', () => {
    const advert = pluginAdvertOf(PLUGIN_ADVERT)

    expect(advert?.version).toBe('0.2.0')
    expect(advert?.modules.push).toBe('on')
    expect(advert?.limits).toMatchObject({ contextChars: 1200 })
    expect(hasPluginCapability(advert, PLUGIN_CAPABILITIES.pushTurnDone)).toBe(true)
  })

  it('never offers a capability the gateway did not claim', () => {
    // The whole point of a string contract: a plugin built without the signing
    // library does not list Web Push, and an app that saw the module switched
    // on must still not offer a button that cannot work.
    const advert = pluginAdvertOf({ ...PLUGIN_ADVERT, capabilities: ['push.expo'] })

    expect(hasPluginCapability(advert, PLUGIN_CAPABILITIES.pushExpo)).toBe(true)
    expect(hasPluginCapability(advert, PLUGIN_CAPABILITIES.pushWebPush)).toBe(false)
  })

  it('yields nothing for a contract version from the future', () => {
    expect(pluginAdvertOf({ ...PLUGIN_ADVERT, v: 2 })).toBeNull()
    expect(pluginAdvertOf({ ...PLUGIN_ADVERT, v: '1' })).toBeNull()
    expect(pluginAdvertOf({ ...PLUGIN_ADVERT, v: true })).toBeNull()
  })

  it('yields nothing for something that is not an advert at all', () => {
    expect(pluginAdvertOf(null)).toBeNull()
    expect(pluginAdvertOf('hermie-plugin')).toBeNull()
    expect(pluginAdvertOf([PLUGIN_ADVERT])).toBeNull()
  })

  it('survives an advert with every optional field missing', () => {
    const advert = pluginAdvertOf({ v: 1 })

    expect(advert).toEqual({ version: '', capabilities: [], modules: {}, limits: {}, relayOrigins: [], updatedAt: 0 })
    expect(hasPluginCapability(advert, PLUGIN_CAPABILITIES.pushExpo)).toBe(false)
  })

  it('reads the relay origins the plugin posts to, normalised, https only, once each', () => {
    const advert = pluginAdvertOf({
      ...PLUGIN_ADVERT,
      relayOrigins: [
        'https://push.hermie.dev/',
        'http://relay.example.org',
        'https://relay.example.org',
        'https://PUSH.hermie.dev',
        'https://relay.example.org/v1/send',
        42
      ]
    })

    expect(advert?.relayOrigins).toEqual(['https://push.hermie.dev', 'https://relay.example.org'])
    expect(pluginAdvertOf({ v: 1, relayOrigins: 'https://push.hermie.dev' })?.relayOrigins).toEqual([])
  })

  it('tells a module that is switched off from one that is merely planned', () => {
    const advert = pluginAdvertOf({ ...PLUGIN_ADVERT, modules: { push: 'off', presence: 'planned' } })

    expect(pluginModuleOn(advert, 'push')).toBe(false)
    expect(pluginModuleOn(advert, 'presence')).toBe(false)
    expect(pluginModuleOn(advert, 'context')).toBe(false)
  })
})

describe('a roster', () => {
  it('finds the advert on the default profile', () => {
    const advert = pluginAdvert([
      row('writer', { 'hermes-bots': {} }),
      row('researcher', { 'hermes-bots': {}, [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }, true)
    ])

    expect(advert?.version).toBe('0.2.0')
  })

  it('finds one on a profile that is not the default, rather than insisting', () => {
    // Which profile is default is not a question the reader has any way to
    // answer, and "is the plugin installed" must not depend on it.
    const advert = pluginAdvert([
      row('writer', { [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }),
      row('researcher', { 'hermes-bots': {} }, true)
    ])

    expect(advert?.version).toBe('0.2.0')
  })

  it('prefers the default profile’s when two disagree', () => {
    const advert = pluginAdvert([
      row('writer', { [HERMIE_PLUGIN_KEY]: { ...PLUGIN_ADVERT, version: '0.0.1' } }),
      row('researcher', { [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }, true)
    ])

    expect(advert?.version).toBe('0.2.0')
  })

  it('answers null for a gateway with no plugin, which is what "do not offer it" means', () => {
    expect(pluginAdvert([row('researcher', { 'hermes-bots': {} }, true)])).toBeNull()
    expect(pluginAdvert({ profiles: [] })).toBeNull()
    expect(pluginAdvert(null)).toBeNull()
  })
})
