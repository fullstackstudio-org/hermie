/**
 * The `+` menu: _Photo library_, _Choose file_ — as a popover anchored above the
 * button, the way WhatsApp desktop draws it.
 *
 * §6.7 calls it a small glass menu, and the owner measured why it has to be one.
 * The `+` used to open the system photo picker directly, and on the Mac there were
 * **1.5–2 seconds of nothing** between the tap and the picker appearing — long
 * enough that the tap read as ignored. Nothing here can fix how long UIKit takes
 * to present a picker, so the fix is to stop pretending the tap was the picker: the
 * menu is local state with no async in it at all, so it paints in the same frame
 * as the tap, and the entry the reader chooses shows a busy state for as long as
 * the system takes.
 *
 * `busy` is therefore not a nicety. It is the only honest thing on screen during
 * those two seconds.
 *
 * On a Mac the order is reversed: `Choose file` first. A Mac window has a
 * filesystem in front of it and a photo library somewhere behind it, which is the
 * opposite of a phone.
 *
 * ## Why it is a popover and not a list, and why it has no tail
 *
 * It was a list: two full-width rows of text in a card sitting above the composer.
 * A list of two things is a list for the sake of being one, so the choices are round
 * icon buttons with their labels underneath — two objects rather than a truncated
 * menu.
 *
 * It also had a TAIL: an SVG pointer hanging off the lower edge, aimed at the centre
 * of the `+`. That is gone, by the owner's call, on every platform. A tail is a
 * bubble's shape, and a bubble is a thing somebody said; a menu that borrows it
 * reads as a message from the composer. What says where this came from is the
 * MOTION — it rises out of the `+` and sinks back into it — which is what the
 * platform's own menus use and the one cue that survives the popover being dragged
 * anywhere near an edge. The arithmetic that aimed the tip (`pointerOffset`, half
 * the round control, computed by the composer) went with it.
 *
 * ## It is opaque, and that is not a style choice
 *
 * `GlassSurface`'s own rule: a text-heavy surface takes the solid rung under its
 * wash, so its contrast is a fixed number rather than a function of whatever is
 * behind it. Without it this menu floats over the transcript at the wash's own
 * alpha, and what a simulator shows is "Photo library" printed across the file
 * path of the tool card underneath — two strings of text at the same weight in
 * the same place. It was survivable while the tail said where the menu ended;
 * with the tail gone the surface has to be the thing that says so.
 *
 * ## The narrow case
 *
 * `layout="list"` keeps the old stacked rows. Two round buttons with labels under
 * them need about 180pt of width, and the phone's composer can be narrower than that
 * with the tray open — so the caller picks, and the list is still the honest
 * fallback rather than a squeezed popover.
 */
import { Pressable, View } from 'react-native'

import { GlassSurface } from '../ui/glass'
import { Icon, ICON_SIZE, type IconName } from '../ui/Icon'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_MIN_HEIGHT, CONTROL_SIZE, TAP_SLOP } from '../ui/tokens'
import type { AttachChoice } from './types'

/** The round glass button a choice is drawn as. Matches §4's wide-layout control. */
const CHOICE_SIZE = CONTROL_SIZE.regular + 6

/**
 * The stacked list's width floor.
 *
 * The POPOVER has none — it is as wide as its two labels and no wider, which is
 * the whole reason a label is allowed to be long. A floor is what the fallback
 * needs, because full-width rows of text in a card that is only as wide as the
 * longest of them is not a list, it is two sentences.
 */
export const ATTACH_LIST_MIN_WIDTH = 220

const GLYPH_FOR: Record<AttachChoice['id'], IconName> = { file: 'file', photo: 'photo' }

export interface AttachMenuProps {
  choices: readonly AttachChoice[]
  onChoose: (id: AttachChoice['id']) => void
  /**
   * `popover` is the default. `list` is the narrow fallback — see the note above.
   */
  layout?: 'popover' | 'list'
  testID?: string
}

export function AttachMenu({
  choices,
  onChoose,
  layout = 'popover',
  testID = 'composer-attach-menu'
}: AttachMenuProps) {
  const theme = useTheme()

  if (layout === 'list') {
    return (
      <GlassSurface
        contentStyle={{ paddingVertical: theme.space.xs }}
        opaque
        radius={theme.radii.card}
        shadow="float"
        style={{ alignSelf: 'flex-start', marginBottom: theme.space.sm, minWidth: ATTACH_LIST_MIN_WIDTH }}
        testID={testID}
        variant="float"
      >
        {choices.map(choice => (
          <Pressable
            accessibilityRole="button"
            aria-busy={choice.busy ?? false}
            disabled={choice.busy}
            key={choice.id}
            onPress={() => onChoose(choice.id)}
            style={({ pressed }) => ({
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.sm,
              justifyContent: 'space-between',
              minHeight: CONTROL_MIN_HEIGHT,
              opacity: pressed ? 0.6 : 1,
              paddingHorizontal: theme.space.lg
            })}
            testID={`${testID}-${choice.id}`}
          >
            <Text variant="preview">{choice.label}</Text>
            {choice.busy ? <BusyMark testID={`${testID}-${choice.id}-busy`} /> : null}
          </Pressable>
        ))}
      </GlassSurface>
    )
  }

  return (
    <GlassSurface
      contentStyle={{
        flexDirection: 'row',
        gap: theme.space.md,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.md
      }}
      opaque
      radius={theme.radii.xl}
      shadow="float"
      style={{ alignSelf: 'flex-start', marginBottom: theme.space.sm }}
      testID={testID}
      variant="float"
    >
      {choices.map(choice => (
        <Pressable
          accessibilityLabel={choice.label}
          accessibilityRole="button"
          aria-busy={choice.busy ?? false}
          disabled={choice.busy}
          hitSlop={TAP_SLOP}
          key={choice.id}
          onPress={() => onChoose(choice.id)}
          style={({ pressed }) => ({ alignItems: 'center', gap: theme.space.xs, opacity: pressed ? 0.6 : 1 })}
          testID={`${testID}-${choice.id}`}
        >
          <GlassSurface
            contentStyle={{
              alignItems: 'center',
              height: CHOICE_SIZE,
              justifyContent: 'center',
              width: CHOICE_SIZE
            }}
            variant="control"
          >
            {choice.busy ? (
              <BusyMark testID={`${testID}-${choice.id}-busy`} />
            ) : (
              <Icon color={theme.colors.text} name={GLYPH_FOR[choice.id]} size={ICON_SIZE.control} />
            )}
          </GlassSurface>

          {/*
              The label UNDER the button, not beside it: two labelled columns are
              two objects, and a label beside a round button in a row of two is a
              list again.

              It carries no width limit and no line clamp, so the COLUMN is as wide
              as its label. Clamping it to the button's width was tried and
              photographed on an iPad: "Photo library" came out as "Photo libr…",
              which is a label that has stopped being one. The popover is two short
              words wide either way, and a translation that is longer simply makes
              it wider — which is the correct outcome for a thing that floats.
            */}
          <Text color="textMuted" variant="micro">
            {choice.label}
          </Text>
        </Pressable>
      ))}
    </GlassSurface>
  )
}

/**
 * The busy mark: a still, hollow ring.
 *
 * Not a spinner. §5 reserves motion for things that need the reader, and the one
 * thing this state has to say is "the tap landed".
 */
function BusyMark({ testID }: { testID: string }) {
  const theme = useTheme()

  return (
    <View
      style={{ borderColor: theme.colors.textFaint, borderRadius: 7, borderWidth: 2, height: 14, width: 14 }}
      testID={testID}
    />
  )
}
