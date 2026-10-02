/**
 * The one list a sheet shows when a row is "choose one of these".
 *
 * It was private to `ChatOptionsSheet`, and that is what let the other places a
 * choice is made grow their own control: the New-bot sheet divided a gateway's
 * whole model inventory between the segments of one `SegmentedRow`, so every
 * label was a few pixels wide and none of them was readable. A segmented control
 * is right for two, three or four fixed options whose words are short; it is
 * wrong for a list whose length is a property of somebody else's machine.
 *
 * So the pane moved here, unchanged in look, and grew the two things a longer
 * list needs:
 *
 *  - **Groups.** A model inventory is naturally per provider, and a flat list of
 *    sixty ids with the providers interleaved is a list nobody reads twice. An
 *    option carrying `group` gets a headed section; options without one stay in a
 *    single unheaded group, which is exactly what the chat's picker already was.
 *  - **A search field that appears on its own.** `searchable` used to be the
 *    caller's decision, and a caller that forgot it shipped an unsearchable list
 *    of sixty. Left unset it now follows the length.
 *
 * Grouping is deliberately NOT a separate `sections` prop. The options are built
 * by pure functions (`modelPickerOptions`) that also answer "what does this value
 * say on its row", and a second shape would mean those two could disagree about
 * which options exist — which is the bug the row label and the option list
 * already had once.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'

import type { PickerOption } from '../../chat-ui/types'
import { strings } from '../../i18n/strings'
import { SheetPage } from '../BottomSheet'
import { InsetGroup, Text, TextField } from '../primitives'
import { useTheme } from '../theme'

/**
 * From how many options a list searches itself.
 *
 * Eight is one screenful on the smallest phone the app supports: below it the
 * field would cost a row to save no scrolling, and above it scrolling is the
 * only way to reach the bottom.
 */
export const PICKER_SEARCH_FROM = 8

/**
 * A page inside a sheet.
 *
 * `SheetPage` rather than a local copy: the back affordance has to be in the
 * same place with the same glyph in every sheet that goes a level deeper, which
 * is the visible half of "Escape goes back one level".
 */
export function PickerPage({ children, onBack, title }: { children: ReactNode; onBack: () => void; title: string }) {
  return (
    <SheetPage backLabel={strings.common.back} onBack={onBack} testID="picker-back" title={title}>
      {children}
    </SheetPage>
  )
}

export interface PickerListProps {
  options: readonly PickerOption[]
  /** The option that carries the tick. `''` ticks nothing, which a span picker wants. */
  value: string
  /** Unset follows {@link PICKER_SEARCH_FROM}; `false` suppresses the field on any length. */
  searchable?: boolean
  /** The search field's label. Defaults to the generic verb. */
  searchLabel?: string
  /** What an empty list says. Defaults to the generic sentence. */
  emptyLabel?: string
  /**
   * The explanatory line under the list — `InsetGroup`'s own `footer`, carried
   * on the last section so a caller with no groups at all still gets one.
   */
  footer?: ReactNode
  onPick: (option: PickerOption) => void
}

export interface PickerPaneProps extends PickerListProps {
  title: string
  onBack: () => void
}

/** The options in the order given, cut into the sections their `group` asks for. */
function sectionsFor(options: readonly PickerOption[]): { group: string | null; options: PickerOption[] }[] {
  if (!options.some(option => option.group)) {
    return [{ group: null, options: [...options] }]
  }

  const sections: { group: string | null; options: PickerOption[] }[] = []

  for (const option of options) {
    // An ungrouped option among grouped ones lands in a HEADLESS section rather
    // than under the header above it: "Inherit" is not a model that provider
    // offers, and a header over it would say it was.
    const group = option.group ? option.group : null
    const last = sections[sections.length - 1]

    if (last && last.group === group) {
      last.options.push(option)
    } else {
      sections.push({ group, options: [option] })
    }
  }

  return sections
}

/**
 * The list itself: the search field a long list grows and the sectioned rows,
 * with no page frame around them.
 *
 * Split out of `PickerPane` for HERM-106's `LockThreshold` route, which is a
 * pushed Settings page rather than a sheet — it already has the one back
 * control `PageChrome` gives every route, and wrapping this in `PickerPage`
 * there would draw a second one. `PickerPane` below is unchanged for every
 * caller that still wants the sheet page around it.
 */
export function PickerList({ options, value, searchable, searchLabel, emptyLabel, footer, onPick }: PickerListProps) {
  const theme = useTheme()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()

    if (!needle) {
      return options
    }

    return options.filter(
      option =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle) ||
        (option.detail ?? '').toLowerCase().includes(needle) ||
        (option.group ?? '').toLowerCase().includes(needle)
    )
  }, [options, query])

  const sections = useMemo(() => sectionsFor(filtered), [filtered])
  const showSearch = searchable ?? options.length >= PICKER_SEARCH_FROM

  return (
    <>
      {showSearch ? (
        <TextField
          autoCapitalize="none"
          autoCorrect={false}
          label={searchLabel ?? strings.common.search}
          onChangeText={setQuery}
          testID="picker-search"
          value={query}
        />
      ) : null}

      {filtered.length ? (
        sections.map((section, index) => (
          <InsetGroup
            footer={index === sections.length - 1 ? footer : undefined}
            header={section.group ?? undefined}
            key={section.group ?? `section-${index}`}
          >
            {section.options.map(option => (
              <Pressable
                accessibilityRole="button"
                aria-selected={option.value === value}
                key={option.value}
                onPress={() => onPick(option)}
                testID={`picker-option-${option.value}`}
              >
                <View
                  style={{
                    alignItems: 'center',
                    flexDirection: 'row',
                    gap: theme.space.sm,
                    minHeight: 44,
                    paddingHorizontal: theme.space.lg,
                    paddingVertical: theme.space.sm
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text>{option.label}</Text>
                    {option.detail ? (
                      <Text color="textMuted" variant="meta">
                        {option.detail}
                      </Text>
                    ) : null}
                  </View>
                  {option.expensive ? (
                    <Text color="dangerText" variant="meta">
                      {'$$'}
                    </Text>
                  ) : null}
                  {option.value === value ? <Text color="accentText">{'✓'}</Text> : null}
                </View>
              </Pressable>
            ))}
          </InsetGroup>
        ))
      ) : (
        <Text color="textMuted" testID="picker-empty" variant="preview">
          {emptyLabel ?? (query.trim() ? strings.common.noMatches : strings.common.nothingToPick)}
        </Text>
      )}
    </>
  )
}

export function PickerPane({ title, onBack, ...list }: PickerPaneProps) {
  return (
    <PickerPage onBack={onBack} title={title}>
      <PickerList {...list} />
    </PickerPage>
  )
}
