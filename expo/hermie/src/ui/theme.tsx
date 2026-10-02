import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Appearance, useColorScheme } from 'react-native'

import { SystemStatusBar } from '../platform/status-bar'
import { useSettingsStore } from '../store/settings'
import {
  ACCENTS,
  DANGER_SOFT,
  darkPresence,
  darkShadows,
  EDGE,
  EDGE_SOFT,
  HAIRLINE,
  HAIRLINE_SOFT,
  OK_SOFT,
  lightPresence,
  lightShadows,
  radii,
  space,
  TINT_HOVER,
  TINT_SUNK,
  type,
  type AccentName,
  type AccentSwatch,
  type BubbleRecipe,
  type BubbleVariant,
  type ColorScale,
  type ElevationScale,
  type GlassScale,
  type PresenceScale,
  type Scheme,
  type ShadowScale
} from './tokens'
import { motion } from './motion'
import {
  bubblesFor,
  colorsForFace,
  DEFAULT_THEME_CHOICE,
  glassFor,
  resolveThemeFace,
  type ThemeChoice,
  type ThemePresetName,
  type UserTheme
} from './themes'

/** An accent with its scheme-dependent halves already resolved. */
export type ResolvedAccent = {
  name: AccentName
  fill: AccentSwatch['fill']
  text: string
  bubble: AccentSwatch['bubble']
  /** The wash under a selected row or an icon well. */
  soft: string
}

export type Theme = {
  scheme: Scheme
  colors: ColorScale
  elevation: ElevationScale
  glass: GlassScale
  /** Incoming bubbles: a hand-composited recipe, never a blur view per row. */
  bubbles: Record<BubbleVariant, BubbleRecipe>
  presence: PresenceScale
  shadows: ShadowScale
  /**
   * The floor, as the one field every surface already reads.
   *
   * It keeps the name it has had since there were wallpapers rather than themes,
   * because it is the same thing: `Wallpaper` paints it, every glass recipe
   * composites against it and the contrast check measures against it.
   */
  wallpaper: { fill: string }
  /** What is on, so a picker and a screenshot can both name it. */
  themeChoice: ThemeChoice
  space: typeof space
  radii: typeof radii
  type: typeof type
  motion: typeof motion
  hairline: string
  hairlineSoft: string
  edge: string
  edgeSoft: string
  tintSunk: string
  /** The wash a pointer leaves on the control it is over. */
  tintHover: string
  /** The soft destructive fill; `colors.dangerText` is the ink that goes on it. */
  dangerSoft: string
  /** Its counterpart, for a confirmed or locked state. `colors.okText` reads on it. */
  okSoft: string
  /**
   * VoiceOver's "Reduce Transparency". Every glass surface swaps for its solid
   * tint and keeps the identical token set.
   */
  reduceTransparency: boolean
  /** "Reduce Motion". Durations collapse and the amber pulse goes static. */
  reduceMotion: boolean
  /** Resolve a chat's accent for this scheme. `undefined` means Default. */
  accent: (name?: AccentName) => ResolvedAccent
}

function resolveAccent(name: AccentName, scheme: Scheme): ResolvedAccent {
  const swatch = ACCENTS[name] ?? ACCENTS.default

  return {
    name,
    fill: swatch.fill,
    text: swatch.text[scheme],
    bubble: swatch.bubble,
    soft: accentSoftValue(swatch.fill, scheme)
  }
}

function accentSoftValue(fill: string, scheme: Scheme): string {
  const value = fill.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)

  return `rgba(${r},${g},${b},${scheme === 'dark' ? 0.26 : 0.13})`
}

export interface BuildThemeOptions {
  scheme: Scheme
  choice: ThemeChoice
  userThemes: readonly UserTheme[]
  reduceTransparency: boolean
  reduceMotion: boolean
}

export function buildTheme({ scheme, choice, userThemes, reduceTransparency, reduceMotion }: BuildThemeOptions): Theme {
  const dark = scheme === 'dark'
  const face = resolveThemeFace(choice, scheme, userThemes)
  const themeAccent: ResolvedAccent = {
    name: face.accentName,
    fill: face.accentSwatch.fill,
    text: face.accentSwatch.text[scheme],
    bubble: face.accentSwatch.bubble,
    soft: accentSoftValue(face.accentSwatch.fill, scheme)
  }

  return {
    scheme,
    colors: colorsForFace(scheme, face),
    elevation: face.elevation,
    glass: glassFor(scheme, face.elevation),
    bubbles: bubblesFor(scheme, face.elevation),
    presence: dark ? darkPresence : lightPresence,
    shadows: dark ? darkShadows : lightShadows,
    wallpaper: { fill: face.background },
    themeChoice: choice,
    space,
    radii,
    type,
    motion,
    hairline: HAIRLINE[scheme],
    hairlineSoft: HAIRLINE_SOFT[scheme],
    edge: EDGE[scheme],
    edgeSoft: EDGE_SOFT[scheme],
    tintSunk: TINT_SUNK[scheme],
    tintHover: TINT_HOVER[scheme],
    dangerSoft: DANGER_SOFT[scheme],
    okSoft: OK_SOFT[scheme],
    reduceTransparency,
    reduceMotion,
    /*
      "Default" is the THEME's accent, and a chat's own colour is everything else.

      A theme is the one setting a reader picks that is meant to change the whole
      composition, and the outgoing bubble is the largest saturated area in it — so a
      matte grey window under the stock blue bubble is not a matte grey window; it is
      a grey window with a blue stripe down one side. A chat whose colour the reader
      picked is untouched: that choice is about the conversation, not about the window
      it is in.

      `'default'` is treated exactly like no argument at all, and that is a fix rather
      than a nicety. `useChatAccent` answers `'default'` for a chat nobody has
      coloured — never `undefined` — so the old signature quietly took the theme's
      accent away from every caller that passed the value it was given, which is why
      the avatar ring stayed blue on a theme whose bubbles were not.
    */
    accent: name => (!name || name === 'default' ? themeAccent : resolveAccent(name, scheme))
  }
}

const EMPTY_USER_THEMES: readonly UserTheme[] = []

const ThemeContext = createContext<Theme>(
  buildTheme({
    scheme: 'light',
    choice: DEFAULT_THEME_CHOICE,
    userThemes: EMPTY_USER_THEMES,
    reduceTransparency: false,
    reduceMotion: false
  })
)

/**
 * Both accessibility flags, as one subscription each.
 *
 * They are read here rather than per surface: a list of forty rows must not open
 * forty native subscriptions, and both settings change so rarely that a context
 * re-render is the cheapest possible delivery.
 */
function useAccessibilityPreferences(): { reduceTransparency: boolean; reduceMotion: boolean } {
  const [reduceTransparency, setReduceTransparency] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let alive = true

    // Both getters reject on a platform that does not implement them, and a
    // missing accessibility setting is not a reason to fail to render.
    AccessibilityInfo.isReduceTransparencyEnabled?.()
      .then(value => {
        if (alive) {
          setReduceTransparency(Boolean(value))
        }
      })
      .catch(() => {})

    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(value => {
        if (alive) {
          setReduceMotion(Boolean(value))
        }
      })
      .catch(() => {})

    const transparency = AccessibilityInfo.addEventListener('reduceTransparencyChanged', value =>
      setReduceTransparency(Boolean(value))
    )
    const reduced = AccessibilityInfo.addEventListener('reduceMotionChanged', value => setReduceMotion(Boolean(value)))

    return () => {
      alive = false
      transparency?.remove()
      reduced?.remove()
    }
  }, [])

  return { reduceTransparency, reduceMotion }
}

export interface ThemeProviderProps {
  children: ReactNode
  /**
   * Pin the scheme, whatever the system and the stored preference say.
   *
   * Development only (`--hermieTheme dark`). A simulator's appearance is
   * Simulator.app state and this machine has none, so without this the dark
   * theme could not be photographed at all — see docs/platform-notes.md.
   */
  forceScheme?: Scheme
  /** Pin the preset, for the same reason (`--hermiePreset lime`). */
  forcePreset?: ThemePresetName
}

export function ThemeProvider({ children, forceScheme, forcePreset }: ThemeProviderProps) {
  // `useColorScheme` follows the system appearance on every platform, a Mac
  // window included. The stored appearance overrides it when the user pinned
  // one, which is why the preference is read here rather than in Settings: the
  // theme is what every screen resolves through.
  const system = useColorScheme() === 'dark' ? 'dark' : 'light'
  const appearance = useSettingsStore(state => state.appearance)
  const storedChoice = useSettingsStore(state => state.themeChoice)
  const userThemes = useSettingsStore(state => state.userThemes)
  const appearanceLoaded = useSettingsStore(state => state.appearanceLoaded)
  const { reduceTransparency, reduceMotion } = useAccessibilityPreferences()

  useEffect(() => {
    // Hydrating here rather than further down the tree keeps the very first
    // paint from flashing the system scheme before the stored one arrives.
    //
    // The APPEARANCE only. The theme itself belongs to a gateway account and is
    // read by `ChatRuntimeProvider` once there is a gateway to key it by; this
    // provider sits above the lock and the wizard and has no such key. The cost
    // is that a chosen preset lands one disk read later than light-or-dark
    // does, behind the splash.
    if (!appearanceLoaded) {
      void useSettingsStore.getState().hydrateAppearance()
    }
  }, [appearanceLoaded])

  // `null` means "let the system decide", which is also what releases a pin.
  const pinned = forceScheme ?? (appearance === 'system' ? null : appearance)
  const scheme = pinned ?? system
  // Memoised because a fresh object literal on every render would rebuild the
  // whole token set on every render, and the token set is what every surface in
  // the app reads.
  const choice = useMemo<ThemeChoice>(
    () => (forcePreset ? { kind: 'preset', name: forcePreset } : storedChoice),
    [forcePreset, storedChoice]
  )

  /**
   * Tell UIKit which scheme won, because half the app is not ours to colour.
   *
   * The token set only reaches what JavaScript draws. A native material takes its
   * appearance from the window's trait collection, so with the theme pinned to
   * Light while macOS was in Dark, every glass panel on the Mac build rendered as
   * murky dark glass under light ink — `expo-glass-effect`'s `UIGlassEffect`
   * asked the window, and the window was still saying dark.
   *
   * `Appearance.setColorScheme` is the one lever React Native offers: it walks
   * `UIApplication.connectedScenes` and sets `overrideUserInterfaceStyle` on every
   * window in them (`RCTAppearance.mm`), which is the whole app — the root window,
   * a `Modal`'s presented controller, and any native view that reads the trait.
   * Passing `null` clears the override rather than pinning the current value, so
   * "System" really goes back to following the system.
   *
   * It lives here for the same reason the status bar does: this is the one
   * component that knows which of the pinned and the system scheme won.
   *
   * **The pin comes from the store, never from `useColorScheme()`.** Once the
   * override is in place UIKit reports the pinned scheme back as the system one,
   * so deriving the pin from what `useColorScheme()` says would be a loop with
   * nothing to break it. `system` is only ever READ when nothing is pinned, which
   * is exactly when no override is in place and the value is honest again.
   *
   * **react-native-web does not have it.** Its `Appearance` module exposes the
   * listener and the getter and stops there, because a page cannot override the
   * user agent's colour scheme for anything but itself — and it does not need
   * to: on the web every surface in this app is drawn by our own token set, and
   * the one native material that reads the trait collection does not exist
   * there. So the call is guarded rather than seamed: there is nothing for a
   * web implementation to DO.
   */
  useEffect(() => {
    if (typeof Appearance.setColorScheme === 'function') {
      Appearance.setColorScheme(pinned)
    }
  }, [pinned])

  const theme = useMemo(
    () => buildTheme({ scheme, choice, userThemes, reduceTransparency, reduceMotion }),
    [scheme, choice, userThemes, reduceTransparency, reduceMotion]
  )

  // The status bar follows the PINNED appearance, not the system's, and it is
  // rendered here because this is the one component that knows which of the two
  // won and the one that sits above every screen, so the setting survives
  // navigation. Android needs it said out loud: the window starts with
  // `windowLightStatusBar` unset — white icons — and edge-to-edge makes the bar
  // transparent, so on a light wallpaper the clock, the battery and the signal
  // bars simply disappear. `ink` is the INK, not the background, so a dark app
  // needs light icons. On a Mac there is no status bar to paint and the call is
  // inert. In a browser there is no status bar either, but there IS a document
  // whose `theme-color` and page background have to follow the pinned theme —
  // which is why `background` is handed over as well, and why the web seam is
  // the one place that reads it.
  return (
    <ThemeContext.Provider value={theme}>
      <SystemStatusBar
        background={theme.wallpaper.fill}
        focus={theme.colors.accentText}
        ink={scheme === 'dark' ? 'light' : 'dark'}
      />
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

/**
 * The same theme with its type scale multiplied, for one subtree.
 *
 * The transcript's text size (`store/text-size.ts`) is a factor on the TYPE
 * TOKENS and on nothing else, and this is how it reaches the words without
 * reaching the chrome: a nested provider around the transcript, so every
 * component under it reads the scaled tokens through the same `theme.type` it
 * already reads — `Text`, `Markdown`, the code blocks and the bubbles all go
 * through it — and every component outside it is untouched.
 *
 * A provider rather than a prop for exactly that reason. A prop would have to
 * be threaded through every row, every bubble and every markdown block, and the
 * first component somebody added without it would be the one that stayed 17pt
 * while the rest of the conversation grew.
 *
 * Only `type` changes. Colours, glass, spacing and both accessibility flags are
 * the outer theme's own objects, passed through by identity, so nothing that
 * memoises on them re-renders because a reader changed the text size.
 *
 * A scale of exactly 1 provides the theme UNCHANGED — the same object, not a
 * copy — so the default costs nothing at all, not even a context value that
 * differs by identity from the one above it.
 */
export function TypeScaleProvider({ children, scale }: { children: ReactNode; scale: number }) {
  const theme = useTheme()

  const scaled = useMemo<Theme>(() => {
    if (scale === 1) {
      return theme
    }

    const type = Object.fromEntries(
      Object.entries(theme.type).map(([token, style]) => [
        token,
        {
          ...style,
          fontSize: Math.round(style.fontSize * scale * 10) / 10,
          lineHeight: Math.round(style.lineHeight * scale * 10) / 10
        }
      ])
    ) as Theme['type']

    return { ...theme, type }
  }, [scale, theme])

  return <ThemeContext.Provider value={scaled}>{children}</ThemeContext.Provider>
}
