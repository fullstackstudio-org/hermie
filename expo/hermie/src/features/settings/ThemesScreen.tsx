/**
 * Settings → Appearance → Theme: the preset cards, then the reader's own
 * themes, then the rows that start a new one.
 *
 * HERM-107 moved this content off the Appearance page — a picker with six-plus
 * cards on it is a long look for a screen that also holds light/dark, language
 * and text size — and moved the EDITOR off this one in turn: editing a theme's
 * colours is a `ThemeEdit` page of its own now (`ThemeEditScreen`), reached by
 * tapping a card here or starting one from a preset. Tapping a card, preset or
 * user, still applies it straight away: the only question in front of a theme
 * picker is what the window will look like, and a reader should not have to
 * open the editor just to try one on.
 */
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSettingsStore } from '../../store/settings'
import { PageFrame, PageScrollView, type PageChromeBack } from '../../ui/chrome'
import { InsetButtonRow, InsetGroup, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { THEME_PRESET_ORDER } from '../../ui/themes'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { ThemeCard } from './ThemeCard'

export interface ThemesScreenProps {
  /** The page's one back control, labelled with the page it returns to. */
  back?: PageChromeBack
  /** Open the editor for one of the reader's own themes — created or existing. */
  onEditTheme: (id: string) => void
}

export function ThemesScreen({ back, onEditTheme }: ThemesScreenProps) {
  const theme = useTheme()
  const userThemes = useSettingsStore(state => state.userThemes)
  const themeChoice = useSettingsStore(state => state.themeChoice)
  const setThemeChoice = useSettingsStore(state => state.setThemeChoice)

  return (
    <PageFrame {...(back ? { back } : {})} title={strings.settings.themes.title}>
      <PageScrollView
        ref={directTouchPanRef}
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
      >
        {/*
          The presets, as cards rather than as a segmented control of names. A
          segment reading "Graphite" is a promise a reader cannot check; each
          card paints its own floor, its own panel and a bubble pair in its own
          accent, resolved through the same function the app resolves the live
          theme with — see `ThemeCard`.
        */}
        <View style={{ gap: theme.space.md }}>
          <Text color="textMuted" style={{ letterSpacing: 0.6, marginLeft: theme.space.lg }} variant="meta">
            {strings.settings.preset}
          </Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md }}>
            {THEME_PRESET_ORDER.map(name => (
              <ThemeCard
                choice={{ kind: 'preset', name }}
                key={name}
                label={strings.settings.presetOptions[name]}
                onPress={() => setThemeChoice({ kind: 'preset', name })}
                scheme={theme.scheme}
                selected={themeChoice.kind === 'preset' && themeChoice.name === name}
                testID={`theme-card-${name}`}
                userThemes={userThemes}
              />
            ))}
          </View>
          <Text color="textMuted" style={{ marginHorizontal: theme.space.lg }} variant="meta">
            {strings.settings.presetHint}
          </Text>
        </View>

        {userThemes.length ? (
          <View style={{ gap: theme.space.md }}>
            <Text color="textMuted" style={{ marginLeft: theme.space.lg, letterSpacing: 0.6 }} variant="meta">
              {strings.settings.themes.header}
            </Text>
            <View
              accessibilityRole="radiogroup"
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md }}
            >
              {userThemes.map(entry => (
                <ThemeCard
                  choice={{ kind: 'user', id: entry.id }}
                  key={entry.id}
                  label={entry.name || strings.settings.themes.untitled}
                  onPress={() => {
                    setThemeChoice({ kind: 'user', id: entry.id })
                    onEditTheme(entry.id)
                  }}
                  scheme={theme.scheme}
                  selected={themeChoice.kind === 'user' && themeChoice.id === entry.id}
                  testID={`theme-card-user-${entry.id}`}
                  userThemes={userThemes}
                />
              ))}
            </View>
          </View>
        ) : (
          <Text color="textMuted" variant="preview">
            {strings.settings.themes.empty}
          </Text>
        )}

        <InsetGroup header={strings.settings.themes.create}>
          {THEME_PRESET_ORDER.map(preset => (
            <InsetButtonRow
              key={preset}
              onPress={() => {
                const id = useSettingsStore.getState().createUserTheme(preset, strings.settings.presetOptions[preset])

                useSettingsStore.getState().setThemeChoice({ kind: 'user', id })
                onEditTheme(id)
              }}
              testID={`theme-new-${preset}`}
              title={strings.settings.themes.createFrom(strings.settings.presetOptions[preset])}
            />
          ))}
        </InsetGroup>

        <View style={{ height: theme.space.xxl }} />
      </PageScrollView>
    </PageFrame>
  )
}
