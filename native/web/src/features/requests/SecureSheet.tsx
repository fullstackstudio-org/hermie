/**
 * The frame every one-string prompt is answered in (`secret`, `sudo`, the vault
 * prompts): the five sheets (`SecretSheet`, `SudoSheet`, `VaultUnlockSheet`,
 * `VaultCodeSheet`, `VaultSaveLoginSheet`) say what is asked and which fields it
 * takes; this draws them and does the answering.
 *
 * A prompt for a secret is a phishing surface: anyone who can make the bot ask
 * can make this sheet appear, and a page cannot prove it is the real app. The
 * rules (plan, "Secret prompts in a browser"; the native apps' `SecureInputSheet`):
 *
 *  1. **The chrome is the app's.** The heading (who asks, for what kind of thing),
 *     the gateway's host, the labels, who receives the value and the buttons are
 *     fixed words. The request's own words (a prompt, a command, a site, a hint)
 *     are plain text in a quoted box under a label that says so: never Markdown,
 *     never a link, already cleaned and bounded by the model (`displayText`).
 *  2. **The value is never state.** The fields are uncontrolled: nothing in React
 *     state, a store or a ref holds what is typed. Send reads the field at that
 *     moment and hands the text to the model, which puts it into the reply and
 *     keeps nothing; the field is emptied once it went, when the guard ends, and
 *     when the sheet goes. The only things kept here are whether the fields could
 *     answer (a boolean, for Send) and the countdown.
 *  3. **Nothing is filled in, and nothing takes the keyboard by itself.** The
 *     layer puts focus on the dialog, not the field, and for `tapGuardMs` after the
 *     sheet appears the fields and buttons are off, so keystrokes or a click meant
 *     for something else never land here, and whatever reached a field by then is
 *     dropped when they wake. Every field is `autocomplete="off"` (the plan's rule)
 *     and carries the opt-outs the common password-manager extensions read, has no
 *     `name` and sits in no `<form>`: what this origin has saved is the gateway's
 *     sign-in, never the answer to a bot's question, so nothing may be offered into
 *     these fields, and nothing typed here may be offered for saving. A field is
 *     emptied before it leaves the page (in the commit that removes it), so a
 *     browser that looks at a password field as it disappears sees nothing.
 *  4. **Only Send or Skip ends it.** Escape and the scrim do nothing (the layer
 *     keeps them). Skip answers `''`. Return in the last field is Send.
 *  5. **A countdown to the gateway's deadline**, when it is known; the model ends
 *     the prompt at the deadline on its own clock.
 *  6. **Offline is said, not swallowed.** An answer while the connection is down is
 *     not sent; the sheet says so and keeps what is typed in the field.
 */
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { type AnswerOutcome, answerText } from '../../core/requests/secure-input'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import type { SecurePrompt } from '../../state/secure-input'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'

/** What every sheet is given by the layer. */
export interface SecureSheetProps {
  prompt: SecurePrompt
  /** The bot's name, cleaned for display. */
  name: string
  /** The gateway's host. */
  gateway: string
  /** The dialog's accessible name is the sheet's heading. */
  titleId: string
  /** The line under it (which gateway asks) is the dialog's description. */
  descriptionId: string
  /** Send: what the fields hold, read at the press. */
  onAnswer: (value: string, identifier: string) => AnswerOutcome
  onSkip: () => AnswerOutcome
  /** Milliseconds before a field or button takes anything. Tests pass 0. */
  tapGuardMs?: number
  /** Epoch milliseconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

/** One field of a sheet. */
export interface SecureField {
  /** `value` is the answer (or a login's password); `identifier` is a login's username. */
  role: 'value' | 'identifier'
  label: string
  /** Masked (every value a bot asks for) or not (a login's username, which is not a secret). */
  type: 'password' | 'text'
}

interface FrameProps extends SecureSheetProps {
  title: string
  /** What is asked: fixed leads and the request's words in quoted boxes. */
  details: ReactNode
  fields: readonly SecureField[]
  /** Who receives the value. */
  receiver: string
  /** Send, or Save for a login. */
  sendLabel: string
}

const clock = (): number => Date.now()

/** `m:ss`, never negative. */
const countdown = (ms: number): string => {
  const left = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/**
 * The request's own words (a prompt, a command, a hint, a name it gives): plain text in a box, under a label
 * that says they are the request's. Never woven into the app's own sentences, so a name cannot finish one.
 */
export function SecureQuote({
  text,
  label = webStrings.secureInput.quoteLabel,
  monospaced = false
}: {
  text: string
  /** Whose words, and what they are; "What the request says" unless the sheet says more. */
  label?: string
  monospaced?: boolean
}): ReactElement {
  const labelId = useId()

  return (
    <div className="hm-requests__detail-box">
      <p className="hm-requests__label" id={labelId}>
        {label}
      </p>
      {/* Scrolls when long, so it takes the keyboard: a scroll region nobody can reach is a trap. */}
      <blockquote
        className="hm-secure__quote"
        data-mono={monospaced ? '' : undefined}
        tabIndex={0}
        aria-labelledby={labelId}
        data-secure-quote=""
      >
        {text}
      </blockquote>
    </div>
  )
}

export function SecureSheetFrame({
  prompt,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now = clock,
  title,
  details,
  fields,
  receiver,
  sendLabel
}: FrameProps): ReactElement {
  useLocale()

  const ids = useId()
  const valueField = useRef<HTMLInputElement>(null)
  const identifierField = useRef<HTMLInputElement>(null)
  const [armed, setArmed] = useState(tapGuardMs <= 0)
  /** Whether the fields hold something that answers the prompt: a yes or no, never the text. */
  const [answerable, setAnswerable] = useState(false)
  const [offline, setOffline] = useState(false)
  const [time, setTime] = useState(now)
  /** One answer per prompt: the layer takes the sheet away on the next render, and a second press lands before it. */
  const done = useRef(false)
  const { deadline } = prompt

  const clear = (): void => {
    if (valueField.current) {
      valueField.current.value = ''
    }

    if (identifierField.current) {
      identifierField.current.value = ''
    }

    setAnswerable(false)
  }

  // The guard: nothing is taken until it ends, and whatever reached a field before it is dropped.
  useEffect(() => {
    done.current = false

    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)

    const timer = setTimeout(() => {
      clear()
      setArmed(true)
    }, tapGuardMs)

    return () => clearTimeout(timer)
  }, [prompt.id, tapGuardMs])

  // The sheet goes (answered, withdrawn, expired, another prompt): its fields are emptied on the way out, in
  // the commit that removes them and before the nodes leave the document (a layout effect's cleanup runs then).
  useLayoutEffect(() => {
    const value = valueField.current
    const identifier = identifierField.current

    return () => {
      if (value) {
        value.value = ''
      }

      if (identifier) {
        identifier.value = ''
      }
    }
  }, [])

  // The countdown ticks while there is a deadline; it is text, not a live region.
  useEffect(() => {
    if (deadline === null) {
      return
    }

    setTime(now())

    const timer = setInterval(() => setTime(now()), 1000)

    return () => clearInterval(timer)
  }, [deadline, now])

  const read = (): { value: string; identifier: string } => ({
    value: valueField.current?.value ?? '',
    identifier: identifierField.current?.value ?? ''
  })

  const onInput = (): void => {
    const { value, identifier } = read()

    setAnswerable(answerText(prompt.ask, value, identifier) !== null)
    setOffline(false)
  }

  const settle = (outcome: AnswerOutcome): void => {
    if (outcome === 'sent') {
      done.current = true
      clear()
    } else if (outcome === 'closed') {
      clear()
    } else if (outcome === 'offline') {
      setOffline(true)
    }
  }

  const submit = (): void => {
    if (!armed || done.current) {
      return
    }

    const { value, identifier } = read()

    settle(onAnswer(value, identifier))
  }

  const skip = (): void => {
    if (!armed || done.current) {
      return
    }

    settle(onSkip())
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, role: SecureField['role']): void => {
    // The Return that confirms an input method's candidate is not a Send.
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) {
      return
    }

    event.preventDefault()

    if (role === 'identifier') {
      valueField.current?.focus()

      return
    }

    submit()
  }

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {title}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {webStrings.secureInput.gateway({ host: gateway })}
      </p>

      {prompt.earlierAnswerLost ? (
        <p className="hm-requests__phase" data-tone="danger">
          {webStrings.secureInput.earlierAnswerLost}
        </p>
      ) : null}

      {details}

      <div className="hm-secure__fields">
        {fields.map(field => {
          const id = `${ids}-${field.role}`

          return (
            <div className="hm-secure__field" key={field.role}>
              <label className="hm-requests__label" htmlFor={id}>
                {field.label}
              </label>
              <input
                id={id}
                ref={field.role === 'value' ? valueField : identifierField}
                className="hm-secure__input"
                type={field.type}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={!armed}
                data-secure-field={field.role}
                // The opt-outs of 1Password, LastPass, Bitwarden and Dashlane: see rule 3.
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                onInput={onInput}
                onKeyDown={event => onKeyDown(event, field.role)}
              />
            </div>
          )
        })}
      </div>

      {deadline !== null ? (
        <p className="hm-requests__meta" data-tone={deadline - time <= 10_000 ? 'danger' : undefined}>
          {webStrings.secureInput.expiresIn({ time: countdown(deadline - time) })}
        </p>
      ) : null}

      <p className="hm-requests__phase" role="status" data-tone={offline ? 'danger' : undefined}>
        {offline ? webStrings.secureInput.offline : ''}
      </p>

      <p className="hm-secure__receiver">{receiver}</p>

      <div className="hm-requests__actions">
        <Button className="hm-requests__action" variant="quiet" disabled={!armed} onClick={skip}>
          {webStrings.secureInput.skip}
        </Button>
        <Button className="hm-requests__action" variant="primary" disabled={!armed || !answerable} onClick={submit}>
          {sendLabel}
        </Button>
      </div>
    </>
  )
}
