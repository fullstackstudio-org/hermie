/**
 * The four destinations, drawn twice.
 *
 * `TabStrip` is the inset track the wide layout puts at the bottom of its
 * sidebar — a sunk plate with a raised slot for the current tab. `TabBar` is the
 * same four marks as the phone's own tab bar: full-bleed glass across the bottom
 * of the window, over the content rather than beside it.
 *
 * Both live here rather than in `features/bots` because the strip is no longer
 * the chat list's property. The compact shell's tab NAVIGATOR draws the bar
 * under every tab root, so the list is one of four screens under it instead of
 * the screen that owns it — and a component the shell draws cannot live inside
 * one of the screens the shell draws.
 *
 * Neither knows what a tab MEANS. They take a list of `{ key, label, icon }` and
 * report a key back; `features/bots/SidebarFooter.tsx` still owns the four
 * entries (`tabs()`), because the labels are the chat list's strings and the
 * sidebar rail reads the same list.
 */
import { Pressable, View } from 'react-native'

import { useSafeAreaInsets } from '../../platform/safe-area'
import { GlassSurface } from '../glass'
import { Icon, ICON_SIZE, type IconName } from '../Icon'
import { Text } from '../primitives/Text'
import { useTheme } from '../theme'

export interface TabItem {
  key: string
  label: string
  icon: IconName
}

export interface TabsProps {
  items: readonly TabItem[]
  /** The key of the tab that reads as current. */
  current: string
  /**
   * A tab was chosen. The CURRENT tab reports too — a second tap on the tab you
   * are already on is how a reader asks a stack to go back to its root, and the
   * navigator is what decides whether that means anything.
   */
  onSelect: (key: string) => void
  testID?: string
}

/**
 * One tab's mark and label, shared by both bars so they cannot drift.
 *
 * The icon is decorative and `Icon` hides itself from the tree — with
 * `aria-hidden` as well as the two native props, which is what makes that true
 * in a browser — so the tab is not announced twice. The accessible name is set
 * explicitly although the label is right there under the mark: name-from-content
 * is allowed for `tab` and Chrome does compute it, but a second reader on the
 * same page returned four tabs with no name at all. The label is the visible
 * text, character for character, so the two can never drift apart.
 */
function TabButton({
  tab,
  selected,
  onPress,
  style
}: {
  tab: TabItem
  selected: boolean
  onPress: () => void
  style: { backgroundColor: string; borderRadius: number; paddingVertical: number }
}) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityLabel={tab.label}
      accessibilityRole="tab"
      aria-selected={selected}
      onPress={onPress}
      style={{
        alignItems: 'center',
        flex: 1,
        gap: 2,
        paddingHorizontal: 2,
        ...style
      }}
      testID={`tab-${tab.key}`}
    >
      {/*
        One drawn size for all four marks, and one SLOT around each of them so
        the labels sit on one line whatever the mark's own weight wants.
      */}
      <Icon
        color={selected ? theme.colors.text : theme.colors.textMuted}
        name={tab.icon}
        size={ICON_SIZE.tab}
        slot={ICON_SIZE.tabSlot}
        testID={`tab-icon-${tab.key}`}
      />
      <Text color={selected ? 'text' : 'textMuted'} numberOfLines={1} variant="micro">
        {tab.label}
      </Text>
    </Pressable>
  )
}

/**
 * The sidebar's track: a sunk plate with a raised slot for the current tab.
 *
 * Level 3 — a tint and a hairline, never a blur of its own — because it sits
 * INSIDE the sidebar's glass, and glass over glass reads as neither.
 */
export function TabStrip({ items, current, onSelect, testID }: TabsProps) {
  const theme = useTheme()

  return (
    <View
      style={{
        backgroundColor: theme.tintSunk,
        borderColor: theme.hairlineSoft,
        borderRadius: theme.radii.inset,
        borderWidth: 1,
        flexDirection: 'row',
        marginHorizontal: theme.space.md,
        marginVertical: theme.space.sm,
        padding: 3
      }}
      {...(testID ? { testID } : {})}
    >
      {items.map(tab => (
        <TabButton
          key={tab.key}
          onPress={() => onSelect(tab.key)}
          selected={tab.key === current}
          style={{
            backgroundColor: tab.key === current ? theme.elevation.e3 : 'transparent',
            borderRadius: 9,
            paddingVertical: 6
          }}
          tab={tab}
        />
      ))}
    </View>
  )
}

/**
 * The phone's tab bar: full-bleed glass along the bottom of the window.
 *
 * Full-bleed and square-cornered for the reason the chat list panel is (at
 * 393pt there is no room to spend 14pt a side proving a bar floats), and the
 * same `float` material the page chrome uses at the other end of the screen, so
 * the two edges of a page are made of one thing.
 *
 * The home-indicator inset is padding INSIDE the glass rather than a gap under
 * it: the material has to reach the bottom of the window, or a strip of
 * wallpaper shows below the bar on every phone with a gesture bar.
 */
export function TabBar({ items, current, onSelect, testID = 'tab-bar' }: TabsProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <GlassSurface
      contentStyle={{
        flexDirection: 'row',
        paddingBottom: insets.bottom,
        paddingHorizontal: theme.space.xs,
        paddingTop: theme.space.xs
      }}
      radius={0}
      shadow="none"
      testID={testID}
      variant="float"
    >
      {items.map(tab => (
        <TabButton
          key={tab.key}
          onPress={() => onSelect(tab.key)}
          selected={tab.key === current}
          style={{
            backgroundColor: 'transparent',
            borderRadius: theme.radii.inset,
            paddingVertical: theme.space.xs
          }}
          tab={tab}
        />
      ))}
    </GlassSurface>
  )
}
