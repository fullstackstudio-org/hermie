/**
 * The composer: a field that grows with what is typed, Send, and Stop while a
 * reply runs.
 *
 * **Rules, each the native apps' (`expo/hermie/src/chat-ui/Composer.tsx` and the
 * chat screen's send):**
 *
 *  - Return sends, Shift+Return breaks the line, an input method's Return never
 *    sends (`send-key.ts`).
 *  - The words are kept per chat (`drafts.ts`) and put back where the reader left
 *    them, and a send that fails puts them back in the field: they are the
 *    reader's, not ours to lose.
 *  - Typing stays possible while the gateway cannot carry a send (a reconnect is
 *    a good moment to write the next message and a bad one to send it); Send is
 *    what is switched off, never Stop.
 *  - A line that begins with a slash is a command only if the gateway has one by
 *    that name (`slashRouteFor`, from the catalogue it keeps per session). Then it
 *    runs (`runSlash`) and its answer lands in the transcript; anything else,
 *    `/usr/local/bin` or a sentence that happens to begin with a slash, goes as a
 *    prompt. A command that answers with a prefill hands text for the field.
 *  - While a reply runs a send is parked by the controller and drawn as a chip
 *    (`QueuedStrip`): Steer, Edit, Delete. The turn claim before a model turn is
 *    the controller's too (`send`, when the plugin advertises
 *    `context.turn_claim`).
 *  - Stop is `stopTurn`: the interrupt on the gateway, and the chat marked
 *    interrupted so the field comes back whatever the gateway answers.
 *
 * **Completions.** While the line starts with a slash the gateway is asked what
 * could follow (`querySlash`), and the answer is a list under the field. Only the
 * newest question may paint: answers arrive out of order, and the wide list for
 * `/` must not land over the narrow one for `/mo`. The field names the list it
 * controls and the item it is on (`aria-controls`, `aria-activedescendant`).
 * Up and Down move, Tab or Return takes the item, Escape closes the list.
 *
 * **Attachments** (W-19) come from the attach button (the browser's file
 * dialog), a paste of files into the field (`paste.ts`) and a drop on the chat
 * (`DropZone`, which the chat screen puts around the composer), and all three
 * end in the chat's `AttachmentTray` (`core/chats/attachments.ts`): an image is
 * read for `image.attach_bytes`, anything else is uploaded as it is staged and
 * named in the prompt by its `@file:` reference. A message may be attachments
 * and no words. Send waits while a chip is still working or has failed, so what
 * the tray shows is what goes, and the tray is emptied in the same synchronous
 * step that decides to send (`take`): a second Return or click landing while the
 * first send is in flight finds nothing to send again (HERM-126). A send that
 * fails puts the attachments back, with the words. A slash command takes no
 * attachments: they stay staged for the next message.
 *
 * **A turn put back** (`prefill`, from a message's "Edit and resend") lands in the
 * field ahead of whatever was typed, which stays after it (`mergeIntoDraft`), and
 * the field takes focus with the caret at the end. Sending it starts a new turn.
 *
 * **Dictation** is a microphone beside the field, drawn only where the browser has a recogniser (`canDictate`) and
 * fetched then (`features/voice/DictationButton`, a chunk of its own). What is heard goes into the field at the caret as it
 * is heard; the field is the reader's to read, change and send. A change to the field that dictation did not make
 * ends the session, so a result that arrives after a send cannot put the sentence back. Where it listens, what it
 * says about it (listening, or why it did not work) is the line under the field.
 *
 * Nothing here talks to the gateway except through the controller, and the text
 * the bot or the reader wrote is never Markdown in this component.
 */
import { parseSlashCommand, looksLikeSlashCommand } from '@hermes/shared/slash'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  lazy,
  type ReactElement,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useStore } from 'zustand'

import type { AttachmentTray } from '../../core/chats/attachments'
import { mergeIntoDraft } from '../../core/chats/edit-resend'
import { ownedElsewhereDetails } from '../../core/session-ownership'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { hasFinePointer } from '../../platform/input-kind'
import { chatsStore, type QueuedMessage } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { Button } from '../../ui/primitives'
import { canDictate } from '../../platform/voice-capabilities'
import type { DictationSnapshot } from '../voice/dictation'
import { noticeFor } from '../voice/dictation-notice'
import { AttachMenu } from './AttachMenu'
import { AttachmentChips } from './AttachmentChips'
import { useChatRuntime } from './chat-runtime'
import { filesFromPaste } from './paste'
import { QueuedStrip } from './QueuedStrip'
import { decideKey } from './send-key'
import { useStagedAttachments } from './use-attachment-tray'
import { usePageVisible } from './use-page-visible'
import './composer.css'

/** The microphone: a chunk of its own, fetched only where the browser can dictate. */
const DictationButton = lazy(() =>
  import('../voice/DictationButton').then(module => ({ default: module.DictationButton }))
)

/** How long after the last keystroke the draft is written down. */
const DRAFT_WRITE_MS = 300

/** How many completions are listed. */
const MAX_COMPLETIONS = 6

/** The queue of a chat that has none: one array, so the selector does not see a change. */
const NO_QUEUE: readonly QueuedMessage[] = []

export interface ComposerProps {
  /** The chat's key in the chat store: what the controller addresses it by. */
  chatKey: string
  /** The name to show: the bot's display name. */
  botName: string
  /** The reader just sent a message (or ran a command): keep the transcript pinned to the newest row. */
  onSent?: () => void
  /**
   * The chat's attachment tray (`useAttachmentTray`), shared with the drop zone
   * over the chat. Without one the composer offers no attachments.
   */
  tray?: AttachmentTray | null
  /**
   * Words to put in the field from outside, once per `serial` (a message's "Edit and resend"). A prefill that is
   * already there when the composer mounts has been handled by an earlier one.
   */
  prefill?: ComposerPrefill | null
}

/** Text for the field from somewhere other than typing; a new `serial` is a new request. */
export interface ComposerPrefill {
  text: string
  serial: number
}

interface Completion {
  /** What is listed. */
  name: string
  /** What the gateway says it is. */
  description: string
  /** What the field holds once it is taken. */
  insert: string
}

interface CompletionState {
  items: Completion[]
  loading: boolean
  failure: string | null
}

/**
 * The gateway refused the message because another Hermes window or terminal has this chat open
 * (`SESSION_NOT_OWNED`, 4090). `details` is its own line about who holds it, empty when it sent none;
 * `words` are the refused words, which "Start new chat" puts in the empty field of the new chat.
 */
interface OwnedElsewhere {
  kind: 'owned-elsewhere'
  details: string
  words: string
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function Composer({ chatKey, botName, onSent, tray = null, prefill = null }: ComposerProps): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const controller = runtime?.controller
  const drafts = runtime?.drafts
  const visible = usePageVisible()
  const keyboardLikely = hasFinePointer()

  const running = useStore(chatsStore, state => state.chats[chatKey]?.turn.active ?? false)
  const attached = useStore(chatsStore, state => state.chats[chatKey]?.runtimeSessionId !== undefined)
  const queued = useStore(chatsStore, state => state.queues[chatKey] ?? NO_QUEUE)
  const ready = useStore(connectionStore, state => state.status === 'ready')
  // Send is what a closed gateway switches off; the field, Stop and the strip stay as they are.
  const canSend = Boolean(controller) && ready && attached
  const staged = useStagedAttachments(tray)
  // A file is uploaded into the session's workspace, which a chat names once it is attached.
  const canAttach = tray !== null && attached

  const [text, setText] = useState(() => drafts?.read(chatKey) ?? '')
  const [failure, setFailure] = useState<string | OwnedElsewhere | null>(null)
  const [startingNew, setStartingNew] = useState(false)
  const [dictation, setDictation] = useState<DictationSnapshot | null>(null)
  const dictates = canDictate()
  const field = useRef<HTMLTextAreaElement>(null)
  const textRef = useRef(text)

  textRef.current = text

  // ── the draft ───────────────────────────────────────────────────────────────
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushDraft = useCallback(() => {
    if (writeTimer.current !== null) {
      clearTimeout(writeTimer.current)
      writeTimer.current = null
    }

    drafts?.write(chatKey, textRef.current)
  }, [chatKey, drafts])

  const keepDraft = useCallback(() => {
    if (writeTimer.current !== null) {
      clearTimeout(writeTimer.current)
    }

    writeTimer.current = setTimeout(flushDraft, DRAFT_WRITE_MS)
  }, [flushDraft])

  // Leaving the screen, or the tab going to the background (which may be the last the page does): write it down.
  useEffect(() => flushDraft, [flushDraft])
  useEffect(() => {
    if (!visible) {
      flushDraft()
    }
  }, [flushDraft, visible])

  /** Set the field's text from somewhere other than typing. */
  const put = useCallback(
    (next: string) => {
      textRef.current = next
      setText(next)
      keepDraft()
    },
    [keepDraft]
  )

  // ── a turn put back ─────────────────────────────────────────────────────────
  const prefilled = useRef(prefill?.serial ?? 0)
  /** The next paint of the field ends with focus on it and the caret after the last word. */
  const caretAtEnd = useRef(false)

  useEffect(() => {
    if (!prefill || prefill.serial === prefilled.current) {
      return
    }

    prefilled.current = prefill.serial
    caretAtEnd.current = true
    put(mergeIntoDraft(textRef.current, prefill.text))
  }, [prefill, put])

  // ── the field grows ─────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const element = field.current

    if (!element) {
      return
    }

    if (caretAtEnd.current) {
      caretAtEnd.current = false
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    }

    // Shrunk first, or a field that once held ten lines would never get smaller; set through the CSSOM, which
    // the document's policy allows (it forbids only a `style` attribute in markup).
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text])

  // ── completions ─────────────────────────────────────────────────────────────
  const listId = useId()
  const [completions, setCompletions] = useState<CompletionState | null>(null)
  const [active, setActive] = useState(0)
  /** The list was closed with Escape; it stays closed until the reader types again. */
  const [dismissed, setDismissed] = useState(false)
  const slashSeq = useRef(0)
  const slashAnswered = useRef(false)

  const askSlash = useCallback(
    (typed: string) => {
      if (!controller) {
        return
      }

      slashSeq.current += 1

      const seq = slashSeq.current

      if (!slashAnswered.current) {
        setCompletions(current => ({ items: current?.items ?? [], loading: true, failure: null }))
      }

      void controller
        .querySlash(chatKey, typed)
        .then(({ failure: refused, items, replaceFrom }) => {
          if (seq !== slashSeq.current) {
            return
          }

          slashAnswered.current = true
          setActive(0)
          setCompletions({
            loading: false,
            failure: refused ? refused.method : null,
            items: items.slice(0, MAX_COMPLETIONS).map(item => {
              const name = (item.display ?? item.text).replace(/^\//u, '')

              return {
                name,
                description: item.meta ?? '',
                // The gateway says how much of the line its answer stands for; without it, a bare command name.
                insert: replaceFrom === undefined ? `/${name} ` : `${typed.slice(0, replaceFrom)}${item.text}`
              }
            })
          })
        })
        .catch(() => {
          if (seq === slashSeq.current) {
            // Not as far as the gateway: this chat has no session yet. The same row as a refusal.
            setCompletions({ items: [], loading: false, failure: 'complete.slash' })
          }
        })
    },
    [chatKey, controller]
  )

  const closeCompletions = useCallback(() => {
    slashSeq.current += 1
    setCompletions(null)
  }, [])

  const onChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value

      textRef.current = next
      setText(next)
      // What went wrong with a send goes with the next change to the words. A chat that is open in another
      // window stays: it is about the chat, not the words, and "Start new chat" is still the way out.
      setFailure(current => (typeof current === 'object' ? current : null))
      keepDraft()
      setDismissed(false)

      if (next.startsWith('/') && !next.includes('\n')) {
        askSlash(next)
      } else {
        closeCompletions()
      }
    },
    [askSlash, closeCompletions, keepDraft]
  )

  const listOpen =
    completions !== null &&
    !dismissed &&
    (completions.items.length > 0 || completions.failure !== null || completions.loading)
  const optionId = (index: number): string => `${listId}-${index}`

  const takeCompletion = useCallback(
    (item: Completion) => {
      put(item.insert)
      // The field holds the line again: ask what could follow it, as typing would have.
      askSlash(item.insert)
      field.current?.focus()
    },
    [askSlash, put]
  )

  // ── sending ─────────────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    const body = textRef.current.trim()

    if (!controller || !canSend) {
      return
    }

    const slash =
      body !== '' &&
      looksLikeSlashCommand(body) &&
      controller.slashRouteFor(chatKey, parseSlashCommand(body).name) !== null

    // A chip still working or failed holds a message back: what the tray shows is what goes. A command takes none.
    if (!slash && tray?.blocked) {
      return
    }
    // Out of the tray now, before anything is awaited: a second Return or click landing while this send is in
    // flight finds the tray empty, and with the field empty too, nothing to send (HERM-126).
    const taken = slash ? null : (tray?.take() ?? null)

    if (!body && !taken) {
      return
    }

    // Emptied first: a second Return landing while this one is in flight finds nothing left to send.
    put('')
    flushDraft()
    closeCompletions()
    setFailure(null)

    /** The words come back, ahead of anything typed since, and so do the attachments. */
    const restore = (error: unknown): void => {
      const typedSince = textRef.current

      if (body !== '') {
        put(typedSince.trim() === '' ? body : `${body}\n${typedSince}`)
        flushDraft()
      }

      if (taken) {
        tray?.restore(taken)
      }

      const details = ownedElsewhereDetails(error)

      // Never sent again by itself: the way out is a new chat, which the reader asks for.
      setFailure(
        details === null
          ? webStrings.composer.sendFailed({ message: messageOf(error) })
          : { kind: 'owned-elsewhere', details, words: body }
      )
    }

    try {
      if (slash) {
        onSent?.()

        const outcome = await controller.runSlash(chatKey, body)

        // A `prefill` is text for the field, which the controller does not reach into.
        if (outcome.prefill !== undefined) {
          put(outcome.prefill)
        }

        return
      }

      // Before the round trip: the optimistic bubble is painted at once, and the view is already where it will land.
      onSent?.()

      if (taken) {
        await controller.send(chatKey, body, taken.inputs)
        tray?.release(taken)
      } else {
        await controller.send(chatKey, body)
      }
    } catch (error) {
      restore(error)
    }
  }, [canSend, chatKey, closeCompletions, controller, flushDraft, onSent, put, tray])

  // ── a chat that is open elsewhere ───────────────────────────────────────────
  /**
   * The way out of the gateway's "this chat is open in another window" refusal: a new conversation, as `/new`
   * starts one, and the refused words in its empty field. Nothing is sent: that is the reader's to do.
   */
  const startNewChat = useCallback(async () => {
    if (!controller || startingNew || failure === null || typeof failure === 'string') {
      return
    }

    const { words } = failure

    setStartingNew(true)
    setFailure(null)

    try {
      await controller.startNewConversation(chatKey)

      if (words.trim() !== '' && textRef.current.trim() === '') {
        caretAtEnd.current = true
        put(words)
        flushDraft()
      }
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setStartingNew(false)
    }
  }, [chatKey, controller, failure, flushDraft, put, startingNew])

  // ── attaching ───────────────────────────────────────────────────────────────
  const attach = useCallback(
    (files: File[]) => {
      if (canAttach && tray) {
        setFailure(null)
        tray.add(files)
      }
    },
    [canAttach, tray]
  )

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!canAttach) {
        return
      }

      const files = filesFromPaste(event.clipboardData)

      if (files.length > 0) {
        // The files are what was meant; their names or a picture's placeholder text are not for the field.
        event.preventDefault()
        attach(files)
      }
    },
    [attach, canAttach]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (listOpen && completions && completions.items.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setActive(current => {
            const count = completions.items.length

            return (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
          })

          return
        }

        if ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'Enter' && !event.nativeEvent.isComposing)) {
          const item = completions.items[active] ?? completions.items[0]

          if (item) {
            event.preventDefault()
            takeCompletion(item)

            return
          }
        }
      }

      if (event.key === 'Escape' && listOpen) {
        event.preventDefault()
        setDismissed(true)

        return
      }

      const decision = decideKey(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          isComposing: event.nativeEvent.isComposing,
          keyCode: event.keyCode
        },
        keyboardLikely
      )

      if (decision === 'send') {
        event.preventDefault()
        void submit()
      }
    },
    [active, completions, keyboardLikely, listOpen, submit, takeCompletion]
  )

  // ── stopping ────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (!controller) {
      return
    }

    setFailure(null)
    controller.stopTurn(chatKey).catch((error: unknown) => setFailure(messageOf(error)))
  }, [chatKey, controller])

  // ── the queue ───────────────────────────────────────────────────────────────
  const steer = useCallback(
    (id: string) => {
      if (!controller) {
        return
      }

      setFailure(null)
      controller
        .steerQueued(chatKey, id)
        .then(status => {
          if (status === 'rejected') {
            setFailure(strings.chat.queue.steerRejected)
          }
        })
        .catch((error: unknown) => setFailure(webStrings.composer.steerFailed({ message: messageOf(error) })))
    },
    [chatKey, controller]
  )

  const edit = useCallback(
    (id: string) => {
      const taken = controller?.editQueued(chatKey, id)

      if (taken === undefined) {
        return
      }

      const current = textRef.current

      put(current.trim() === '' ? taken : `${taken}\n${current}`)
      field.current?.focus()
    },
    [chatKey, controller, put]
  )

  const remove = useCallback((id: string) => controller?.deleteQueued(chatKey, id), [chatKey, controller])

  const blocked = staged.some(item => item.status !== 'ready')
  const sendable = canSend && !blocked && (text.trim() !== '' || staged.length > 0)
  const hintId = `${listId}-hint`
  const waitingId = `${listId}-waiting`

  return (
    <div className="hm-composer">
      <QueuedStrip queued={queued} onSteer={steer} onEdit={edit} onDelete={remove} />

      {typeof failure === 'string' && failure !== '' ? (
        // Scrolls when long (the gateway's words can be any length), so it is a stop for the keyboard too.
        <p className="hm-composer__failure" role="alert" tabIndex={0}>
          {failure}
        </p>
      ) : null}

      {failure !== null && typeof failure === 'object' ? (
        <div className="hm-composer__owned">
          <p className="hm-composer__failure" role="alert">
            {sheetStrings.composer.ownedElsewhere.sentence}
          </p>
          {failure.details !== '' ? (
            <p className="hm-composer__failure-details" title={failure.details}>
              {sheetStrings.composer.ownedElsewhere.details({ detail: failure.details })}
            </p>
          ) : null}
          <div>
            <Button variant="quiet" disabled={startingNew} onClick={() => void startNewChat()}>
              {sheetStrings.composer.ownedElsewhere.startNewChat}
            </Button>
          </div>
        </div>
      ) : null}

      {listOpen && completions ? (
        <ul className="hm-composer__list" id={listId} role="listbox" aria-label={webStrings.composer.commandsLabel}>
          {completions.items.map((item, index) => (
            <li
              key={item.insert}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className="hm-composer__option"
              // Taking it must not move focus off the field first, or the field's blur would close the list.
              onMouseDown={event => event.preventDefault()}
              onClick={() => takeCompletion(item)}
            >
              <span className="hm-composer__option-name">/{item.name}</span>
              {item.description ? <span className="hm-composer__option-hint">{item.description}</span> : null}
            </li>
          ))}
          {completions.items.length === 0 && completions.failure ? (
            <li className="hm-composer__note" role="presentation">
              {strings.chat.composer.slashUnavailable({ method: completions.failure })}
            </li>
          ) : null}
          {completions.items.length === 0 && !completions.failure && completions.loading ? (
            <li className="hm-composer__note" role="presentation">
              {strings.chat.composer.slashLoading}
            </li>
          ) : null}
        </ul>
      ) : null}

      {tray ? <AttachmentChips tray={tray} attachments={staged} waitingId={waitingId} /> : null}

      {dictation?.phase === 'listening' ? (
        <p className="hm-composer__listening" role="status">
          {strings.chat.voice.listening}
        </p>
      ) : null}
      {dictation?.phase === 'error' && noticeFor(dictation.failure) ? (
        <p className="hm-composer__failure" role={dictation.failure === 'no-speech' ? 'status' : 'alert'}>
          {noticeFor(dictation.failure)}
        </p>
      ) : null}

      <div className="hm-composer__row">
        {tray ? <AttachMenu onFiles={attach} disabled={!canAttach} /> : null}
        <label className="hm-sr" htmlFor={`${listId}-field`}>
          {strings.chat.composer.messageTo({ bot: botName })}
        </label>
        <textarea
          id={`${listId}-field`}
          ref={field}
          className="hm-composer__field"
          data-composer-field=""
          rows={1}
          value={text}
          placeholder={strings.chat.composer.placeholder}
          enterKeyHint={keyboardLikely ? 'send' : 'enter'}
          autoComplete="off"
          aria-describedby={keyboardLikely ? hintId : undefined}
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen && completions && completions.items.length > 0 ? optionId(active) : undefined}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={closeCompletions}
        />
        {dictates ? (
          <Suspense fallback={null}>
            <DictationButton field={field} value={text} onValue={put} onState={setDictation} />
          </Suspense>
        ) : null}
        {running ? (
          <Button variant="quiet" className="hm-composer__stop" onClick={stop}>
            {strings.app.chat.stop}
          </Button>
        ) : null}
        <Button
          className="hm-composer__send"
          disabled={!sendable}
          aria-label={
            staged.length > 0 ? strings.chat.composer.sendWithAttachments({ count: staged.length }) : undefined
          }
          aria-describedby={blocked ? waitingId : undefined}
          onClick={() => void submit()}
        >
          {strings.app.chat.send}
        </Button>
      </div>

      {keyboardLikely ? (
        <p className="hm-composer__hint" id={hintId}>
          {strings.chat.composer.keyHint}
        </p>
      ) : null}
    </div>
  )
}
