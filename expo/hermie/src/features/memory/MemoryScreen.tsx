/**
 * One bot's memory: both files, a search across them, and the writes.
 *
 * ## Two sections, never one merged list
 *
 * `MEMORY.md` and `USER.md` are two files with two char limits and two
 * meanings — what the bot learned about its work, and what it learned about
 * the person. A merged list would be tidier and would also make "is my USER.md
 * nearly full" unanswerable, which is the question the bars exist for.
 *
 * ## Search is the plugin's, not a filter over what is on screen
 *
 * `memory/browse.py::search` matches every word of the query somewhere in the
 * entry, in any order, as plain text — never as a regular expression, because a
 * query that is accidentally a regex is worse than one that matches nothing. It
 * goes over the wire rather than being done here so that the app and the bot's
 * own `/memory` command agree about what "matching" means.
 *
 * ## Three states before there is a page at all
 *
 * The routes belong to a PLUGIN, so "connected" does not imply "browsable".
 * The advert is asked first and answers one of: not looked yet, which draws
 * nothing rather than an accusation; no `memory.browse`, which draws the
 * install panel; `memory.browse` without `memory.edit`, which draws the page
 * with its composers and row actions gone and a line saying why.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Pressable, ScrollView, View } from 'react-native'

import { PLUGIN_GUIDE_URL, PLUGIN_INSTALL_COMMANDS } from '../push/PluginInstall'
import { strings } from '../../i18n/strings'
import { MONOSPACE } from '../../markdown/context'
import { useMemoryStore } from '../../store/memory'
import { Button, InsetButtonRow, InsetGroup, InsetRow, InsetValueRow, Text, TextField } from '../../ui/primitives'
import { PageChromeSpacer, PageFrame, type PageChromeProps } from '../../ui/chrome'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useTheme } from '../../ui/theme'
import { MemoryEntryRow } from './MemoryEntryRow'
import type { MemoryGraph as MemoryGraphType, MemoryGraphNode } from './graph-model'
import { MemoryGraphFullScreen } from './MemoryGraphFullScreen'
import { MemoryRawTab } from './MemoryRawTab'
import { MemoryGraphView } from './MemoryGraphView'
import { MemoryNodeCard } from './MemoryNodeCard'
import { MemoryUsageBar } from './MemoryUsageBar'
import {
  externalProviders,
  type MemoryEntry,
  type MemoryListing as MemoryListingType,
  MEMORY_TARGETS,
  type MemoryTarget
} from './model'
import { memoryStrings } from './strings'
import { useMemoryAvailability, useMemoryController } from './useMemory'

/** A little air above the row the map sent us to, so it is not against the top. */
const SCROLL_MARGIN = 24

export interface MemoryScreenProps {
  /** The bot whose memory this is — the profile NAME, never a display name. */
  profile: string
  /** What the reader calls this bot, for the title only. */
  title?: string
  /** Where the page's back control goes. Absent, the page has none. */
  onClose?: () => void
  /** What that back control is labelled: the page it returns to. */
  backLabel?: string
  testID?: string
}

export function MemoryScreen({ profile, title, onClose, backLabel, testID = 'memory' }: MemoryScreenProps) {
  const theme = useTheme()
  const availability = useMemoryAvailability()
  const controller = useMemoryController(profile)

  const listing = useMemoryStore(state => state.listing)
  const loading = useMemoryStore(state => state.loading)
  const busy = useMemoryStore(state => state.busy)
  const error = useMemoryStore(state => state.error)
  const notice = useMemoryStore(state => state.notice)
  const query = useMemoryStore(state => state.query)
  const searching = useMemoryStore(state => state.searching)
  const results = useMemoryStore(state => state.results)
  const graph = useMemoryStore(state => state.graph)
  const graphLoading = useMemoryStore(state => state.graphLoading)
  const raw = useMemoryStore(state => state.raw)
  const rawLoading = useMemoryStore(state => state.rawLoading)
  const rawMissing = useMemoryStore(state => state.rawMissing)

  const [tab, setTab] = useState<MemoryTab>('entries')
  const [selected, setSelected] = useState<MemoryGraphNode | null>(null)
  /** The entry the map sent us to, lit until the reader touches something else. */
  const [highlighted, setHighlighted] = useState<string | null>(null)
  /** The graph with the window to itself, opened from the card's own button. */
  const [fullGraph, setFullGraph] = useState(false)
  const scroller = useRef<ScrollView | null>(null)
  /** Entry id → the row's own view, so it can be measured against the scroller. */
  const rows = useRef<Record<string, View | null>>({})

  /*
    The graph is a second read of the same files, so it is fetched when its tab
    is opened rather than beside the listing — most readers never open it.
    Asked again whenever the controller changes, which is a new bot or a new
    connection, because the answer belongs to one profile.
  */
  useEffect(() => {
    if (tab === 'graph' && controller) {
      void controller.loadGraph()
    }

    // Same rule as the graph's: a third read of the same files, asked for only
    // by a reader who opened the tab that shows it.
    if (tab === 'raw' && controller) {
      void controller.loadRaw()
    }
  }, [controller, tab])

  /*
    Back — Escape and Android's back included — is `PageFrame`'s, registered on
    mount. A deeper surface still wins because it registers LATER: the
    full-screen graph and a selected node both switch their handlers on after
    the page is up, and the stack hands the key to whatever was pushed last.
  */

  /*
    A selected node on the map is a LEVEL, so Escape leaves it before it leaves
    the screen.

    `MemoryNodeCard` has a close control of its own, which is what makes it one:
    anything with a way out has to be the thing Escape takes. Registered after
    the pair above, so it sits on top of them while a node is selected and hands
    the key straight back when nothing is — which is the whole of the ordering,
    and why neither of the two above has to know this exists.
  */
  useEscapeKey(() => setSelected(null), selected !== null && !fullGraph)
  useHardwareBack(() => setSelected(null), selected !== null && !fullGraph)

  const onReplace = useCallback(
    (entry: MemoryEntry, text: string) => void controller?.replace(entry, text),
    [controller]
  )
  const onRemove = useCallback((entry: MemoryEntry) => void controller?.remove(entry), [controller])

  const chrome: PageChromeProps = {
    subtitle: title ? memoryStrings.forBot(title) : profile,
    title: memoryStrings.title,
    ...(onClose ? { back: { label: backLabel ?? strings.common.back, onPress: onClose } } : {})
  }

  /**
   * Jump from a node to the entry it stands for.
   *
   * `measureLayout` against the scroller's own inner view rather than an
   * `onLayout` offset: a row sits inside an `InsetGroup`, which wraps every
   * child in a view of its own, so the `y` a row reports is relative to that
   * card and not to the scrolling content. Measuring asks the one question that
   * has the right answer.
   *
   * The Entries tab is shown first and the measurement waits a frame, because a
   * tab that has never been drawn has no rows to measure.
   */
  const openInList = useCallback((entryId: string) => {
    setTab('entries')
    setHighlighted(entryId)
    requestAnimationFrame(() => {
      const row = rows.current[entryId]
      const content = scroller.current?.getInnerViewNode?.()

      if (!row || !content) {
        return
      }

      row.measureLayout?.(
        content as never,
        (_x: number, y: number) => scroller.current?.scrollTo({ animated: true, y: Math.max(0, y - SCROLL_MARGIN) }),
        () => undefined
      )
    })
  }, [])

  if (availability === 'unknown') {
    return (
      <PageFrame {...chrome}>
        <PageChromeSpacer />
        <View style={{ paddingHorizontal: theme.space.lg }}>
          <Text color="textMuted" testID={`${testID}-unknown`} variant="meta">
            {memoryStrings.missing.unknown}
          </Text>
        </View>
      </PageFrame>
    )
  }

  if (availability === 'missing') {
    return (
      <PageFrame {...chrome}>
        <PageChromeSpacer />
        <ScrollView contentContainerStyle={{ gap: theme.space.lg, padding: theme.space.lg }}>
          <Text testID={`${testID}-missing`} variant="body">
            {memoryStrings.missing.title}
          </Text>
          <Text color="textMuted" variant="meta">
            {memoryStrings.missing.body}
          </Text>
          <InsetGroup header={memoryStrings.missing.install}>
            <InsetRow>
              <Text
                selectable
                style={{
                  fontFamily: MONOSPACE,
                  fontSize: theme.type.meta.fontSize,
                  lineHeight: theme.type.body.lineHeight
                }}
                testID={`${testID}-install`}
              >
                {PLUGIN_INSTALL_COMMANDS.join('\n')}
              </Text>
            </InsetRow>
            <InsetButtonRow
              onPress={() => void Linking.openURL(PLUGIN_GUIDE_URL)}
              testID={`${testID}-guide`}
              title={memoryStrings.missing.guide}
            />
          </InsetGroup>
        </ScrollView>
      </PageFrame>
    )
  }

  const readOnly = availability === 'readOnly'

  return (
    <PageFrame {...chrome}>
      <PageChromeSpacer />

      <MemoryTabs onChange={setTab} tab={tab} testID={testID} />

      <ScrollView
        contentContainerStyle={{ gap: theme.space.lg, padding: theme.space.lg }}
        ref={scroller}
        testID={`${testID}-scroll`}
      >
        {tab === 'graph' ? (
          <GraphTab
            graph={graph}
            listing={listing}
            loading={graphLoading}
            onOpenFull={() => setFullGraph(true)}
            onOpenInList={openInList}
            onSelect={setSelected}
            selected={selected}
            testID={testID}
          />
        ) : null}

        {tab === 'raw' ? <MemoryRawTab loading={rawLoading} missing={rawMissing} raw={raw} testID={testID} /> : null}

        {tab === 'entries' ? (
          <>
            <InsetGroup footer={memoryStrings.search.hint}>
              <InsetRow>
                <TextField
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={next => void controller?.search(next)}
                  placeholder={memoryStrings.search.placeholder}
                  testID={`${testID}-search`}
                  value={query}
                />
              </InsetRow>
            </InsetGroup>

            {readOnly ? (
              <Text color="textMuted" testID={`${testID}-read-only`} variant="meta">
                {memoryStrings.readOnly}
              </Text>
            ) : null}

            {notice ? (
              <Text color="dangerText" testID={`${testID}-notice`} variant="meta">
                {notice}
              </Text>
            ) : null}

            {error ? (
              <InsetGroup>
                <InsetRow>
                  <Text color="dangerText" testID={`${testID}-error`} variant="meta">
                    {memoryStrings.failed(error)}
                  </Text>
                </InsetRow>
                <InsetButtonRow onPress={() => void controller?.refresh()} title={memoryStrings.retry} />
              </InsetGroup>
            ) : null}

            {loading && !listing ? (
              <Text color="textMuted" testID={`${testID}-loading`} variant="meta">
                {memoryStrings.loading}
              </Text>
            ) : null}

            {query.trim() ? (
              <SearchResults
                busy={busy}
                onRemove={onRemove}
                onReplace={onReplace}
                query={query}
                readOnly={readOnly}
                results={results}
                searching={searching}
                testID={testID}
              />
            ) : (
              MEMORY_TARGETS.map(target => (
                <MemorySection
                  busy={busy}
                  key={target}
                  highlighted={highlighted}
                  onAdd={text => void controller?.add(target, text)}
                  onRow={(entryId, view) => {
                    rows.current[entryId] = view
                  }}
                  onRemove={onRemove}
                  onReplace={onReplace}
                  readOnly={readOnly}
                  section={listing?.sections.find(row => row.target === target) ?? null}
                  target={target}
                  testID={testID}
                />
              ))
            )}

            <Providers listing={listing} testID={testID} />
          </>
        ) : null}
      </ScrollView>

      {/*
        Rendered from the screen rather than from the tab, so it survives a tab
        switch underneath it and so there is one of it. `graph` is non-null
        whenever it can be opened — the button lives inside the branch that
        already checked.
      */}
      {graph ? (
        <MemoryGraphFullScreen
          graph={graph}
          listing={listing}
          onClose={() => setFullGraph(false)}
          onSelect={setSelected}
          selected={selected}
          visible={fullGraph}
        />
      ) : null}
    </PageFrame>
  )
}

interface SectionProps {
  target: MemoryTarget
  section: { entries: MemoryEntry[]; chars: number; limit: number; percent: number } | null
  readOnly: boolean
  busy: boolean
  onAdd: (text: string) => void
  onReplace: (entry: MemoryEntry, text: string) => void
  onRemove: (entry: MemoryEntry) => void
  /** Hand back each row's view, so "show in the list" can measure and scroll to it. */
  onRow: (entryId: string, view: View | null) => void
  highlighted: string | null
  testID: string
}

function MemorySection({
  target,
  section,
  readOnly,
  busy,
  onAdd,
  onReplace,
  onRemove,
  onRow,
  highlighted,
  testID
}: SectionProps) {
  const theme = useTheme()
  const [draft, setDraft] = useState('')
  const label = memoryStrings.sections[target]

  return (
    <InsetGroup
      footer={
        <View style={{ gap: theme.space.xs }}>
          <Text color="textMuted" variant="meta">
            {memoryStrings.sectionHint[target]}
          </Text>
          <MemoryUsageBar
            chars={section?.chars ?? 0}
            label={label}
            limit={section?.limit ?? 0}
            percent={section?.percent ?? 0}
            testID={`${testID}-usage-${target}`}
          />
        </View>
      }
      header={label}
      testID={`${testID}-section-${target}`}
    >
      {section && section.entries.length === 0 ? (
        <InsetRow>
          <Text color="textMuted" testID={`${testID}-empty-${target}`} variant="meta">
            {memoryStrings.empty[target]}
          </Text>
        </InsetRow>
      ) : null}

      {(section?.entries ?? []).map(entry => (
        <View key={entry.id} ref={view => onRow(entry.id, view)}>
          <MemoryEntryRow
            busy={busy}
            entry={entry}
            highlighted={entry.id === highlighted}
            onRemove={onRemove}
            onReplace={onReplace}
            readOnly={readOnly}
          />
        </View>
      ))}

      {readOnly ? null : (
        <InsetRow>
          <TextField
            multiline
            onChangeText={setDraft}
            placeholder={memoryStrings.add.placeholder}
            testID={`${testID}-add-${target}`}
            value={draft}
          />
          <Button
            accessibilityLabel={memoryStrings.add.label(label)}
            busy={busy}
            disabled={busy || !draft.trim()}
            onPress={() => {
              // Cleared on the tap rather than on the answer: the write is
              // followed by a refetch, and a composer that stayed full until
              // that landed reads as though nothing happened.
              onAdd(draft)
              setDraft('')
            }}
            testID={`${testID}-add-${target}-action`}
            title={memoryStrings.add.action}
            variant="secondary"
          />
        </InsetRow>
      )}
    </InsetGroup>
  )
}

interface SearchResultsProps {
  query: string
  results: MemoryEntry[] | null
  searching: boolean
  readOnly: boolean
  busy: boolean
  onReplace: (entry: MemoryEntry, text: string) => void
  onRemove: (entry: MemoryEntry) => void
  testID: string
}

function SearchResults({ query, results, searching, readOnly, busy, onReplace, onRemove, testID }: SearchResultsProps) {
  if (searching && !results) {
    return (
      <Text color="textMuted" testID={`${testID}-searching`} variant="meta">
        {memoryStrings.search.searching}
      </Text>
    )
  }

  if (results && results.length === 0) {
    return (
      <Text color="textMuted" testID={`${testID}-no-results`} variant="meta">
        {memoryStrings.search.none(query)}
      </Text>
    )
  }

  return (
    <InsetGroup header={memoryStrings.search.count(results?.length ?? 0)} testID={`${testID}-results`}>
      {(results ?? []).map(entry => (
        <MemoryEntryRow
          busy={busy}
          entry={entry}
          key={entry.id}
          onRemove={onRemove}
          onReplace={onReplace}
          readOnly={readOnly}
        />
      ))}
    </InsetGroup>
  )
}

/**
 * The providers that cannot be opened.
 *
 * Drawn even though there is nothing behind them, because the alternative is a
 * page that silently shows two files while a mem0 store holds most of what the
 * bot actually remembers. The row names the provider and says it is not
 * browsable; the footer says once why, for all of them.
 */
function Providers({ listing, testID }: { listing: Parameters<typeof externalProviders>[0]; testID: string }) {
  const external = externalProviders(listing)

  if (external.length === 0) {
    return null
  }

  return (
    <InsetGroup
      footer={memoryStrings.providers.hint}
      header={memoryStrings.providers.header}
      testID={`${testID}-providers`}
    >
      {external.map(provider => (
        <InsetValueRow key={provider.name} label={provider.name} value={memoryStrings.providers.notBrowsable} />
      ))}
    </InsetGroup>
  )
}

/** Which half of the page is showing. */
export type MemoryTab = 'entries' | 'graph' | 'raw'

/**
 * The two tabs.
 *
 * A pair of pressables rather than the app's `SegmentedRow`, which belongs to a
 * sheet's control stack and carries a row's chrome with it. This is a strip
 * under a screen header, and the selected one is marked with the accent rule
 * the design board uses for exactly that.
 */
function MemoryTabs({
  tab,
  onChange,
  testID
}: {
  tab: MemoryTab
  onChange: (next: MemoryTab) => void
  testID: string
}) {
  const theme = useTheme()

  return (
    <View style={{ flexDirection: 'row', gap: theme.space.lg, paddingHorizontal: theme.space.lg }}>
      {(['entries', 'graph', 'raw'] as const).map(name => (
        <Pressable
          accessibilityRole="tab"
          // `aria-selected`, never `accessibilityState`: react-native-web drops
          // the object on the floor. `accessibility-state.test.tsx` sweeps for it.
          aria-selected={tab === name}
          key={name}
          onPress={() => onChange(name)}
          style={{
            borderBottomColor: tab === name ? theme.colors.accentText : 'transparent',
            borderBottomWidth: 2,
            paddingVertical: theme.space.sm
          }}
          testID={`${testID}-tab-${name}`}
        >
          <Text color={tab === name ? 'accentText' : 'textMuted'} variant="name">
            {memoryStrings.tabs[name]}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

/**
 * The map, what it left out, and whatever node is open.
 *
 * Two different kinds of "left out" are said separately, because they have
 * different fixes: the PLUGIN pages over entries and says `truncated` when a
 * cap bit, and the LAYOUT has a node ceiling of its own. Rolling them into one
 * sentence would tell somebody their memory is too big when the picture simply
 * has a page after it.
 */
function GraphTab({
  graph,
  listing,
  loading,
  selected,
  onSelect,
  onOpenInList,
  onOpenFull,
  testID
}: {
  graph: MemoryGraphType | null
  listing: MemoryListingType | null
  loading: boolean
  selected: MemoryGraphNode | null
  onSelect: (node: MemoryGraphNode | null) => void
  onOpenInList: (entryId: string) => void
  onOpenFull: () => void
  testID: string
}) {
  if (loading && !graph) {
    return (
      <Text color="textMuted" testID={`${testID}-graph-loading`} variant="meta">
        {memoryStrings.graph.loading}
      </Text>
    )
  }

  if (!graph || graph.nodes.length <= 1) {
    return (
      <Text color="textMuted" testID={`${testID}-graph-empty`} variant="meta">
        {memoryStrings.graph.empty}
      </Text>
    )
  }

  return (
    <>
      <MemoryGraphView graph={graph} onSelect={onSelect} selectedId={selected?.id ?? null} />

      {/*
        The card is a square the width of this column, and a 640-unit drawing in
        350 points arrives at about half size before anybody has zoomed. This is
        the way out of that: the same picture with the window to itself.
      */}
      <Button
        onPress={onOpenFull}
        testID={`${testID}-graph-open-full`}
        title={memoryStrings.graph.full.open}
        variant="secondary"
      />

      {graph.truncated || graph.page.hasMore ? (
        <Text color="textMuted" testID={`${testID}-graph-truncated`} variant="meta">
          {memoryStrings.graph.truncated(graph.page.returned, graph.page.total)}
        </Text>
      ) : null}

      {selected ? (
        <MemoryNodeCard
          graph={graph}
          listing={listing}
          node={selected}
          onClose={() => onSelect(null)}
          onOpenInList={onOpenInList}
        />
      ) : null}
    </>
  )
}
