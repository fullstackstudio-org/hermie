/**
 * The panel of the chat's options (`ChatOptions`): the verbosity as a radio
 * group, bot-to-bot and thinking as checkboxes, and the way back to the default.
 *
 * Its own module so it loads when the reader first opens the options, not with
 * the first screen: the button is on every chat, the panel is opened now and
 * then. Native controls, so every one is labelled and the keyboard works the way
 * it works everywhere; a change is written to the chat's view at once
 * (`state/chat-view.ts`) and the transcript follows it in the same frame.
 */
import { type ReactElement, type RefObject, useId } from 'react'
import { flushSync } from 'react-dom'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { chatViewFor, chatViewStore, hasChatViewOverride, VERBOSITIES } from '../../state/chat-view'

export interface ChatOptionsPanelProps {
  /** The bot whose chat this is: the key its own view is kept under. */
  bot: string
  /** The name of the verbosity radio group: unique on the page. */
  name: string
  panelRef: RefObject<HTMLDivElement | null>
}

export function ChatOptionsPanel({ bot, name, panelRef }: ChatOptionsPanelProps): ReactElement {
  useLocale()

  const headingId = useId()
  const resetHintId = useId()
  const view = useStore(
    chatViewStore,
    useShallow(state => chatViewFor(state, bot))
  )
  const overridden = useStore(chatViewStore, state => hasChatViewOverride(state, bot))
  const { setChatView, resetChatView } = chatViewStore.getState()

  return (
    <div ref={panelRef} className="hm-chat-options__panel" role="group" aria-labelledby={headingId}>
      <p className="hm-chat-options__heading" id={headingId}>
        {strings.chat.options.viewHeader}
      </p>

      <fieldset className="hm-chat-options__set">
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
              panelRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus()
            }}
          >
            {strings.chat.options.useDefault}
          </button>
          <p className="hm-chat-options__hint" id={resetHintId}>
            {strings.chat.options.useDefaultHint}
          </p>
        </>
      ) : null}
    </div>
  )
}
