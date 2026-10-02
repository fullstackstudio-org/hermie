/**
 * Settings → Appearance: light or dark, the language, the chat text size and
 * the theme. "Advanced" pushes the `Theme` page with the reader's own themes;
 * HERM-107 moves the preset cards there as well.
 */
import { useNavigation, type NavigationProp } from '@react-navigation/native'

import { LANGUAGE_ENDONYMS } from '../../../i18n/locales'
import { strings } from '../../../i18n/strings'
import { useLocale } from '../../../i18n/use-locale'
import { useSettingsStore } from '../../../store/settings'
import { AppearanceSection } from '../AppearanceSection'
import type { SettingsParamList } from '../navigation/route-names'
import { SettingsPage } from '../navigation/SettingsPage'

export function useSummary(): string {
  const appearance = useSettingsStore(state => state.appearance)
  const locale = useLocale()

  return `${strings.settings.themeOptions[appearance]} · ${LANGUAGE_ENDONYMS[locale]}`
}

export function Page() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()

  return (
    <SettingsPage route="Appearance">
      <AppearanceSection onOpenAdvanced={() => navigation.navigate('Theme')} />
    </SettingsPage>
  )
}
