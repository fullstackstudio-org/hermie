/**
 * One category in the Settings list: its coloured mark, its name, one line of
 * where it stands, and the chevron that says it opens a page.
 *
 * ## Two shapes, one row
 *
 * `variant` is the only difference between the phone's list and the sidebar's,
 * and it is a shape rather than a second component:
 *
 *  - **`grouped`** — the phone, and the stacked layout at any width. The row sits
 *    inside an `InsetGroup` card with a hairline between it and the next, so the
 *    row draws no background of its own and the press tint fills its full width.
 *  - **`sidebar`** — the split layout's column. There is no card; a row is a
 *    free-standing pill, and the SELECTED one is filled and rounded with its
 *    label in the accent ink, which is how the reference marks the category whose
 *    page is open beside the list.
 *
 * The selected pill is the same surface the chat list's open bot gets
 * (`GlassSurface variant="rowSelected"`, `radii.card`, an `space.sm` margin), so
 * "this one is open" looks the same in the sidebar as it does in the chat list.
 * Untinted, unlike that one: a bot's pill carries the CHAT's own colour, and
 * nothing here belongs to a reader's colour choice — which also keeps the surface
 * one `contrast:check` can measure, and it now does (`contrast.ts`, `row selected`).
 *
 * ## The mark carries no meaning on its own
 *
 * The colour is a finding aid, not information: every row says the same thing in
 * words beside it, and the marks avoid the hues `ok` and `danger` own so a
 * coloured square can never be mistaken for a state. See `category-look.ts`.
 */
import { Pressable, View } from 'react-native'

import { GlassSurface } from '../../../ui/glass'
import { Icon, ICON_SIZE } from '../../../ui/Icon'
import { Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../../ui/tokens'
import { CategoryMark } from './CategoryMark'
import type { SettingsCategoryName } from './route-names'

export type CategoryRowVariant = 'grouped' | 'sidebar'

export interface CategoryRowProps {
  category: SettingsCategoryName
  title: string
  summary: string
  onPress: () => void
  selected?: boolean
  variant?: CategoryRowVariant
  testID?: string
}

export function CategoryRow({
  category,
  title,
  summary,
  onPress,
  selected = false,
  variant = 'grouped',
  testID
}: CategoryRowProps) {
  const theme = useTheme()
  const sidebar = variant === 'sidebar'

  const body = (pressed: boolean) => (
    <View
      style={{
        alignItems: 'center',
        // In the sidebar the pill under the row is the background, so the press
        // state is an opacity on the pressable rather than a second colour here.
        backgroundColor: sidebar || !(pressed || selected) ? 'transparent' : theme.elevation.e2,
        borderRadius: sidebar ? theme.radii.card : 0,
        flexDirection: 'row',
        gap: theme.space.md,
        minHeight: CONTROL_MIN_HEIGHT,
        paddingHorizontal: sidebar ? theme.space.md : theme.space.lg,
        paddingVertical: theme.space.sm
      }}
    >
      <CategoryMark category={category} />

      <View style={{ flex: 1, gap: theme.space.xxs, minWidth: 0 }}>
        <Text
          color={selected && sidebar ? 'accentText' : 'text'}
          numberOfLines={1}
          style={selected && sidebar ? { fontWeight: '600' } : undefined}
          variant="body"
        >
          {title}
        </Text>
        {summary ? (
          <Text color="textMuted" numberOfLines={1} testID={testID ? `${testID}-summary` : undefined} variant="meta">
            {summary}
          </Text>
        ) : null}
      </View>

      <Icon
        color={selected && sidebar ? theme.colors.accentText : theme.colors.textMuted}
        name="chevronRight"
        size={ICON_SIZE.inline}
      />
    </View>
  )

  return (
    <Pressable
      accessibilityHint={summary || undefined}
      accessibilityLabel={title}
      accessibilityRole="button"
      aria-selected={selected}
      onPress={onPress}
      // A row is a thing you click, and on a Mac the pointer has to say so —
      // the same two style keys the chat list's own rows carry.
      style={({ pressed }) =>
        sidebar
          ? {
              borderRadius: theme.radii.card,
              cursor: 'pointer',
              marginHorizontal: theme.space.sm,
              opacity: pressed && !selected ? 0.7 : 1
            }
          : {}
      }
      testID={testID}
    >
      {({ pressed }) =>
        sidebar && selected ? <GlassSurface variant="rowSelected">{body(pressed)}</GlassSurface> : body(pressed)
      }
    </Pressable>
  )
}
