/**
 * What to do when the gateway has no plugin: two commands and a link.
 *
 * Shown in two places and deliberately the same component in both — the
 * onboarding step reached after a successful connection test, and Settings →
 * Notifications on a gateway whose advert is missing. A reader who skipped it
 * during setup and came looking later should find the same screen rather than a
 * paraphrase of it.
 *
 * **The commands are the point, so they are copyable.** `hermes plugins install
 * …` is not something anybody types from memory, and the machine it has to be
 * typed on is usually not the one holding the phone — so Copy puts both lines
 * on the pasteboard at once, ready to paste into whatever gets them to the
 * gateway. Where there is no pasteboard the button simply is not offered; a
 * Copy that silently does nothing is worse than none.
 *
 * **Hermie Web is named, once, at the bottom.** It is still supported and
 * somebody may already be running it, in which case notifications work and this
 * screen would otherwise be telling them a lie. What it must also say is that
 * running both notifies the device twice.
 */
import { Linking, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { MONOSPACE } from '../../markdown/context'
import { copyToClipboard } from '../../platform/clipboard'
import { Button, CodeChipText, InsetGroup, InsetRow, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

/** Where the guide lives. One address, said in one place. */
export const PLUGIN_GUIDE_URL = 'https://hermie.dev/plugin'

/**
 * The install, verbatim from the plugin's own README.
 *
 * Two lines rather than one: Hermes clones and enables the plugin, and the
 * gateway has to be restarted before anything is loaded. A reader who ran only
 * the first would find the advert still missing and no reason why.
 */
export const PLUGIN_INSTALL_COMMANDS = [
  'hermes plugins install fullstackstudio-org/hermie-plugin --enable',
  'hermes gateway restart'
] as const

export interface PluginInstallProps {
  /** Said only where a working alternative is still worth naming. */
  showFallback?: boolean
  testID?: string
}

export function PluginInstall({ showFallback = true, testID = 'plugin-install' }: PluginInstallProps) {
  const theme = useTheme()
  const text = strings.onboarding.notifications
  const commands = PLUGIN_INSTALL_COMMANDS.join('\n')

  return (
    <View style={{ gap: theme.space.lg }} testID={testID}>
      <CodeChipText color="textMuted" variant="meta">
        {text.missingSubtitle}
      </CodeChipText>

      <InsetGroup header={text.install}>
        <InsetRow>
          <Text
            selectable
            style={{
              fontFamily: MONOSPACE,
              fontSize: theme.type.meta.fontSize,
              lineHeight: theme.type.body.lineHeight
            }}
            testID={`${testID}-commands`}
            variant="code"
          >
            {commands}
          </Text>
        </InsetRow>
      </InsetGroup>

      <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
        <Button
          onPress={() => copyToClipboard(commands)}
          testID={`${testID}-copy`}
          title={text.copy}
          variant="secondary"
        />
        <Button
          onPress={() => void Linking.openURL(PLUGIN_GUIDE_URL).catch(() => undefined)}
          testID={`${testID}-guide`}
          title={text.guide}
          variant="secondary"
        />
      </View>

      <Text color="textMuted" variant="meta">
        {text.missingHint}
      </Text>

      {showFallback ? (
        <Text color="textMuted" testID={`${testID}-fallback`} variant="meta">
          {text.fallback}
        </Text>
      ) : null}

      {/* No "Copied" confirmation and no disabled state: the block above is
          selectable, so a pasteboard that refuses leaves a reader with the same
          two lines they can select by hand. */}
    </View>
  )
}
