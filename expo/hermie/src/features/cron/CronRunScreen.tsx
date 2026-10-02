/**
 * One routine run, read-only.
 *
 * A run is an ordinary session — `cron_{job_id}_{timestamp}` — so it is read
 * with `session.history` and rendered through exactly the same pipeline as a
 * chat: `rowsToItems` → `visibleItems` → `TranscriptList`. That is the point of
 * the shared engine, and it is why a tool call in a routine run looks like a
 * tool call in a conversation.
 *
 * What it does not get is a composer. A cron session has no live agent behind
 * it; there is nothing to send a prompt to.
 */
import { createChatState, rowsToItems, visibleItems, type ChatState, type VisibleItem } from '@hermie/transcript'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'

import { TranscriptList } from '../../chat-ui'
import { PageChrome } from '../../ui/chrome'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { CronController } from './cron-controller'
import type { CronJob, CronRun } from './model'
import { relativeEpoch } from './model'
import { cronStrings } from './strings'

export interface CronRunScreenProps {
  controller: CronController | null
  job: CronJob
  run: CronRun
  onClose: () => void
}

export function CronRunScreen({ controller, job, run, onClose }: CronRunScreenProps) {
  const theme = useTheme()
  const [items, setItems] = useState<VisibleItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chromeHeight, setChromeHeight] = useState(0)

  const load = useCallback(async () => {
    if (!controller) {
      return
    }

    setError(null)

    try {
      const rows = await controller.loadRunTranscript(run.id, job.profile)

      setItems(visibleItems(stateFromRows(run.id, rows), { level: 'normal', showBotToBot: true, showThinking: false }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setItems([])
    }
  }, [controller, job.profile, run.id])

  useEffect(() => {
    void load()
  }, [load])

  const started = relativeEpoch(run.startedAt ?? run.lastActive)
  const title = run.title || cronStrings.run.title
  // A run session is TITLED with its job's name, so printing the job under it
  // said the same words twice in two sizes — the stutter the crons list and
  // Activity were already cured of. The subtitle earns its line only where the
  // run calls itself something else.
  const subtitle = [title === job.name ? '' : job.name, started].filter(Boolean).join(' · ')

  return (
    <Screen padded={false}>
      <Text
        color="textMuted"
        variant="meta"
        style={{ paddingHorizontal: theme.space.lg, paddingTop: chromeHeight + theme.space.sm }}
      >
        {cronStrings.run.readOnly}
      </Text>

      {items === null ? (
        <View style={{ alignItems: 'center', gap: theme.space.sm, padding: theme.space.xl }}>
          <ActivityIndicator />
          <Text color="textMuted">{cronStrings.run.loading}</Text>
        </View>
      ) : error ? (
        <View style={{ padding: theme.space.lg }}>
          <Text color="dangerText">{cronStrings.run.failed(error)}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={{ padding: theme.space.lg }}>
          <Text color="textMuted">{cronStrings.run.empty}</Text>
        </View>
      ) : (
        <TranscriptList items={items} testID="cron-run-transcript" />
      )}

      <PageChrome
        back={{ label: job.name, onPress: onClose }}
        onHeightChange={setChromeHeight}
        subtitle={subtitle}
        title={title}
      />
    </Screen>
  )
}

/**
 * A paintable state from history rows.
 *
 * Only `items` and `order` are filled: the indexes exist so live events can
 * find the row they amend, and nothing is ever going to amend this one.
 */
function stateFromRows(runId: string, rows: Parameters<typeof rowsToItems>[0]): ChatState {
  const state = createChatState('', runId, runId)

  for (const item of rowsToItems(rows, 'rpc')) {
    state.items[item.id] = item
    state.order.push(item.id)
  }

  return state
}
