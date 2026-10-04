/**
 * Whether the plugin carries the web client this page is running: the commit settles it where the
 * advert gave one, the version only where it did not, and a plugin that does not say (or has the client
 * switched off) is "unknown", never "up to date".
 */
import { describe, expect, it } from 'vitest'

import { webPluginAdvertOf } from '../../core/advert'
import { asModuleState, carriedLabel, webUpdateOf } from './gateway-facts'

const PAGE = { version: '0.2.0', commit: 'abcdef0123456789abcdef0123456789abcdef01' }

const advert = (over: Record<string, unknown> = {}) =>
  webPluginAdvertOf({
    v: 1,
    version: '0.1.0',
    capabilities: ['web.client'],
    modules: { web: 'on', push: 'on' },
    limits: {},
    updatedAt: 1,
    web: { path: '/dashboard-plugins/hermie/app/index.html', version: '0.2.0', commit: 'abcdef012345' },
    ...over
  })

describe('webUpdateOf', () => {
  it('is current when the plugin carries this very commit, whatever the abbreviation', () => {
    expect(webUpdateOf(advert(), PAGE)).toEqual({ kind: 'current' })
    expect(webUpdateOf(advert({ web: { path: '/x', version: '9.9.9', commit: PAGE.commit } }), PAGE)).toEqual({
      kind: 'current'
    })
  })

  it('differs when the plugin carries another commit, even under the same version number', () => {
    expect(webUpdateOf(advert({ web: { path: '/x', version: '0.2.0', commit: '0011223344aa' } }), PAGE)).toEqual({
      kind: 'differs',
      carried: '0.2.0 (0011223)'
    })
  })

  it('compares the version only where the plugin named no commit', () => {
    expect(webUpdateOf(advert({ web: { path: '/x', version: '0.2.0' } }), PAGE)).toEqual({ kind: 'current' })
    expect(webUpdateOf(advert({ web: { path: '/x', version: '0.3.0' } }), PAGE)).toEqual({
      kind: 'differs',
      carried: '0.3.0'
    })
  })

  it('is unknown without a plugin, without the block, with the client switched off or without its capability', () => {
    expect(webUpdateOf(null, PAGE)).toEqual({ kind: 'unknown' })
    expect(webUpdateOf(advert({ web: undefined }), PAGE)).toEqual({ kind: 'unknown' })
    expect(webUpdateOf(advert({ modules: { web: 'off' } }), PAGE)).toEqual({ kind: 'unknown' })
    expect(webUpdateOf(advert({ capabilities: [] }), PAGE)).toEqual({ kind: 'unknown' })
  })
})

describe('carriedLabel', () => {
  it('names a build by its version and the first seven characters of its commit', () => {
    expect(carriedLabel('0.2.0', 'abcdef0123')).toBe('0.2.0 (abcdef0)')
    expect(carriedLabel('0.2.0', '')).toBe('0.2.0')
    expect(carriedLabel('', 'abcdef0123')).toBe('abcdef0')
  })
})

describe('asModuleState', () => {
  it('knows the three states the plugin writes, and nothing else', () => {
    expect(asModuleState('on')).toBe('on')
    expect(asModuleState('off')).toBe('off')
    expect(asModuleState('planned')).toBe('planned')
    expect(asModuleState('experimental')).toBeNull()
  })
})
