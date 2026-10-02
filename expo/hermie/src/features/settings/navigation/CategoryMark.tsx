/**
 * A Settings category's mark: its icon, white, on a rounded square in the
 * category's own colour.
 *
 * One component for both sizes, because they are one mark. The row size is what
 * makes a list of eleven labels scannable — the eye finds the orange square long
 * before it reads "Notifications" — and the header size is the same square on the
 * card that opens the category, so the row somebody tapped and the page they
 * landed on are visibly the same thing.
 *
 * The square is flat. There is no gradient in this app (`design/liquid-glass-tokens.md`
 * §0.1) and there is no glass here either: a well 28pt across is smaller than the
 * blur radius of every recipe in the scale, so a blurred one would read as a grey
 * smudge rather than as a colour. It is one token colour with white on it, and
 * `contrast:check` measures that pair for every accent in the set.
 */
import { View } from 'react-native'

import { Icon } from '../../../ui/Icon'
import { useTheme } from '../../../ui/theme'
import { CATEGORY_MARK } from '../../../ui/tokens'
import { categoryWell, SETTINGS_CATEGORY_LOOK } from './category-look'
import type { SettingsCategoryName } from './route-names'

export type CategoryMarkSize = keyof typeof CATEGORY_MARK

export interface CategoryMarkProps {
  category: SettingsCategoryName
  size?: CategoryMarkSize
  testID?: string
}

/**
 * The corner per size, so the mark is the same shape at both.
 *
 * `md` on 28 and `thumb` on 52 — 0.29 and 0.27 of the box. A single radius for
 * both would make the large one read as a rounded rectangle and the small one as
 * a circle.
 */
const RADIUS_FOR: Record<CategoryMarkSize, 'md' | 'thumb'> = { row: 'md', header: 'thumb' }

/** The mark inside the well, as a fraction that keeps the same optical weight at both sizes. */
const GLYPH_FOR: Record<CategoryMarkSize, number> = { row: 17, header: 28 }

export function CategoryMark({ category, size = 'row', testID }: CategoryMarkProps) {
  const theme = useTheme()
  const box = CATEGORY_MARK[size]

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: categoryWell(category),
        borderRadius: theme.radii[RADIUS_FOR[size]],
        flexShrink: 0,
        height: box,
        justifyContent: 'center',
        width: box
      }}
      testID={testID ?? `settings-mark-${category}`}
    >
      <Icon
        color={theme.colors.onAccent}
        name={SETTINGS_CATEGORY_LOOK[category].icon}
        size={GLYPH_FOR[size]}
        slot={box}
      />
    </View>
  )
}
