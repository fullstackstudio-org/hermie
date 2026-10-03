/**
 * The layer over everything where a bot's questions are answered, one at a time.
 *
 * A question that stops a bot (may I run this? which of these?) must not be
 * missable and must not sit in the transcript where it scrolls away, so it is not
 * a row: it is a modal dialog above the whole page, whichever chat is open, and
 * it names the bot, because that bot may be one the reader is not looking at.
 *
 * **What it shows** is the first of the store's queue (`state/requests.ts`: every
 * open request of every chat, oldest first), and how many wait behind it. An
 * answer takes the request off the queue and the next appears. A request the
 * gateway withdraws (`request.cancel`) or lets time out goes the same way, and
 * the reader is told in words, politely, because a dialog that vanishes while
 * they are reading it is a reason to wonder what happened. A resume that restores
 * a request restores it here too: it is the same chat state.
 *
 * **Modal, for real.**
 *  - `role="dialog"` and `aria-modal`, named by its heading and described by what
 *    is being asked.
 *  - The rest of the page is `inert` while it is open (`platform/modal-isolation.ts`),
 *    so nothing behind it takes a key, a click or a screen reader's attention;
 *    Tab is also kept inside by hand, and a focus that lands outside (a browser
 *    without `inert`) is brought back.
 *  - **Escape does not dismiss.** A question that is dismissed is a question the
 *    bot goes on waiting for, with nobody looking: only an answer closes it. The
 *    scrim does not either.
 *  - Focus goes to the dialog itself, not to a button, when it opens, so that a
 *    Return meant for the field the reader was typing in finds nothing to press;
 *    when the last request is gone focus returns to where it was.
 *
 * **Answering** goes through the controller (`respondApproval`,
 * `respondClarify`, `lockClarify`); this component calls nothing else. A failure
 * to deliver an answer is said in an alert over the page.
 */
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { type StoreApi, useStore } from 'zustand'

import { RequestWithdrawnError } from '../../core/request-withdrawn'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { isolateModal } from '../../platform/modal-isolation'
import { botsStore } from '../../state/bots'
import { type ChatsState, chatsStore } from '../../state/chats'
import { type RequestsState, requestsStore } from '../../state/requests'
import { useChatRuntime } from '../chat/chat-runtime'
import { ApprovalSheet } from './ApprovalSheet'
import { ClarifySheet } from './ClarifySheet'
import './request-layer.css'

/** How long a failure to deliver an answer stays on screen. */
const FAILURE_MS = 12_000

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface RequestLayerProps {
  /** The queue; the page's own unless a test hands in its own. */
  store?: StoreApi<RequestsState>
  /** Where a withdrawn request's last state is read; the page's own unless a test hands in its own. */
  chats?: StoreApi<ChatsState>
  /** Milliseconds before a sheet's buttons accept a press. Tests pass 0. */
  tapGuardMs?: number
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What a reader is told when a request left without their answer. */
const withdrawnAnnouncement = (name: string, reason: string | undefined): string =>
  reason === 'timeout' ? webStrings.requests.timedOut({ name }) : webStrings.requests.withdrawn({ name })

export function RequestLayer({
  store = requestsStore,
  chats = chatsStore,
  tapGuardMs
}: RequestLayerProps): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const controller = runtime?.controller
  const queue = useStore(store, state => state.queue)
  const current = queue[0]
  const open = current !== undefined
  const bot = current?.bot
  const displayName = useStore(botsStore, state => (bot === undefined ? '' : (state.byName[bot]?.displayName ?? bot)))
  const cwd = useStore(chats, state => {
    const info = bot === undefined ? undefined : state.chats[bot]?.info

    return typeof info?.cwd === 'string' ? info.cwd : undefined
  })

  const ids = useId()
  const titleId = `${ids}-title`
  const descriptionId = `${ids}-description`
  const overlay = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const opener = useRef<Element | null>(null)
  const wasOpen = useRef(false)
  const [announcement, setAnnouncement] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  // Where the reader was, taken before anything in the dialog moves focus (children's effects run after this).
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      opener.current = overlay.current?.ownerDocument.activeElement ?? null
    }
  }, [open])

  // The rest of the page goes inert while the layer is open.
  useEffect(() => {
    if (!open || !overlay.current) {
      return
    }

    return isolateModal(overlay.current)
  }, [open])

  // Focus: onto the dialog when a request appears (each one in turn), back to where it was when the last is gone.
  const currentKey = current?.key
  useEffect(() => {
    if (currentKey !== undefined) {
      dialog.current?.focus({ preventScroll: true })
    }
  }, [currentKey])

  useEffect(() => {
    if (!open && wasOpen.current) {
      const target = opener.current
      const documentOf = overlay.current?.ownerDocument

      opener.current = null

      // `body` is where focus is when nothing has it: no place to go back to.
      if (target instanceof HTMLElement && target.isConnected && target !== target.ownerDocument.body) {
        target.focus({ preventScroll: true })
      } else {
        // The place the reader was is gone (they left the chat): the composer if there is one, else the page's main pane.
        const root = documentOf ?? target?.ownerDocument

        root?.querySelector<HTMLElement>('[data-composer-field]')?.focus({ preventScroll: true })
      }
    }

    wasOpen.current = open
  }, [open])

  // A focus that lands outside the dialog while it is open (a browser without `inert`) is brought back.
  useEffect(() => {
    if (!open || !overlay.current) {
      return
    }

    const documentOf = overlay.current.ownerDocument
    const onFocusIn = (event: FocusEvent): void => {
      if (dialog.current && event.target instanceof Node && !dialog.current.contains(event.target)) {
        dialog.current.focus({ preventScroll: true })
      }
    }

    documentOf.addEventListener('focusin', onFocusIn)

    return () => documentOf.removeEventListener('focusin', onFocusIn)
  }, [open])

  // A request that left without our answer: said once, politely.
  const lastShown = useRef<typeof current>(undefined)

  useEffect(() => {
    const previous = lastShown.current

    if (previous && !queue.some(entry => entry.key === previous.key)) {
      const item = chats.getState().chats[previous.bot]?.items[previous.item.id]

      if ((item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'cancelled') {
        const name = botsStore.getState().byName[previous.bot]?.displayName ?? previous.bot

        setAnnouncement(withdrawnAnnouncement(name, item.cancelReason))
      }
    }

    lastShown.current = queue[0]
  }, [chats, queue])

  // An approval is acknowledged to the gateway's queue the first time a person can see it.
  const approvalId = current?.item.kind === 'approval' ? current.item.requestId : undefined

  useEffect(() => {
    if (controller && bot !== undefined && approvalId !== undefined) {
      void controller.acknowledgeApproval(bot, approvalId).catch(() => undefined)
    }
  }, [approvalId, bot, controller])

  useEffect(() => {
    if (failure === null) {
      return
    }

    const timer = setTimeout(() => setFailure(null), FAILURE_MS)

    return () => clearTimeout(timer)
  }, [failure])

  // ── answering ───────────────────────────────────────────────────────────────
  // A press that reached the controller after the request was withdrawn is not a failed answer: nothing was
  // sent, and the reader is told what happened, the same words as when they watched it go. (The card is no
  // longer open, so the effect above never sees it leave as `cancelled` if the press came first.)
  const report = useCallback((error: unknown, from: string) => {
    if (error instanceof RequestWithdrawnError) {
      if (error.state === 'cancelled') {
        const name = botsStore.getState().byName[from]?.displayName ?? from

        setAnnouncement(withdrawnAnnouncement(name, error.reason))
      }

      return
    }

    setFailure(webStrings.requests.answerFailed({ message: messageOf(error) }))
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    // Not an answer, so not a way out. Nothing behind the dialog hears it either.
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()

      return
    }

    if (event.key !== 'Tab' || !dialog.current) {
      return
    }

    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const lastOne = focusable.at(-1)
    const active = dialog.current.ownerDocument.activeElement

    if (!first || !lastOne) {
      event.preventDefault()
      dialog.current.focus()

      return
    }

    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault()
      lastOne.focus()
    } else if (!event.shiftKey && active === lastOne) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const waiting = queue.length - 1

  return (
    <div className="hm-requests">
      {/* Beside the dialog, so it stays live while the page behind it is inert. */}
      <div className="hm-sr" aria-live="polite" aria-atomic="true" data-modal-keep="">
        {announcement}
      </div>

      {failure ? (
        <p className="hm-requests__failure" role="alert" data-modal-keep="">
          {failure}
        </p>
      ) : null}

      {current ? (
        <div className="hm-requests__scrim" ref={overlay}>
          <section
            className="hm-requests__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            ref={dialog}
            onKeyDown={onKeyDown}
          >
            <p className="hm-requests__from">{webStrings.requests.from({ name: displayName })}</p>

            {current.item.kind === 'approval' ? (
              <ApprovalSheet
                key={current.key}
                item={current.item}
                handle={current.bot}
                {...(cwd ? { directory: cwd } : {})}
                titleId={titleId}
                descriptionId={descriptionId}
                {...(tapGuardMs !== undefined ? { tapGuardMs } : {})}
                onRespond={choice => {
                  void controller
                    ?.respondApproval(current.bot, current.item.requestId, choice)
                    .catch(error => report(error, current.bot))
                }}
              />
            ) : (
              <ClarifySheet
                key={current.key}
                item={current.item}
                titleId={titleId}
                descriptionId={descriptionId}
                {...(tapGuardMs !== undefined ? { tapGuardMs } : {})}
                onSubmit={answers => {
                  void controller
                    ?.respondClarify(current.bot, current.item.requestId, answers)
                    .catch(error => report(error, current.bot))
                }}
                onLock={(qid, answer) => {
                  void controller
                    ?.lockClarify(current.bot, current.item.requestId, qid, answer)
                    .catch(error => report(error, current.bot))
                }}
              />
            )}

            {waiting > 0 ? <p className="hm-requests__meta">{webStrings.requests.more({ count: waiting })}</p> : null}
          </section>
        </div>
      ) : null}
    </div>
  )
}
