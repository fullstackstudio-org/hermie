/**
 * The development launch hook.
 *
 * Two things are worth pinning. The grammar, because a mistyped argument produces
 * a screenshot of the wrong thing and nobody notices until the design review. And
 * the `__DEV__` gate, because this opens arbitrary screens and the only acceptable
 * behaviour in a shipped build is that it does not exist.
 */
import { GALLERY_SECTION_IDS } from '../src/features/settings'
import { parseDevLaunchArguments } from '../src/dev/launch-intent'

describe('parseDevLaunchArguments', () => {
  it('finds nothing in the arguments a plain launch carries', () => {
    expect(parseDevLaunchArguments(['/path/to/Hermie.app/Hermie'])).toBeNull()
    expect(parseDevLaunchArguments(['--initialUrl', 'http://localhost:8081'])).toBeNull()
  })

  it('reads a gallery section, a scheme and a preset in any order', () => {
    expect(
      parseDevLaunchArguments([
        'Hermie',
        '--hermieTheme',
        'dark',
        '--initialUrl',
        'http://localhost:8081',
        '--hermieOpen',
        'gallery:sheet-options-model-page',
        '--hermiePreset',
        'lime'
      ])
    ).toEqual({
      open: { kind: 'gallery', section: 'sheet-options-model-page' },
      scheme: 'dark',
      preset: 'lime'
    })
  })

  it('accepts the `--flag=value` spelling, because shells differ', () => {
    expect(parseDevLaunchArguments(['--hermieOpen=chat:researcher', '--hermieTheme=light'])).toEqual({
      open: { kind: 'chat', bot: 'researcher' },
      scheme: 'light'
    })
  })

  it('does not swallow the next flag as a missing value', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', '--hermieTheme', 'dark'])).toEqual({ scheme: 'dark' })
  })

  it('maps a sheet shorthand onto the gallery section that holds it', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', 'sheet:approval'])?.open).toEqual({
      kind: 'gallery',
      section: 'sheet-approval'
    })
    expect(parseDevLaunchArguments(['--hermieOpen', 'sheet:colour'])?.open).toEqual({
      kind: 'gallery',
      section: 'sheet-options-colour-page'
    })
  })

  it('reads an overlay and its settings page, under either spelling', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', 'overlay:crons'])?.open).toEqual({
      kind: 'overlay',
      section: 'cron'
    })
    // Route names, and the spellings the old boolean pages were opened by.
    expect(parseDevLaunchArguments(['--hermieOpen', 'overlay:settings/licenses'])?.open).toEqual({
      kind: 'overlay',
      section: 'settings',
      page: 'Licences'
    })
    expect(parseDevLaunchArguments(['--hermieOpen', 'overlay:settings/gateways'])?.open).toEqual({
      kind: 'overlay',
      section: 'settings',
      page: 'Gateways'
    })
  })

  it('reads a gateway and its session token, in either order', () => {
    // The pair that reaches a connected app without typing. `demo` is the fake
    // gateway's fixture token (`npm run fake-gateway -- --auth token --token
    // demo`), not a person's credential.
    expect(parseDevLaunchArguments(['--hermieToken', 'demo', '--hermieGateway', 'http://localhost:9119'])).toEqual({
      gateway: { baseUrl: 'http://localhost:9119', token: 'demo' }
    })
  })

  it('defaults a scheme-less gateway to http, not https', () => {
    // The opposite of `normalizeBaseUrl`, on purpose: there is no probe behind
    // this argument to discover which scheme answers, and the only gateways it
    // names are a loopback port or a LAN address.
    expect(parseDevLaunchArguments(['--hermieGateway', 'localhost:9119'])?.gateway).toEqual({
      baseUrl: 'http://localhost:9119'
    })
    expect(parseDevLaunchArguments(['--hermieGateway=https://gateway.example/api'])?.gateway).toEqual({
      baseUrl: 'https://gateway.example/api'
    })
  })

  it('does not keep a token that has no gateway to belong to', () => {
    // Writing one would leave a secret in the keychain that no stored
    // configuration explains.
    expect(parseDevLaunchArguments(['--hermieToken', 'demo'])).toBeNull()
  })

  it('keeps a token exactly as it was typed', () => {
    // Every other value here is lowercased. A session token is opaque and the
    // gateway compares it byte for byte.
    expect(
      parseDevLaunchArguments(['--hermieGateway', 'localhost:9119', '--hermieToken', 'AbC-Demo'])?.gateway
    ).toEqual({ baseUrl: 'http://localhost:9119', token: 'AbC-Demo' })
  })

  it('ignores a gateway address that is not one', () => {
    expect(parseDevLaunchArguments(['--hermieGateway', 'ftp://host/'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermieGateway', 'http://'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermieGateway', '--hermieTheme', 'dark'])).toEqual({ scheme: 'dark' })
  })

  it('ignores a target, a scheme or a preset it does not recognise', () => {
    expect(parseDevLaunchArguments(['--hermieOpen', 'nonsense:thing'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermieOpen', 'overlay:nowhere'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermieTheme', 'sepia'])).toBeNull()
    expect(parseDevLaunchArguments(['--hermiePreset', 'tartan'])).toBeNull()
  })

  it('names sheet shorthands that exist in the gallery', () => {
    // A shorthand pointing at a section nobody wrote is a launch that silently
    // shows the whole gallery instead of the sheet that was asked for.
    for (const shorthand of ['agents', 'approval', 'clarify', 'colour', 'cron-editor', 'model', 'options']) {
      const open = parseDevLaunchArguments(['--hermieOpen', `sheet:${shorthand}`])?.open

      expect(open?.kind).toBe('gallery')
      expect(GALLERY_SECTION_IDS).toContain(open?.kind === 'gallery' ? open.section : '')
    }
  })
})

describe('the __DEV__ gate', () => {
  /**
   * `DEV_LAUNCH_INTENT` is `__DEV__ ? parse(...) : null`, evaluated once at module
   * load, so the assertion has to be made on a fresh load with the flag down.
   * That is also exactly the shape Metro's minifier folds away: with `__DEV__`
   * inlined as `false`, the ternary and the native read beside it are dead code
   * and do not reach a Release bundle at all. The `#if DEBUG` in
   * `HermieMacModule.swift` removes the constant they would have read.
   */
  const withDev = (value: boolean) => {
    jest.resetModules()
    const previous = (globalThis as { __DEV__?: boolean }).__DEV__

    ;(globalThis as { __DEV__?: boolean }).__DEV__ = value

    try {
      return require('../src/dev/launch-intent').DEV_LAUNCH_INTENT as unknown
    } finally {
      ;(globalThis as { __DEV__?: boolean }).__DEV__ = previous
    }
  }

  it('is null when __DEV__ is false, whatever the process was launched with', () => {
    expect(withDev(false)).toBeNull()
  })

  it('is null in this environment even with __DEV__ true, because there is no native module', () => {
    // The Jest renderer has no Expo module host, so the argument read degrades to
    // an empty array rather than throwing. A gallery test must not accidentally
    // inherit a launch argument from the runner.
    expect(withDev(true)).toBeNull()
  })
})

describe('which native module the arguments come from', () => {
  /**
   * There are two, one per platform family, and the JavaScript asks both rather
   * than branching on `Platform.OS`: `HermieMac` reports the process's own
   * argument vector, which is what `xcrun simctl launch` sets, and
   * `HermieDevLaunch` reports an Android launch's Intent extras flattened into the
   * same shape. Exactly one of them exists in a given binary — so the case that
   * has to hold is that a missing first module does not stop the second being
   * read, which is the whole of the Android path.
   */
  const withModules = (modules: Record<string, unknown>) => {
    jest.resetModules()
    jest.doMock('expo', () => ({
      ...jest.requireActual<Record<string, unknown>>('expo'),
      requireOptionalNativeModule: (name: string) => modules[name]
    }))

    const previous = (globalThis as { __DEV__?: boolean }).__DEV__

    ;(globalThis as { __DEV__?: boolean }).__DEV__ = true

    try {
      return require('../src/dev/launch-intent').DEV_LAUNCH_INTENT as unknown
    } finally {
      ;(globalThis as { __DEV__?: boolean }).__DEV__ = previous
      jest.dontMock('expo')
    }
  }

  it('reads the Apple module when it is the one that exists', () => {
    expect(withModules({ HermieMac: { devLaunchArguments: ['--hermieTheme', 'dark'] } })).toEqual({ scheme: 'dark' })
  })

  it('falls through to the Android module, which is the only one on that platform', () => {
    expect(withModules({ HermieDevLaunch: { devLaunchArguments: ['--hermieOpen', 'chat:researcher'] } })).toEqual({
      open: { kind: 'chat', bot: 'researcher' }
    })
  })

  it('survives a module that exists but answers nothing, and one that throws', () => {
    // `HermieDevLaunch` answers an empty list in a release APK — the activity's
    // extras are never read there — and a host with no module at all throws.
    // Neither is an error: both mean this launch asked for nothing.
    expect(withModules({ HermieMac: {}, HermieDevLaunch: { devLaunchArguments: [] } })).toBeNull()
    expect(
      withModules({
        get HermieMac(): never {
          throw new Error('no module host')
        },
        HermieDevLaunch: { devLaunchArguments: ['--hermiePreset', 'graphite'] }
      })
    ).toEqual({ preset: 'graphite' })
  })
})
