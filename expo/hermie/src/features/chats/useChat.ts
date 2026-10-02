/**
 * The hook a chat screen talks to.
 *
 * It opens the chat once the connection can carry it, keeps it live afterwards,
 * and hands back the transcript already filtered through the view settings. The
 * actions are thin bindings onto the controller — no logic lives here, so a
 * screen can be replaced wholesale without any of the protocol moving with it.
 *
 * WHEN it opens is the part worth stating. `openChat` ends in
 * `session.resume`, and a JSON-RPC call on a socket that is still dialling
 * rejects immediately with "gateway not connected" — it does not queue. Opening
 * on mount therefore failed outright on a cold start or mid-reconnect, and
 * nothing asked again: the screen showed "This conversation could not be
 * opened: gateway not connected" with a Try again nobody should have had to
 * press. The open now waits for `status === 'ready'` and runs on the transition
 * to it, which is the same fix the roster got in `ChatRuntime` for the same
 * race, and which covers every reconnect for free.
 */
import {
  chatContextUsage,
  type ContextUsage,
  isBusy,
  itemsVersion,
  hasOpenRequest,
  openRequests,
  runningSubagents,
  type Subagent,
  type SubagentNode,
  subagentTree,
  turnActivity,
  type TurnActivity,
  type TranscriptItem,
  type VisibleItem,
  visibleItems
} from '@hermie/transcript'
import type { ConnectionStatus, GatewayError } from '@hermie/gateway-client'
import type { SessionLiveInfo } from '@hermes/shared/gateway-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { describeConnectionError, useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { type Bot, useBotsStore } from '../../store/bots'
import { useChatsStore, type QueuedMessage } from '../../store/chats'
import { useChatView } from '../../store/settings'
import { branchCountFor, branchTitle, type Conversation } from '../sessions/session-model'
import type {
  AttachmentInput,
  ChatOptionKey,
  ModelChoice,
  SetOptionResult,
  SlashCompletions,
  SlashOutcome
} from './chat-controller'
import { FileUploadError, type UploadableFile, type UploadedFile } from './file-upload'
import { type ChatRuntimeValue, useChatRuntime } from './ChatRuntime'

/** One array for every chat with nothing parked, so the hook's result settles. */
const EMPTY_QUEUE: QueuedMessage[] = []

export interface UseChatResult {
  bot: Bot | undefined
  /** Undefined until the chat has been created; the screen shows a spinner. */
  botName: string
  items: VisibleItem[]
  draft: string
  /** Anything running: the turn, a tool, a child. Drives the header and composer. */
  busy: boolean
  /**
   * The TURN specifically. Narrower than `busy` on purpose: the typing dots
   * mean "a reply is coming", and a chat whose turn ended while a sub-agent
   * keeps working is not about to say anything.
   */
  turnActive: boolean
  /**
   * What the bot is doing, for the line under its name. Narrower again than
   * `turnActive`: thinking, typing, running a tool, blocked on the reader.
   */
  activity: TurnActivity
  hydration: 'cold' | 'cached' | 'hydrating' | 'live' | 'stale' | 'error'
  /** Approval and clarify cards still waiting on the user. */
  requests: TranscriptItem[]
  /** A question is waiting on a person. The header's bead reads this. */
  needsInput: boolean
  subagents: Subagent[]
  /** The same children as a tree, for the agents sheet. */
  subagentTree: SubagentNode[]
  /** A prompt the backend parked behind the running turn. */
  queuedText: string | undefined
  /**
   * Messages THIS client parked behind the running turn, oldest first.
   *
   * Ours rather than the gateway's, because the reader can still steer, edit or
   * delete one — see `QueuedMessage`.
   */
  queued: QueuedMessage[]
  /** Inject a parked message into the running turn now. */
  steerQueued: (id: string) => Promise<string>
  /** Take one back for editing; answers the text to put in the field. */
  editQueued: (id: string) => string | undefined
  deleteQueued: (id: string) => void
  /** The gateway's view of this session: yolo, fast, reasoning effort, model. */
  info: SessionLiveInfo | undefined
  /**
   * How full this session's context window is, or `null`.
   *
   * `null` is the capability gate and the whole of it: a gateway that does not
   * report a window size has nothing to draw, and the surfaces hide the control
   * rather than showing a ring at zero or an error. See `context-usage.ts` for
   * why there is no table of model context sizes behind this.
   */
  contextUsage: ContextUsage | null
  /**
   * Ask the gateway for the reading again.
   *
   * Rarely needed — the reducer already follows the live ticks and the usage on
   * `message.complete` — and it exists for the one case those do not cover: a
   * chat resumed and not yet spoken to. Resolves either way; a gateway without
   * the method is not an error.
   */
  refreshUsage: () => Promise<void>
  /**
   * A failure that happened WHILE connected — the only kind worth a banner with
   * a retry on it. A chat that has not been opened because the socket is not up
   * is not an error: see `connection-notice.ts`, which turns the status and the
   * presence of a cached transcript into the one notice the screen draws.
   */
  error: string | null
  /**
   * What the CONNECTION says, when its own state is why this chat cannot open
   * and waiting will not fix it: signed out, too old, or refused by the
   * gateway's configuration. It replaces the raw RPC message, which in those
   * cases says "gateway not connected" and explains nothing.
   */
  connectionError: string | null
  /**
   * Drop the controller error the banner is showing.
   *
   * Without this the banner's "Done" only cleared the screen's OWN notice, so
   * a failed `openChat` left a banner that no button on it could dismiss —
   * only a successful retry.
   */
  clearError: () => void
  setDraft: (draft: string) => void
  send: (text: string, attachments?: AttachmentInput[]) => Promise<void>
  /**
   * Stream a file to the gateway and answer where it landed, so the next prompt
   * can name it. Rejects with a `FileUploadError` — see `file-upload.ts` for the
   * four reasons, two of which the sender cannot do anything about.
   */
  uploadFile: (file: UploadableFile, options?: { onProgress?: (fraction: number) => void }) => Promise<UploadedFile>
  stop: () => Promise<void>
  /** Tell the queue the sheet is on screen; safe to call more than once. */
  acknowledgeApproval: (requestId: string) => Promise<void>
  respondApproval: (requestId: string, choice: string, all?: boolean) => Promise<void>
  respondClarify: (requestId: string, answers: Record<string, string>) => Promise<void>
  lockClarify: (requestId: string, questionId: string, answer: string) => Promise<void>
  steerSubagent: (subagentId: string, text: string) => Promise<string>
  interruptSubagent: (subagentId: string) => Promise<boolean>
  tailSubagent: (subagentId: string) => Promise<string>
  /** The child's own stored transcript, for the full read-only view. */
  childTranscript: (childSessionId: string) => Promise<TranscriptItem[]>
  /** Completions for the line being typed, with the column they replace from. */
  querySlash: (typed: string) => Promise<SlashCompletions>
  /** Is this a command the gateway will run, rather than prose starting with `/`? */
  knowsSlashCommand: (name: string) => boolean
  runSlash: (command: string) => Promise<SlashOutcome>
  setOption: (
    key: ChatOptionKey,
    value: string,
    options?: { confirmExpensiveModel?: boolean }
  ) => Promise<SetOptionResult>
  refreshOptions: () => Promise<void>
  /** The gateway's model inventory; empty when it cannot answer. */
  modelOptions: () => Promise<ModelChoice[]>
  reload: () => Promise<void>
  /**
   * Fork this conversation at one row, into a branch of its own.
   *
   * Takes the row's ID rather than a position, because the number
   * `session.branch` wants is a count of the gateway's MESSAGES and the visible
   * list is neither all of them nor one item per row. The count is taken here,
   * off the full ordered transcript, by `branchCountFor`.
   */
  branchFrom: (itemId: string, text: string) => Promise<Conversation>
}

export function useChat(botName: string): UseChatResult {
  const runtime = useChatRuntime()
  const { status, lastError, config } = useGateway()
  const bot = useBotsStore(state => state.byName[botName])
  const chat = useChatsStore(state => state.chats[botName])
  const queued = useChatsStore(state => state.queues[botName]) ?? EMPTY_QUEUE
  const view = useChatView(botName)
  const [error, setError] = useState<string | null>(null)

  const ready = status === 'ready'
  const connectionError = terminalConnectionMessage(status, lastError, config?.baseUrl ?? '')

  /**
   * The attempt, if one has been made: the bot AND the runtime it was made on.
   * A new gateway connection builds a new controller with empty stores, so
   * remembering only the name leaves the screen bound to a chat the live
   * controller has never opened. `failed` is what makes the next `ready`
   * transition a retry rather than a no-op.
   */
  const attemptRef = useRef<{ botName: string; runtime: ChatRuntimeValue; failed: boolean } | null>(null)

  const open = useCallback(async () => {
    if (!runtime || !bot) {
      return
    }

    try {
      setError(null)
      // The reader opening the chat screen is the "next open" a conversation
      // picked on another device waits for (Owner Decision 4).
      await runtime.controller.openChat(bot, { follow: true })

      if (attemptRef.current) {
        attemptRef.current.failed = false
      }
    } catch (caught) {
      // Remembered rather than only shown: a failure here is usually the socket
      // going away underneath the resume, and the next ready connection is the
      // thing that can actually fix it.
      if (attemptRef.current) {
        attemptRef.current.failed = true
      }

      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [bot, runtime])

  useEffect(() => {
    if (!runtime || !bot || !ready) {
      // Nothing to do and nothing to report. Whatever the cache painted stays
      // on screen; the effect runs again the moment `ready` flips.
      return
    }

    const attempt = attemptRef.current
    const opened = attempt?.botName === bot.name && attempt.runtime === runtime

    if (opened && !attempt.failed) {
      return
    }

    attemptRef.current = { botName: bot.name, runtime, failed: false }
    void open()
  }, [bot, open, ready, runtime])

  useEffect(() => {
    // Leaving the screen writes the cache and marks the chat read. It does NOT
    // detach: a teammate bot's message has to keep streaming in.
    return () => {
      const attempt = attemptRef.current

      if (attempt) {
        void attempt.runtime.controller.closeChat(attempt.botName)
      }
    }
  }, [runtime])

  // `visibleItems` does no caching of its own, by design; this is where the
  // memo it expects lives. `itemsVersion` changes whenever any item mutates.
  const version = chat ? itemsVersion(chat) : 0
  const items = useMemo(
    () => (chat ? visibleItems(chat, view) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName, view.level, view.showBotToBot, view.showThinking]
  )

  const requests = useMemo(
    () => (chat ? openRequests(chat) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName]
  )

  /*
    The same predicate the chat list's bead and the widget file answer with,
    rather than `requests.length > 0` spelled out again here. They have to
    agree: a header that says Online above a row that says Needs input is two
    bugs that look like one.
  */
  const needsInput = useMemo(
    () => (chat ? hasOpenRequest(chat) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName]
  )

  const subagents = useMemo(
    () => (chat ? runningSubagents(chat) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName]
  )

  const tree = useMemo(
    () => (chat ? subagentTree(chat) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName]
  )

  /**
   * Memoized on the same key as the rest, and for the same reason: this is read
   * on every render of the header, and it walks the order twice.
   *
   * `turn.active` is deliberately in the key beside `version`. Ending a turn
   * patches no item, so `itemsVersion` can be unchanged across exactly the
   * transition that takes the line back to idle.
   */
  const activity = useMemo<TurnActivity>(
    () => (chat ? turnActivity(chat) : { kind: 'idle' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, chat?.botName, chat?.turn.active, chat?.turn.draftingTool]
  )

  const controller = runtime?.controller

  const notReady = useCallback(() => Promise.reject(new Error('The chat is not connected yet.')), [])

  return {
    bot,
    botName,
    items,
    draft: chat?.draft ?? '',
    busy: chat ? isBusy(chat) : false,
    turnActive: chat?.turn.active ?? false,
    activity,
    hydration: chat?.hydration ?? 'cold',
    needsInput,
    requests,
    subagents,
    subagentTree: tree,
    queuedText: chat?.queued?.text,
    queued,
    steerQueued: useCallback(
      (id: string) => (controller ? controller.steerQueued(botName, id) : notReady()),
      [botName, controller, notReady]
    ),
    editQueued: useCallback(
      (id: string) => (controller ? controller.editQueued(botName, id) : undefined),
      [botName, controller]
    ),
    deleteQueued: useCallback((id: string) => controller?.deleteQueued(botName, id), [botName, controller]),
    info: chat?.info,
    contextUsage: chatContextUsage(chat),
    refreshUsage: useCallback(async () => {
      await controller?.refreshUsage(botName)
    }, [botName, controller]),
    // A stale message from a previous connection must not outlive it: the retry
    // it offers is the reconnect that already happened.
    error: ready ? error : null,
    connectionError,
    clearError: useCallback(() => setError(null), []),
    setDraft: useCallback((draft: string) => useChatsStore.getState().setDraft(botName, draft), [botName]),
    // The composer has no use for the id `send` answers with — that is the
    // Shortcuts runner's, which needs a fixed point in the transcript — so it is
    // dropped here rather than widening every caller of the hook.
    send: useCallback(
      async (text: string, attachments?: AttachmentInput[]) => {
        if (!controller) {
          await notReady()

          return
        }

        await controller.send(botName, text, attachments)
      },
      [botName, controller, notReady]
    ),
    uploadFile: useCallback(
      (file: UploadableFile, options?: { onProgress?: (fraction: number) => void }) =>
        controller
          ? controller.uploadFile(botName, file, options)
          : Promise.reject(new FileUploadError('failed', 'There is no gateway connection to upload to.')),
      [botName, controller]
    ),
    stop: useCallback(() => (controller ? controller.stopTurn(botName) : Promise.resolve()), [botName, controller]),
    acknowledgeApproval: useCallback(
      (requestId: string) => (controller ? controller.acknowledgeApproval(botName, requestId) : Promise.resolve()),
      [botName, controller]
    ),
    respondApproval: useCallback(
      (requestId: string, choice: string, all?: boolean) =>
        controller ? controller.respondApproval(botName, requestId, choice, all) : notReady(),
      [botName, controller, notReady]
    ),
    respondClarify: useCallback(
      (requestId: string, answers: Record<string, string>) =>
        controller ? controller.respondClarify(botName, requestId, answers) : notReady(),
      [botName, controller, notReady]
    ),
    lockClarify: useCallback(
      (requestId: string, questionId: string, answer: string) =>
        controller ? controller.lockClarify(botName, requestId, questionId, answer) : notReady(),
      [botName, controller, notReady]
    ),
    steerSubagent: useCallback(
      (subagentId: string, text: string) =>
        controller ? controller.steerSubagent(botName, subagentId, text) : notReady(),
      [botName, controller, notReady]
    ),
    interruptSubagent: useCallback(
      (subagentId: string) => (controller ? controller.interruptSubagent(botName, subagentId) : notReady()),
      [botName, controller, notReady]
    ),
    tailSubagent: useCallback(
      (subagentId: string) => (controller ? controller.tailSubagent(botName, subagentId) : notReady()),
      [botName, controller, notReady]
    ),
    childTranscript: useCallback(
      (childSessionId: string) => (controller ? controller.childTranscript(botName, childSessionId) : notReady()),
      [botName, controller, notReady]
    ),
    querySlash: useCallback(
      (typed: string) => (controller ? controller.querySlash(botName, typed) : Promise.resolve({ items: [] })),
      [botName, controller]
    ),
    knowsSlashCommand: useCallback(
      (name: string) => controller?.knowsSlashCommand(botName, name) ?? false,
      [botName, controller]
    ),
    runSlash: useCallback(
      (command: string) => (controller ? controller.runSlash(botName, command) : notReady()),
      [botName, controller, notReady]
    ),
    setOption: useCallback(
      (key: ChatOptionKey, value: string, options?: { confirmExpensiveModel?: boolean }) =>
        controller ? controller.setOption(botName, key, value, options) : notReady(),
      [botName, controller, notReady]
    ),
    refreshOptions: useCallback(async () => {
      await controller?.refreshOptions(botName)
    }, [botName, controller]),
    modelOptions: useCallback(() => (controller ? controller.modelOptions() : Promise.resolve([])), [controller]),
    reload: open,
    /*
      Read off the store rather than off `items`.

      `items` is the VISIBLE list — the view settings have already taken the
      thinking blocks and, in Quiet, the tool cards out of it — and a count taken
      over it would tell the gateway to branch at a row several messages earlier
      than the one the reader pressed. What `branchCountFor` needs is the whole
      ordered transcript, which only the store has.
    */
    branchFrom: useCallback(
      (itemId: string, text: string) => {
        if (!controller) {
          return notReady()
        }

        const state = useChatsStore.getState().chats[botName]
        const ordered = (state?.order ?? [])
          .map(id => state?.items[id])
          .filter((item): item is TranscriptItem => Boolean(item))

        return controller.branchFrom(botName, {
          messageCount: branchCountFor(ordered, itemId),
          title: branchTitle(text)
        })
      },
      [botName, controller, notReady]
    )
  }
}

/**
 * Close codes that mean the gateway looked at us and said no.
 *
 * 4403 is its host guard and 4404 is chat being switched off; neither is a
 * transient. The dial loop keeps retrying them anyway — it cannot know the
 * difference — so the chat would otherwise sit on "Connecting…" forever
 * instead of saying what has to be changed on the gateway.
 */
const CONFIGURATION_CLOSE_CODES = new Set([4403, 4404])

/**
 * The connection's own message, when the connection is why this chat cannot
 * open and waiting will not help. Null means keep waiting.
 */
function terminalConnectionMessage(
  status: ConnectionStatus,
  error: GatewayError | null,
  baseUrl: string
): string | null {
  if (status === 'needs_signin') {
    return error ? describeConnectionError(error, baseUrl) : strings.errors.signedOut
  }

  if (status === 'incompatible') {
    return error ? describeConnectionError(error, baseUrl) : strings.errors.incompatible
  }

  if (error && (error.kind === 'config' || CONFIGURATION_CLOSE_CODES.has(error.closeCode ?? 0))) {
    return describeConnectionError(error, baseUrl)
  }

  return null
}
