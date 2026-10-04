/**
 * YOLO mode of the open chat: whether it is on, and the way to switch it.
 *
 * YOLO skips the approval requests of ONE session (`config.set` with
 * `scope: 'session'`, `ChatController.setOption`). What is on is read from the
 * session's own info (`ChatState.info.yolo`, which `session.info` replaces and
 * `setOption` refreshes), never guessed from the last click: a switch the
 * gateway refused, or one made from another device, leaves this page showing the
 * truth.
 *
 * What this hook keeps is only what the page has to say about the attempt: that
 * one is under way, and why the last one failed. A failure also re-reads the
 * options, because a refusal that arrived after the gateway had acted would
 * otherwise leave the switch drawn the wrong way round.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import type { ChatSessionRuntime } from './chat-runtime'

export interface YoloControl {
  /** The chat is in YOLO mode, as its session reports it. */
  on: boolean
  /** The mode can be changed now: a chat of the reader's own, attached to a live connection. */
  available: boolean
  /** A change is on its way to the gateway. */
  busy: boolean
  /** Switch it; resolves once the gateway has answered, and never rejects (a refusal becomes `error`). */
  set: (on: boolean) => Promise<void>
}

export interface YoloState {
  yolo: YoloControl
  /** Why the last change failed, until the next one or `dismissError`. */
  error: string | null
  dismissError: () => void
}

interface Failure {
  bot: string
  message: string
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useYolo(bot: string, runtime: ChatSessionRuntime | null, viewer: boolean): YoloState {
  const on = useStore(chatsStore, state => state.chats[bot]?.info?.yolo === true)
  const attached = useStore(chatsStore, state => Boolean(state.chats[bot]?.runtimeSessionId))
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const [busyBot, setBusyBot] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const mounted = useRef(true)
  const controller = runtime?.controller

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const set = useCallback(
    async (next: boolean): Promise<void> => {
      if (!controller) {
        return
      }

      setFailure(null)
      setBusyBot(bot)

      try {
        await controller.setOption(bot, 'yolo', next ? 'on' : 'off')
      } catch (caught) {
        if (mounted.current) {
          setFailure({ bot, message: messageOf(caught) })
        }

        // What the gateway holds now, whichever way it went; a read that fails too changes nothing.
        await controller.refreshOptions(bot).catch(() => undefined)
      } finally {
        if (mounted.current) {
          setBusyBot(current => (current === bot ? null : current))
        }
      }
    },
    [bot, controller]
  )

  const dismissError = useCallback(() => setFailure(null), [])

  return {
    yolo: {
      on,
      available: controller !== undefined && !viewer && attached && ready,
      busy: busyBot === bot,
      set
    },
    // A failure belongs to the chat it happened in; the page may be on another bot's by now.
    error: failure && failure.bot === bot ? failure.message : null,
    dismissError
  }
}
