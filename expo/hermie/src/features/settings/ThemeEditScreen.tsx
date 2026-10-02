/**
 * Settings → Appearance → Theme → edit: the colours of one of the reader's own
 * themes.
 *
 * Split out of `ThemesScreen` by HERM-107, which turned the picker's inline
 * editor into a page of its own — `ThemeEdit`, pushed from a card or a "from a
 * preset" row. Three things carried over unchanged from before the split:
 *
 *  1. **A theme is a preset plus a few colours.** Not a palette editor. What is
 *     handed over is the three colours that carry the composition: the floor,
 *     the accent's ring and the outgoing bubble.
 *  2. **The guard is the build's guard.** `judgeThemeColour` is the function
 *     `npm run contrast:check` measures with, so a colour this screen accepts is
 *     a colour the check accepts, and the refusal says the ratio it measured
 *     rather than "invalid".
 *  3. **One face at a time.** A theme has a light and a dark face; the face
 *     being edited is the one that is ON, and the screen says so out loud.
 *
 * The delete confirmation is a LEVEL rather than a second back control: it is
 * two rows drawn in place, registered on the Escape and hardware-back stacks
 * while it is up, so a press cancels the question before it leaves the page —
 * the page still has exactly one `page-back`.
 */
import { useState } from 'react'
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSettingsStore } from '../../store/settings'
import { judgeThemeColour, type ThemeColourField } from '../../ui/contrast'
import { PageFrame, PageScrollView, type PageChromeBack } from '../../ui/chrome'
import { InsetButtonRow, InsetGroup, InsetRow, Text, TextField } from '../../ui/primitives'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { useTheme } from '../../ui/theme'
import { DEFAULT_THEME_PRESET, resolveThemeFace, type ThemePresetName } from '../../ui/themes'
import { FORM_MAX_WIDTH } from '../../ui/tokens'

/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const fields = (): { field: ThemeColourField; label: string }[] => [
  { field: 'background', label: strings.settings.themes.background },
  { field: 'accentFill', label: strings.settings.themes.accentFill },
  { field: 'accentBubble', label: strings.settings.themes.accentBubble }
]

export interface ThemeEditScreenProps {
  /** The page's one back control, labelled with the page it returns to. */
  back?: PageChromeBack
  /** The theme being edited. */
  id: string
}

export function ThemeEditScreen({ back, id }: ThemeEditScreenProps) {
  const theme = useTheme()
  const userThemes = useSettingsStore(state => state.userThemes)
  const entry = userThemes.find(item => item.id === id)
  const face = resolveThemeFace({ kind: 'user', id }, theme.scheme, userThemes)
  const stored = entry?.[theme.scheme] ?? {}
  const name = entry?.name ?? ''
  // A theme deleted from elsewhere (or a stale deep link) still opens on
  // something legible, the same way `resolveThemeFace` falls back on its own.
  const base = entry?.base ?? DEFAULT_THEME_PRESET

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  /*
    The delete confirmation is a LEVEL, so Escape cancels it before it leaves
    the page.

    It is two rows drawn in place rather than a sheet, which is exactly why it
    was missed on the page this was extracted from: nothing mounts, so there
    was no new registration and the first Escape closed the whole page with a
    destructive question still on screen.
  */
  useEscapeKey(() => setConfirmingDelete(false), confirmingDelete)
  useHardwareBack(() => setConfirmingDelete(false), confirmingDelete)

  const current: Record<ThemeColourField, string> = {
    background: face.background,
    accentFill: face.accentSwatch.fill,
    accentBubble: face.accentSwatch.bubble
  }

  const [drafts, setDrafts] = useState<Partial<Record<ThemeColourField, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<ThemeColourField, string>>>({})

  const describe = (field: ThemeColourField, verdict: ReturnType<typeof judgeThemeColour>): string => {
    if (verdict.ok) {
      return ''
    }

    if (verdict.reason === 'malformed') {
      return strings.settings.themes.rejected(strings.settings.themes.reasonMalformed)
    }

    const ratio = verdict.ratio.toFixed(2)

    if (field === 'accentBubble') {
      return strings.settings.themes.rejected(strings.settings.themes.reasonBubble(ratio))
    }

    if (field === 'background') {
      return strings.settings.themes.rejected(strings.settings.themes.reasonBackground(ratio))
    }

    return strings.settings.themes.rejected(strings.settings.themes.reasonAccentFill(ratio))
  }

  return (
    <PageFrame {...(back ? { back } : {})} title={name || strings.settings.themes.untitled}>
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
        <View style={{ gap: theme.space.lg }}>
          <InsetGroup
            footer={strings.settings.themes.editingHint}
            header={strings.settings.themes.editing(theme.scheme)}
          >
            <InsetRow>
              <TextField
                autoCapitalize="words"
                label={strings.settings.themes.name}
                onChangeText={next => useSettingsStore.getState().renameUserTheme(id, next)}
                placeholder={strings.settings.themes.namePlaceholder}
                testID="theme-name"
                value={name}
              />
            </InsetRow>

            {fields().map(({ field, label }) => (
              <InsetRow key={field}>
                <TextField
                  autoCapitalize="characters"
                  autoCorrect={false}
                  error={errors[field] ?? null}
                  label={label}
                  onChangeText={next => {
                    setDrafts(previous => ({ ...previous, [field]: next }))

                    const verdict = judgeThemeColour(field, next, theme.scheme, face)

                    setErrors(previous => ({ ...previous, [field]: describe(field, verdict) }))

                    if (verdict.ok) {
                      useSettingsStore.getState().editUserTheme(id, theme.scheme, { [field]: next.trim() })
                    }
                  }}
                  placeholder={strings.settings.themes.colourPlaceholder}
                  testID={`theme-colour-${field}`}
                  value={drafts[field] ?? current[field]}
                />
                {/* A field that is following the preset can say so and be let go of again. */}
                {stored[field as keyof typeof stored] ? (
                  <Text
                    color="accentText"
                    onPress={() => {
                      setDrafts(previous => ({ ...previous, [field]: undefined }))
                      setErrors(previous => ({ ...previous, [field]: '' }))
                      useSettingsStore.getState().editUserTheme(id, theme.scheme, { [field]: null })
                    }}
                    testID={`theme-follow-${field}`}
                    variant="meta"
                  >
                    {strings.settings.themes.followPreset}
                  </Text>
                ) : (
                  <Text color="textFaint" variant="meta">
                    {strings.settings.themes.createFrom(strings.settings.presetOptions[base as ThemePresetName])}
                  </Text>
                )}
              </InsetRow>
            ))}
          </InsetGroup>

          <InsetGroup>
            <InsetButtonRow
              onPress={() => setConfirmingDelete(true)}
              testID="theme-delete"
              title={strings.settings.themes.delete}
              tone="danger"
            />
          </InsetGroup>

          {confirmingDelete ? (
            <InsetGroup footer={strings.settings.themes.deleteHint}>
              <InsetButtonRow
                onPress={() => {
                  useSettingsStore.getState().deleteUserTheme(id)
                  setConfirmingDelete(false)
                  back?.onPress()
                }}
                testID="theme-delete-confirm"
                title={strings.settings.themes.deleteConfirm(name)}
                tone="danger"
              />
              <InsetButtonRow
                onPress={() => setConfirmingDelete(false)}
                title={strings.settings.themes.keepIt}
                tone="text"
              />
            </InsetGroup>
          ) : null}
        </View>

        <View style={{ height: theme.space.xxl }} />
      </PageScrollView>
    </PageFrame>
  )
}
