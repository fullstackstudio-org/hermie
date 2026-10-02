/**
 * What the plugin's advert says about the bundled web client and its Web Push
 * key, and the options that take them away.
 *
 * The client reads `web`, `webPush.publicKey` and the capability strings
 * `web.client` and `push.webpush.key` and nothing else, so a fixture that spelled
 * any of them differently would stage a plugin that exists and offers nothing.
 * Both halves are withdrawn as a unit — member, capability and (for the client)
 * the module — because that is how the real plugin withdraws them.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { type FakeGateway, type FakeGatewayOptions, PLUGIN_ADVERT, startFakeGateway } from './server'

const gateways: FakeGateway[] = []

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

/** The advert as a client reads it: out of the default profile's `ui_meta`. */
const advertOf = async (options: FakeGatewayOptions = {}): Promise<Record<string, unknown> | undefined> => {
  const gateway = await startFakeGateway({ port: 0, ...options })
  gateways.push(gateway)

  const roster = (await (await fetch(`${gateway.url}/api/profiles`)).json()) as {
    profiles: { ui_meta?: Record<string, Record<string, unknown>> }[]
  }

  return roster.profiles.map(row => row.ui_meta?.['hermie-plugin']).find(Boolean)
}

const capabilities = (advert: Record<string, unknown> | undefined): string[] => (advert?.capabilities ?? []) as string[]

describe('the default advert', () => {
  it('names the bundled client, the way the plugin describes it', async () => {
    const advert = await advertOf()

    expect(advert?.web).toEqual({
      path: '/dashboard-plugins/hermie/app/index.html',
      version: '0.2.0',
      commit: expect.stringMatching(/^[0-9a-f]{12}$/u),
      files: expect.any(Number),
      bytes: expect.any(Number)
    })
    expect(capabilities(advert)).toContain('web.client')
    expect((advert?.modules as Record<string, string>).web).toBe('on')
  })

  it('names the path the fake serves the client at', async () => {
    const advert = await advertOf()
    const web = advert?.web as { path: string }

    expect(web.path).toBe('/dashboard-plugins/hermie/app/index.html')
  })

  it('publishes a Web Push key that is an uncompressed P-256 point in base64url', async () => {
    const advert = await advertOf()
    const key = (advert?.webPush as { publicKey: string }).publicKey
    const bytes = Buffer.from(key, 'base64url')

    expect(key).toHaveLength(87)
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(4)
    expect(capabilities(advert)).toEqual(expect.arrayContaining(['push.webpush', 'push.webpush.key']))
  })

  it('is the exported advert, unchanged, so the existing readers see the same object', async () => {
    expect(await advertOf()).toEqual(PLUGIN_ADVERT)
  })
})

describe('webClient: false', () => {
  it('withdraws the capability, the `web` block and the module together', async () => {
    const advert = await advertOf({ webClient: false })

    expect(capabilities(advert)).not.toContain('web.client')
    expect(advert).not.toHaveProperty('web')
    expect(advert?.modules).not.toHaveProperty('web')
  })

  it('leaves the Web Push key, and everything else, alone', async () => {
    const advert = await advertOf({ webClient: false })

    expect(advert?.webPush).toEqual((PLUGIN_ADVERT.webPush as Record<string, unknown>) ?? {})
    expect(capabilities(advert)).toEqual(capabilities(PLUGIN_ADVERT).filter(entry => entry !== 'web.client'))
  })

  it('applies to an advert a test passed in itself', async () => {
    const advert = await advertOf({
      webClient: false,
      plugin: {
        v: 1,
        capabilities: ['web.client', 'push.expo'],
        modules: { web: 'on', push: 'on' },
        web: { path: '/x' }
      }
    })

    expect(capabilities(advert)).toEqual(['push.expo'])
    expect(advert).not.toHaveProperty('web')
    expect(advert?.modules).toEqual({ push: 'on' })
  })
})

describe('webPushKey: false', () => {
  it('withdraws the capability and the `webPush` block together, and keeps `push.webpush`', async () => {
    const advert = await advertOf({ webPushKey: false })

    expect(capabilities(advert)).not.toContain('push.webpush.key')
    expect(capabilities(advert)).toContain('push.webpush')
    expect(advert).not.toHaveProperty('webPush')
  })

  it('leaves the web client alone', async () => {
    const advert = await advertOf({ webPushKey: false })

    expect(advert?.web).toEqual(PLUGIN_ADVERT.web)
    expect(capabilities(advert)).toContain('web.client')
  })

  it('both options together stage a plugin with neither', async () => {
    const advert = await advertOf({ webClient: false, webPushKey: false })

    expect(capabilities(advert)).not.toEqual(expect.arrayContaining(['web.client']))
    expect(capabilities(advert)).not.toEqual(expect.arrayContaining(['push.webpush.key']))
    expect(advert).not.toHaveProperty('web')
    expect(advert).not.toHaveProperty('webPush')
  })
})

describe('plugin: false', () => {
  it('has no advert at all, so neither half is there to read', async () => {
    expect(await advertOf({ plugin: false })).toBeUndefined()
  })
})
