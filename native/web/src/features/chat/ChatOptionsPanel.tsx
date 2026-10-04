/**
 * The panel of the chat's options (`ChatOptions`): whose chat it is where the gateway has a reader to name
 * (`ChatChoice`), the verbosity as a radio group, bot-to-bot and thinking as checkboxes, and the way back to the default;
 * then, where the gateway has a notifier, what this chat may notify about.
 *
 * Its own module so it loads when the reader first opens the options, not with
 * the first screen: the button is on every chat, the panel is opened now and
 * then. Native controls, so every one is labelled and the keyboard works the way
 * it works everywhere; a change is written to the chat's view at once
 * (`state/chat-view.ts`) and the transcript follows it in the same frame.
 */
import { PUSH_TYPES } from '@hermie/gateway-client/push'
import { type KeyboardEvent, type ReactElement, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { chatViewFor, chatViewStore, hasChatViewOverride, VERBOSITIES } from '../../state/chat-view'
import type { ExportFormat } from './chat-export'
import { ExportOptions, SessionOptions } from './ConversationOptions'
import { ChatChoice } from './ChatChoice'
import type { ChatSessionRuntime } from './chat-runtime'
import { useSessionOptions } from './use-session-options'
import { pluginStore } from '../../state/plugin'
import { autoReadFor, ensureVoiceSettings, voiceSettingsStore } from '../../state/voice-settings'
import { canSpeak } from '../../platform/voice-capabilities'
import { botPushTypes, pushStore } from '../../state/push'
import { pushTypeLabel } from '../push/type-labels'
import type { YoloControl } from './use-yolo'

/** What a chat says about reading aloud: whether a read is going, and how to stop it. */
export interface VoiceControl {
  reading: boolean
  stop: () => void
}

export interface ChatOptionsPanelProps {
  /** The bot whose chat this is: the key its own view is kept under. */
  bot: string
  /** The name of the verbosity radio group: unique on the page. */
  name: string
  panelRef: RefObject<HTMLDivElement | null>
  /** YOLO mode of this chat; absent where the chat has no session of its own to switch it on (a past conversation). */
  yolo?: YoloControl
  /** What the session's options talk to the gateway through; absent in a render without a gateway. */
  runtime?: ChatSessionRuntime | null
  /** A past conversation or a branch: no session of its own, so no session options. */
  viewer?: boolean
  /** Write the conversation to a file; absent where there is nothing on screen to write. */
  exportChat?: (format: ExportFormat) => void
  /** What is being read aloud in this chat; absent where the chat cannot read (a gallery). */
  voice?: VoiceControl
}

/**
 * Whether this chat reads each finished reply aloud without being asked, on this browser (`state/voice-settings.ts`:
 * device-local, per chat), and a way to stop a read that is going. Drawn only where the browser can speak. The rate,
 * the language and the rest are the whole browser's, in Settings, Voice.
 */
function VoiceOptions({ bot, voice }: { bot: string; voice: VoiceControl | undefined }): ReactElement | null {
  const hintId = useId()

  // Read from the store the page already opened, before the first read of the choice below.
  useState(() => ensureVoiceSettings())

  const on = useStore(voiceSettingsStore, state => autoReadFor(state, bot))

  if (!canSpeak()) {
    return null
  }

  return (
    <div className="hm-chat-options__option">
      <p className="hm-chat-options__heading">{strings.chat.voice.header}</p>
      <label className="hm-chat-options__choice">
        <input
          type="checkbox"
          checked={on}
          aria-describedby={hintId}
          onChange={event => voiceSettingsStore.getState().setAutoRead(bot, event.currentTarget.checked)}
        />
        <span>{strings.chat.voice.autoRead}</span>
      </label>
      <p className="hm-chat-options__hint" id={hintId}>
        {strings.chat.voice.autoReadHint}
      </p>
      {/* Only while there is something to stop: a Stop that does nothing almost all of the time is a control to skip. */}
      {voice?.reading ? (
        <button type="button" className="hm-chat-options__reset" onClick={voice.stop}>
          {strings.chat.menu.stopReading}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The one option that talks to the gateway: skip this chat's approval requests.
 *
 * Turning it ON asks first, inline and under the switch: the switch stays off
 * until the reader says yes, and focus goes to Cancel, so a stray Return
 * enables nothing. Turning it OFF is the switch alone. Escape in the question
 * withdraws it and nothing more (the panel stays open).
 */
function YoloOption({ yolo }: { yolo: YoloControl }): ReactElement {
  const hintId = useId()
  const questionId = useId()
  const [confirming, setConfirming] = useState(false)
  const box = useRef<HTMLInputElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // The question is for turning it on: it goes when it is on already, and when the chat can no longer be switched.
  const asking = confirming && !yolo.on && yolo.available

  useEffect(() => {
    if (asking) {
      cancel.current?.focus()
    }
  }, [asking])

  const withdraw = (): void => {
    setConfirming(false)
    box.current?.focus()
  }

  return (
    <div className="hm-chat-options__option">
      <label className="hm-chat-options__choice">
        <input
          ref={box}
          type="checkbox"
          checked={yolo.on}
          disabled={!yolo.available}
          aria-busy={yolo.busy || undefined}
          aria-describedby={hintId}
          onChange={event => {
            if (yolo.busy) {
              return
            }

            if (event.currentTarget.checked) {
              setConfirming(true)
            } else {
              setConfirming(false)
              void yolo.set(false)
            }
          }}
        />
        <span>{strings.chat.options.yolo}</span>
      </label>
      <p className="hm-chat-options__hint" id={hintId}>
        {strings.chat.options.yoloHint}
      </p>

      {asking ? (
        <div
          className="hm-chat-options__confirm"
          role="group"
          aria-labelledby={questionId}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Escape') {
              // Withdraws the question only: the panel's own Escape handler leaves a prevented key alone.
              event.preventDefault()
              withdraw()
            }
          }}
        >
          <p id={questionId}>{webStrings.chat.yolo.confirm}</p>
          <div className="hm-chat-options__confirm-actions">
            <button
              type="button"
              className="hm-chat-options__reset"
              onClick={() => {
                setConfirming(false)
                box.current?.focus()
                void yolo.set(true)
              }}
            >
              {webStrings.chat.yolo.confirmAction}
            </button>
            <button ref={cancel} type="button" className="hm-chat-options__reset" onClick={withdraw}>
              {webStrings.chat.yolo.cancel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function ChatOptionsPanel({
  bot,
  name,
  panelRef,
  yolo,
  runtime = null,
  viewer = false,
  exportChat,
  voice
}: ChatOptionsPanelProps): ReactElement {
  useLocale()

  const headingId = useId()
  const conversationId = useId()
  const resetHintId = useId()
  const view = useStore(
    chatViewStore,
    useShallow(state => chatViewFor(state, bot))
  )
  const overridden = useStore(chatViewStore, state => hasChatViewOverride(state, bot))
  const { setChatView, resetChatView } = chatViewStore.getState()
  const {
    options: session,
    error: sessionError,
    dismissError: dismissSessionError
  } = useSessionOptions(bot, runtime, viewer)

  // What is there to show: the switches that talk to the gateway only while the chat can be switched.
  const yoloControl = yolo && (yolo.available || yolo.on) ? yolo : undefined
  const sessionControl = session.available ? session : undefined
  const prepare = sessionControl?.prepare

  // What the options open on: the gateway's models and a fresh reading of the context window.
  useEffect(() => {
    prepare?.()
  }, [prepare])

  return (
    <div ref={panelRef} className="hm-chat-options__panel" role="group" aria-labelledby={headingId}>
      {/* The shared Bot Chat or the reader's own (ADR-0007, amended): drawn only where the gateway named the reader. */}
      {viewer ? null : <ChatChoice bot={bot} controller={runtime?.controller} />}

      <p className="hm-chat-options__heading" id={headingId}>
        {strings.chat.options.viewHeader}
      </p>

      <fieldset className="hm-chat-options__set" data-verbosity="">
        <legend>{strings.chat.options.verbosity}</legend>
        {VERBOSITIES.map(level => (
          <label className="hm-chat-options__choice" key={level}>
            <input
              type="radio"
              name={name}
              value={level}
              checked={view.level === level}
              onChange={() => setChatView(bot, { level })}
            />
            <span>{strings.chat.options.verbosityOptions[level]}</span>
          </label>
        ))}
      </fieldset>

      <label className="hm-chat-options__choice">
        <input
          type="checkbox"
          checked={view.showBotToBot}
          onChange={event => setChatView(bot, { showBotToBot: event.currentTarget.checked })}
        />
        <span>{strings.chat.options.showBotToBot}</span>
      </label>

      <label className="hm-chat-options__choice">
        <input
          type="checkbox"
          checked={view.showThinking}
          onChange={event => setChatView(bot, { showThinking: event.currentTarget.checked })}
        />
        <span>{strings.chat.options.showThinking}</span>
      </label>

      <p className="hm-chat-options__note">
        {overridden ? strings.chat.options.usingOverride : strings.chat.options.usingDefault}
      </p>

      {overridden ? (
        <>
          <button
            type="button"
            className="hm-chat-options__reset"
            aria-describedby={resetHintId}
            onClick={() => {
              // Drawn at once, so the radio in force is the one checked when focus lands on it.
              flushSync(() => resetChatView(bot))
              // This button goes with the override; focus stays in the panel, on the verbosity now in force.
              panelRef.current?.querySelector<HTMLInputElement>('[data-verbosity] input[type="radio"]:checked')?.focus()
            }}
          >
            {strings.chat.options.useDefault}
          </button>
          <p className="hm-chat-options__hint" id={resetHintId}>
            {strings.chat.options.useDefaultHint}
          </p>
        </>
      ) : null}

      <VoiceOptions bot={bot} voice={voice} />

      {yoloControl || sessionControl || sessionError || exportChat ? (
        <div className="hm-chat-options__conversation" role="group" aria-labelledby={conversationId}>
          <p className="hm-chat-options__heading" id={conversationId}>
            {strings.chat.options.thisChatHeader}
          </p>
          {yoloControl ? <YoloOption yolo={yoloControl} /> : null}
          {sessionControl ? <SessionOptions session={sessionControl} /> : null}
          {sessionError ? (
            <div className="hm-chat-options__alert" role="alert">
              <p>{sessionError}</p>
              <button type="button" className="hm-chat-options__reset" onClick={dismissSessionError}>
                {webStrings.chat.yolo.dismiss}
              </button>
            </div>
          ) : null}
          {exportChat ? <ExportOptions onExport={exportChat} /> : null}
        </div>
      ) : null}

      <ChatNotifications bot={bot} panelRef={panelRef} />
    </div>
  )
}

/**
 * What this chat may notify the reader about: the global types (Settings ›
 * Notifications) with this chat's own overrides folded in. A box set back to what
 * the global type says stops overriding it, so the chat follows the global switch
 * again as it moves. The overrides belong to the person and follow them to every
 * device (`state/push.ts`). Shown only where a plugin can send notifications at all.
 */
function ChatNotifications({
  bot,
  panelRef
}: {
  bot: string
  panelRef: RefObject<HTMLDivElement | null>
}): ReactElement | null {
  const hintId = useId()
  const notifier = useStore(pluginStore, state => state.advert !== null)
  const global = useStore(
    pushStore,
    useShallow(state => state.types)
  )
  const effective = useStore(
    pushStore,
    useShallow(state => botPushTypes(state, bot))
  )
  const overridden = useStore(pushStore, state => state.perBot[bot] !== undefined)

  if (!notifier) {
    return null
  }

  const words = strings.chat.notifications

  return (
    <>
      <fieldset className="hm-chat-options__set" aria-describedby={hintId} data-push-types="">
        <legend>{words.label}</legend>
        {PUSH_TYPES.map(type => (
          <label className="hm-chat-options__choice" key={type}>
            <input
              type="checkbox"
              checked={effective[type]}
              onChange={event => {
                const on = event.currentTarget.checked

                pushStore.getState().setBotType(bot, type, on === global[type] ? null : on)
              }}
            />
            <span>{pushTypeLabel(type)}</span>
          </label>
        ))}
      </fieldset>
      <p className="hm-chat-options__hint" id={hintId}>
        {overridden ? words.overridden : words.following} {words.hint}
      </p>
      {overridden ? (
        <button
          type="button"
          className="hm-chat-options__reset"
          onClick={() => {
            flushSync(() => pushStore.getState().resetBotTypes(bot))
            // This button goes with the overrides; focus stays in the panel, on the first type.
            panelRef.current?.querySelector<HTMLInputElement>('[data-push-types] input[type="checkbox"]')?.focus()
          }}
        >
          {words.useDefault}
        </button>
      ) : null}
    </>
  )
}
