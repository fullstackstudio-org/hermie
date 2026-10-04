/**
 * "Shared Bot Chat / My chat", as one control: the Expo app's `ChatChoiceRow` (ADR-0007, amended), drawn on the chat's
 * options panel and on the Conversations page, which is why it is a component of its own: the two surfaces have to
 * agree about the labels, about which one is on, and about what happens while the gateway is thinking.
 *
 * A bot has one shared chat, the hidden `Bot Chat` everybody on the gateway can reach, and, where the gateway has
 * said who the reader is, a chat of their own beside it (`Chat · <name>`) that only they use. The choice is the
 * reader's, per bot, and follows them to every device (`state/layout.ts`: `myChats`, `current`, through the gateway's
 * `ui_meta`). Choosing My chat finds the reader's chat on this bot, or makes it the first time (the controller's
 * `chooseChat`, never two: the lookup is shared and fails closed).
 *
 * Three things it does that a bare pair of radios does not:
 *
 *  - **It draws nothing at all when there is no identity.** A gateway that never said who this is has one chat per
 *    bot and always did, so the control is absent, not disabled: a disabled control promises that something could
 *    be turned on.
 *  - **It holds the pending choice.** Switching is a resolve and a re-open, two round trips on a cold bot; the radio
 *    moves at the press and moves back if the gateway refuses, and it says which, in a polite line (a refusal is an
 *    alert, in the gateway's words, as plain text). A press while a switch is on its way does nothing.
 *  - **It says who else is reading**, in the note under the radios: "shared" is not something to infer from a word.
 *
 * A bot whose reply is running, or that has a queue waiting, cannot be moved off its chat (the controller refuses
 * before anything changes), and the refusal says so in the sentence the Conversations page already uses.
 */
import { type ReactElement, useId, useState } from 'react'
import { useStore } from 'zustand'

import { ConversationBusyError } from '../../core/chat-controller'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { layoutStore } from '../../state/layout'
import type { ChatScreenController } from './chat-runtime'
import './chat-choice.css'

type Choice = 'shared' | 'mine'

/** The longest part of the gateway's own reason that is shown. */
const REASON_CHARS = 300

export interface ChatChoiceProps {
  /** The bot whose chat this is. */
  bot: string
  /**
   * What switches. Absent in a render without a gateway, and a controller that cannot say whether the reader has a
   * chat of their own is one that has none: nothing is drawn in either case.
   */
  controller: Partial<Pick<ChatScreenController, 'chooseChat' | 'ownChatsAvailable'>> | undefined
  /** Called once a switch has happened (the Conversations page reads its list again). */
  onChosen?: () => void
}

/** A refusal as the reader is told it: a busy bot has its own sentence, the rest carry the gateway's reason. */
function failureText(error: unknown): string {
  if (error instanceof ConversationBusyError) {
    return strings.chat.sessions.busy
  }

  const reason = error instanceof Error ? error.message : String(error)

  return sheetStrings.sessions.actionFailed({
    message: displayText(reason, REASON_CHARS) || strings.chat.sessions.switchFailed
  })
}

export function ChatChoice({ bot, controller, onChosen }: ChatChoiceProps): ReactElement | null {
  useLocale()

  const record = useStore(botsStore, state => state.byName[bot])
  const mine = useStore(layoutStore, state => state.myChats[bot] === true)
  const group = useId()
  const noteId = useId()
  // What the reader asked for while the gateway is still answering.
  const [pending, setPending] = useState<Choice | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Which switch just happened, so the line is built in the language the reader is in now.
  const [said, setSaid] = useState<Choice | null>(null)

  const chooseChat = controller?.chooseChat

  if (!chooseChat || controller.ownChatsAvailable?.() !== true || !record) {
    return null
  }

  const choice: Choice = mine ? 'mine' : 'shared'
  const shown = pending ?? choice

  const choose = (next: Choice): void => {
    // One switch at a time; tapping the one that is on is no switch at all.
    if (pending !== null || next === choice) {
      return
    }

    setPending(next)
    setFailure(null)
    setSaid(null)
    chooseChat
      .call(controller, record, next)
      .then(() => {
        setSaid(next)
        onChosen?.()
      })
      .catch((error: unknown) => setFailure(failureText(error)))
      .finally(() => setPending(null))
  }

  const options: { value: Choice; label: string }[] = [
    { value: 'shared', label: strings.chat.sessions.shared },
    { value: 'mine', label: strings.chat.sessions.mine }
  ]

  return (
    <fieldset className="hm-chatchoice" aria-describedby={noteId} aria-busy={pending !== null || undefined}>
      <legend className="hm-chatchoice__legend">{sheetStrings.chatChoice.legend}</legend>
      <div className="hm-chatchoice__options">
        {options.map(option => (
          <label className="hm-chatchoice__option" key={option.value}>
            <input
              type="radio"
              name={group}
              value={option.value}
              checked={shown === option.value}
              onChange={() => choose(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <p className="hm-chatchoice__note" id={noteId}>
        {shown === 'mine' ? strings.chat.sessions.mineNote : strings.chat.sessions.sharedNote}
      </p>
      {/* Present before it speaks, so it is heard. */}
      <p className="hm-sr" role="status" aria-live="polite" aria-atomic="true">
        {said === null ? '' : said === 'mine' ? sheetStrings.chatChoice.nowMine : sheetStrings.chatChoice.nowShared}
      </p>
      {failure ? (
        <p className="hm-chatchoice__failure" role="alert">
          {failure}
        </p>
      ) : null}
    </fieldset>
  )
}
