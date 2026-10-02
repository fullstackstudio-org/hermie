/**
 * Activity: one timeline of everything the bots said to each other.
 *
 * The design board's Activity screen, and the reason the app exists at all —
 * bot-to-bot traffic is invisible in any per-chat view, because it is by
 * definition spread across two chats. Rows read as sentences (`researcher →
 * writer: draft the announcement`) and each one is a door into the chat where
 * it happened.
 *
 * Two arrangements worth knowing about:
 *
 *  - Pull to refresh lives on the LIST, not on the screen. A refresh spinner
 *    that floats over the whole screen lands on top of the header it was
 *    supposed to sit under.
 *  - The counters at the top are the only thing here that is not derived from
 *    the transcripts. They are polled while this screen is mounted and dropped
 *    when it is not; a number nobody is looking at is not worth a round trip.
 */
import type { ActivityEntry } from '@hermie/transcript'
import { useMemo, useState, type ReactNode } from 'react'
import { RefreshControl, SectionList, Pressable, View } from 'react-native'

import { formatClock } from '../../chat-ui'
import { useGateway } from '../../gateway'
import { humaniseStatus } from '../../i18n/humanise'
import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useBotsStore } from '../../store/bots'
import { PageChrome, usePageScroll, type PageChromeBack } from '../../ui/chrome'
import { GlassSurface } from '../../ui/glass'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useActivity } from './useActivity'

export interface ActivityScreenProps {
  /** Open the chat a row came from, scrolled to that row's item. */
  onOpenBot?: (botName: string, options?: { focusItemId?: string }) => void
  /** Absent on a tab root — both shells mount this as one, so neither passes it. */
  back?: PageChromeBack
  /**
   * The wide shell's close (X): this screen has no `back` there, so its overlay
   * hands its own close in as the chrome's trailing action instead. Absent
   * everywhere else.
   */
  trailing?: ReactNode
}

interface DaySection {
  title: string
  data: ActivityEntry[]
}

const DAY_MS = 86_400_000

/** `Today`, `Yesterday`, `Tue 9 Sep` — the section heading over a day's rows. */
function dayLabel(atSeconds: number, now: number): string {
  const date = new Date(atSeconds * 1000)
  const midnight = new Date(now)

  midnight.setHours(0, 0, 0, 0)

  const start = midnight.getTime()

  if (date.getTime() >= start) {
    return strings.activity.today
  }

  if (date.getTime() >= start - DAY_MS) {
    return strings.activity.yesterday
  }

  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short' })
}

/** Newest day first, and newest row first inside it: a timeline is read backwards. */
function groupByDay(entries: readonly ActivityEntry[], now: number): DaySection[] {
  const sections: DaySection[] = []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (!entry) {
      continue
    }

    const title = dayLabel(entry.at, now)
    const last = sections[sections.length - 1]

    if (last?.title === title) {
      last.data.push(entry)
    } else {
      sections.push({ title, data: [entry] })
    }
  }

  return sections
}

export function ActivityScreen({ onOpenBot, back, trailing }: ActivityScreenProps) {
  const theme = useTheme()
  const { status } = useGateway()
  const { entries, counters, loading, refreshing, error, refresh } = useActivity()
  const byName = useBotsStore(state => state.byName)
  const [chromeHeight, setChromeHeight] = useState(0)

  const sections = useMemo(() => groupByDay(entries, Date.now()), [entries])

  const label = (handle: string): string => {
    const bot = byName[handle] ?? Object.values(byName).find(entry => entry.name.toLowerCase() === handle)

    return bot?.displayName ?? handle
  }

  return (
    <Screen padded={false}>
      <SectionList
        ref={directTouchPanRef}
        ListEmptyComponent={
          <EmptyState
            error={error}
            loading={loading}
            offline={status !== 'ready' && entries.length === 0 && !loading}
          />
        }
        ListHeaderComponent={<Header counters={counters} />}
        keyExtractor={entry => entry.id}
        // On the list, not on the screen: a spinner floating over the whole
        // screen lands on top of the header it was supposed to sit under.
        refreshControl={<RefreshControl onRefresh={() => void refresh()} refreshing={refreshing} />}
        renderItem={({ item }) => (
          <Row entry={item} label={label} onPress={() => onOpenBot?.(item.botName, { focusItemId: item.itemId })} />
        )}
        renderSectionHeader={({ section }) => (
          // The day label plus a rule, the same divider the crons list uses. It
          // is sticky, so it needs a background of its own: over glass a
          // transparent sticky header would let the rows scroll through it. A
          // `GlassSurface` at the same `panel` material as the page, rather than
          // a flat `elevation.e1` fill, is what stops it reading as an opaque
          // band painted at a depth nothing else on the screen uses (HERM-105).
          <GlassSurface
            contentStyle={{
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.md,
              paddingBottom: theme.space.xs,
              paddingHorizontal: theme.space.lg,
              paddingTop: theme.space.md
            }}
            contentTestID="activity-section-header"
            radius={0}
            shadow="none"
            variant="panel"
          >
            <Text color="textFaint" variant="micro">
              {section.title.toUpperCase()}
            </Text>
            <View style={{ backgroundColor: theme.hairlineSoft, flex: 1, height: 1 }} />
          </GlassSurface>
        )}
        sections={sections}
        stickySectionHeadersEnabled
        testID="activity-list"
        {...usePageScroll(chromeHeight)}
      />

      <PageChrome back={back} onHeightChange={setChromeHeight} title={strings.activity.title} trailing={trailing} />
    </Screen>
  )
}

function Header({ counters }: { counters: ReturnType<typeof useActivity>['counters'] }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.md, paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm }}>
      {/* `PageChrome` already names this screen, floating over the list. */}
      <Text color="textMuted" variant="preview">
        {strings.activity.subtitle}
      </Text>

      {/*
        Three glass chips, not three big numerals with captions under them. The
        numerals were 22pt — larger than the screen's own rows — so a page whose
        whole point is the timeline led with a dashboard. A chip is the level-3
        tint §3 already uses for a count, it is static, and it reads as status
        rather than as a headline.
      */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Counter
          label={strings.activity.counters.working}
          testID="activity-count-working"
          value={counters.botsWorking}
        />
        <Counter
          label={strings.activity.counters.subagents}
          testID="activity-count-subagents"
          value={counters.activeSubagents}
        />
        <Counter
          label={strings.activity.counters.deliveries}
          testID="activity-count-deliveries"
          value={counters.inFlightDeliveries}
        />
      </View>
    </View>
  )
}

function Counter({ label, value, testID }: { label: string; value: number; testID: string }) {
  const theme = useTheme()

  return (
    <GlassSurface
      contentStyle={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: 5,
        paddingHorizontal: theme.space.md,
        paddingVertical: 6
      }}
      radius={theme.radii.pill}
      variant="chip"
    >
      <Text
        color={value > 0 ? 'accentText' : 'textMuted'}
        style={{ fontSize: 13, fontWeight: '700', lineHeight: 17 }}
        testID={testID}
      >
        {String(value)}
      </Text>
      <Text color="textMuted" style={{ fontSize: 13, lineHeight: 17 }}>
        {label}
      </Text>
    </GlassSurface>
  )
}

/**
 * One line of traffic, in the transcript's ledger language (§6.4).
 *
 * Deliberately the same silhouette as a `LedgerRow`: a 20pt glyph well on the
 * left, the sentence in `meta` at 600, a clock at the right edge, and the body
 * indented under it so the column of glyphs is unbroken. It is not that
 * component, because that one is a DISCLOSURE — its chevron and its
 * `expanded` state both promise the row opens in place, and these rows navigate.
 * Saying so here is cheaper than a second mode on a shared component.
 *
 * The heading is the sentence (`researcher → writer`), the body is what was
 * actually said. A delegation has no recipient, so it reads `researcher spawned
 * 3 agents` instead.
 */
function Row({
  entry,
  label,
  onPress
}: {
  entry: ActivityEntry
  label: (handle: string) => string
  onPress: () => void
}) {
  const theme = useTheme()

  const heading =
    entry.kind === 'delegation'
      ? strings.activity.spawned(label(entry.fromHandle), entry.agentCount ?? 0)
      : entry.kind === 'dm_reply'
        ? strings.activity.reply(label(entry.fromHandle), label(entry.toHandle ?? ''))
        : strings.activity.to(label(entry.fromHandle), label(entry.toHandle ?? ''))

  // A delegation has its own wording; everything else, including a status this
  // build has never seen, still arrives as words rather than as an identifier.
  const status =
    (entry.kind === 'delegation' ? strings.activity.groupStatus[entry.status ?? ''] : undefined) ??
    humaniseStatus(entry.status)

  return (
    <Pressable
      accessibilityHint={strings.activity.openChat(label(entry.botName))}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
        gap: 3,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.sm + 2
      })}
      testID={`activity-row-${entry.id}`}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <View
          style={{
            alignItems: 'center',
            backgroundColor: theme.tintSunk,
            borderRadius: theme.radii.sm + 2,
            height: 20,
            justifyContent: 'center',
            width: 20
          }}
        >
          <Text color={entry.failed ? 'dangerText' : 'textFaint'} style={{ fontSize: 11, lineHeight: 14 }}>
            {entry.kind === 'delegation' ? '⑃' : '→'}
          </Text>
        </View>

        <Text color="text" numberOfLines={1} style={{ flex: 1, fontWeight: '600' }} variant="meta">
          {heading}
        </Text>

        {entry.at ? (
          <Text color="textFaint" variant="meta">
            {formatClock(entry.at)}
          </Text>
        ) : null}
      </View>

      {/* Indented past the glyph well, so the column of glyphs stays a column. */}
      {entry.text ? (
        <Text color="textMuted" numberOfLines={2} style={{ marginLeft: 20 + theme.space.sm }} variant="preview">
          {entry.text}
        </Text>
      ) : null}

      {status ? (
        <Text
          color={entry.failed ? 'dangerText' : entry.pending ? 'accentText' : 'textFaint'}
          style={{ marginLeft: 20 + theme.space.sm }}
          testID={`activity-status-${entry.id}`}
          variant="micro"
        >
          {status.toUpperCase()}
        </Text>
      ) : null}
    </Pressable>
  )
}

function EmptyState({ loading, error, offline }: { loading: boolean; error: string | null; offline: boolean }) {
  const theme = useTheme()

  const message = error
    ? strings.activity.failed(error)
    : loading
      ? strings.activity.loading
      : offline
        ? strings.activity.emptyOffline
        : strings.activity.empty

  return (
    <View style={{ padding: theme.space.lg }}>
      <Text color={error ? 'dangerText' : 'textMuted'} testID="activity-empty">
        {message}
      </Text>
    </View>
  )
}
