/**
 * Settings → About → Licences: the same list as `THIRD_PARTY_LICENSES.md`, on
 * the device that is running the code it describes.
 *
 * Three things shape this screen.
 *
 *  1. **The data is loaded, never imported.** See `licences-data.ts`: half a
 *     megabyte may not sit in the start-up path for a screen most people never
 *     open, so it arrives through a dynamic import in an effect, with a real
 *     loading state and a real error state rather than a blank list.
 *  2. **The list is virtualised.** Six hundred entries is a `FlatList`, not a
 *     `ScrollView` with six hundred mounted rows.
 *  3. **The licence text is one tap away, not inlined.** Rendering every text at
 *     once would be most of a megabyte of glyphs; a row expands on demand and
 *     collapses again.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { PageChromeSpacer, PageFrame, type PageChromeBack } from '../../ui/chrome'
import { Button, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'
import { type LicenceData, type LicencePackage, loadLicenceData } from './licences-data'

export interface LicencesScreenProps {
  /** The page's one back control, labelled with the page it returns to. */
  back?: PageChromeBack
}

type LoadState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; data: LicenceData }

export function LicencesScreen({ back }: LicencesScreenProps) {
  const theme = useTheme()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let live = true

    setState({ status: 'loading' })

    loadLicenceData()
      .then(data => {
        if (live) {
          setState({ status: 'ready', data })
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      })

    // A resolved import that lands after the reader has left must not set state.
    return () => {
      live = false
    }
  }, [attempt])

  const toggle = useCallback((key: string) => setExpanded(current => (current === key ? null : key)), [])

  /*
    The page's name is the chrome's, and the back button with it. What is left
    here is the one line that belongs to the LIST — how many packages ship —
    and it rides above the rows with the spacer that keeps it clear of the glass.
  */
  const header = (
    <View style={{ gap: theme.space.sm, paddingBottom: theme.space.lg }}>
      <PageChromeSpacer />
      <Text color="textMuted" variant="preview">
        {state.status === 'ready'
          ? strings.settings.licencesSummary(state.data.packages.length)
          : strings.settings.licencesHint}
      </Text>
    </View>
  )

  const chrome = { title: strings.settings.licences, ...(back ? { back } : {}) }

  if (state.status !== 'ready') {
    return (
      <PageFrame {...chrome}>
        <View style={{ gap: theme.space.lg, padding: theme.space.lg }}>
          {header}
          {state.status === 'loading' ? (
            <View
              accessibilityRole="progressbar"
              style={{ alignItems: 'center', gap: theme.space.md, paddingVertical: theme.space.xl }}
              testID="licences-loading"
            >
              <ActivityIndicator color={theme.colors.accentText} />
              <Text color="textMuted" variant="preview">
                {strings.settings.licencesLoading}
              </Text>
            </View>
          ) : (
            <View style={{ gap: theme.space.md }} testID="licences-error">
              <Text color="dangerText" variant="preview">
                {strings.settings.licencesFailed(state.message)}
              </Text>
              <Button onPress={() => setAttempt(count => count + 1)} title={strings.settings.licencesRetry} />
            </View>
          )}
        </View>
      </PageFrame>
    )
  }

  return (
    <PageFrame {...chrome}>
      <FlatList
        ref={directTouchPanRef}
        ListFooterComponent={<Footer data={state.data} />}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: theme.space.lg }}
        data={state.data.packages}
        extraData={expanded}
        keyExtractor={keyOf}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <PackageRow
            expanded={expanded === keyOf(item)}
            onToggle={toggle}
            package={item}
            text={item.text ? state.data.texts[item.text] : undefined}
          />
        )}
        testID="licences-list"
      />
    </PageFrame>
  )
}

/** Name and version identify a package; the list can hold two versions of one name. */
const keyOf = (entry: LicencePackage): string => `${entry.name}@${entry.version}`

function PackageRow({
  expanded,
  onToggle,
  package: entry,
  text
}: {
  expanded: boolean
  onToggle: (key: string) => void
  package: LicencePackage
  text: string | undefined
}) {
  const theme = useTheme()
  const key = keyOf(entry)
  // Not memoised: it is a template literal over two fields, and a memo would
  // have had to be told about the language as well — for a saving of one string
  // concatenation per render.
  const detail = `${entry.version} · ${entry.licence || strings.settings.licencesUndeclared}`

  return (
    <View
      style={{
        backgroundColor: theme.elevation.e3c,
        borderColor: theme.hairline,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        marginBottom: theme.space.sm,
        overflow: 'hidden'
      }}
    >
      <Pressable
        accessibilityRole="button"
        aria-expanded={expanded}
        onPress={() => onToggle(key)}
        testID={`licence-row-${key}`}
      >
        {({ pressed }) => (
          <View
            style={{
              backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
              gap: theme.space.xxs,
              justifyContent: 'center',
              minHeight: CONTROL_MIN_HEIGHT,
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.md
            }}
          >
            <Text variant="name">{entry.name}</Text>
            <Text color="textMuted" variant="meta">
              {detail}
            </Text>
          </View>
        )}
      </Pressable>

      {expanded ? (
        <View
          style={{
            borderTopColor: theme.hairline,
            borderTopWidth: 1,
            gap: theme.space.sm,
            padding: theme.space.lg
          }}
          testID={`licence-text-${key}`}
        >
          {entry.repository ? (
            <Text color="textMuted" variant="meta">
              {entry.repository}
            </Text>
          ) : null}
          <Text selectable variant="code">
            {text ?? strings.settings.licencesNoText}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/** Where the list came from, so a reader can check it against the repository. */
function Footer({ data }: { data: LicenceData }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm, paddingTop: theme.space.lg }}>
      <Text color="textMuted" variant="meta">
        {strings.settings.licencesScope(data.excludesWorkspacePackages.length)}
      </Text>
      <Text color="textMuted" variant="meta">
        {strings.settings.licencesGeneratedBy(data.generatedBy)}
      </Text>
    </View>
  )
}
