/**
 * Settings → Appearance → Theme: the preset cards and the reader's own themes.
 *
 * A route rather than a boolean inside Appearance, so its back control is the
 * stack's like every other page's. HERM-107 moved the preset cards here from
 * Appearance and split the colour editor out again, into `ThemeEdit` below —
 * two pages rather than one page whose content changed shape depending on
 * whether a card was tapped.
 */
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native'

import { ThemeEditScreen } from '../ThemeEditScreen'
import { ThemesScreen } from '../ThemesScreen'
import type { SettingsParamList } from '../navigation/route-names'
import { useSettingsBack } from '../navigation/SettingsPage'

export function Page() {
  const back = useSettingsBack('Theme')
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()

  return <ThemesScreen {...(back ? { back } : {})} onEditTheme={id => navigation.navigate('ThemeEdit', { id })} />
}

export function EditPage() {
  const back = useSettingsBack('ThemeEdit')
  const route = useRoute<RouteProp<SettingsParamList, 'ThemeEdit'>>()

  return <ThemeEditScreen {...(back ? { back } : {})} id={route.params.id} />
}
