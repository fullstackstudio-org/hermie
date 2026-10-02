/**
 * Settings → Bots & capabilities: the gateway-wide surfaces a bot can reach,
 * plus the one action that makes a bot.
 *
 * They sit together because all of them answer "what can my bots do" — and the
 * New-bot row is here as well as in the chat list's header because Settings is
 * where somebody looks for a thing they do once.
 *
 * There is deliberately no "delete a bot" anywhere. The gateway has no
 * profile-delete method at all; see `PROFILE_DELETE_UNAVAILABLE` in
 * `features/profiles/profiles-controller.ts` for the whole argument.
 */
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native'
import { useState } from 'react'

import { strings } from '../../../i18n/strings'
import { InsetButtonRow, InsetGroup } from '../../../ui/primitives'
import { ConnectorScreen, ConnectorsScreen, connectorStrings } from '../../connectors'
import { KanbanScreen, kanbanStrings, useBoardsOpener } from '../../kanban'
import { McpScreen, McpServerScreen, mcpStrings } from '../../mcp'
import { NewBotFlow, profileStrings } from '../../profiles'
import { SkillsScreen, skillStrings } from '../../skills'
import type { SettingsParamList } from '../navigation/route-names'
import { SettingsPage, useSettingsBack } from '../navigation/SettingsPage'

export function useSummary(): string {
  return strings.settings.categories.summary.capabilities
}

export function Page() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()
  const [showNewBot, setShowNewBot] = useState(false)
  /*
    Boards is the one page here that does NOT belong inside a narrow Settings
    column: its columns need 700pt. A shell with a content column takes it
    instead, and the `Boards` route is what happens where there is none — see
    `features/kanban/boards-host.tsx`.
  */
  const openBoards = useBoardsOpener(() => navigation.navigate('Boards'))

  return (
    <SettingsPage route="Capabilities">
      {/*
        Two groups where there was one, and the line between them is what each row
        IS. The first makes a bot; the four under `capabilityReach` are places a
        bot can be sent — and a card holding both cannot carry a header or a footer
        that is true of all five rows.
      */}
      <InsetGroup header={profileStrings.settings.group}>
        <InsetButtonRow
          detail={profileStrings.settings.newBotHint}
          onPress={() => setShowNewBot(true)}
          testID="settings-new-bot"
          title={profileStrings.settings.newBot}
        />
      </InsetGroup>

      <InsetGroup header={strings.settings.capabilityReach}>
        <InsetButtonRow
          detail={skillStrings.settings.hint}
          onPress={() => navigation.navigate('Skills')}
          testID="settings-skills"
          title={skillStrings.settings.row}
        />
        <InsetButtonRow
          detail={mcpStrings.settings.hint}
          onPress={() => navigation.navigate('Mcp')}
          testID="settings-mcp"
          title={mcpStrings.settings.row}
        />
        <InsetButtonRow
          detail={connectorStrings.settings.hint}
          onPress={() => navigation.navigate('Connectors')}
          testID="settings-connectors"
          title={connectorStrings.settings.row}
        />
        <InsetButtonRow
          detail={kanbanStrings.settings.hint}
          onPress={openBoards}
          testID="settings-boards"
          title={kanbanStrings.settings.row}
        />
      </InsetGroup>

      {/*
        A sheet rather than a page: it is a form, not a place. No `onOpened` —
        from Settings there is nowhere to land, so the new bot simply appears in
        the chat list where somebody will look for it.
      */}
      <NewBotFlow onClose={() => setShowNewBot(false)} visible={showNewBot} />
    </SettingsPage>
  )
}

export function SkillsPage() {
  const back = useSettingsBack('Skills')

  return <SkillsScreen {...(back ? { back } : {})} />
}

export function McpPage() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()
  const back = useSettingsBack('Mcp')

  return <McpScreen {...(back ? { back } : {})} onOpenServer={name => navigation.navigate('McpServer', { name })} />
}

export function McpServerPage() {
  const route = useRoute<RouteProp<SettingsParamList, 'McpServer'>>()
  const back = useSettingsBack('McpServer')

  return <McpServerScreen {...(back ? { back } : {})} name={route.params.name} />
}

export function ConnectorsPage() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()
  const back = useSettingsBack('Connectors')

  return (
    <ConnectorsScreen
      {...(back ? { back } : {})}
      onOpenConnector={(sessionId, slug) => navigation.navigate('Connector', { sessionId, slug })}
    />
  )
}

export function ConnectorPage() {
  const route = useRoute<RouteProp<SettingsParamList, 'Connector'>>()
  const back = useSettingsBack('Connector')

  return <ConnectorScreen {...(back ? { back } : {})} sessionId={route.params.sessionId} slug={route.params.slug} />
}

export function BoardsPage() {
  const back = useSettingsBack('Boards')

  return <KanbanScreen {...(back ? { backLabel: back.label, onClose: back.onPress } : {})} />
}
