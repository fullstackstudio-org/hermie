/**
 * The pieces the gateway-management pages share (Memory, Skills, MCP servers, Connectors, Boards): the bot a
 * page is about, a destructive action that asks first, and the line that says what just happened.
 *
 * Native controls throughout: a `<select>` inside a `<label>`, buttons, a status line the reader's screen
 * reader announces. Nothing here is a `div` with a click handler.
 */
import { type ReactElement, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { strings } from '../../generated/strings'
import { botLabel } from '../bots/bot-label'
import { botsStore } from '../../state/bots'
import { Button } from '../../ui/primitives'
import './manage.css'

/** What a page says after something happened: shown in a polite status line. */
export interface Outcome {
  tone: 'ok' | 'danger'
  text: string
}

export interface BotChoice {
  /** The profile's handle: what every call names. */
  name: string
  /** What the reader calls the bot, cleaned. */
  label: string
}

/** The bots of the roster, in its order, and the one a page starts on (the default bot, else the first). */
export function useBotChoices(): { choices: BotChoice[]; initial: string } {
  const bots = useStore(botsStore, state => state.bots)

  return useMemo(
    () => ({
      choices: bots.map(bot => ({ name: bot.name, label: botLabel(bot.displayName, bot.name) })),
      initial: (bots.find(bot => bot.isDefault) ?? bots[0])?.name ?? ''
    }),
    [bots]
  )
}

/** The bot a page is about, kept across roster refreshes and falling back to the initial one when it is gone. */
export function useSelectedBot(): { choices: BotChoice[]; selected: string; select: (name: string) => void } {
  const { choices, initial } = useBotChoices()
  const [picked, setPicked] = useState('')
  const selected = choices.some(choice => choice.name === picked) ? picked : initial

  return { choices, selected, select: setPicked }
}

/** A labelled `<select>` of the bots. */
export function BotPicker({
  label,
  choices,
  value,
  onChange
}: {
  label: string
  choices: readonly BotChoice[]
  value: string
  onChange: (name: string) => void
}): ReactElement {
  const id = useId()

  return (
    <div className="hm-manage__field">
      <label className="hm-manage__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="hm-manage__select"
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
      >
        {choices.map(choice => (
          <option key={choice.name} value={choice.name}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The line that says what just happened (`role="status"`), empty and hidden when nothing did. */
export function StatusLine({ outcome }: { outcome: Outcome | null }): ReactElement {
  return (
    <p className="hm-manage__status" role="status" data-tone={outcome?.tone}>
      {outcome?.text ?? ''}
    </p>
  )
}

/** A failure that is on the page to stay until it is retried (`role="alert"`). */
export function ProblemLine({
  text,
  retryLabel,
  onRetry
}: {
  text: string
  retryLabel?: string
  onRetry?: () => void
}): ReactElement {
  return (
    <div className="hm-manage__problem">
      <p role="alert" className="hm-manage__problem-text">
        {text}
      </p>
      {onRetry ? (
        <Button variant="quiet" onClick={onRetry}>
          {retryLabel ?? strings.memory.retry}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * A destructive action that asks first. The button opens a question with the verb and a way back; Cancel takes
 * the focus (one stray Enter never confirms), and the button gets it back when the question is dismissed.
 */
export function ConfirmAction({
  label,
  accessibleName,
  question,
  detail,
  confirmLabel,
  cancelLabel,
  disabled = false,
  onConfirm
}: {
  /** The trigger's text. */
  label: ReactNode
  /** The trigger's and the confirming verb's accessible name, which says what it is about. */
  accessibleName: string
  question: string
  detail?: string
  confirmLabel: string
  cancelLabel: string
  disabled?: boolean
  onConfirm: () => void
}): ReactElement {
  const [asking, setAsking] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (!asking && refocus.current) {
      refocus.current = false
      trigger.current?.focus()
    }
  }, [asking])

  if (asking) {
    return (
      <div className="hm-manage__confirm" role="group" aria-label={accessibleName}>
        <p className="hm-manage__confirm-question">{question}</p>
        {detail ? <p className="hm-manage__hint">{detail}</p> : null}
        <div className="hm-manage__actions">
          <Button
            variant="quiet"
            data-tone="danger"
            aria-label={accessibleName}
            disabled={disabled}
            onClick={() => {
              setAsking(false)
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
          <Button
            variant="quiet"
            autoFocus
            onClick={() => {
              refocus.current = true
              setAsking(false)
            }}
          >
            {cancelLabel}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Button
      ref={trigger}
      variant="quiet"
      data-tone="danger"
      aria-label={accessibleName}
      disabled={disabled}
      onClick={() => setAsking(true)}
    >
      {label}
    </Button>
  )
}
