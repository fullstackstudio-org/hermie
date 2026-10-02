/**
 * Settings → Appearance, as its own component.
 *
 * It is lifted out of `SettingsScreen` for one reason: this machine has no
 * `Simulator.app`, so a surface can be launched and photographed and nothing
 * else — and Appearance sits four groups down a scrolling screen, which on a
 * phone puts it permanently below the fold of every screenshot. The gallery is
 * the mechanism that already exists for that (`--hermieOpen gallery:appearance`),
 * and a gallery section that re-implemented the picker would be a second picker
 * to keep in step with the first. So the section is the thing itself, mounted
 * twice.
 *
 * HERM-107: the preset cards and the reader's own themes used to live here,
 * inline. They moved to their own page — a picker with six-plus cards on it is
 * a long look for a screen that also holds light/dark, language and text size —
 * and this keeps one row: the theme that is ON, and where to change it.
 */
import { strings } from '../../i18n/strings'
import { type Appearance, useSettingsStore } from '../../store/settings'
import { InsetGroup } from '../../ui/primitives'
import { DisclosureRow, SegmentedRow } from '../../ui/sheets'
import { TEXT_SIZE_ORDER, type TextSize } from '../../store/text-size'
import { chatStrings } from '../../chat-ui/strings'
import { type ThemeChoice, type UserTheme } from '../../ui/themes'
import { LanguageGroup } from './LanguageGroup'

/**
 * What the reader would call the theme that is on: the preset's own name, or
 * the name they gave a theme of their own.
 */
function themeChoiceLabel(choice: ThemeChoice, userThemes: readonly UserTheme[]): string {
  if (choice.kind === 'preset') {
    return strings.settings.presetOptions[choice.name]
  }

  return userThemes.find(entry => entry.id === choice.id)?.name || strings.settings.themes.untitled
}

/*
 * Built on CALL rather than at import.
 *
 * These two lists were the clearest example of the thing the i18n layer had to
 * work around: a module-level literal reads `strings.*` once, when the bundle
 * loads, and a bundle loads before the stored language has come off disk. The
 * segments would have stayed English for the life of the process no matter what
 * the picker under them said.
 */
const appearanceOptions = (): { value: Appearance; label: string }[] => [
  { value: 'system', label: strings.settings.themeOptions.system },
  { value: 'light', label: strings.settings.themeOptions.light },
  { value: 'dark', label: strings.settings.themeOptions.dark }
]

/**
 * Which of a bot's two names is the large one, app-wide.
 *
 * The segments are named after the FIELDS rather than after an example, because
 * an example is a promise about this reader's own bots that the setting cannot
 * keep: a gateway where nobody has set a display name shows the same thing
 * either way, and a segment reading "lance-vance" would be a lie on it.
 */

export interface AppearanceSectionProps {
  /** Open the page where a reader makes a theme of their own. */
  onOpenAdvanced: () => void
}

export function AppearanceSection({ onOpenAdvanced }: AppearanceSectionProps) {
  const appearance = useSettingsStore(state => state.appearance)
  const setAppearance = useSettingsStore(state => state.setAppearance)
  const textSize = useSettingsStore(state => state.textSize)
  const setTextSize = useSettingsStore(state => state.setTextSize)
  const themeChoice = useSettingsStore(state => state.themeChoice)
  const userThemes = useSettingsStore(state => state.userThemes)

  return (
    <>
      <InsetGroup footer={strings.settings.themeHint} header={strings.settings.appearance}>
        <SegmentedRow
          label={strings.settings.theme}
          onChange={(value: Appearance) => setAppearance(value)}
          options={appearanceOptions()}
          testID="settings-appearance"
          value={appearance}
        />
      </InsetGroup>

      {/*
        Language sits directly under light-or-dark because the two are the same
        kind of decision: both belong to the device rather than to a gateway
        account, and both are read before there is an account to read them for.
      */}
      <LanguageGroup />

      {/*
        The transcript's type scale, in the same group shape as the two above it.

        Its own footer, because it needs the one sentence the other two do not:
        this multiplies the device's own text size rather than replacing it, and
        it reaches the conversation and nothing else. Both halves of that are
        surprising if nobody says them.
      */}
      <InsetGroup footer={strings.settings.chatTextSizeHint}>
        <SegmentedRow
          label={strings.settings.chatTextSize}
          onChange={(value: TextSize) => setTextSize(value)}
          options={TEXT_SIZE_ORDER.map(size => ({ label: chatStrings.options.textSizes[size] as string, value: size }))}
          testID="settings-text-size"
          value={textSize}
        />
      </InsetGroup>

      {/*
        HERM-107: one row, not the gallery of cards that used to sit here. The
        preset cards and the reader's own themes moved to the `Theme` page this
        opens — see `ThemesScreen` — and this row says only which one is on.
      */}
      <InsetGroup>
        <DisclosureRow
          label={strings.settings.theme}
          onPress={onOpenAdvanced}
          testID="settings-theme"
          value={themeChoiceLabel(themeChoice, userThemes)}
        />
      </InsetGroup>
    </>
  )
}
