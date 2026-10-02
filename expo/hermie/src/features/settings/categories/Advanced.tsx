/**
 * Settings → Advanced: the browser build's own update row, and the developer
 * tools in a development build.
 *
 * The category hides itself where it would be empty (`isAdvancedVisible`): on a
 * released phone or Mac build there is no Hermie Web to update and no developer
 * group, so an Advanced row would open a blank page.
 */
import { useNavigation, type NavigationProp } from '@react-navigation/native'
import { Platform } from 'react-native'

import { strings } from '../../../i18n/strings'
import { InsetButtonRow, InsetGroup } from '../../../ui/primitives'
import { DebugConnectionScreen } from '../DebugConnectionScreen'
import { GALLERY_ROW_TITLE, GalleryScreen } from '../GalleryScreen'
import type { SettingsParamList } from '../navigation/route-names'
import { SettingsPage, useSettingsBack } from '../navigation/SettingsPage'
import { WebUpdateRow } from '../WebUpdateRow'

/** Only the browser build has a server of its own to update; `__DEV__` brings the tools. */
export function isAdvancedVisible(): boolean {
  return Platform.OS === 'web' || __DEV__
}

export function useSummary(): string {
  return __DEV__ ? strings.settings.categories.summary.developer : strings.settings.webUpdate.header
}

export function Page() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()

  return (
    <SettingsPage route="Advanced">
      <WebUpdateRow />

      {/* Development builds only. The connection test prints the gateway's
          address and the component gallery is a catalogue of fixtures; both are
          tools for whoever is building the app, and neither belongs in a
          release a user installs. */}
      {__DEV__ ? (
        <InsetGroup header={strings.settings.developer}>
          <InsetButtonRow
            onPress={() => navigation.navigate('ConnectionTest')}
            testID="settings-connection-test"
            title={strings.settings.connectionTest}
          />
          <InsetButtonRow
            onPress={() => navigation.navigate('Gallery')}
            testID="settings-gallery"
            title={GALLERY_ROW_TITLE}
          />
        </InsetGroup>
      ) : null}
    </SettingsPage>
  )
}

export function ConnectionTestPage() {
  const back = useSettingsBack('ConnectionTest')

  return <DebugConnectionScreen {...(back ? { back } : {})} />
}

export function GalleryPage() {
  const back = useSettingsBack('Gallery')

  return <GalleryScreen {...(back ? { back } : {})} />
}
