/**
 * One glass surface, in whichever material this platform can draw.
 *
 * A glass surface is a stack: a blur, one translucent wash, a specular edge and
 * a drop shadow. Which parts are real depends on the platform
 * (`material.ts`) and on the reader's Reduce Transparency setting; the token set
 * is identical in all three cases, which is the point — the dark elevation
 * ladder is defined so that the solid fallback keeps the same hierarchy.
 *
 * Two rules from `design/liquid-glass-tokens.md` are enforced here rather than
 * documented and hoped for:
 *
 *  - **Never nest glass more than one level.** Panel (level 1) → header,
 *    composer, sheet, card (level 2) → tint only (level 3). Two stacked blurs
 *    cost real frame time on the wide layout and visually cancel out: the second
 *    samples an already-blurred backdrop and returns mud. A `GlassSurface`
 *    inside a `GlassSurface` inside a `GlassSurface` therefore drops to a tint
 *    on its own, by reading the depth off a context.
 *  - **Text-heavy surfaces get a tint layer.** `opaque` lays the surface's solid
 *    rung under the wash at full strength, so body-text contrast is a fixed
 *    number rather than a function of whatever is behind it.
 *  - **No gradients.** Not here and not anywhere: the owner's verdict is that
 *    they look generated. The wash is one flat colour at the alpha the thinnest
 *    stop used to carry — see `GlassRecipe.fill`.
 */
import { BlurView } from 'expo-blur'
import { createContext, useContext, type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'

import { useTheme } from '../theme'
import type { GlassVariant, ShadowName } from '../tokens'
import { GLASS_MATERIAL } from './material'
import { GlassContainer, GlassView } from './native-effect'

/** How many glass surfaces are already between this one and the wallpaper. */
const GlassDepth = createContext(0)

/**
 * How many glass surfaces are between the caller and the wallpaper.
 *
 * Read by anything that would otherwise paint an opaque background of its own.
 * `Screen` is the one that matters: it fills with the app's background colour
 * and adds the safe-area inset, both of which are right on a phone and both of
 * which are wrong inside a floating panel that has already done them.
 */
export function useGlassDepth(): number {
  return useContext(GlassDepth)
}

/**
 * Say that a background has already been painted between here and the window.
 *
 * `GlassSurface` does this for itself. This is for the ONE thing that is a
 * background without being glass: the edge-to-edge chat column, which is the
 * wallpaper rather than a floating panel (`RegularShell`). Everything inside it —
 * the header, the composer, a `Screen` — has to read the same depth it read while
 * the column was a panel, or the header drops to a level-3 tint and `Screen`
 * paints the wallpaper's own rung over the wallpaper.
 */
export function GlassDepthProvider({ value, children }: { value: number; children: ReactNode }) {
  return <GlassDepth.Provider value={value}>{children}</GlassDepth.Provider>
}

/** The level past which a surface stops blurring and becomes a plain tint. */
const MAX_GLASS_DEPTH = 2

export type GlassSurfaceProps = Omit<ViewProps, 'style'> & {
  variant?: GlassVariant
  /** Defaults to the radius that belongs to the variant. */
  radius?: number
  /**
   * The BOTTOM corners, when they differ from the rest.
   *
   * A bottom sheet is the only caller: it sits on the window's own edge, so its
   * lower corners are square. It used to say that by overriding four style keys
   * on two of the surface's views — which left the third, the native material,
   * still rounded, and a material is not clipped by a parent's corner mask the
   * way a plain layer is. One number reaches every layer instead.
   */
  radiusBottom?: number
  shadow?: ShadowName | 'none'
  /** A chat's accent, laid under the wash. Used by the selected row. */
  tint?: string
  /** Lay the solid rung under the glass, for a surface that carries body text. */
  opaque?: boolean
  /**
   * This surface is a BUTTON, so the material may react to the finger.
   *
   * `UIGlassEffect.isInteractive` is what makes a Liquid Glass control feel like
   * one: it flexes and brightens under the touch, which is the behaviour the
   * reference toolbars have and which a `Pressable` opacity change only imitates.
   * Off by default and wrong for anything that holds content — a panel carrying a
   * scrolling list must not squirm when the reader drags it.
   */
  interactive?: boolean
  style?: StyleProp<ViewStyle>
  /** The outer box carries the shadow; this styles the clipped inner surface. */
  contentStyle?: StyleProp<ViewStyle>
  /** A handle on that inner surface, for a caller whose padding lives there. */
  contentTestID?: string
  children?: ReactNode
}

const RADIUS_FOR: Record<GlassVariant, keyof ReturnType<typeof useTheme>['radii']> = {
  panel: 'panel',
  float: 'sheet',
  sheet: 'sheet',
  card: 'card',
  row: 'card',
  rowSelected: 'card',
  control: 'pill',
  chip: 'pill'
}

const SHADOW_FOR: Record<GlassVariant, ShadowName | 'none'> = {
  panel: 'panel',
  float: 'float',
  sheet: 'sheet',
  card: 'card',
  row: 'none',
  rowSelected: 'card',
  control: 'card',
  chip: 'none'
}

export function GlassSurface({
  variant = 'panel',
  radius,
  radiusBottom,
  shadow,
  tint,
  opaque = false,
  interactive = false,
  style,
  contentStyle,
  contentTestID,
  children,
  ...rest
}: GlassSurfaceProps) {
  const theme = useTheme()
  const depth = useContext(GlassDepth)
  const recipe = theme.glass[variant]

  const cornerRadius = radius ?? theme.radii[RADIUS_FOR[variant]]
  const bottomRadius = radiusBottom ?? cornerRadius
  // Spelled per corner so that one number can differ; a single `borderRadius`
  // beside a per-corner override is two rules for one shape, and which wins
  // depends on the order a style array happens to be flattened in.
  const corners = {
    borderBottomLeftRadius: bottomRadius,
    borderBottomRightRadius: bottomRadius,
    borderTopLeftRadius: cornerRadius,
    borderTopRightRadius: cornerRadius
  }
  const shadowToken = shadow ?? SHADOW_FOR[variant]
  const shadowStyle = shadowToken === 'none' ? null : theme.shadows[shadowToken]

  // A variant whose recipe carries no blur is already a level-3 tint by
  // definition (a chip, a list row), so it never counts towards the depth and
  // never opens a blur view of its own.
  const wantsBlur = recipe.blurIntensity > 0
  /*
    Two things decide the material, and the app's own window state is not one of
    them.

    R11a made a surface stop drawing its `UIVisualEffectView` while the Mac
    window was not key, because macOS dims a visual effect view in a window that
    is not in front and this was the only lever UIKit offers. The owner rejected
    the cure along with the disease — _"I do not want the styling to change when
    the window is inactive. Same for iOS, Android etc."_ — and he is describing
    the thing that swap DID: it changed the app's own drawing, at the moment the
    reader looked away, which is a restyle whichever direction it goes in. What
    macOS does to its own materials is the platform's business and is the same
    for every application on the screen; what this app draws is now the same
    whether its window is in front or behind. See docs/platform-notes.md.
  */
  const blurred = wantsBlur && !theme.reduceTransparency && depth < MAX_GLASS_DEPTH && GLASS_MATERIAL !== 'solid'
  const childDepth = wantsBlur ? depth + 1 : depth

  /**
   * A level-3 tint stays TRANSLUCENT even where there is no blur anywhere.
   *
   * Its rung exists so that the tint composites onto a known colour, not so
   * that the tint becomes that colour: a chip that paints itself `e4` on a
   * panel is an opaque white rectangle, which is what the gateway card looked
   * like before this distinction existed. The opaque rung belongs to the
   * surfaces that have to hide a wallpaper — panels, sheets, cards — and only
   * when they cannot blur it.
   */
  const translucent = blurred ? !opaque : !wantsBlur

  /** The real material is drawing this surface, so our own layers step back. */
  const native = blurred && GLASS_MATERIAL === 'native'

  // The specular edge reads as an inner highlight on glass and as a plain
  // hairline where there is none, so the border colour follows the material
  // rather than the token set.
  const border = blurred ? (variant === 'panel' ? theme.edge : theme.edgeSoft) : recipe.hairline

  return (
    <View {...rest} style={[shadowStyle, corners, style]}>
      <View
        style={[
          {
            ...corners,
            overflow: 'hidden',
            borderWidth: border === 'transparent' ? 0 : 1,
            borderColor: border,
            backgroundColor: translucent ? 'transparent' : recipe.solid
          },
          contentStyle
        ]}
        testID={contentTestID}
      >
        {blurred ? (
          <Material
            corners={corners}
            interactive={interactive}
            intensity={recipe.blurIntensity}
            tint={recipe.nativeTint}
          />
        ) : null}

        {/*
          The wash: a low-alpha flat fill that turns a plain blur into something
          that reads as a material. It belongs to the two FALLBACKS and nowhere
          else — the real Liquid Glass material already lightens and refracts,
          and laying our own wash over it applies the lightening twice. Measured
          on an iPhone 17 Pro (iOS 26.5): with both, the Blue wallpaper read as a
          flat near-white field behind the list.

          It used to be a diagonal gradient. The owner's verdict on gradients is
          that they look generated, and the benchmark he set — iPadOS 26 Messages
          — has none: the transparency comes from the material, not from a ramp
          painted on top of it.
        */}
        {native ? null : (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: recipe.fill }]} />
        )}

        {tint ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} /> : null}

        <GlassDepth.Provider value={childDepth}>{children}</GlassDepth.Provider>
      </View>
    </View>
  )
}

/**
 * The blur itself.
 *
 * On iOS 26 this is the real material — a `UIVisualEffectView` carrying a
 * `UIGlassEffect`, which samples and refracts what is behind it rather than only
 * blurring it.
 *
 * Both materials are told the app's scheme rather than left on `auto`. A native
 * material reads the window's trait collection, and with the theme pinned against
 * the system's the two disagree: pinned Light on a Dark Mac drew murky dark glass
 * under light ink. `ThemeProvider` now overrides the window's interface style, so
 * `colorScheme` here is the same answer said twice — which is the point. It is
 * the only thing standing between a material and the system appearance if a
 * window ever escapes that override, and it costs one prop.
 *
 * `isInteractive` is passed through rather than hard-coded off. It used to be off
 * everywhere, on the argument that the round controls were small enough for the
 * effect to read as noise; the owner's reference — the buttons beside the Messages
 * search field — says otherwise, and it is what makes a Liquid Glass control feel
 * like a control rather than like a picture of one. It stays off for anything that
 * holds content.
 *
 * A native material that is interactive must also be able to RECEIVE the touch, so
 * `pointerEvents` follows it. Elsewhere the material is decoration behind a
 * `Pressable` and stays out of the way.
 */
function Material({
  intensity,
  tint,
  corners,
  interactive
}: {
  intensity: number
  tint?: string | undefined
  /** Per corner, so a sheet's square bottom reaches the material too. */
  corners: ViewStyle
  interactive: boolean
}) {
  const theme = useTheme()

  if (GLASS_MATERIAL === 'native') {
    return (
      <GlassView
        colorScheme={theme.scheme}
        glassEffectStyle="regular"
        isInteractive={interactive}
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, corners]}
        {...(tint ? { tintColor: tint } : {})}
      />
    )
  }

  return (
    <BlurView
      intensity={intensity}
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      tint={theme.scheme === 'dark' ? 'systemMaterialDark' : 'systemMaterialLight'}
    />
  )
}

/**
 * Several glass surfaces that should merge where they meet.
 *
 * iOS 26 does this natively through `UIGlassContainerEffect`: two round controls
 * closer together than `spacing` flow into one shape the way the system's own
 * toolbars do. Everywhere else it is a plain row, which is what those controls
 * look like anyway.
 */
export function GlassGroup({ spacing = 12, style, children, ...rest }: ViewProps & { spacing?: number }) {
  const theme = useTheme()

  // Reduce Transparency is the one thing that takes the container away; the
  // window's own key state is not, for the reason `GlassSurface` gives above.
  if (GLASS_MATERIAL !== 'native' || theme.reduceTransparency) {
    return (
      <View {...rest} style={style}>
        {children}
      </View>
    )
  }

  return (
    <GlassContainer {...rest} spacing={spacing} style={style}>
      {children}
    </GlassContainer>
  )
}
