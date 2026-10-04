/**
 * The layer over everything where a bot's questions are answered, one at a time.
 *
 * A question that stops a bot (may I run this? which of these?) must not be
 * missable and must not sit in the transcript where it scrolls away, so it is not
 * a row: it is a modal dialog above the whole page, whichever chat is open, and
 * it names the bot, because that bot may be one the reader is not looking at.
 *
 * **What it shows** is the first of the store's queue (`state/requests.ts`: every
 * open request of every chat, oldest first) in the order of `sheet-order.ts`: the questions that stop a bot first,
 * the form, file request and draft sheets after them, and how many wait behind it. An
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
 *    scrim does not either. The one exception is a form, a file request or a draft
 *    to review, where Escape is Later: the sheet is put away with what was entered
 *    in it, the page is usable, and the transcript's record offers Open. Nothing
 *    was answered, and the request still waits.
 *  - Focus goes to the dialog itself, not to a button, when it opens, so that a
 *    Return meant for the field the reader was typing in finds nothing to press;
 *    when the last request is gone focus returns to where it was.
 *
 * **Answering** goes through the controller (`respondApproval`, one call per
 * request when one answer covers several of the same bot's, `respondClarify`,
 * `lockClarify`, `cancelClarify`), and for a `confirm` at level `passkey`
 * through the passkey model (`confirm`, `decline`, `dismiss`); this component
 * calls nothing else. A failure to deliver an answer is said in an alert over
 * the page; a confirmation says where it stands on its own sheet, and stays on
 * screen once it is over until the person closes it, because "the gateway is
 * checking it" and "nothing was confirmed" are things to read, not to miss.
 *
 * The passkey model's notices (`PasskeyNotices`) are drawn here too, beside the
 * dialog, so they are seen whichever route is open.
 *
 * **A secret, a sudo password, a vault prompt** (`SecureRequest`) is answered
 * through the secure input model (`answer`, `skip`), in one of five sheets over
 * one frame (`SecureSheet.tsx`). What is typed there is read from the field at the
 * press and goes straight into the model's reply: nothing here holds it. A prompt
 * that ends without the reader's answer closes, is said politely, and leaves a
 * notice on its chat saying why (`features/notices/SecureInputNotice.tsx`).
 *
 * **A form, a file request, a draft to review** (`InteractiveRequestEntry`) is held by the interactive model
 * (`core/requests/interactive.ts`) and answered through it (`answer`, `skip`, `cannotShow`), each in a sheet of its
 * own (`FormSheet`, `FileSheet`, `DraftSheet`). A file request also uploads, through the controller
 * (`uploadFileTo`): the sheet puts the files on the gateway and answers with their references.
 *
 * **A question comes first.** An approval, a clarify, a confirmation, a secure prompt (and a connector authorisation)
 * does not wait behind an interactive sheet that is open: that sheet steps aside, parked with what was typed, picked
 * or edited in it (not Later: it comes back by itself when the questions are done), and the question has the dialog.
 * Only a sheet that is sending an answer or uploading files is not stepped over: the question waits until that is
 * over (`SheetBusyContext`, the same rule as the native apps'). A sheet put away with Later stays away until Open.
 *
 * **A connector authorisation** (`ConnectionRequest`) is answered through the
 * connections model (`skip`, `cancel`) on its own sheet (`ConnectionSheet.tsx`),
 * with a countdown to the gateway's deadline; a link on it is opened only when the
 * person presses it (`openAuthorisationLink`). One whose time ran out, or that the
 * gateway settled while it was on screen, is said politely.
 *
 * The gateway's own notices (`GatewayNotices`) are drawn beside the dialog too.
 */
import type { ApprovalItem } from '@hermie/transcript'
import { createPortal } from 'react-dom'
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { type StoreApi, useStore } from 'zustand'

import { CANCELLED_BY_READER, RequestWithdrawnError } from '../../core/request-withdrawn'
import type { AnswerOutcome } from '../../core/requests/interactive'
import type { InteractiveAnswer } from '../../core/requests/interactive-types'
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { isolateModal } from '../../platform/modal-isolation'
import { botsStore } from '../../state/bots'
import { type ChatsState, chatsStore } from '../../state/chats'
import { type ConnectionsState, connectionsStore } from '../../state/connections'
import { type PasskeyConfirmation, type PasskeysState, passkeysStore } from '../../state/passkeys'
import { type EngineRequest, type OpenRequest, type RequestsState, requestsStore } from '../../state/requests'
import { type InteractiveRequest, type InteractiveState, interactiveStore } from '../../state/interactive'
import { type RequestLaterState, requestLaterStore } from '../../state/request-later'
import { type SecureInputState, secureInputStore, type SecurePrompt } from '../../state/secure-input'
import { useChatRuntime } from '../chat/chat-runtime'
import { GatewayNotices } from '../notices/GatewayNotices'
import { openAuthorisationLink, useSessionSignalsRuntime } from '../notices/signals-runtime'
import { usePasskeyRuntime } from './passkey-runtime'
import { PasskeyNotices } from './PasskeyNotices'
import { type RequestSheets, useRequestSheets } from './request-sheets'
import { SheetBusyContext } from './interactive-frame'
import { useInteractiveRuntime } from './interactive-runtime'
import { useSecureInputRuntime } from './secure-input-runtime'
import { orderSheets } from './sheet-order'
import type { FileUploader } from './FileSheet'
import type { SecureSheetProps } from './SecureSheet'
import { WithName } from './with-name'
import './request-layer.css'

/**
 * What a confirmation's dialog shows while the sheets' chunk loads (`request-sheets.ts`; the passkey model
 * that reads the frame and the WebAuthn layer stay in the entry bundle: a frame is read, and a 4040
 * answered, whether or not the sheet ever loads): its heading and who asks, and nothing to press.
 */
function ConfirmFallback({
  confirmation,
  titleId,
  descriptionId
}: {
  confirmation: PasskeyConfirmation
  titleId: string
  descriptionId: string
}): ReactElement {
  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {confirmation.title}
      </h2>
      <p className="hm-requests__lead" id={descriptionId}>
        {webStrings.passkeys.sheetLead({ host: new URL(confirmation.baseUrl).host })}
      </p>
    </>
  )
}

/** How long a failure to deliver an answer stays on screen. */
const FAILURE_MS = 12_000

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface RequestLayerProps {
  /** The queue; the page's own unless a test hands in its own. */
  store?: StoreApi<RequestsState>
  /** Where a withdrawn request's last state is read; the page's own unless a test hands in its own. */
  chats?: StoreApi<ChatsState>
  /** Where a confirmation is read; the page's own unless a test hands in its own. */
  passkeys?: StoreApi<PasskeysState>
  /** Where a secret, sudo or vault prompt is read; the page's own unless a test hands in its own. */
  secureInput?: StoreApi<SecureInputState>
  /** Where a form, a file request or a draft to review is read; the page's own unless a test hands in its own. */
  interactive?: StoreApi<InteractiveState>
  /** Which interactive requests were put away (Later); the page's own unless a test hands in its own. */
  later?: StoreApi<RequestLaterState>
  /** Where a connector authorisation is read; the page's own unless a test hands in its own. */
  connections?: StoreApi<ConnectionsState>
  /** Opens an authorisation link the person pressed; a new tab with no opener unless a test hands in its own. */
  openLink?: (url: string) => void
  /** Milliseconds before a sheet's buttons accept a press. Tests pass 0. */
  tapGuardMs?: number
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What a reader is told when a request left without their answer; nothing for a clarify they cancelled themselves. */
const withdrawnAnnouncement = (name: string, reason: string | undefined): string =>
  reason === CANCELLED_BY_READER
    ? ''
    : reason === 'timeout'
      ? webStrings.requests.timedOut({ name })
      : webStrings.requests.withdrawn({ name })

/** The same chat's other open approvals, oldest first: what one answer for several may also cover. */
function otherApprovals(queue: readonly OpenRequest[], current: EngineRequest): ApprovalItem[] {
  const found: ApprovalItem[] = []

  for (const entry of queue) {
    if (entry !== current && entry.kind === 'engine' && entry.bot === current.bot && entry.item.kind === 'approval') {
      found.push(entry.item)
    }
  }

  return found
}

/** What a reader is told when a confirmation left the screen without their answer, or nothing. */
function confirmationAnnouncement(confirmation: PasskeyConfirmation | undefined, name: string): string {
  if (confirmation?.phase.kind !== 'ended') {
    return ''
  }

  switch (confirmation.phase.end.kind) {
    case 'timed_out':
      return webStrings.requests.timedOut({ name })
    case 'answered_elsewhere':
      return webStrings.passkeys.answeredElsewhere({ name })
    case 'withdrawn':
      return webStrings.requests.withdrawn({ name })
    default:
      return ''
  }
}

/** What a reader is told when a secure prompt left the screen without their answer, or nothing (it was answered). */
function secureAnnouncement(store: StoreApi<SecureInputState>, bot: string, id: string, name: string): string {
  const notice = store.getState().notices[bot]

  if (notice?.requestId !== id) {
    return ''
  }

  switch (notice.notice.kind) {
    case 'expired':
      return webStrings.requests.timedOut({ name })
    case 'withdrawn':
      return webStrings.requests.withdrawn({ name })
    case 'lapsed':
      return webStrings.secureInput.noticeLapsed({ name })
    default:
      return ''
  }
}

/** What a reader is told when an interactive request left the screen without their answer, or nothing. */
function interactiveAnnouncement(store: StoreApi<InteractiveState>, bot: string, id: string, name: string): string {
  const notice = store.getState().notices[bot]

  if (notice?.requestId !== id) {
    return ''
  }

  switch (notice.notice.kind) {
    case 'expired':
      return webStrings.requests.timedOut({ name })
    case 'withdrawn':
      return webStrings.requests.withdrawn({ name })
    case 'answered_elsewhere':
      return webStrings.passkeys.answeredElsewhere({ name })
    case 'lapsed':
      return webStrings.secureInput.noticeLapsed({ name })
    case 'may_not_have_arrived':
      return webStrings.requests.answerMayNotHaveArrived({ name })
    default:
      return ''
  }
}

/** What a reader is told when a connection card left the screen without their answer, or nothing. */
function connectionAnnouncement(store: StoreApi<ConnectionsState>, bot: string, opId: string, name: string): string {
  const ended = store.getState().ended[bot]

  if (ended?.opId !== opId) {
    return ''
  }

  return ended.end === 'deadline' ? webStrings.connections.expired({ name }) : webStrings.connections.done({ name })
}

/** The sheet for a prompt's kind. */
function SecureSheetFor({ sheets, ...props }: SecureSheetProps & { sheets: RequestSheets }): ReactElement | null {
  switch (props.prompt.ask.kind) {
    case 'secret':
      return <sheets.SecretSheet {...props} />
    case 'sudo':
      return <sheets.SudoSheet {...props} />
    case 'vault_unlock':
      return <sheets.VaultUnlockSheet {...props} />
    case 'vault_code':
      return <sheets.VaultCodeSheet {...props} />
    case 'vault_save_login':
      return <sheets.VaultSaveLoginSheet {...props} />
  }
}

/** What the sheet of an interactive request is given by the layer. */
interface InteractiveSheetForProps {
  sheets: RequestSheets
  request: InteractiveRequest
  gateway: string
  titleId: string
  descriptionId: string
  tapGuardMs?: number
  /** The sheet is the one on screen: its tap guard starts from then. */
  shown: boolean
  onAnswer: (result: InteractiveAnswer) => Promise<AnswerOutcome>
  onSkip: () => Promise<AnswerOutcome>
  onCannotShow: (reason: string) => 'sent' | 'closed' | 'offline' | 'busy'
  onLater: () => void
  onUpload: FileUploader | undefined
}

/** The sheet for an interactive request's method. */
function InteractiveSheetFor({
  sheets,
  request,
  onUpload,
  onCannotShow,
  onSkip,
  ...rest
}: InteractiveSheetForProps): ReactElement | null {
  const { ask } = request

  switch (ask.method) {
    case 'input.form':
      return <sheets.FormSheet request={{ ...request, ask }} onSkip={onSkip} onCannotShow={onCannotShow} {...rest} />
    case 'input.file':
      return (
        <sheets.FileSheet
          request={{ ...request, ask }}
          onSkip={onSkip}
          onCannotShow={onCannotShow}
          onUpload={onUpload}
          {...rest}
        />
      )
    case 'review.draft':
      return <sheets.DraftSheet request={{ ...request, ask }} {...rest} />
  }
}

/** Hands the sheet inside the way to tell the layer that it is sending or uploading (`useReportBusy`). */
function BusyScope({
  entryKey,
  onBusy,
  children
}: {
  entryKey: string
  onBusy: (key: string, busy: boolean) => void
  children: ReactNode
}): ReactElement {
  const report = useCallback((busy: boolean) => onBusy(entryKey, busy), [entryKey, onBusy])

  return <SheetBusyContext.Provider value={report}>{children}</SheetBusyContext.Provider>
}

/** Who a request is from: the bot's display name, or the gateway's host for a confirmation in no chat held here. */
function senderName(entry: OpenRequest, confirmation: PasskeyConfirmation | undefined): string {
  if (entry.bot !== undefined) {
    return botsStore.getState().byName[entry.bot]?.displayName ?? entry.bot
  }

  return confirmation ? new URL(confirmation.baseUrl).host : ''
}

export function RequestLayer({
  store = requestsStore,
  chats = chatsStore,
  passkeys = passkeysStore,
  secureInput = secureInputStore,
  interactive = interactiveStore,
  connections = connectionsStore,
  later = requestLaterStore,
  openLink = openAuthorisationLink,
  tapGuardMs
}: RequestLayerProps): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const controller = runtime?.controller
  const passkeyActions = usePasskeyRuntime()
  const secureActions = useSecureInputRuntime()
  const interactiveActions = useInteractiveRuntime()
  const queue = useStore(store, state => state.queue)
  const away = useStore(later, state => state.away)
  // A sheet put away (Later) is not shown and does not hold the page: it waits, with what was entered in it, until Open.
  const shown = queue.filter(entry => !(entry.kind === 'interactive' && away.includes(entry.key)))
  // The interactive sheets that are sending an answer or uploading: reported by the sheets themselves.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  // The one that has the dialog now, as of the last commit: a busy interactive sheet that has it keeps it.
  const onScreen = useRef<string | undefined>(undefined)
  const holding = onScreen.current !== undefined && busy.has(onScreen.current) ? onScreen.current : undefined
  // Questions before sheets (`sheet-order.ts`); among themselves, the queue's order.
  const ordered = orderSheets(shown, holding)
  const current = ordered[0]
  const open = current !== undefined
  // Every sheet comes from one chunk, fetched when the session starts and held from then on.
  const sheets = useRequestSheets(open)
  const bot = current?.bot
  const confirmId = current?.kind === 'confirm' ? current.id : undefined
  const confirmation = useStore(passkeys, state =>
    confirmId === undefined ? undefined : state.confirmations.find(entry => entry.id === confirmId)
  )
  const rpId = useStore(passkeys, state => state.rpId)
  const secureId = current?.kind === 'secure' ? current.id : undefined
  const prompt: SecurePrompt | undefined = useStore(secureInput, state =>
    secureId === undefined ? undefined : state.prompts.find(entry => entry.id === secureId)
  )
  const gatewayHost = useStore(secureInput, state => state.gateway)
  const interactiveGateway = useStore(interactive, state => state.gateway)
  const interactiveRequests = useStore(interactive, state => state.requests)
  const signals = useSessionSignalsRuntime()
  const connectionOp = current?.kind === 'connection' ? current.opId : undefined
  const card = useStore(connections, state => {
    const held = bot === undefined || connectionOp === undefined ? undefined : state.cards[bot]

    return held?.opId === connectionOp ? held : undefined
  })
  const displayName = useStore(botsStore, state => (bot === undefined ? '' : (state.byName[bot]?.displayName ?? bot)))
  /** The name as the dialog shows it: the roster's words, cleaned and bounded like a request's (a bot can set it). */
  const shownName = displayText(displayName, BOT_NAME_LIMIT)
  const cwd = useStore(chats, state => {
    const info = bot === undefined ? undefined : state.chats[bot]?.info

    return typeof info?.cwd === 'string' ? info.cwd : undefined
  })

  const ids = useId()
  const titleId = `${ids}-title`
  const descriptionId = `${ids}-description`
  const overlay = useRef<HTMLDivElement>(null)
  // The sheets of the interactive requests live in nodes of their own (`holders`) that are moved between the dialog's
  // slot and a parking place, so that a sheet put away keeps what was entered in it: the same React tree, another place.
  const holders = useRef(new Map<string, HTMLDivElement>())
  const parking = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const interactiveEntries = queue.flatMap(entry => (entry.kind === 'interactive' ? [entry] : []))
  const dialog = useRef<HTMLElement>(null)
  const opener = useRef<Element | null>(null)
  const wasOpen = useRef(false)
  const [announcement, setAnnouncement] = useState('')
  const reportBusy = useCallback((key: string, working: boolean): void => {
    setBusy(held => {
      if (held.has(key) === working) {
        return held
      }

      const next = new Set(held)

      if (working) {
        next.add(key)
      } else {
        next.delete(key)
      }

      return next
    })
  }, [])
  const [failure, setFailure] = useState<string | null>(null)

  useLayoutEffect(() => {
    onScreen.current = current?.key
  })

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
      if (previous.kind === 'confirm') {
        const last = passkeys.getState().confirmations.find(entry => entry.id === previous.id)
        const said = confirmationAnnouncement(last, senderName(previous, last))

        if (said) {
          setAnnouncement(said)
        }
      } else if (previous.kind === 'secure') {
        const said = secureAnnouncement(
          secureInput,
          previous.bot,
          previous.id,
          displayText(senderName(previous, undefined), BOT_NAME_LIMIT)
        )

        if (said) {
          setAnnouncement(said)
        }
      } else if (previous.kind === 'interactive') {
        const said = interactiveAnnouncement(
          interactive,
          previous.bot,
          previous.id,
          displayText(senderName(previous, undefined), BOT_NAME_LIMIT)
        )

        if (said) {
          setAnnouncement(said)
        }
      } else if (previous.kind === 'connection') {
        const said = connectionAnnouncement(
          connections,
          previous.bot,
          previous.opId,
          displayText(senderName(previous, undefined), BOT_NAME_LIMIT)
        )

        if (said) {
          setAnnouncement(said)
        }
      } else {
        const item = chats.getState().chats[previous.bot]?.items[previous.item.id]

        if ((item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'cancelled') {
          const said = withdrawnAnnouncement(senderName(previous, undefined), item.cancelReason)

          if (said) {
            setAnnouncement(said)
          }
        }
      }
    }

    // An interactive sheet that was on screen gave way to a question: said, so that the swap is not a surprise, and
    // that what was entered in it is kept.
    if (
      previous?.kind === 'interactive' &&
      current?.kind !== 'interactive' &&
      queue.some(entry => entry.key === previous.key) &&
      !later.getState().away.includes(previous.key)
    ) {
      setAnnouncement(webStrings.requests.madeWay)
    }

    // The one on screen, not the first of the queue: a sheet put away (Later) is not the one a reader is looking at.
    lastShown.current = current
  }, [chats, connections, current, interactive, later, passkeys, queue, secureInput])

  // An approval is acknowledged to the gateway's queue the first time a person can see it.
  const approvalId = current?.kind === 'engine' && current.item.kind === 'approval' ? current.item.requestId : undefined

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
      const said =
        error.state === 'cancelled'
          ? withdrawnAnnouncement(botsStore.getState().byName[from]?.displayName ?? from, error.reason)
          : ''

      if (said) {
        setAnnouncement(said)
      }

      return
    }

    setFailure(webStrings.requests.answerFailed({ message: messageOf(error) }))
  }, [])

  // Native, not React's: a sheet of an interactive request is in the dialog's DOM through a portal, and React sends
  // its events up its own tree, which does not pass through the dialog.
  const currentRef = useRef(current)

  currentRef.current = current

  useEffect(() => {
    const node = dialog.current

    if (!node) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // The Escape that ends an input method's composition is the input method's, not the sheet's.
        if (event.isComposing) {
          return
        }

        // Not an answer. For a form, a file request or a draft it is Later: the sheet goes away with what was entered,
        // the page is usable, and the transcript's record offers Open. For anything else it is no way out: a question
        // that is dismissed is a question the bot goes on waiting for. Nothing behind the dialog hears it either.
        event.preventDefault()
        event.stopPropagation()

        const now = currentRef.current

        if (now?.kind === 'interactive') {
          later.getState().putAway(now.key)
        }

        return
      }

      if (event.key !== 'Tab') {
        return
      }

      // What takes focus now: not a control a disabled fieldset switched off, nor a file input kept hidden behind a button.
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        element => !element.hidden && !element.matches(':disabled')
      )
      const first = focusable[0]
      const lastOne = focusable.at(-1)
      const active = node.ownerDocument.activeElement

      if (!first || !lastOne) {
        event.preventDefault()
        node.focus()

        return
      }

      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault()
        lastOne.focus()
      } else if (!event.shiftKey && active === lastOne) {
        event.preventDefault()
        first.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)

    return () => node.removeEventListener('keydown', onKeyDown)
  }, [currentKey, later])

  // Every sheet in its place: the current one in the dialog's slot, the ones put away in the parking place, and a
  // request that ended gone altogether (its put-away mark with it).
  useLayoutEffect(() => {
    const live = new Set(interactiveEntries.map(entry => entry.key))

    for (const entry of interactiveEntries) {
      const holder = holders.current.get(entry.key)
      const target = current?.key === entry.key ? slot.current : parking.current

      if (holder && target && holder.parentNode !== target) {
        target.appendChild(holder)
      }
    }

    for (const [key, holder] of holders.current) {
      if (!live.has(key)) {
        holder.remove()
        holders.current.delete(key)
      }
    }

    later.getState().prune([...live])
  })

  const waiting = ordered.length - 1

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

      <aside className="hm-requests__notices-area" aria-label={webStrings.gatewayNotices.area} data-modal-keep="">
        <PasskeyNotices store={passkeys} />
        <GatewayNotices />
      </aside>

      <div className="hm-requests__parking" ref={parking} hidden />

      {sheets
        ? interactiveEntries.flatMap(entry => {
            const asked = interactiveRequests.find(request => request.id === entry.id)

            if (!asked) {
              return []
            }

            let holder = holders.current.get(entry.key)

            if (!holder) {
              holder = document.createElement('div')
              holder.className = 'hm-requests__holder'
              holders.current.set(entry.key, holder)
            }

            const isCurrent = current?.key === entry.key

            return [
              createPortal(
                <BusyScope entryKey={entry.key} onBusy={reportBusy}>
                  <InteractiveSheetFor
                    sheets={sheets}
                    request={asked}
                    gateway={interactiveGateway}
                    shown={isCurrent}
                    // Only the sheet in the dialog is the dialog's heading and description.
                    titleId={isCurrent ? titleId : `${ids}-away-${entry.id}-title`}
                    descriptionId={isCurrent ? descriptionId : `${ids}-away-${entry.id}-description`}
                    {...(tapGuardMs !== undefined ? { tapGuardMs } : {})}
                    onAnswer={result =>
                      interactiveActions?.answer(asked.id, result) ?? Promise.resolve({ kind: 'closed' })
                    }
                    onSkip={() => interactiveActions?.skip(asked.id) ?? Promise.resolve({ kind: 'closed' })}
                    onCannotShow={reason => interactiveActions?.cannotShow(asked.id, reason) ?? 'closed'}
                    onLater={() => later.getState().putAway(entry.key)}
                    onUpload={
                      controller?.uploadFileTo
                        ? (path, file, options) => controller.uploadFileTo(path, file, options)
                        : undefined
                    }
                  />
                </BusyScope>,
                holder,
                entry.key
              )
            ]
          })
        : null}

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
          >
            {current.kind === 'engine' || displayName ? (
              <p className="hm-requests__from">
                <WithName phrase={name => webStrings.requests.from({ name })} name={shownName} />
              </p>
            ) : null}

            {current.kind === 'confirm' ? (
              confirmation ? (
                sheets ? (
                  <sheets.ConfirmSheet
                    key={current.key}
                    confirmation={confirmation}
                    rpId={rpId}
                    titleId={titleId}
                    descriptionId={descriptionId}
                    {...(tapGuardMs !== undefined ? { tapGuardMs } : {})}
                    onConfirm={() => void passkeyActions?.confirm(confirmation.id)}
                    onDecline={() => void passkeyActions?.decline(confirmation.id)}
                    onClose={() => passkeyActions?.dismiss(confirmation.id)}
                    onExpire={() => passkeyActions?.expire(confirmation.id)}
                  />
                ) : (
                  <ConfirmFallback confirmation={confirmation} titleId={titleId} descriptionId={descriptionId} />
                )
              ) : null
            ) : !sheets ? (
              // The sheets' chunk is not in memory yet (it is fetched when the session starts): nothing to press.
              <div className="hm-requests__pending" aria-busy="true" />
            ) : current.kind === 'secure' ? (
              prompt ? (
                <SecureSheetFor
                  sheets={sheets}
                  key={current.key}
                  prompt={prompt}
                  name={shownName}
                  gateway={gatewayHost}
                  titleId={titleId}
                  descriptionId={descriptionId}
                  {...(tapGuardMs !== undefined ? { tapGuardMs } : {})}
                  onAnswer={(value, identifier) => secureActions?.answer(prompt.id, value, identifier) ?? 'closed'}
                  onSkip={() => secureActions?.skip(prompt.id) ?? 'closed'}
                />
              ) : null
            ) : current.kind === 'interactive' ? (
              // The sheet itself is in `holders`, moved here (see above).
              <div className="hm-requests__slot" ref={slot} />
            ) : current.kind === 'connection' ? (
              card ? (
                <sheets.ConnectionSheet
                  key={current.key}
                  card={card}
                  name={shownName}
                  gateway={gatewayHost}
                  titleId={titleId}
                  descriptionId={descriptionId}
                  {...(tapGuardMs !== undefined ? { tapGuardMs } : {})}
                  onOpen={target => {
                    if (target.link) {
                      openLink(target.link.url)
                      signals?.connections.markOpened(card.chat, target.name)
                    }
                  }}
                  onSkip={target => void signals?.connections.skip(card.chat, target.name)}
                  onCancel={() => void signals?.connections.cancel(card.chat)}
                />
              ) : null
            ) : current.item.kind === 'approval' ? (
              <sheets.ApprovalSheet
                key={current.key}
                item={current.item}
                handle={current.bot}
                name={shownName}
                others={otherApprovals(queue, current)}
                {...(cwd ? { directory: cwd } : {})}
                titleId={titleId}
                descriptionId={descriptionId}
                {...(tapGuardMs !== undefined ? { tapGuardMs } : {})}
                onRespond={(choice, others) => {
                  // One by one, in one go: each is marked answered before anything is awaited (see `ApprovalSheet`).
                  for (const requestId of [current.item.requestId, ...others]) {
                    void controller
                      ?.respondApproval(current.bot, requestId, choice)
                      .catch(error => report(error, current.bot))
                  }
                }}
              />
            ) : (
              <sheets.ClarifySheet
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
                onCancelAll={() => {
                  void controller
                    ?.cancelClarify(current.bot, current.item.requestId)
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
