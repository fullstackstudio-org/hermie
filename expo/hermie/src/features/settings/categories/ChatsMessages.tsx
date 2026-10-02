/**
 * Settings → Chats & messages: what a new conversation shows by default, and
 * which of a bot's two names is the large one.
 *
 * The bot-name order moved here from Appearance (HERM-108): it decides how a
 * bot is ADDRESSED across the app, which is a question about chats rather than
 * about colour. The hide-handle switch (HERM-110) joins it here.
 */
import type { Verbosity } from '@hermie/transcript'

import { chatStrings } from '../../../chat-ui'
import { strings } from '../../../i18n/strings'
import type { NameOrder } from '../../../store/bot-names'
import { useSettingsStore } from '../../../store/settings'
import { InsetGroup } from '../../../ui/primitives'
import { SegmentedRow, SwitchRow } from '../../../ui/sheets'
import { SettingsPage } from '../navigation/SettingsPage'

/*
  Built on CALL rather than at import: a module-level literal would freeze
  whatever language was active when the bundle loaded — see `i18n/catalogue.ts`.
*/
const verbosityOptions = (): { value: Verbosity; label: string }[] => [
  { value: 'quiet', label: chatStrings.options.verbosityOptions.quiet },
  { value: 'normal', label: chatStrings.options.verbosityOptions.normal },
  { value: 'verbose', label: chatStrings.options.verbosityOptions.verbose }
]

const nameOrderOptions = (): { value: NameOrder; label: string }[] => [
  { value: 'profile', label: strings.settings.botNameOptions.profile },
  { value: 'display', label: strings.settings.botNameOptions.display }
]

export function useSummary(): string {
  const level = useSettingsStore(state => state.defaults.level)

  return chatStrings.options.verbosityOptions[level]
}

export function Page() {
  const defaults = useSettingsStore(state => state.defaults)
  const setDefaults = useSettingsStore(state => state.setDefaults)
  const botNameOrder = useSettingsStore(state => state.botNameOrder)
  const setBotNameOrder = useSettingsStore(state => state.setBotNameOrder)
  const hideHandleWhenNamed = useSettingsStore(state => state.hideHandleWhenNamed)
  const setHideHandleWhenNamed = useSettingsStore(state => state.setHideHandleWhenNamed)

  return (
    <SettingsPage route="ChatsMessages">
      <InsetGroup footer={strings.settings.defaultVerbosityHint} header={strings.settings.chat}>
        <SegmentedRow
          label={strings.settings.defaultVerbosity}
          onChange={(level: Verbosity) => setDefaults({ level })}
          options={verbosityOptions()}
          testID="settings-verbosity"
          value={defaults.level}
        />
        <SwitchRow
          label={strings.settings.showBotToBot}
          onChange={showBotToBot => setDefaults({ showBotToBot })}
          testID="settings-bot-to-bot"
          value={defaults.showBotToBot}
        />
        <SwitchRow
          label={strings.settings.showThinking}
          onChange={showThinking => setDefaults({ showThinking })}
          testID="settings-thinking"
          value={defaults.showThinking}
        />
      </InsetGroup>

      {/*
        Its own group, for its own footer: which of the two names the rest of
        the app addresses a bot by is the whole reason somebody would move this,
        and a group has one footer.
      */}
      <InsetGroup footer={strings.settings.botNamesHint}>
        <SegmentedRow
          disabled={hideHandleWhenNamed}
          label={strings.settings.botNames}
          onChange={(value: NameOrder) => setBotNameOrder(value)}
          options={nameOrderOptions()}
          testID="settings-bot-names"
          value={botNameOrder}
        />
      </InsetGroup>

      {/*
        Below the order it overrides, matching the reading order the footer
        above points to ("below" in `botNamesHint`).
      */}
      <InsetGroup footer={strings.settings.hideHandleHint}>
        <SwitchRow
          label={strings.settings.hideHandle}
          onChange={setHideHandleWhenNamed}
          testID="settings-hide-handle"
          value={hideHandleWhenNamed}
        />
      </InsetGroup>
    </SettingsPage>
  )
}
