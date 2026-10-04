/**
 * The Activity page's data.
 *
 * Everything the timeline shows is DERIVED from the chat store (`activityEntries`), the same chats the chat screens
 * read, so a bot's traffic appears here and in its chat as one set of items with one set of ids: a row is a door
 * into the exact message, not a copy of it. The page's own work is two things: make sure the store holds something
 * for every bot (`controller.loadActivity`, every bot's recent tail), and keep the counters fresh. Neither is
 * transcript state, so the counters are read while the page is shown and forgotten when it is not.
 *
 * The load waits for the connection to be READY, and that wait is the point. A call on a socket that is still
 * dialling rejects at once, `loadActivity` reads a failed roster as "no bots", and the timeline would settle on
 * "your bots have not talked to each other yet" for good, because nothing asks again (the Expo app's bug, the same
 * one `use-open-chat.ts` and `use-conversations.ts` guard against).
 *
 * Ported from the Expo app's `features/activity/useActivity.ts`.
 */
import type { ConnectionStatus } from '@hermie/gateway-client'
import { activityEntries, type ActivityEntry } from '@hermie/transcript'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import type { ChatScreenController } from '../chat/chat-runtime'

/** On its way to `ready`: worth waiting for, and worth a spinner rather than a verdict. */
const DIALLING: readonly ConnectionStatus[] = ['probing', 'authenticating', 'connecting', 'reconnecting']

/** `delegation.status` and `agents.list` cadence while the page is shown. */
export const ACTIVITY_COUNTER_POLL_MS = 10_000

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
  /** The first load is on its way and there is nothing to show yet. */
  loading: boolean
  /** The connection is not usable and there is nothing to show. */
  offline: boolean
  /** Why the load failed, while it has. */
  error: string | null
  refresh: () => Promise<void>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useActivity(controller: ChatScreenController | undefined): UseActivityResult {
  const status = useStore(connectionStore, state => state.status)
  const ready = status === 'ready'
  const chats = useStore(chatsStore, state => state.chats)
  const running = useStore(botsStore, state => state.running)
  const bots = useStore(botsStore, state => state.bots)
  const [counters, setCounters] = useState({ activeSubagents: 0, inFlightDeliveries: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (!controller) {
      return
    }

    try {
      setError(null)
      await controller.loadActivity()
    } catch (caught) {
      if (mounted.current) {
        setError(messageOf(caught))
      }
    } finally {
      if (mounted.current) {
        setLoading(false)
      }
    }
  }, [controller])

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  // The background load, once for each arrival at `ready`.
  useEffect(() => {
    if (!controller) {
      setLoading(false)

      return
    }

    if (ready) {
      void refresh()
    } else if (!DIALLING.includes(status)) {
      // A connection that has stopped trying must not keep the spinner, or the notice saying so is never seen.
      setLoading(false)
    }
  }, [controller, ready, refresh, status])

  // `session.active_list` is already polled by the roster; this only adds the two counters nothing else reads.
  useEffect(() => {
    if (!controller || !ready) {
      return
    }

    let cancelled = false

    const read = async (): Promise<void> => {
      const [activeSubagents, inFlightDeliveries] = await Promise.all([
        controller.activeSubagentCount().catch(() => 0),
        controller.inFlightDeliveries().catch(() => 0)
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
    }
  }, [controller, ready])

  // `sessions.changed` keeps the transcripts fresh through the controller's own sweep, and this is a pure
  // projection of them, so it follows for free.
  const entries = useMemo(() => activityEntries(chats), [chats])

  return {
    entries,
    counters: {
      botsWorking: bots.filter(bot => running[bot.name]).length,
      activeSubagents: counters.activeSubagents,
      inFlightDeliveries: counters.inFlightDeliveries
    },
    loading: loading && entries.length === 0 && controller !== undefined,
    offline: !ready && entries.length === 0 && !loading,
    error,
    refresh
  }
}
