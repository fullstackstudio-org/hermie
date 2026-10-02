/**
 * The Android redirect guard.
 *
 * React Native's `fetch` on Android is OkHttp, and OkHttp follows a redirect to
 * another host with every header but `Authorization` — https to http included.
 * The gateway client refuses such an answer afterwards, but by then the
 * credentials have gone. The plugin installs an OkHttp network interceptor that
 * stops the follow itself.
 *
 * What can be pinned without a device: that the prebuild puts the call where it
 * runs before the first request, that it fails loudly rather than producing an
 * app without the guard, and that the Kotlin it writes speaks the same header
 * name the gateway client reads.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REFUSED_LOCATION_HEADER as CLIENT_HEADER } from '@hermie/gateway-client'

const plugin = require('../plugins/with-android-redirect-guard')
const { addRedirectGuard, CLASS_NAME, guardPath, guardSource, MARKER, REFUSED_LOCATION_HEADER } = plugin

const fixture = readFileSync(join(__dirname, 'support', 'generated-main-application.kt'), 'utf8')

describe('MainApplication', () => {
  const patched = addRedirectGuard(fixture)

  it('installs the guard straight after super.onCreate(), before React Native loads', () => {
    const onCreate = patched.slice(patched.indexOf('override fun onCreate()'))
    const lines = onCreate.split('\n').map(line => line.trim())
    const superCall = lines.indexOf('super.onCreate()')

    expect(lines[superCall + 1]).toBe(MARKER)
    expect(lines[superCall + 2]).toBe(`${CLASS_NAME}.install()`)
    expect(lines.indexOf(`${CLASS_NAME}.install()`)).toBeLessThan(lines.indexOf('loadReactNative(this)'))
  })

  it('is applied once however often the prebuild runs', () => {
    expect(addRedirectGuard(patched)).toBe(patched)
    expect(patched.split(`${CLASS_NAME}.install()`)).toHaveLength(2)
  })

  it('changes nothing else', () => {
    expect(patched.replace(/^\s*\/\/ hermie: android redirect guard\n\s*HermieRedirectGuard\.install\(\)\n/m, '')).toBe(
      fixture
    )
  })

  it('refuses a template it cannot place the call in, rather than building an app without it', () => {
    expect(() => addRedirectGuard(fixture.replace('super.onCreate()', 'superOnCreate()'))).toThrow(/redirect guard/)
  })
})

describe('the interceptor it writes', () => {
  const source = guardSource('dev.hermie.app')

  it('lives in the app package, where MainApplication reaches it without an import', () => {
    expect(source.startsWith('package dev.hermie.app\n')).toBe(true)
    expect(guardPath('/p/android', 'dev.hermie.app')).toBe(
      join('/p/android', 'app', 'src', 'main', 'java', 'dev', 'hermie', 'app', `${CLASS_NAME}.kt`)
    )
  })

  it('hooks the client fetch and XMLHttpRequest use, at the network level where each hop is seen', () => {
    expect(source).toContain('NetworkingModule.setCustomClientBuilder')
    expect(source).toContain('addNetworkInterceptor(this)')
  })

  it('lets a redirect within one origin through and moves Location aside for any other', () => {
    expect(source).toContain('target.scheme == from.scheme && target.host == from.host && target.port == from.port')
    expect(source).toContain('.removeHeader("Location")')
    expect(source).toContain('.header(REFUSED_LOCATION, target?.toString() ?: "")')
  })

  it('names the refused target in the header the gateway client reads', () => {
    expect(REFUSED_LOCATION_HEADER.toLowerCase()).toBe(CLIENT_HEADER)
    expect(source).toContain(`"${REFUSED_LOCATION_HEADER}"`)
  })
})

describe('app.config.ts', () => {
  it('runs the plugin', () => {
    expect(readFileSync(join(__dirname, '..', 'app.config.ts'), 'utf8')).toContain(
      "'./plugins/with-android-redirect-guard'"
    )
  })
})
