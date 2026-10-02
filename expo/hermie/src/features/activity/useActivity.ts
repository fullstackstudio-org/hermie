/**
 * The Activity screen's data.
 *
 * Everything the timeline shows is DERIVED from the chat store — the same
 * `ChatState`s the chat screens read — so a bot's traffic appears here and in
 * its chat as one set of items with one set of ids. That is what makes tapping
 * a row able to scroll to the exact message rather than to a copy of it.
 *
 * The screen's own work is therefore only two things: make sure the store
 * actually holds something for every bot (the background load), and keep the
 * three header counters fresh. Neither is transcript state, so neither is
 * cached — they are read from the gateway while the screen is on top and
 * forgotten when it is not.
 */
import type { ConnectionStatus } from '@hermie/gateway-client'
import { activityEntries, type ActivityEntry } from '@hermie/transcript'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useGateway } from '../../gateway'
import { useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { useChatRuntime } from '../chats/ChatRuntime'

/** `delegation.status` and `agents.list` cadence while the screen is visible. */
export const ACTIVITY_COUNTER_POLL_MS = 10_000

/** On its way to `ready`: worth waiting for, and worth a spinner rather than a verdict. */
const DIALLING: readonly ConnectionStatus[] = ['probing', 'authenticating', 'connecting', 'reconnecting']

export interface ActivityCounters {
  /** Bots with a session the gateway calls busy (`session.active_list`). */
  botsWorking: number
  /** Children running across every bot (`delegation.status`). */
  activeSubagents: number
  /** `message_agent` deliveries still in flight (`agents.list`). */
  inFlightDeliveries: number
}

export interface UseActivityResult {
  entries: ActivityEntry[]
  counters: ActivityCounters
  /** True during the first background load, when there is nothing to show yet. */
  loading: boolean
  /** True while a pull-to-refresh is running, so the control can spin. */
  refreshing: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useActivity(): UseActivityResult {
  const runtime = useChatRuntime()
  const { status } = useGateway()
  const chats = useChatsStore(state => state.chats)
  const running = useBotsStore(state => state.running)
  const bots = useBotsStore(state => state.bots)

  const [counters, setCounters] = useState({ activeSubagents: 0, inFlightDeliveries: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const controller = runtime?.controller

  const refresh = useCallback(async () => {
    if (!controller) {
      return
    }

    setRefreshing(true)

    try {
      setError(null)
      await controller.loadActivity()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (mounted.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [controller])

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * The background load: every bot without a live chat gets its recent tail, so
   * the timeline is not limited to the conversations the user happened to open.
   *
   * It waits for the connection to be READY, and that wait is the whole fix.
   * A `GatewayConnection` exists from the moment a gateway is configured, long
   * before its socket is up, so this ran the instant the screen mounted; the
   * roster read under it failed with "gateway not connected", `loadActivity`
   * swallows a failed roster as "no bots", and the timeline settled on "your
   * bots have not talked to each other yet" — for good, because nothing asked
   * again. It was a race the screen lost on every launch that opened Activity
   * first, and it is the same failure, for the same reason, that
   * `ChatRuntimeProvider` already guards the roster against.
   */
  const wasReady = useRef(false)

  useEffect(() => {
    if (status !== 'ready') {
      wasReady.current = false

      // A connection still dialling keeps the spinner; one that has stopped
      // trying must not, or the notice saying so never gets to be seen.
      if (!DIALLING.includes(status)) {
        setLoading(false)
      }

      return
    }

    if (wasReady.current) {
      return
    }

    wasReady.current = true
    void refresh()
  }, [refresh, status])

  // `session.active_list` is already polled by the roster controller; this only
  // adds the two counters nothing else reads.
  useEffect(() => {
    if (!runtime) {
      return
    }

    const stopRoster = runtime.bots.watchRunning()
    let cancelled = false

    const read = async () => {
      const [activeSubagents, inFlightDeliveries] = await Promise.all([
        runtime.controller.activeSubagentCount(),
        runtime.controller.inFlightDeliveries()
      ])

      if (!cancelled) {
        setCounters({ activeSubagents, inFlightDeliveries })
      }
    }

    void read()

    const timer = setInterval(() => void read(), ACTIVITY_COUNTER_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
      stopRoster()
    }
  }, [runtime])

  // `sessions.changed` keeps the transcripts fresh through the controller's own
  // sweep, and this is a pure projection of them, so it follows for free.
  const entries = useMemo(() => activityEntries(chats), [chats])

  return {
    entries,
    counters: {
      botsWorking: bots.filter(bot => running[bot.name]).length,
      activeSubagents: counters.activeSubagents,
      inFlightDeliveries: counters.inFlightDeliveries
    },
    loading: loading && entries.length === 0,
    refreshing,
    error,
    refresh
  }
}
