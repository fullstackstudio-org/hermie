/**
 * The team's own look, as a service asks for it (ADR-0025, part 2).
 *
 * Two claims are worth pinning and only one of them is about what happens:
 *
 *  - **The defaults are a starting point, never an override.** A reader who has
 *    chosen a theme keeps it, and a chat they have coloured keeps its colour.
 *    That is the whole difference between a branded build and a build that
 *    fights its reader.
 *  - **An absent flag is ON.** A Hermie Web too old to send the object, and
 *    every platform that is not the web, must not switch a feature off by
 *    saying nothing about it.
 */
import {
  accentOrBrand,
  applyBranding,
  brandAccent,
  brandName,
  brandTheme,
  featureOn,
  setDefaultAccent
} from '../src/features/branding'
import type { HermieWebConfig } from '../src/gateway/web-config'
import { strings } from '../src/i18n/strings'

const config = (over: Partial<HermieWebConfig>): HermieWebConfig =>
  ({
    gatewayHost: 'gateway.test',
    gatewayOrigin: 'http://gateway.test',
    loginReturn: '/',
    version: '9.9.9',
    setupRequired: false,
    authRequired: true,
    authKinds: ['cookie'],
    providers: [],
    service: { login: true, push: true, cache: true },
    branding: null,
    flags: null,
    ...over
  }) as HermieWebConfig

afterEach(() => {
  setDefaultAccent(null)
})

describe('reading the branding', () => {
  it('falls back to the app’s own name', () => {
    expect(brandName(null)).toBe(strings.app.name)
    expect(brandName({ name: '   ' })).toBe(strings.app.name)
    expect(brandName({ name: 'Acme Chat' })).toBe('Acme Chat')
  })

  it('caps a name that would push a chat’s own off the row', () => {
    expect(brandName({ name: 'x'.repeat(200) })).toHaveLength(64)
  })

  it('takes only an accent the app actually has', () => {
    expect(brandAccent({ accent: 'violet' })).toBe('violet')
    expect(brandAccent({ accent: 'chartreuse' })).toBeNull()
    expect(brandAccent(null)).toBeNull()
  })

  it('passes a theme name through for the store to validate', () => {
    expect(brandTheme({ theme: 'slate' })).toBe('slate')
    expect(brandTheme({ theme: '  ' })).toBeNull()
  })
})

describe('applying it', () => {
  it('sets the theme for a reader who has not chosen one', () => {
    const set: string[] = []
    const applied = applyBranding(config({ branding: { theme: 'slate' } }), {
      chosenTheme: false,
      setTheme: name => set.push(name)
    })

    expect(applied.theme).toBe(true)
    expect(set).toEqual(['slate'])
  })

  it('leaves a reader who HAS chosen exactly where they are', () => {
    const set: string[] = []
    const applied = applyBranding(config({ branding: { theme: 'slate' } }), {
      chosenTheme: true,
      setTheme: name => set.push(name)
    })

    expect(applied.theme).toBe(false)
    expect(set).toEqual([])
  })

  it('stands the accent in for “no colour chosen” and touches nothing else', () => {
    applyBranding(config({ branding: { accent: 'violet' } }), { chosenTheme: true, setTheme: () => undefined })

    expect(accentOrBrand('default')).toBe('violet')
    // A chat the reader coloured keeps its colour, which is the whole rule.
    expect(accentOrBrand('teal')).toBe('teal')
  })

  it('does nothing at all with no branding, which is every native build', () => {
    const set: string[] = []
    const applied = applyBranding(null, { chosenTheme: false, setTheme: name => set.push(name) })

    expect(applied).toEqual({ accent: false, theme: false })
    expect(set).toEqual([])
    expect(accentOrBrand('default')).toBe('default')
  })
})

describe('the feature flags', () => {
  it('reads an absent object as everything on', () => {
    expect(featureOn(null, 'userChats')).toBe(true)
    expect(featureOn(config({ flags: null }), 'messageCache')).toBe(true)
  })

  it('reads a false as off and anything else as on', () => {
    const flags = config({ flags: { userChats: false, messageCache: true, selfUpdate: true } })

    expect(featureOn(flags, 'userChats')).toBe(false)
    expect(featureOn(flags, 'messageCache')).toBe(true)
  })
})
