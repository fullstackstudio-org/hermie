/**
 * Settings, Appearance: the colour scheme, the accent colour, the language and the text size of the
 * conversation.
 *
 * Every choice takes effect where the reader stands. The scheme and the tint are applied to the
 * document by `bindTheme` (`state/settings.ts`), the text size by `bindTextSize`, and the language by
 * `setLanguageChoice`, which loads the language and then makes it the one every screen reads, with no
 * reload and nothing remounted. The scheme, the tint and the language belong to the browser (they stay
 * when somebody signs out); the text size follows the person through the gateway's `ui_meta`, which
 * the bridge does by watching `textSizeStore`.
 */
import { type ReactElement, useState } from 'react'
import { useStore } from 'zustand'

import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { LANGUAGE_ENDONYMS, languageChoice, LOCALES, setLanguageChoice, type LanguageChoice } from '../../i18n/locale'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type SchemeChoice, settingsStore, type Tint, TINTS } from '../../state/settings'
import { TEXT_SIZE_ORDER, type TextSize, textSizeStore } from '../../state/text-size'
import { RadioGroup, type RadioOption, SettingsPage, SyncNote } from './controls'

const SCHEMES: readonly SchemeChoice[] = ['system', 'light', 'dark']

/** The name of a tint: the catalogue's word for the colour (`blue` is the Expo app's default preset). */
export const tintName = (tint: Tint): string =>
  tint === 'blue' ? strings.app.settings.presetOptions.blue : strings.app.layout.accents[tint]

export function Appearance(): ReactElement {
  useLocale()

  const scheme = useStore(settingsStore, state => state.scheme)
  const tint = useStore(settingsStore, state => state.tint)
  const textSize = useStore(textSizeStore, state => state.textSize)
  // The language module holds the choice, but not as something a screen can subscribe to, and a pick of
  // `system` can resolve to the language already in use: the page keeps what was picked.
  const [language, setLanguage] = useState<LanguageChoice>(languageChoice)

  const schemeOptions: RadioOption<SchemeChoice>[] = SCHEMES.map(value => ({
    value,
    label: strings.app.settings.themeOptions[value]
  }))

  const tintOptions: RadioOption<Tint>[] = TINTS.map(value => ({
    value,
    label: tintName(value),
    mark: <span className="hm-swatch" data-tint={value} />
  }))

  const languageOptions: RadioOption<LanguageChoice>[] = [
    { value: 'system', label: webStrings.language.followBrowser },
    // An endonym, never translated: somebody hunting for their language wants their own word for it.
    ...LOCALES.map(value => ({ value, label: LANGUAGE_ENDONYMS[value] }))
  ]

  const textSizeOptions: RadioOption<TextSize>[] = TEXT_SIZE_ORDER.map(value => ({
    value,
    label: strings.chat.options.textSizes[value]
  }))

  return (
    <SettingsPage title={strings.app.settings.categories.appearance}>
      <RadioGroup
        legend={strings.app.settings.theme}
        value={scheme}
        options={schemeOptions}
        onChange={choice => settingsStore.getState().setScheme(choice)}
        hint={`${strings.app.settings.themeHint} ${sheetStrings.settings.appearance.schemeNote}`}
        layout="wrap"
      />

      <RadioGroup
        legend={sheetStrings.settings.appearance.tint}
        value={tint}
        options={tintOptions}
        onChange={choice => settingsStore.getState().setTint(choice)}
        hint={sheetStrings.settings.appearance.tintHint}
        layout="wrap"
      />

      <RadioGroup
        legend={strings.app.settings.language}
        value={language}
        options={languageOptions}
        onChange={choice => {
          setLanguage(choice)
          void setLanguageChoice(choice)
        }}
        hint={strings.app.settings.languageHint}
        layout="wrap"
      />

      <RadioGroup
        legend={strings.app.settings.chatTextSize}
        value={textSize}
        options={textSizeOptions}
        onChange={choice => textSizeStore.getState().setTextSize(choice)}
        hint={strings.app.settings.chatTextSizeHint}
        layout="wrap"
      />
      <SyncNote />
    </SettingsPage>
  )
}
