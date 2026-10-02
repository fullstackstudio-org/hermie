/**
 * One routine.
 *
 * The design board's "contact card": what it does, when it next runs, the
 * actions, and the run history under it. Everything on it is the gateway's
 * answer — in particular `next_run_at`, which is shown as the server sent it
 * rather than recomputed from the schedule string, because the scheduler owns
 * the timezone and the DST rules.
 *
 * The full prompt only exists on the HTTP detail read, so the screen fires that
 * on mount and paints the list row's preview until it lands.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { prettyModelName } from '@hermie/transcript'

import { humaniseStatus } from '../../i18n/humanise'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { BottomSheet, SheetEyebrow } from '../../ui/BottomSheet'
import { PageChrome, usePageScroll } from '../../ui/chrome'
import { Button, InsetGroup, InsetRow, InsetValueRow, Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { CronController } from './cron-controller'
import { useCronStore } from '../../store/cron'
import { StatusDot } from './StatusDot'
import {
  type CronJob,
  type CronRun,
  cronStatusLabel,
  cronStatusOf,
  lastErrorSummary,
  relativeEpoch,
  relativeTime,
  scheduleText
} from './model'
import { cronStrings } from './strings'

export interface CronDetailScreenProps {
  controller: CronController | null
  job: CronJob
  /**
   * What the page's one back control says, when it is not the crons list.
   *
   * The list is the usual page underneath, so the label defaults to it. A cron
   * opened straight from a card in a transcript has no list underneath: the
   * chat is what `onClose` returns to, and the button has to say so.
   */
  backLabel?: string
  onClose: () => void
  onOpenRun: (run: CronRun) => void
  onEdit: (job: CronJob) => void
  /** Called after a successful delete, so the list can take the screen back. */
  onDeleted: () => void
}

export function CronDetailScreen({
  controller,
  job,
  backLabel,
  onClose,
  onOpenRun,
  onEdit,
  onDeleted
}: CronDetailScreenProps) {
  const theme = useTheme()
  const detail = useCronStore(state => state.details[job.id]) ?? job
  const runs = useCronStore(state => state.runs[job.id])
  const busy = useCronStore(state => Boolean(state.busy[job.id]))
  const [runsError, setRunsError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [chromeHeight, setChromeHeight] = useState(0)

  const load = useCallback(async () => {
    if (!controller) {
      return
    }

    setRunsError(null)

    await Promise.all([
      controller.loadDetail(job).catch(() => undefined),
      controller.loadRuns(job).catch((error: unknown) => {
        setRunsError(error instanceof Error ? error.message : String(error))
      })
    ])
  }, [controller, job])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const status = cronStatusOf(detail)
  const paused = status === 'paused'
  const nextRun = relativeTime(detail.nextRunAt)
  const lastRun = relativeTime(detail.lastRunAt)
  const error = lastErrorSummary(detail.lastError)

  const pageScroll = usePageScroll(chromeHeight)

  return (
    <Screen padded={false}>
      <ScrollView
        ref={directTouchPanRef}
        refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
        {...pageScroll}
        contentContainerStyle={[{ gap: theme.space.xl, padding: theme.space.lg }, pageScroll.contentContainerStyle]}
      >
        <View
          style={{
            backgroundColor: theme.elevation.e3c,
            borderColor: theme.hairlineSoft,
            borderRadius: theme.radii.card,
            borderWidth: 1,
            gap: theme.space.xs,
            padding: theme.space.lg
          }}
          testID="cron-detail-summary"
        >
          <SheetEyebrow>{cronStrings.detail.nextRun}</SheetEyebrow>
          <Text variant="sheetTitle">{nextRun ?? cronStrings.list.noNextRun}</Text>
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
            <StatusDot status={status} />
            <Text color="textMuted" variant="preview">
              {cronStatusLabel(status)}
            </Text>
          </View>
          {error ? (
            <Text color="dangerText" variant="meta" testID="cron-detail-error">
              {error}
            </Text>
          ) : null}
        </View>

        {/*
          The prompt goes in a sunk well. It is the text a bot is handed verbatim,
          so it reads as an input rather than as prose the screen wrote — the
          same treatment the approval sheet gives a command.
        */}
        <View style={{ gap: theme.space.sm }}>
          <Text color="textFaint" variant="micro">
            {cronStrings.detail.instructions.toUpperCase()}
          </Text>
          <View
            style={{
              backgroundColor: theme.tintSunk,
              borderColor: theme.hairlineSoft,
              borderRadius: theme.radii.inset,
              borderWidth: 1,
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.md
            }}
          >
            <Text color="text" selectable testID="cron-detail-prompt" variant="preview">
              {detail.prompt || detail.promptPreview || cronStrings.detail.noPrompt}
            </Text>
          </View>
        </View>

        <InsetGroup header={cronStrings.detail.details.toUpperCase()}>
          <InsetValueRow
            label={cronStrings.detail.scheduleLabel}
            value={detail.schedule || cronStrings.detail.unknown}
          />
          <InsetValueRow label={cronStrings.detail.deliverLabel} value={detail.deliver || cronStrings.detail.unknown} />
          <InsetValueRow
            label={cronStrings.detail.repeatLabel}
            value={detail.repeat === null ? cronStrings.detail.repeatForever : String(detail.repeat)}
          />
          <InsetValueRow label={cronStrings.detail.lastRunLabel} value={lastRun ?? cronStrings.list.neverRun} />
          <InsetValueRow
            label={cronStrings.detail.lastStatusLabel}
            // The gateway's own word, made readable. Printing `ok` two rows
            // under a humanised `Success` read as two different facts.
            value={humaniseStatus(detail.lastStatus) ?? cronStrings.detail.unknown}
          />
          {detail.model ? (
            <InsetValueRow label={cronStrings.detail.modelLabel} value={prettyModelName(detail.model)} />
          ) : null}
          {detail.skills.length ? (
            <InsetValueRow label={cronStrings.detail.skillsLabel} value={detail.skills.join(', ')} />
          ) : null}
          {detail.pausedReason ? (
            <InsetValueRow label={cronStrings.detail.pausedReasonLabel} value={detail.pausedReason} />
          ) : null}
        </InsetGroup>

        {/*
          One primary, then the two that change the job side by side, then the
          destructive one alone. Four full-width buttons in a column gave Delete
          the same weight as Run now and put it under the reader's thumb.
        */}
        <View style={{ gap: theme.space.sm }}>
          <Button
            busy={busy}
            onPress={() => void controller?.runNow(job).catch(() => undefined)}
            testID="cron-run-now"
            title={busy ? cronStrings.detail.running : cronStrings.detail.runNow}
          />
          <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
            <Button
              disabled={busy}
              onPress={() => void (paused ? controller?.resume(job) : controller?.pause(job))?.catch(() => undefined)}
              style={{ flex: 1 }}
              testID="cron-toggle-pause"
              title={paused ? cronStrings.detail.resume : cronStrings.detail.pause}
              variant="secondary"
            />
            <Button
              disabled={busy}
              onPress={() => onEdit(detail)}
              style={{ flex: 1 }}
              testID="cron-edit"
              title={cronStrings.detail.edit}
              variant="secondary"
            />
          </View>
          <Button
            disabled={busy}
            onPress={() => setConfirmingDelete(true)}
            testID="cron-delete"
            title={cronStrings.detail.delete}
            variant="danger"
          />
        </View>

        <View style={{ gap: theme.space.sm }}>
          <Text color="textFaint" variant="micro">
            {cronStrings.detail.runHistory}
          </Text>

          {runsError ? (
            <Text color="dangerText" variant="meta">
              {cronStrings.detail.runsFailed(runsError)}
            </Text>
          ) : runs === undefined ? (
            <View style={{ alignItems: 'flex-start', gap: theme.space.sm }}>
              <ActivityIndicator />
              <Text color="textMuted" variant="meta">
                {cronStrings.detail.loadingRuns}
              </Text>
            </View>
          ) : runs.length === 0 ? (
            <Text color="textMuted">{cronStrings.detail.noRuns}</Text>
          ) : (
            <InsetGroup>
              {runs.map(run => (
                <RunRow key={run.id} onPress={() => onOpenRun(run)} run={run} />
              ))}
            </InsetGroup>
          )}
        </View>
      </ScrollView>

      <BottomSheet
        accessibilityLabel={cronStrings.confirmDelete.title(detail.name)}
        onRequestClose={() => setConfirmingDelete(false)}
        testID="cron-delete-sheet"
        visible={confirmingDelete}
      >
        <View style={{ gap: theme.space.md }}>
          <SheetEyebrow>{cronStrings.confirmDelete.eyebrow}</SheetEyebrow>
          <Text variant="sheetTitle">{cronStrings.confirmDelete.title(detail.name)}</Text>
          <Text color="textMuted">{cronStrings.confirmDelete.body}</Text>
          <Button
            onPress={() => {
              setConfirmingDelete(false)
              void controller
                ?.remove(job)
                .then(onDeleted)
                .catch(() => undefined)
            }}
            testID="cron-delete-confirm"
            title={cronStrings.confirmDelete.confirm}
            variant="danger"
          />
          <Button
            onPress={() => setConfirmingDelete(false)}
            title={cronStrings.confirmDelete.cancel}
            variant="secondary"
          />
        </View>
      </BottomSheet>

      <PageChrome
        back={{ label: backLabel ?? cronStrings.title, onPress: onClose }}
        onHeightChange={setChromeHeight}
        subtitle={scheduleText(detail.schedule)}
        title={detail.name}
      />
    </Screen>
  )
}

function RunRow({ run, onPress }: { run: CronRun; onPress: () => void }) {
  const theme = useTheme()
  const started = relativeEpoch(run.startedAt ?? run.lastActive)
  const ok = !run.status || /ok|success|completed|done|idle/i.test(run.status)

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={run.title || run.id} onPress={onPress}>
      {({ pressed }) => (
        <InsetRow style={{ backgroundColor: pressed ? theme.elevation.e2 : 'transparent' }}>
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
            {/* The same static dot the list rows carry, so a run reads as a run. */}
            <StatusDot size={8} status={ok ? 'ok' : 'failed'} />
            <Text numberOfLines={1} style={{ flex: 1 }} variant="preview">
              {started ?? run.id}
            </Text>
            <Text color={ok ? 'okText' : 'dangerText'} variant="meta">
              {humaniseStatus(run.status) ?? cronStrings.status.ok}
            </Text>
          </View>
          {run.preview ? (
            <Text color="textMuted" numberOfLines={1} variant="meta">
              {run.preview}
            </Text>
          ) : null}
        </InsetRow>
      )}
    </Pressable>
  )
}
