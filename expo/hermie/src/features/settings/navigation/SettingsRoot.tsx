/**
 * The Settings root: the category list, and nothing else.
 *
 * No back control of its own — `useSettingsBack` only gives the root one when
 * the shell holding Settings handed one over (an overlay's close, the compact
 * shell's way back to the chats until it grows a tab bar). On a tab root it
 * draws none, which is HERM-105 without a special case per shell.
 */
import { useNavigation, type NavigationProp } from '@react-navigation/native'

import type { SettingsParamList } from './route-names'
import { SettingsCategoryList } from './SettingsCategoryList'
import { SettingsPage } from './SettingsPage'

export function SettingsRoot() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()

  return (
    <SettingsPage route="Root">
      <SettingsCategoryList onPick={name => navigation.navigate(name)} />
    </SettingsPage>
  )
}
