/**
 * The wizard's one surface: a glass card on the wallpaper, holding whichever
 * step is current.
 *
 * What it replaces is worth writing down, because the shape was the complaint.
 * Every step used to be a full-bleed `Screen`: an eyebrow and a title at the
 * top, a paragraph, sometimes a field, then a tall empty middle, a hairline and
 * a pinned footer carrying Continue and Back. On a Mac window that middle was
 * most of the screen, and the two controls that move the wizard forward were as
 * far from the content they act on as the layout could put them.
 *
 * So the card's height follows its content, the actions sit INSIDE it under the
 * step they belong to, and the hairline is gone — a card already has an edge.
 *
 * Three things are deliberate:
 *
 *  - **The wallpaper is drawn here**, not by `Screen`. `Screen` fills its box
 *    with `elevation.e0` at depth 0, which is the wallpaper's own rung, so a
 *    wizard inside one would paint the floor over the floor. Every other
 *    wallpapered surface in the app does the same thing (`RegularShell`,
 *    `CompactShell`), and for the same reason.
 *  - **The card is one glass level.** It is a `sheet` surface, `opaque`, because
 *    it carries running body text and a token in a field: §7.1 of
 *    `design/liquid-glass-tokens.md` says a text-heavy surface gets the solid
 *    rung under the gradient so its contrast is a fixed number rather than a
 *    function of whichever wallpaper is behind it. Everything inside it is a
 *    level-3 tint, never a second blur.
 *  - **The keyboard behaviour survived the redesign.** The soft keyboard used to
 *    cover the pinned footer, which is why the footer existed at all; the card
 *    is inside the same `KeyboardAvoidingView` and inside a scroll view, so a
 *    field, its status line and the button under it all stay reachable.
 */
import type { ReactNode } from 'react'
import { Image, KeyboardAvoidingView, Pressable, ScrollView, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSafeAreaInsets } from '../../platform/safe-area'
import { GlassSurface, Wallpaper } from '../../ui/glass'
import { KEYBOARD_AVOID_BEHAVIOR } from '../../ui/keyboard'
import { Button, CodeChipText, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { ONBOARDING_CARD_MAX_WIDTH, WINDOW_GAP } from '../../ui/tokens'

const APP_ICON = require('../../../assets/icon.png') as number

export type OnboardingCardProps = {
  /** Which of the numbered steps this is, or `-1` for the Welcome cover. */
  stepIndex: number
  stepCount: number
  /** The cover shows the app icon instead of a progress rail. */
  cover?: boolean
  title: string
  lead?: string
  children?: ReactNode
  primaryLabel: string
  onPrimary: () => void
  primaryDisabled?: boolean
  primaryBusy?: boolean
  /** Omitted on the first step, where there is nowhere to go back to. */
  onBack?: (() => void) | undefined
  /** Back stays visible but inert while the last step is writing to disk. */
  backDisabled?: boolean
  /**
   * A way out of the wizard entirely, offered only when there is something to
   * go back TO: "Change gateway" opens setup over a gateway that is still
   * configured, and a reader who only wanted to read the address must not have
   * to finish a setup to get their app back.
   */
  onCancel?: (() => void) | undefined
  testID?: string
}

export function OnboardingCard({
  stepIndex,
  stepCount,
  cover = false,
  title,
  lead,
  children,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryBusy = false,
  onBack,
  backDisabled = false,
  onCancel,
  testID
}: OnboardingCardProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <Wallpaper style={{ flex: 1 }} testID="onboarding-wallpaper">
      <KeyboardAvoidingView behavior={KEYBOARD_AVOID_BEHAVIOR} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            alignItems: 'center',
            // `flexGrow` rather than `flex`: the card is centred while it is
            // shorter than the window and scrolls from the top once it is not,
            // which is what happens on a phone with the keyboard up.
            flexGrow: 1,
            justifyContent: 'center',
            paddingBottom: WINDOW_GAP + insets.bottom,
            paddingLeft: WINDOW_GAP + insets.left,
            paddingRight: WINDOW_GAP + insets.right,
            paddingTop: WINDOW_GAP + insets.top
          }}
          keyboardShouldPersistTaps="handled"
          ref={directTouchPanRef}
        >
          <GlassSurface
            contentStyle={{ gap: theme.space.panel, padding: theme.space.panel }}
            opaque
            style={{ maxWidth: ONBOARDING_CARD_MAX_WIDTH, width: '100%' }}
            testID={testID ?? 'onboarding-card'}
            variant="sheet"
          >
            <View style={{ gap: theme.space.md }}>
              {cover ? (
                <Image
                  accessibilityIgnoresInvertColors
                  source={APP_ICON}
                  style={{ borderRadius: theme.radii.thumb, height: 56, width: 56 }}
                />
              ) : (
                <View style={{ gap: theme.space.sm }}>
                  <StepRail current={stepIndex} total={stepCount} />
                  {/*
                    Uppercased by the STYLE, not by the string. `toUpperCase()`
                    would change what the text node contains, which is what a
                    screen reader announces and what a test reads back — and
                    `micro` is the uppercase-label token, so the casing is the
                    token's job either way.
                  */}
                  <Text color="textMuted" style={{ textTransform: 'uppercase' }} testID="step-counter" variant="micro">
                    {strings.onboarding.stepCounter(stepIndex + 1, stepCount)}
                  </Text>
                </View>
              )}

              <Text variant={cover ? 'title' : 'sheetTitle'}>{title}</Text>
              {/*
                `CodeChipText`, not `Text`: a lead that names a command writes it
                in backticks, as everybody does, and plain text drew the
                backticks. The chip is the transcript's chip.
              */}
              {lead ? <CodeChipText>{lead}</CodeChipText> : null}
            </View>

            {children}

            <View style={{ gap: theme.space.sm }}>
              {/*
                Exactly one accented block per card. A step that owns its own
                action — "Sign in with …", "Test connection" — keeps Continue
                shut until that action has produced something, and two
                full-width blue buttons stacked on top of each other read as
                two ways forward rather than as one gate. So while Continue is
                shut it is drawn as the quiet variant, and the step's own
                button is the only blue thing on the card.
              */}
              <Button
                busy={primaryBusy}
                disabled={primaryDisabled}
                onPress={onPrimary}
                title={primaryLabel}
                variant={primaryDisabled ? 'secondary' : 'primary'}
              />
              {onBack ? (
                <Pressable
                  accessibilityRole="button"
                  aria-disabled={backDisabled}
                  disabled={backDisabled}
                  hitSlop={12}
                  onPress={onBack}
                  style={({ pressed }) => ({
                    alignSelf: 'center',
                    opacity: backDisabled ? 0.4 : pressed ? 0.6 : 1,
                    padding: theme.space.sm
                  })}
                >
                  <Text color="accentText" variant="preview">
                    {strings.common.back}
                  </Text>
                </Pressable>
              ) : null}
              {onCancel ? (
                <Pressable
                  accessibilityRole="button"
                  aria-disabled={backDisabled}
                  disabled={backDisabled}
                  hitSlop={12}
                  onPress={onCancel}
                  style={({ pressed }) => ({
                    alignSelf: 'center',
                    opacity: backDisabled ? 0.4 : pressed ? 0.6 : 1,
                    padding: theme.space.sm
                  })}
                  testID="onboarding-cancel"
                >
                  <Text color="textMuted" variant="preview">
                    {strings.common.cancel}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </GlassSurface>
        </ScrollView>
      </KeyboardAvoidingView>
    </Wallpaper>
  )
}

/**
 * The progress rail: one slim segment per numbered step, filled up to and
 * including the current one.
 *
 * Static, like every other status indicator in the app. It is hidden from
 * assistive technology because the eyebrow under it says the same thing in
 * words, and a row of four unlabelled bars is noise to a screen reader.
 */
function StepRail({ current, total }: { current: number; total: number }) {
  const theme = useTheme()

  return (
    <View
      accessibilityElementsHidden
      // `aria-hidden` is the web's spelling of the two props around it; react-native-web
      // honours neither of those. See `ui/Icon.tsx`.
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ flexDirection: 'row', gap: theme.space.xs }}
      testID="step-rail"
    >
      {Array.from({ length: total }, (_, index) => (
        <View
          key={index}
          style={{
            backgroundColor: index <= current ? theme.colors.accentText : theme.tintSunk,
            borderRadius: theme.radii.pill,
            flex: 1,
            height: 4
          }}
        />
      ))}
    </View>
  )
}
