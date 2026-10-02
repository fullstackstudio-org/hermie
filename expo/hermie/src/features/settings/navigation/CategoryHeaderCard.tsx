/**
 * The card a category page opens with: its mark, large, its name, and one
 * sentence saying what the category is for.
 *
 * ## It replaces the title bar rather than repeating it
 *
 * `SettingsPage` hides the chrome's own centred title on a page that draws this
 * (`titleHidden`), so the page has one heading and not two. The card IS the
 * heading — `accessibilityRole="header"`, level 1, the level the chrome's title
 * carries everywhere else — which is why the name has to be spelled here rather
 * than left to the bar above.
 *
 * The back control is untouched. It stays in the chrome, exactly one per route,
 * labelled with the parent's title; hiding a title does not move a back button,
 * and `settings-routes.test.tsx` walks all 28 routes to say so.
 *
 * ## The sentence is copy, not a summary
 *
 * A category ROW carries a summary — where the setting stands, "Dark · English" —
 * because a reader scanning the list is looking for the thing that is wrong. This
 * says what the category is FOR, which is the question somebody has once, on
 * arriving. The two are deliberately different sentences; see
 * `strings.settings.categories.blurb`.
 */
import { View } from 'react-native'

import { Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { SETTINGS_CATEGORY_LOOK } from './category-look'
import { CategoryMark } from './CategoryMark'
import { settingsTitle } from './route-meta'
import type { SettingsCategoryName } from './route-names'

export interface CategoryHeaderCardProps {
  category: SettingsCategoryName
}

export function CategoryHeaderCard({ category }: CategoryHeaderCardProps) {
  const theme = useTheme()

  return (
    <View
      // The same block the groups under it are drawn as — `InsetGroup`'s card,
      // by the same three tokens — so the page reads as one stack of objects
      // rather than as a banner over a list.
      style={{
        alignItems: 'center',
        backgroundColor: theme.elevation.e3c,
        borderColor: theme.hairline,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        gap: theme.space.md,
        paddingHorizontal: theme.space.panel,
        paddingVertical: theme.space.xl
      }}
      testID={`settings-header-${category}`}
    >
      <CategoryMark category={category} size="header" />

      <View style={{ gap: theme.space.xs }}>
        <Text
          accessibilityRole="header"
          aria-level={1}
          style={{ textAlign: 'center' }}
          testID={`settings-header-${category}-title`}
          variant="sheetTitle"
        >
          {settingsTitle(category)}
        </Text>
        <Text
          color="textMuted"
          style={{ textAlign: 'center' }}
          testID={`settings-header-${category}-blurb`}
          variant="preview"
        >
          {SETTINGS_CATEGORY_LOOK[category].blurb()}
        </Text>
      </View>
    </View>
  )
}
