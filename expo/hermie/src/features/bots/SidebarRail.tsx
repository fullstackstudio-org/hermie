/**
 * What is left of the sidebar when the owner hides it: a slim glass column with a
 * Show control and the three destinations the tab strip carries.
 *
 * ## Why a rail rather than nothing
 *
 * Collapsing to zero was the other option and it fails twice. The reader loses the
 * only way back that does not involve knowing a keyboard shortcut — a control that
 * only exists in the chat header is a control the reader has to already know about
 * — and Activity, Crons and Settings go with the list, because the strip that
 * reaches them is at the bottom of it. Putting those three in the chat header's
 * `…` menu was the alternative the brief offered; it is wrong for a different
 * reason. That menu is the CHAT's options — verbosity, colour, the model — and app
 * destinations dropped into it would make one menu answer two scopes, which is
 * exactly the confusion the tab strip exists to avoid.
 *
 * So the rail costs 56pt and keeps every destination one tap away, at the same
 * depth as before. What the reader gives up by hiding the list is the list.
 *
 * ## The badge is the honest price of hiding it
 *
 * A hidden list still receives messages, and nothing else on screen would say so
 * — the presence beads went with the rows. The Show control therefore carries the
 * unread total, which is the one fact the collapsed state would otherwise swallow.
 *
 * ## It is a variant of `BotsScreen`, not a component beside it
 *
 * `BotsScreen` renders this instead of the list, rather than the shell swapping one
 * component for the other, and that is deliberate. The roster's polling, the
 * layout reconcile, ⌘1…9, ⌘↑/↓ and the Mac menu bar's nine named chats all hang off
 * state only `BotsScreen` derives. Unmounting it to show a rail would take the
 * numbered shortcuts and the menu bar's chat list away with the visible rows, and
 * a ⌘3 that works until you hide the sidebar is worse than one that never existed.
 */
import { Pressable, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { GlassSurface } from '../../ui/glass'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_SIZE, TAP_SLOP } from '../../ui/tokens'
import { tabs, type BotsSection, type TabKey } from './SidebarFooter'

export interface SidebarRailProps {
  /** Which destination reads as current, so the rail marks the same one the strip would. */
  current?: TabKey
  onOpenSection?: (section: BotsSection) => void
  /** Show the list again — in place on a wide window, as an overlay on a narrow one. */
  onShowList?: () => void
  /** Unread messages across the chats the list would show. Zero draws no badge. */
  unread?: number
}

export function SidebarRail({ current = 'chats', onOpenSection, onShowList, unread = 0 }: SidebarRailProps) {
  const theme = useTheme()

  return (
    <View
      accessibilityLabel={strings.layout.sidebarRail}
      style={{
        alignItems: 'center',
        flex: 1,
        gap: theme.space.sm,
        paddingHorizontal: theme.space.sm,
        paddingVertical: theme.space.md
      }}
      testID="sidebar-rail"
    >
      <RailButton
        badge={unread}
        icon="sidebar"
        label={strings.layout.showSidebar}
        onPress={onShowList}
        selected={false}
        testID="sidebar-rail-show"
      />

      {/* The destinations sit at the FOOT of the rail because that is where the
          strip they replace sits, so the reader's hand goes to the same corner. */}
      <View style={{ flex: 1 }} />

      {tabs()
        .filter(tab => tab.key !== 'chats')
        .map(tab => (
          <RailButton
            icon={tab.icon}
            key={tab.key}
            label={tab.label}
            onPress={onOpenSection ? () => onOpenSection(tab.key as BotsSection) : undefined}
            selected={tab.key === current}
            testID={`sidebar-rail-${tab.key}`}
          />
        ))}
    </View>
  )
}

/**
 * One round control on the rail.
 *
 * Glass for the current destination and bare for the rest, which is the same
 * distinction the strip draws with its raised slot — a rail of four identical glass
 * pills would say nothing about which one you are in.
 */
function RailButton({
  badge = 0,
  icon,
  label,
  onPress,
  selected,
  testID
}: {
  badge?: number
  icon: ReturnType<typeof tabs>[number]['icon'] | 'sidebar'
  label: string
  onPress?: (() => void) | undefined
  selected: boolean
  testID: string
}) {
  const theme = useTheme()
  const size = CONTROL_SIZE.regular
  const mark = (
    <Icon
      color={selected ? theme.colors.text : theme.colors.textMuted}
      name={icon}
      size={ICON_SIZE.control}
      slot={size}
    />
  )

  return (
    <View>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        aria-selected={selected}
        hitSlop={TAP_SLOP}
        onPress={onPress}
        style={({ pressed }) => ({ cursor: 'pointer', opacity: pressed ? 0.6 : 1 })}
        testID={testID}
      >
        {selected ? (
          <GlassSurface
            contentStyle={{ alignItems: 'center', height: size, justifyContent: 'center', width: size }}
            radius={size / 2}
            variant="control"
          >
            {mark}
          </GlassSurface>
        ) : (
          mark
        )}
      </Pressable>

      {badge > 0 ? <UnreadBadge count={badge} /> : null}
    </View>
  )
}

/**
 * The unread total, as a small accent pill on the control's shoulder.
 *
 * Capped at 99+ because the pill's width is what keeps it inside the 56pt rail,
 * and a three-digit count is a number nobody reads as a number anyway.
 */
function UnreadBadge({ count }: { count: number }) {
  const theme = useTheme()

  return (
    <View
      accessibilityLabel={strings.bots.unreadLabel(count)}
      style={{
        alignItems: 'center',
        // The bubble, not the fill: the count on it is `onAccent`.
        backgroundColor: theme.accent().bubble,
        borderColor: theme.glass.panel.solid,
        borderRadius: theme.radii.pill,
        borderWidth: 1.5,
        justifyContent: 'center',
        minWidth: 18,
        paddingHorizontal: 4,
        position: 'absolute',
        right: -5,
        top: -4
      }}
      testID="sidebar-rail-unread"
    >
      <Text color="onAccent" style={{ fontWeight: '700' }} variant="micro">
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  )
}
