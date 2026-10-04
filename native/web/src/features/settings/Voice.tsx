/**
 * Settings, Voice: how Hermie reads a reply out, and how it hears you (`features/settings/categories/Voice.tsx` in
 * the Expo app, `VoiceSettingsPage` in the native apps).
 *
 * Device-local, like the scheme (`state/voice-settings.ts`): kept in this browser, never sent to a gateway. Whether
 * a chat reads each finished reply on its own is that chat's option, not this page's.
 *
 * Each half is there only where the browser has it, and says what it is: reading needs `speechSynthesis`, which is
 * the browser's own voices on this device, so nothing leaves the machine; dictation needs `SpeechRecognition`,
 * which is NOT on the device in Chrome or Safari (the audio goes to Google or Apple), and the page says so in plain
 * words beside the choice of language. A browser that has neither says that and offers nothing.
 *
 * The language list is the three Hermie is written in and the browser's own: a browser cannot enumerate the
 * languages it recognises, so a longer list would offer choices that fail when the session starts. "Confirm
 * before sending" belongs to a hands-free voice mode this client does not have, so it is not offered: a switch
 * that changes nothing is worse than none.
 */
import { type ReactElement, useState } from 'react'
import { useStore } from 'zustand'

import { strings } from '../../generated/strings'
import { LANGUAGE_ENDONYMS, LOCALES } from '../../i18n/locale'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { DICTATION_AUTO, ensureVoiceSettings, RATE_STEPS, voiceSettingsStore } from '../../state/voice-settings'
import { canDictate, canSpeak } from '../../platform/voice-capabilities'
import { Checkbox, RadioGroup, type RadioOption, SettingsPage } from './controls'

/** The five stops' names, in the order of `RATE_STEPS`. */
export function rateLabel(rate: number): string {
  const options = strings.chat.voice.rateOptions

  switch (RATE_STEPS.indexOf(rate as (typeof RATE_STEPS)[number])) {
    case 0:
      return options.slowest
    case 1:
      return options.slow
    case 3:
      return options.fast
    case 4:
      return options.fastest
    default:
      return options.normal
  }
}

export function Voice(): ReactElement {
  useLocale()

  // Read from the store the page already opened, before the first read of a choice below.
  useState(() => ensureVoiceSettings())

  const rate = useStore(voiceSettingsStore, state => state.rate)
  const stopOnBackground = useStore(voiceSettingsStore, state => state.stopOnBackground)
  const language = useStore(voiceSettingsStore, state => state.dictationLanguage)
  const speaks = canSpeak()
  const dictates = canDictate()

  const rateOptions: RadioOption<string>[] = RATE_STEPS.map(step => ({ value: String(step), label: rateLabel(step) }))

  const languageOptions: RadioOption<string>[] = [
    { value: DICTATION_AUTO, label: strings.chat.voice.dictationAuto },
    // An endonym, never translated: somebody hunting for their language wants their own word for it.
    ...LOCALES.map(value => ({ value: value as string, label: LANGUAGE_ENDONYMS[value] })),
    // A language chosen elsewhere (an older build, a hand-edited store) stays listed so the group shows what is in force.
    ...(language !== DICTATION_AUTO && !(LOCALES as readonly string[]).includes(language)
      ? [{ value: language, label: language }]
      : [])
  ]

  return (
    <SettingsPage title={strings.app.settings.categories.voice}>
      {speaks ? (
        <>
          <RadioGroup
            legend={sheetStrings.voice.reading}
            value={String(rate)}
            options={rateOptions}
            onChange={choice => voiceSettingsStore.getState().setRate(Number(choice))}
            hint={sheetStrings.voice.readingHint}
            layout="wrap"
          />
          <Checkbox
            label={strings.chat.voice.stopOnBackground}
            checked={stopOnBackground}
            onChange={checked => voiceSettingsStore.getState().setStopOnBackground(checked)}
          />
        </>
      ) : null}

      {dictates ? (
        <>
          <RadioGroup
            legend={strings.chat.voice.dictationLanguage}
            value={language}
            options={languageOptions}
            onChange={choice => voiceSettingsStore.getState().setDictationLanguage(choice)}
            hint={sheetStrings.voice.dictationHint}
            layout="wrap"
          />
          <p className="hm-set__hint">{sheetStrings.voice.privacy}</p>
        </>
      ) : null}

      {!speaks && !dictates ? <p className="hm-set__hint">{sheetStrings.voice.unavailable}</p> : null}
    </SettingsPage>
  )
}
