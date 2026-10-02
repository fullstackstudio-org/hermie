/**
 * Settings → About: which Hermie this is, and the licences it ships under.
 */
import { useNavigation, type NavigationProp } from '@react-navigation/native'
import Constants from 'expo-constants'

import { strings } from '../../../i18n/strings'
import { InsetButtonRow, InsetGroup } from '../../../ui/primitives'
import { AboutFooter } from '../AboutFooter'
import type { SettingsParamList } from '../navigation/route-names'
import { SettingsPage } from '../navigation/SettingsPage'

export function useSummary(): string {
  return strings.settings.categories.summary.version(Constants.expoConfig?.version ?? '0.0.0')
}

export function Page() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()

  return (
    <SettingsPage route="About">
      {/* Not behind `__DEV__`: an attribution obligation is not a developer tool. */}
      <InsetGroup>
        <InsetButtonRow
          detail={strings.settings.licencesHint}
          onPress={() => navigation.navigate('Licences')}
          testID="settings-licences"
          title={strings.settings.licences}
        />
      </InsetGroup>

      <AboutFooter />
    </SettingsPage>
  )
}
