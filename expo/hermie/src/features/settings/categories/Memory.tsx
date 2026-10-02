/**
 * Settings → Memory: the bots, and one route per bot's memory (`MemoryBot`).
 */
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native'
import { View } from 'react-native'

import { useBotsStore } from '../../../store/bots'
import { MemoryBotList, MemoryScreen, useMemoryBotTitle } from '../../memory'
import type { SettingsParamList } from '../navigation/route-names'
import { SettingsPage, useSettingsBack } from '../navigation/SettingsPage'
import { strings } from '../../../i18n/strings'

export function useSummary(): string {
  const count = useBotsStore(state => state.bots.length)

  return strings.settings.categories.summary.bots(count)
}

export function Page() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()

  return (
    <SettingsPage route="Memory">
      <View testID="settings-memory">
        <MemoryBotList onOpen={profile => navigation.navigate('MemoryBot', { profile })} />
      </View>
    </SettingsPage>
  )
}

/** Settings → Memory → one bot. The memory page draws its own frame; the back is the stack's. */
export function BotPage() {
  const route = useRoute<RouteProp<SettingsParamList, 'MemoryBot'>>()
  const back = useSettingsBack('MemoryBot')
  const title = useMemoryBotTitle(route.params.profile)

  return (
    <MemoryScreen
      {...(back ? { backLabel: back.label, onClose: back.onPress } : {})}
      profile={route.params.profile}
      {...(title ? { title } : {})}
    />
  )
}
