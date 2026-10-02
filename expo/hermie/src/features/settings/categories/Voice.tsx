/**
 * Settings → Voice: the app-wide half of `voice-settings.ts`.
 *
 * The speaking rate, the dictation language, and the two voice-mode switches
 * are global — one reader, one voice — and until now they could only be reached
 * from inside a chat's options sheet. Per-chat auto-read stays in that sheet,
 * because it IS per chat.
 *
 * Each half is drawn only where the platform has it: reading needs a speech
 * engine, the language needs a recognizer, and the category is hidden
 * altogether where there is neither (`isVoiceAvailable`).
 */
import { Pressable, View } from 'react-native'

import { chatStrings } from '../../../chat-ui/strings'
import { speechEngine } from '../../../platform/speech'
import { speechRecognition } from '../../../platform/speech-recognition'
import { Icon, ICON_SIZE } from '../../../ui/Icon'
import { InsetGroup, Text } from '../../../ui/primitives'
import { SegmentedRow, SwitchRow } from '../../../ui/sheets'
import { languageLabel } from '../../../ui/sheets/ChatOptionsSheet'
import { useTheme } from '../../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../../ui/tokens'
import { useDictationLanguages } from '../../voice/useDictationLanguages'
import { DICTATION_AUTO, RATE_STEPS, useVoiceSettingsStore } from '../../voice/voice-settings'
import { SettingsPage } from '../navigation/SettingsPage'

/** The five stops' names, zipped with `RATE_STEPS` the way the options sheet zips them. */
const RATE_LABELS = ['slowest', 'slow', 'normal', 'fast', 'fastest'] as const

const rateLabel = (rate: number): string => {
  const index = RATE_STEPS.findIndex(step => step === rate)

  return chatStrings.voice.rateOptions[RATE_LABELS[index] ?? 'normal']
}

/** Whether this platform has either half of voice. Static: an engine does not appear mid-session. */
export function isVoiceAvailable(): boolean {
  return speechEngine.available || speechRecognition.available
}

export function useSummary(): string {
  const rate = useVoiceSettingsStore(state => state.rate)

  return rateLabel(rate)
}

export function Page() {
  const theme = useTheme()
  const rate = useVoiceSettingsStore(state => state.rate)
  const setRate = useVoiceSettingsStore(state => state.setRate)
  const language = useVoiceSettingsStore(state => state.dictationLanguage)
  const setLanguage = useVoiceSettingsStore(state => state.setDictationLanguage)
  const confirmBeforeSending = useVoiceSettingsStore(state => state.confirmBeforeSending)
  const setConfirmBeforeSending = useVoiceSettingsStore(state => state.setConfirmBeforeSending)
  const stopOnBackground = useVoiceSettingsStore(state => state.stopOnBackground)
  const setStopOnBackground = useVoiceSettingsStore(state => state.setStopOnBackground)
  const languages = useDictationLanguages()

  const languageOptions = [
    { value: DICTATION_AUTO, label: chatStrings.voice.dictationAuto },
    ...languages.map(tag => ({ value: tag, label: languageLabel(tag) }))
  ]

  return (
    <SettingsPage route="Voice">
      {speechEngine.available ? (
        <InsetGroup>
          <SegmentedRow
            label={chatStrings.voice.rate}
            onChange={(value: string) => setRate(Number(value))}
            // Stringified: a segment deals in ids, and `RATE_STEPS` is the only
            // source of these values, so the round trip through `String` is exact.
            options={RATE_STEPS.map(step => ({ value: String(step), label: rateLabel(step) }))}
            testID="settings-voice-rate"
            value={String(rate)}
          />
          <SwitchRow
            label={chatStrings.voice.stopOnBackground}
            onChange={setStopOnBackground}
            testID="settings-voice-stop-on-background"
            value={stopOnBackground}
          />
        </InsetGroup>
      ) : null}

      {speechRecognition.available ? (
        <InsetGroup accessibilityRole="radiogroup" header={chatStrings.voice.dictationLanguage}>
          {languageOptions.map(option => {
            const selected = option.value === language

            return (
              <Pressable
                accessibilityRole="radio"
                aria-checked={selected}
                key={option.value}
                onPress={() => setLanguage(option.value)}
                testID={`settings-voice-language-${option.value}`}
              >
                {({ pressed }) => (
                  <View
                    style={{
                      alignItems: 'center',
                      backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
                      flexDirection: 'row',
                      gap: theme.space.md,
                      minHeight: CONTROL_MIN_HEIGHT,
                      paddingHorizontal: theme.space.lg,
                      paddingVertical: theme.space.sm
                    }}
                  >
                    <Text style={{ flex: 1 }} variant="body">
                      {option.label}
                    </Text>
                    {selected ? <Icon color={theme.colors.accentText} name="check" size={ICON_SIZE.inline} /> : null}
                  </View>
                )}
              </Pressable>
            )
          })}
        </InsetGroup>
      ) : null}

      {speechRecognition.available ? (
        <InsetGroup footer={chatStrings.voice.confirmBeforeSendingHint}>
          <SwitchRow
            label={chatStrings.voice.confirmBeforeSending}
            onChange={setConfirmBeforeSending}
            testID="settings-voice-confirm"
            value={confirmBeforeSending}
          />
        </InsetGroup>
      ) : null}
    </SettingsPage>
  )
}
