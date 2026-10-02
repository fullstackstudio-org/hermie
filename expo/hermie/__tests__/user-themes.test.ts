/**
 * Themes a reader makes: the store, the migration off wallpapers, and the guard.
 *
 * The guard is the interesting one. `judgeThemeColour` is the function
 * `npm run contrast:check` measures with, and the whole reason it is shared is so
 * that a colour the editor accepts is a colour the build accepts. A test that
 * only exercised the editor's own copy of the rule would prove nothing about
 * that, so these cases are about the RULE: the bubble has to carry white, the
 * background has to carry every ink, and the accent's fill is held to nothing
 * because nothing is ever read on it.
 */
import { judgeThemeColour } from '../src/ui/contrast'
import { keyValueStore } from '../src/platform/key-value-store'
import { CHAT_VIEW_KEY, useSettingsStore } from '../src/store/settings'
import { resolveThemeFace, THEME_PRESETS } from '../src/ui/themes'

import { NS_A } from './support/gateway-namespace'

beforeEach(async () => {
  useSettingsStore.getState().reset()
  await keyValueStore.delete(NS_A.key(CHAT_VIEW_KEY))
})

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

const blueDark = resolveThemeFace({ kind: 'preset', name: 'blue' }, 'dark')

describe('the contrast guard', () => {
  it('refuses anything that is not six hex digits', () => {
    expect(judgeThemeColour('background', 'lime', 'dark', blueDark)).toEqual({ ok: false, reason: 'malformed' })
    expect(judgeThemeColour('background', '#ABC', 'dark', blueDark)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses a bubble white cannot be read on, and says the ratio', () => {
    // The studio's lime is a RING colour: white on it is about 1.3 : 1.
    const verdict = judgeThemeColour('accentBubble', '#C7FF4A', 'dark', blueDark)

    expect(verdict.ok).toBe(false)

    if (!verdict.ok && verdict.reason !== 'malformed') {
      expect(verdict.ratio).toBeLessThan(2)
      expect(verdict.floor).toBe(4.5)
    }
  })

  it('takes the deeper lime the preset actually ships', () => {
    expect(judgeThemeColour('accentBubble', '#4A7F15', 'dark', blueDark)).toEqual({ ok: true })
  })

  it('refuses a dark background under the light ink set', () => {
    expect(judgeThemeColour('background', '#101010', 'light', blueDark).ok).toBe(false)
  })

  it('holds the accent fill to nothing, because nothing is read on it', () => {
    // Deliberate, and recorded in `contrast.ts`: an invented floor here would
    // refuse both the studio's lime and the Graphite accent the preset uses.
    expect(judgeThemeColour('accentFill', '#C7FF4A', 'dark', blueDark)).toEqual({ ok: true })
    expect(judgeThemeColour('accentFill', '#485468', 'dark', blueDark)).toEqual({ ok: true })
  })
})

describe('the themes store', () => {
  it('copies a preset into a theme of its own and switches to it', () => {
    const id = useSettingsStore.getState().createUserTheme('lime', 'Studio')

    useSettingsStore.getState().setThemeChoice({ kind: 'user', id })

    const [theme] = useSettingsStore.getState().userThemes

    expect(theme?.base).toBe('lime')
    expect(theme?.dark?.background).toBe(THEME_PRESETS.lime.dark.background)
    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'user', id })
  })

  it('edits one face and leaves the other following the preset', () => {
    const id = useSettingsStore.getState().createUserTheme('blue', 'Night')

    useSettingsStore.getState().editUserTheme(id, 'dark', { accentBubble: '#4A7F15' })

    const themes = useSettingsStore.getState().userThemes

    expect(resolveThemeFace({ kind: 'user', id }, 'dark', themes).accentSwatch.bubble).toBe('#4A7F15')
    expect(resolveThemeFace({ kind: 'user', id }, 'light', themes).accentSwatch.bubble).toBe(
      resolveThemeFace({ kind: 'preset', name: 'blue' }, 'light').accentSwatch.bubble
    )
  })

  it('lets a colour go back to following the preset', () => {
    const id = useSettingsStore.getState().createUserTheme('blue', 'Night')

    useSettingsStore.getState().editUserTheme(id, 'dark', { background: '#101112' })
    useSettingsStore.getState().editUserTheme(id, 'dark', { background: null })

    expect(resolveThemeFace({ kind: 'user', id }, 'dark', useSettingsStore.getState().userThemes).background).toBe(
      THEME_PRESETS.blue.dark.background
    )
  })

  it('falls back to the base when the theme that is ON is deleted', () => {
    const id = useSettingsStore.getState().createUserTheme('graphite', 'Studio')

    useSettingsStore.getState().setThemeChoice({ kind: 'user', id })
    useSettingsStore.getState().deleteUserTheme(id)

    expect(useSettingsStore.getState().userThemes).toEqual([])
    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
  })

  it('reads its themes back off disk', async () => {
    // Hydrated first, because that is what tells the store which gateway these
    // themes belong to. Nothing is written before it knows.
    await useSettingsStore.getState().hydrate(NS_A)

    const id = useSettingsStore.getState().createUserTheme('lime', 'Studio')

    useSettingsStore.getState().setThemeChoice({ kind: 'user', id })
    await settled()

    useSettingsStore.getState().reset()
    await useSettingsStore.getState().hydrate(NS_A)

    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'user', id })
    expect(useSettingsStore.getState().userThemes[0]?.name).toBe('Studio')
  })
})

describe('what an older build left behind', () => {
  it('turns a stored wallpaper into the preset that replaced it', async () => {
    for (const [wallpaper, preset] of [
      ['blue', 'blue'],
      ['warm', 'blue'],
      ['graphite', 'graphite'],
      ['slate', 'graphite']
    ] as const) {
      await keyValueStore.setJson(NS_A.key(CHAT_VIEW_KEY), { defaults: {}, perChat: {}, wallpaper })
      useSettingsStore.getState().reset()
      await useSettingsStore.getState().hydrate(NS_A)

      expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: preset })
    }
  })

  it('ignores a theme row with no id, which nothing could point at', async () => {
    await keyValueStore.setJson(NS_A.key(CHAT_VIEW_KEY), {
      defaults: {},
      perChat: {},
      userThemes: [
        { name: 'Nameless', base: 'blue' },
        { id: 'a', name: 'Fine', base: 'lime' }
      ]
    })
    useSettingsStore.getState().reset()
    await useSettingsStore.getState().hydrate(NS_A)

    expect(useSettingsStore.getState().userThemes.map(theme => theme.id)).toEqual(['a'])
  })
})
