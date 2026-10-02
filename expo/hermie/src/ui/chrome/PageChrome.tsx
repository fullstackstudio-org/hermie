/**
 * The one chrome for every non-chat page, in both shells.
 *
 * Before this, back was a per-screen convention: `cron/ScreenHeader`,
 * `memory/MemoryScreenHeader`, a secondary `Button`, an `InsetButtonRow`, a bare
 * `Pressable` — five ways of drawing the same idea, which is the root cause of
 * HERM-101 (a page that forgot its own back button) and HERM-75 (the stray
 * "‹ Bots" left over from a native header nobody meant to keep). `PageChrome` is
 * the only shape a back control is drawn in from here on: exactly one round
 * glass button, top left, with the previous page's name beside it.
 *
 * ## It floats, like the chat header
 *
 * The reference is the same one `ChatHeader` follows — iPadOS 26 Messages — and
 * for the same reason: the header draws no background panel of its own, so the
 * content scrolls UNDER it and blurs through the glass. That is why this
 * component takes no `children`. A page's content is a sibling, not something
 * this wraps, and `usePageScroll` is what tells that sibling how much of itself
 * to hide under the header.
 *
 * ## Native header, never
 *
 * The Architecture Decisions record why: the required control — a round glass
 * button labelled with the previous page's name — has no native equivalent on
 * two of the four platforms this app draws on. `headerShown: false` everywhere,
 * and this is what fills the gap.
 */
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'

import { GlassSurface } from '../glass'
import { Icon, ICON_SIZE } from '../Icon'
import { Text } from '../primitives/Text'
import { useTheme } from '../theme'
import { CONTROL_SIZE, TAP_SLOP } from '../tokens'
import { useEscapeKey } from '../useEscapeKey'
import { useHardwareBack } from '../useHardwareBack'

export interface PageChromeBack {
  /** The page THIS back returns to, not a generic "Back". */
  label: string
  onPress: () => void
}

export interface PageChromeProps {
  title: string
  /** A quieter second line under the title, centred with it. */
  subtitle?: string
  /**
   * The page draws its own heading, so the bar must not draw a second one.
   *
   * One caller: a Settings CATEGORY page, whose header card carries the name,
   * the mark and the sentence (`CategoryHeaderCard`). A centred title in the bar
   * directly above that card is the same word twice, and the owner's reference
   * has no title bar over the card at all.
   *
   * `title` is still required and still given: it is what a caller passes to
   * `PageFrame`, what the stack reads for a child's back label, and what a
   * screen reader would get if this ever regressed to drawing it. Hiding it is a
   * decision about the BAR, not about whether the page has a name.
   *
   * With nothing else in the row — no back on the stack's bottom page, no
   * trailing action — the bar draws no glass at all and measures zero, so the
   * card starts at the top of the pane instead of under an empty strip.
   */
  titleHidden?: boolean
  /**
   * Absent on a tab root, which has nowhere to go back to. Present everywhere
   * else, with `label` the title of the page one level up — derived by the
   * caller (`useStackBack` for a routed page), never typed by hand, so it
   * cannot drift from the route it actually returns to.
   */
  back?: PageChromeBack
  /** The trailing slot — a close (X), a menu, a page-specific action. */
  trailing?: ReactNode
  testID?: string
  /**
   * The chrome's measured height, on every change.
   *
   * `usePageChromeHeight`'s context only reaches a descendant of THIS
   * component's own returned tree — the `trailing` slot, in practice — and a
   * page's scrolling content is a sibling, not a descendant (see the module
   * doc). This is how that sibling gets the number without a page reaching
   * into `PageChrome`'s internals or re-measuring the same header itself:
   * `onLayout` on this component's own header feeds it straight out, and the
   * caller hands it to `usePageScroll(height)`.
   */
  onHeightChange?: (height: number) => void
}

/** How tall the chrome measured itself, so a scrolling sibling knows how much to clear. */
export const PageChromeHeightContext = createContext(0)

/**
 * Where a chrome reports the height it measured, when something above it wants
 * to hand that number to the chrome's SIBLINGS — see `PageFrame`. The height
 * context below only reaches the chrome's own subtree (its trailing slot), and a
 * page's list is never inside the header it scrolls under.
 */
export const PageChromeReportContext = createContext<((height: number) => void) | null>(null)

/**
 * The chrome's own height, for whatever needs it.
 *
 * `usePageScroll` is the one caller most pages need; this is exported
 * separately for the rare page that wants the number itself — a sticky section
 * header deciding where its own top sits, say — rather than a ready-made set of
 * scroll props.
 */
export function usePageChromeHeight(): number {
  return useContext(PageChromeHeightContext)
}

export function PageChrome({
  title,
  subtitle,
  back,
  trailing,
  titleHidden = false,
  testID = 'page-chrome',
  onHeightChange
}: PageChromeProps) {
  const theme = useTheme()
  const [height, setHeight] = useState(0)
  const report = useContext(PageChromeReportContext)
  // Nothing left to put in the row. See `titleHidden`: a glass strip holding one
  // invisible spacer is furniture, and this is a page that asked for none.
  const empty = titleHidden && !back && !trailing

  // A page never wires these by hand. `enabled` follows `back` rather than a
  // constant `true`, so a tab root — which passes no `back` at all — takes
  // neither key and lets whatever is under it answer instead.
  useEscapeKey(() => back?.onPress(), Boolean(back))
  useHardwareBack(() => back?.onPress(), Boolean(back))

  return (
    <PageChromeHeightContext.Provider value={height}>
      {/*
        `box-none` so the gaps around the row — most of a wide window — pass
        drags and taps through to whatever is scrolling underneath, exactly as
        `ChatHeader` does. `onLayout` is what turns "how tall is this" into a
        number a sibling scroll view can use; it is real height, not a token,
        because the row's height depends on whether a subtitle is showing.
      */}
      <View
        onLayout={event => {
          const measured = event.nativeEvent.layout.height

          setHeight(measured)
          onHeightChange?.(measured)
          report?.(measured)
        }}
        pointerEvents="box-none"
        style={{ left: 0, position: 'absolute', right: 0, top: 0 }}
        testID={testID}
      >
        {empty ? null : (
          <GlassSurface
            contentStyle={{
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.sm,
              paddingHorizontal: theme.space.md,
              paddingVertical: theme.space.sm
            }}
            radius={0}
            shadow="none"
            testID={`${testID}-surface`}
            variant="float"
          >
            {/*
            The leading slot. Exactly one back control when `back` is given,
            nothing at all otherwise — a tab root draws no leading slot rather
            than an empty one, which is the whole of HERM-105's "no back on a
            root" without a special case per shell.
          */}
            {back ? (
              <Pressable
                accessibilityLabel={back.label}
                accessibilityRole="button"
                hitSlop={TAP_SLOP}
                onPress={back.onPress}
                style={({ pressed }) => ({
                  alignItems: 'center',
                  flexDirection: 'row',
                  flexShrink: 0,
                  gap: theme.space.xs,
                  opacity: pressed ? 0.6 : 1
                })}
                testID="page-back"
              >
                {/*
                The same glass circle `RoundIconButton` draws — a `GlassSurface`
                that may merge with a neighbour, `opaque` so a bubble passing
                underneath cannot read through the mark. It is not the
                `RoundIconButton` component itself: that component owns its own
                `Pressable`, and nesting one inside this row's `Pressable` would
                make "one pressable, one testID" two overlapping ones instead.
              */}
                <GlassSurface
                  interactive
                  opaque
                  radius={CONTROL_SIZE.regular / 2}
                  shadow="card"
                  style={{ height: CONTROL_SIZE.regular, width: CONTROL_SIZE.regular }}
                  variant="control"
                >
                  <Icon
                    color={theme.colors.accentText}
                    name="chevronLeft"
                    size={ICON_SIZE.control}
                    slot={CONTROL_SIZE.regular}
                  />
                </GlassSurface>
                <Text color="accentText" numberOfLines={1} style={{ flexShrink: 1 }} variant="body">
                  {back.label}
                </Text>
              </Pressable>
            ) : null}

            {/*
            The title, centred. Not measured against the leading and trailing
            slots the way the chat pill is — those are a fixed size there and a
            variable one here (a back label is as long as the previous page's
            name) — so this is `flex: 1` and `textAlign: 'center'` rather than
            an exact geometric centre. Close enough for a page title, which
            nothing sits directly across from the way the chat pill's avatar
            does.
          */}
            <View style={{ flex: 1, gap: theme.space.xxs }}>
              {titleHidden ? null : (
                <Text
                  accessibilityRole="header"
                  aria-level={1}
                  numberOfLines={1}
                  style={{ textAlign: 'center' }}
                  variant="chatName"
                >
                  {title}
                </Text>
              )}
              {subtitle ? (
                <Text color="textMuted" numberOfLines={1} style={{ textAlign: 'center' }} variant="meta">
                  {subtitle}
                </Text>
              ) : null}
            </View>

            {trailing ? <View style={{ flexShrink: 0 }}>{trailing}</View> : null}
          </GlassSurface>
        )}
      </View>
    </PageChromeHeightContext.Provider>
  )
}
