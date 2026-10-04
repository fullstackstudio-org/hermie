/**
 * The options of the open chat's own session beyond YOLO: fast mode, reasoning
 * effort and the model, and the reading of the context window.
 *
 * Like `use-yolo.ts`, what is on is read from the session's own info
 * (`ChatState.info`, which `session.info` replaces and `ChatController.setOption`
 * refreshes), never from the last click: a change the gateway refused, or one
 * made from another device, leaves this page showing the truth. What this hook
 * keeps is what the page has to say about an attempt: that one is under way, why
 * the last one failed, and the question the gateway asked before it would switch
 * to a model it calls expensive.
 *
 * The expensive-model answer is never confirmed on the reader's behalf: it is
 * kept as a pending question (`confirm`) and only `confirmModel` sends the second
 * `config.set`, with `confirm_expensive_model`.
 *
 * The context reading is `chatContextUsage` (`@hermie/transcript`): the usage the
 * reducer folds from `session.usage` and `message.complete`, or the one a resume
 * answered with. `prepare` asks the gateway once more when the options open,
 * which is nearly always a no-op and covers the chat that was resumed and not yet
 * spoken to.
 */
import { chatContextUsage, type ContextUsage } from '@hermie/transcript'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type { ModelChoice } from '../../core/chat-controller'
import { strings } from '../../generated/strings'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import type { ChatSessionRuntime } from './chat-runtime'

/** The reasoning efforts the gateway takes, from none to the most. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** Which option has a change on its way to the gateway. */
export type SessionOptionKey = 'fast' | 'reasoning' | 'model'

/** The question the gateway asked before switching to an expensive model. */
export interface ModelConfirmation {
  /** The model that was asked for. */
  model: string
  /** The gateway's own words, or an empty string when it said none. */
  message: string
}

export interface SessionOptionsControl {
  /** The options can be changed now: a chat of the reader's own, attached to a live connection. */
  available: boolean
  /** The option with a change on its way, if any. */
  busy: SessionOptionKey | null
  /** Fast mode is on, as the session reports it. */
  fast: boolean
  /** The reasoning effort, as the session reports it; an empty string when it has not said. */
  reasoning: string
  /** The model the session is on; an empty string when it has not said. */
  model: string
  /** The gateway's models; empty until `prepare` has read them (or when it has none to offer). */
  models: readonly ModelChoice[]
  /** The inventory is still on its way. */
  modelsLoading: boolean
  /** How full the context window is; `null` when the gateway does not say (no meter then). */
  usage: ContextUsage | null
  /** The expensive-model question waiting for an answer. */
  confirm: ModelConfirmation | null
  /** Read what the options open on: the models and the context reading. Never rejects. */
  prepare: () => void
  setFast: (on: boolean) => Promise<void>
  setReasoning: (value: string) => Promise<void>
  /** Switch the model; a model the gateway calls expensive becomes `confirm` instead of a switch. */
  setModel: (id: string) => Promise<void>
  /** Answer yes to `confirm`. */
  confirmModel: () => Promise<void>
  /** Answer no to `confirm`. */
  cancelModel: () => void
}

export interface SessionOptionsState {
  options: SessionOptionsControl
  /** Why the last change failed, in the words the line above the chat shows, until the next one or `dismissError`. */
  error: string | null
  dismissError: () => void
}

interface Failure {
  bot: string
  message: string
}

interface Busy {
  bot: string
  key: SessionOptionKey
}

interface Pending extends ModelConfirmation {
  bot: string
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const NO_MODELS: readonly ModelChoice[] = []

/** What the selector answers when there is no reading: a window of nothing, which `contextUsageOf` never produces. */
const NO_USAGE: ContextUsage = { used: 0, limit: 0, fraction: 0, percent: 0, estimated: false }

export function useSessionOptions(
  bot: string,
  runtime: ChatSessionRuntime | null,
  viewer: boolean
): SessionOptionsState {
  const info = useStore(
    chatsStore,
    useShallow(state => {
      const current = state.chats[bot]?.info

      return {
        fast: current?.fast === true,
        reasoning: typeof current?.reasoning_effort === 'string' ? current.reasoning_effort : '',
        model: typeof current?.model === 'string' ? current.model : ''
      }
    })
  )
  // Shallow-compared, so a reading that did not change does not re-render the screen on every streamed delta.
  const reading = useStore(
    chatsStore,
    useShallow(state => chatContextUsage(state.chats[bot]) ?? NO_USAGE)
  )
  const attached = useStore(chatsStore, state => Boolean(state.chats[bot]?.runtimeSessionId))
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const [busy, setBusy] = useState<Busy | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [models, setModels] = useState<readonly ModelChoice[] | null>(null)
  const mounted = useRef(true)
  const controller = runtime?.controller

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  /** One `config.set`, with the bookkeeping every option shares. Never rejects. */
  const change = useCallback(
    async (key: SessionOptionKey, value: string, confirmExpensiveModel = false): Promise<void> => {
      if (!controller) {
        return
      }

      setFailure(null)
      setBusy({ bot, key })

      try {
        const result = await controller.setOption(
          bot,
          key,
          value,
          confirmExpensiveModel ? { confirmExpensiveModel } : {}
        )

        if (!mounted.current) {
          return
        }

        // Asked, not done: the model stays what the session reports until the reader says yes.
        setPending(result.confirmRequired ? { bot, model: value, message: result.confirmMessage ?? '' } : null)
      } catch (caught) {
        if (mounted.current) {
          setFailure({ bot, message: strings.app.chat.settingRefused({ message: messageOf(caught) }) })
          setPending(null)
        }

        // What the gateway holds now, whichever way it went; a read that fails too changes nothing.
        await controller.refreshOptions(bot).catch(() => undefined)
      } finally {
        if (mounted.current) {
          setBusy(current => (current?.bot === bot && current.key === key ? null : current))
        }
      }
    },
    [bot, controller]
  )

  const prepare = useCallback((): void => {
    if (!controller) {
      return
    }

    // Both are the controller's to cache and to absorb: a gateway without the method answers nothing.
    void controller
      .modelOptions()
      .then(list => {
        if (mounted.current) {
          setModels(list)
        }
      })
      .catch(() => {
        if (mounted.current) {
          setModels([])
        }
      })
    void controller.refreshUsage(bot).catch(() => undefined)
  }, [bot, controller])

  const setFast = useCallback((on: boolean) => change('fast', on ? 'fast' : 'normal'), [change])
  const setReasoning = useCallback((value: string) => change('reasoning', value), [change])
  const setModel = useCallback((id: string) => change('model', id), [change])

  const confirmModel = useCallback(async (): Promise<void> => {
    if (pending && pending.bot === bot) {
      await change('model', pending.model, true)
    }
  }, [bot, change, pending])

  const cancelModel = useCallback(() => setPending(null), [])
  const dismissError = useCallback(() => setFailure(null), [])

  return {
    options: {
      available: controller !== undefined && !viewer && attached && ready,
      busy: busy?.bot === bot ? busy.key : null,
      fast: info.fast,
      reasoning: info.reasoning,
      model: info.model,
      models: models ?? NO_MODELS,
      modelsLoading: models === null && controller !== undefined,
      usage: reading.limit > 0 ? reading : null,
      // A question belongs to the chat it was asked in; the page may be on another bot's by now.
      confirm: pending && pending.bot === bot ? { model: pending.model, message: pending.message } : null,
      prepare,
      setFast,
      setReasoning,
      setModel,
      confirmModel,
      cancelModel
    },
    // A failure belongs to the chat it happened in too.
    error: failure && failure.bot === bot ? failure.message : null,
    dismissError
  }
}
