/**
 * Crons: the list, and the stack that hangs off it.
 *
 * NAVIGATION. This is one screen with early-return sub-screens, the same shape
 * Settings uses for its connection test and gallery. It is not a navigator on
 * purpose: the compact and regular shells own their own navigation and disagree
 * about what "push" means, and a feature that carries its own three-deep stack
 * works identically in both.
 *
 * The list itself is the HTTP `GET /api/cron/jobs?profile=all` answer, split
 * into Active and Paused, and it spans every profile — see the controller for
 * why the socket cannot do that. Its banner is the one thing on the screen that
 * is not about a single job: `gateway_running === false` means the scheduler
 * process is down, and every cron below is then a plan rather than a promise.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, RefreshControl, SectionList, View } from 'react-native'

import { ContextMenuHost } from '../../platform/context-menu'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useBotsStore } from '../../store/bots'
import { useCronStore } from '../../store/cron'
import { BottomSheet, SheetEyebrow } from '../../ui/BottomSheet'
import { PageChrome, usePageScroll, type PageChromeBack } from '../../ui/chrome'
import { Button, Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT, withAlpha } from '../../ui/tokens'
import type { CronJobInput } from './cron-controller'
import { CronDetailScreen } from './CronDetailScreen'
import { CronEditorSheet } from './CronEditorSheet'
import { CronRunScreen } from './CronRunScreen'
import {
  type CronJob,
  cronJobFor,
  type CronRun,
  cronRowWhen,
  cronStatusOf,
  lastErrorSummary,
  scheduleText
} from './model'
import { StatusDot } from './StatusDot'
import { cronStrings } from './strings'
import { useCronController } from './useCron'

type CronView =
  { screen: 'list' } | { screen: 'detail'; jobId: string } | { screen: 'run'; jobId: string; run: CronRun }

export interface CronScreenProps {
  /**
   * Open this job's detail instead of the list.
   *
   * How a cron card in a transcript lands on its own cron (§6.5). It is a job
   * ID rather than a name because the name is what was ambiguous in the first
   * place: two profiles may hold a cron called the same thing, and the resolving
   * is done by whoever had both the name and the profile — see `ChatScreen`.
   */
  initialJobId?: string
  /**
   * Open the editor on an empty job, straight away.
   *
   * What the `+` in the chats list means. That button is labelled New cron;
   * until this it navigated here and left the reader to find the same `+`
   * again at the bottom of the list.
   */
  initialCreate?: boolean
  /** Absent on a tab root — both shells mount this as one, so neither passes it. */
  back?: PageChromeBack
  /**
   * This mount is ONE cron, not the list with a cron open on top of it.
   *
   * What a cron card in a transcript pushes. The reader came from a chat and
   * `back` returns to that chat, so there is no list underneath to close the
   * detail onto — and a detail that could close onto one would leave them on a
   * crons list they never asked for, with a back button pointing at a chat.
   * Needs `initialJobId`; without one there is nothing to show.
   */
  detailOnly?: boolean
  /**
   * The wide shell's close (X): the list root has no `back` there, so its
   * overlay hands its own close in as the chrome's trailing action instead.
   * Only the list draws it — the detail and run screens below already have a
   * `back` of their own. Absent everywhere else.
   */
  trailing?: ReactNode
}

export function CronScreen({ back, detailOnly = false, initialCreate, initialJobId, trailing }: CronScreenProps = {}) {
  const controller = useCronController()
  const jobs = useCronStore(state => state.jobs)
  const loading = useCronStore(state => state.loading)
  const error = useCronStore(state => state.error)
  const gatewayRunning = useCronStore(state => state.gatewayRunning)
  const targets = useCronStore(state => state.deliveryTargets)
  const [chromeHeight, setChromeHeight] = useState(0)
  // Called unconditionally, ahead of the early returns below (rules-of-hooks) —
  // only the list root's own SectionList spreads what it returns.
  const pageScroll = usePageScroll(chromeHeight)
  const bots = useBotsStore(state => state.bots)

  // The roster IS the profile list — a bot is a Hermes profile — and a gateway
  // that serves one of them gets no picker rather than a picker with one option.
  const profiles = useMemo(() => (bots.length > 1 ? bots.map(bot => bot.name) : []), [bots])

  const [view, setView] = useState<CronView>(
    initialJobId ? { screen: 'detail', jobId: initialJobId } : { screen: 'list' }
  )
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState<{ open: boolean; job: CronJob | null }>({
    open: initialCreate === true && !initialJobId,
    job: null
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The one thing a row's menu cannot do by itself: two of its four lines have
  // consequences on the gateway, so they ask first. One piece of state for both,
  // because two sheets at once is not a state this screen can be in.
  const [confirming, setConfirming] = useState<{ kind: 'run' | 'delete'; job: CronJob } | null>(null)

  // The initial state covers the wide layout, where this screen is mounted with
  // the overlay and dropped with it. On the phone the route is already in the
  // stack, so a second `navigate` only changes the parameter — this is what
  // makes that land on the detail rather than on whatever page was last open.
  useEffect(() => {
    if (initialJobId) {
      setView({ screen: 'detail', jobId: initialJobId })
    }
  }, [initialJobId])

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await controller?.refresh()
    } catch {
      // The store holds the message; the list keeps the rows it had.
    } finally {
      setRefreshing(false)
    }
  }, [controller])

  const save = useCallback(
    async (input: CronJobInput) => {
      setSaving(true)
      setSaveError(null)

      try {
        if (editing.job) {
          await controller?.update(editing.job, input)
        } else {
          await controller?.create(input)
        }

        setEditing({ open: false, job: null })
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    },
    [controller, editing.job]
  )

  /**
   * A cron row's menu, in one place.
   *
   * Pause and Resume go straight through: they are reversible by the same menu
   * line, and the row's own status dot reports the outcome. Run now and Delete ask
   * first — see `ConfirmSheet`.
   */
  const onRowMenu = useCallback(
    (job: CronJob, id: string) => {
      switch (id) {
        case 'pause':
          void controller?.pause(job).catch(() => undefined)

          return

        case 'resume':
          void controller?.resume(job).catch(() => undefined)

          return

        case 'edit':
          setSaveError(null)
          setEditing({ open: true, job })

          return

        case 'run':
        case 'delete':
          setConfirming({ job, kind: id })

          return

        default:
          return
      }
    },
    [controller]
  )

  // The two headers, read here and depended on by name: `jobs` does not move on
  // a settled gateway, so a memo that only watched it would keep ACTIVE and
  // PAUSED in whatever language they were first built in.
  const activeTitle = cronStrings.sections.active
  const pausedTitle = cronStrings.sections.paused

  const sections = useMemo(() => {
    const active = jobs.filter(job => cronStatusOf(job) !== 'paused')
    const paused = jobs.filter(job => cronStatusOf(job) === 'paused')

    return [
      ...(active.length ? [{ title: activeTitle, data: active }] : []),
      ...(paused.length ? [{ title: pausedTitle, data: paused }] : [])
    ]
  }, [activeTitle, jobs, pausedTitle])

  // The REST list tags EVERY row with its store, so on a single-profile gateway
  // each one would read "Profile: default" — a column of the same word. It is
  // shown only where it tells two rows apart.
  const showProfiles = useMemo(() => new Set(jobs.map(job => job.profile)).size > 1, [jobs])

  const selected = view.screen === 'list' ? null : cronJobFor(jobs, view.jobId)

  // Escape and Android back, one level at a time, used to be wired HERE — a
  // handler shared by both sub-screens that could not tell PageChrome's own
  // back apart from a page that forgot one. Each of `CronDetailScreen` and
  // `CronRunScreen` now carries its own `PageChrome`, which registers both by
  // itself off the same `back.onPress` this file already hands it below,
  // so a second registration here would only double up the stack.

  if (view.screen === 'run' && selected) {
    return (
      <CronRunScreen
        controller={controller}
        job={selected}
        onClose={() => setView({ screen: 'detail', jobId: selected.id })}
        run={view.run}
      />
    )
  }

  if (view.screen !== 'list' && selected) {
    /*
      Where the detail's own back goes. On the list mount it goes to the list,
      which is the page under it; on a `detailOnly` mount there is no such page
      and the shell's `back` — the chat the card was in — is the only way out.
    */
    const closeDetail =
      detailOnly && back ? back : { label: cronStrings.title, onPress: () => setView({ screen: 'list' }) }

    return (
      <>
        <CronDetailScreen
          backLabel={closeDetail.label}
          controller={controller}
          job={selected}
          onClose={closeDetail.onPress}
          onDeleted={closeDetail.onPress}
          onEdit={job => {
            setSaveError(null)
            setEditing({ open: true, job })
          }}
          onOpenRun={run => setView({ screen: 'run', jobId: selected.id, run })}
        />
        <CronEditorSheet
          error={saveError}
          job={editing.job}
          onCancel={() => setEditing({ open: false, job: null })}
          onSave={input => void save(input)}
          profiles={profiles}
          saving={saving}
          targets={targets}
          visible={editing.open}
        />
      </>
    )
  }

  return (
    <Screen padded={false}>
      <SectionList
        ref={directTouchPanRef}
        ListEmptyComponent={<EmptyState error={error} loading={loading} />}
        ListHeaderComponent={
          <ListHeader gatewayRunning={gatewayRunning} onCreate={() => setEditing({ open: true, job: null })} />
        }
        keyExtractor={job => job.id}
        refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
        renderItem={({ item }) => (
          <RoutineRow
            job={item}
            onMenuSelect={onRowMenu}
            onPress={() => setView({ screen: 'detail', jobId: item.id })}
            showProfile={showProfiles}
          />
        )}
        renderSectionHeader={({ section }) => <SectionDivider title={section.title} />}
        sections={sections}
        stickySectionHeadersEnabled={false}
        testID="cron-list"
        {...pageScroll}
      />

      <CronEditorSheet
        error={saveError}
        job={editing.job}
        onCancel={() => setEditing({ open: false, job: null })}
        onSave={input => void save(input)}
        profiles={profiles}
        saving={saving}
        targets={targets}
        visible={editing.open}
      />

      <ConfirmSheet
        confirming={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const pending = confirming

          setConfirming(null)

          if (!pending) {
            return
          }

          void (pending.kind === 'run' ? controller?.runNow(pending.job) : controller?.remove(pending.job))?.catch(
            () => {
              // The controller already put the reason in the store, and the list
              // shows it; a second report on top of the sheet that just closed
              // would land on nothing.
            }
          )
        }}
      />

      <PageChrome back={back} onHeightChange={setChromeHeight} title={cronStrings.title} trailing={trailing} />
    </Screen>
  )
}

/**
 * Run now and Delete, asked before they happen.
 *
 * One component for both because the two sheets differ only in their words: the
 * shape is an eyebrow, a question, the consequence in one sentence, and two
 * buttons with the dangerous one first — which is the shape the detail screen's
 * delete confirmation already had. Dismissing it — backdrop, Escape, a drag —
 * is the same as Cancel, which is the only safe reading of "the reader made it
 * go away".
 */
function ConfirmSheet({
  confirming,
  onCancel,
  onConfirm
}: {
  confirming: { kind: 'run' | 'delete'; job: CronJob } | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const theme = useTheme()
  const words = confirming?.kind === 'run' ? cronStrings.confirmRun : cronStrings.confirmDelete
  const name = confirming?.job.name ?? ''

  return (
    <BottomSheet
      accessibilityLabel={words.title(name)}
      onRequestClose={onCancel}
      testID="cron-row-confirm-sheet"
      visible={confirming !== null}
    >
      <View style={{ gap: theme.space.md }}>
        <SheetEyebrow>{words.eyebrow}</SheetEyebrow>
        <Text variant="sheetTitle">{words.title(name)}</Text>
        <Text color="textMuted">{words.body}</Text>
        <Button
          onPress={onConfirm}
          testID="cron-row-confirm"
          title={words.confirm}
          variant={confirming?.kind === 'delete' ? 'danger' : 'primary'}
        />
        <Button onPress={onCancel} title={words.cancel} variant="secondary" />
      </View>
    </BottomSheet>
  )
}

/**
 * §6.11's `.divider`: the label, then a hairline that runs to the edge.
 *
 * A bare capitalised word was doing the job of a section break on its own, which
 * on a list of six rows read as another row. The rule is what makes `Paused` a
 * boundary rather than a caption.
 */
function SectionDivider({ title }: { title: string }) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.md,
        paddingBottom: theme.space.xs,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.lg
      }}
    >
      <Text color="textFaint" variant="micro">
        {title}
      </Text>
      <View style={{ backgroundColor: theme.hairlineSoft, flex: 1, height: 1 }} />
    </View>
  )
}

function ListHeader({ gatewayRunning, onCreate }: { gatewayRunning: boolean | null; onCreate: () => void }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm, paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm }}>
      {/*
        No title here: `PageChrome` already draws "Crons" in its own header,
        floating over this list — printing it again here would say the
        screen's own name twice in two sizes, the same stutter the cron
        editor's eyebrow had.
      */}
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
        <Text color="textMuted" style={{ flex: 1 }} variant="preview">
          {cronStrings.subtitle}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cronStrings.list.add}
          onPress={onCreate}
          style={{
            backgroundColor: theme.elevation.e2,
            borderRadius: theme.radii.pill,
            justifyContent: 'center',
            minHeight: CONTROL_MIN_HEIGHT,
            paddingHorizontal: theme.space.lg
          }}
          testID="cron-create"
        >
          <Text color="accentText" variant="preview">
            {`+ ${cronStrings.list.add}`}
          </Text>
        </Pressable>
      </View>

      {/*
        The one thing on the screen that is not about a single job, so it is the
        one thing painted in the danger tint: every row below it is a plan rather
        than a promise while the scheduler is down.
      */}
      {gatewayRunning === false ? (
        <View
          style={{
            alignItems: 'center',
            backgroundColor: theme.dangerSoft,
            borderColor: withAlpha(theme.colors.danger, 0.34),
            borderRadius: theme.radii.card,
            borderWidth: 1,
            flexDirection: 'row',
            gap: theme.space.sm,
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.md
          }}
          testID="cron-gateway-banner"
        >
          <Text color="dangerText" style={{ fontSize: 15 }}>
            {'!'}
          </Text>
          <Text color="dangerText" style={{ flex: 1 }} variant="preview">
            {cronStrings.gatewayBanner}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

function EmptyState({ loading, error }: { loading: boolean; error: string | null }) {
  const theme = useTheme()

  return (
    <View style={{ padding: theme.space.lg }}>
      <Text color={error ? 'dangerText' : 'textMuted'}>
        {error ? cronStrings.list.failed(error) : loading ? cronStrings.list.loading : cronStrings.list.empty}
      </Text>
    </View>
  )
}

/**
 * One cron, as §6.11's `.cronrow`.
 *
 * Three columns rather than four stacked lines: a static status dot, the
 * identity (name over "Every day at 04:22 · Researcher"), and a right-aligned
 * pair that says WHEN — a micro label over a relative time. The four-line
 * version printed the schedule, the delivery target, the profile and the next
 * run each on its own row, which made a list of five crons forty lines long and
 * gave a reader no way to scan one column.
 *
 * `next_run_at` is shown as a relative phrase on purpose: the scheduler's
 * timezone is not the phone's (see `relativeTime`). Which label wins — NEXT,
 * LAST, or NEXT overdue — is `cronRowWhen` (HERM-109), not this component: a
 * paused row that still carries a stale `next_run_at` must not read "NEXT 14h
 * ago", and an active row whose next run has slipped into the past says so in
 * one word rather than the same confusing phrase.
 */
function RoutineRow({
  job,
  onMenuSelect,
  onPress,
  showProfile
}: {
  job: CronJob
  onMenuSelect: (job: CronJob, id: string) => void
  onPress: () => void
  showProfile: boolean
}) {
  const theme = useTheme()
  const status = cronStatusOf(job)
  const paused = status === 'paused'
  const summary = lastErrorSummary(job.lastError)

  // Two profiles may hold a cron of the same name, so the name alone does not
  // identify the row to somebody reading it out.
  const owner = showProfile && job.profile ? job.profile : null
  const label = owner ? `${job.name}, ${cronStrings.list.profile(owner)}` : job.name

  const when = cronRowWhen(job)

  const menu = [
    paused
      ? { id: 'resume', title: cronStrings.detail.resume, systemImage: 'play' }
      : { id: 'pause', title: cronStrings.detail.pause, systemImage: 'pause' },
    // The ellipsis is the platform's own promise that a line asks before it acts.
    { id: 'run', title: `${cronStrings.detail.runNow}…`, systemImage: 'bolt' },
    { id: 'edit', title: cronStrings.detail.edit, systemImage: 'pencil' },
    { id: 'delete', title: `${cronStrings.detail.delete}…`, systemImage: 'trash', destructive: true }
  ]

  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ cursor: 'pointer' }}
      testID={`cron-row-${job.id}`}
    >
      {({ pressed }) => (
        <View
          style={{
            alignItems: 'center',
            backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
            flexDirection: 'row',
            gap: theme.space.md,
            // A paused cron is dimmed, not greyed out: it is still a cron, and
            // the colour it would have to lose to read as disabled is the one
            // its status dot needs.
            opacity: paused ? 0.68 : 1,
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.md
          }}
        >
          <StatusDot status={status} />

          <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', lineHeight: 21 }}>
              {job.name}
            </Text>

            <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
              <Text color="textMuted" numberOfLines={1} style={{ flexShrink: 1 }} variant="meta">
                {[scheduleText(job.schedule), job.deliver ? `@${job.deliver}` : ''].filter(Boolean).join(' · ')}
              </Text>

              {/* Only where it tells two rows apart — see `showProfiles`. */}
              {owner ? (
                <Text
                  color="textFaint"
                  style={{
                    backgroundColor: theme.elevation.e2,
                    borderRadius: theme.radii.sm + 2,
                    overflow: 'hidden',
                    paddingHorizontal: 6
                  }}
                  testID={`cron-profile-${job.id}`}
                  variant="micro"
                >
                  {owner}
                </Text>
              ) : null}
            </View>

            {summary ? (
              <Text color="dangerText" numberOfLines={2} testID={`cron-error-${job.id}`} variant="meta">
                {summary}
              </Text>
            ) : null}
          </View>

          <View style={{ alignItems: 'flex-end', flexShrink: 0, gap: 1 }}>
            <Text color="textFaint" variant="micro">
              {when.label.toUpperCase()}
            </Text>
            <Text color="textMuted" variant="meta">
              {when.value}
            </Text>
          </View>
        </View>
      )}
    </Pressable>
  )

  return (
    <ContextMenuHost
      items={menu}
      menuTitle={job.name}
      onSelect={id => onMenuSelect(job, id)}
      testID={`cron-row-menu-${job.id}`}
    >
      {row}
    </ContextMenuHost>
  )
}
