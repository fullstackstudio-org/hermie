/**
 * A clarify: one question, or a stepper over a batch.
 *
 * A bot asks either one question or several at once. A batch is a stepper rather
 * than a long page, because the gateway takes answers one at a time (a locked
 * answer may not be changed) and a step is the shape that makes that visible
 * instead of surprising.
 *
 * Choices and free text coexist on purpose: the bot offers options, and the
 * answer the reader actually has is often neither. One answer per question is
 * one string: a choice, the choices joined with ", " (when more than one may be
 * picked), or what was typed. The value is what the field and the choices both
 * edit, so a typed answer deselects the choices and a choice replaces the typing.
 *
 * **Skip** answers a question with an empty string: the bot is told there is no
 * answer and carries on, rather than waiting for one. In a batch it answers that
 * step and moves to the next, and on the last step it sends everything. A
 * question that was already locked keeps its answer.
 *
 * The questions and their choices are an agent's words and are shown as
 * characters, never as Markdown.
 */
import type { ClarifyItem } from '@hermie/transcript'
import { type KeyboardEvent, type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { Button } from '../../ui/primitives'

export interface ClarifySheetProps {
  item: ClarifyItem
  titleId: string
  /** The question on screen: the dialog's description. */
  descriptionId: string
  /** Every question's answer, by `qid` (a skipped one is `''`). Once. */
  onSubmit: (answers: Record<string, string>) => void
  /** Lock one answer of a batch on the gateway without answering the whole request. */
  onLock?: (qid: string, answer: string) => void
}

const MULTI_SEPARATOR = ', '

const partsOf = (value: string): string[] => (value ? value.split(MULTI_SEPARATOR).filter(Boolean) : [])

function toggled(value: string, choice: string, multiSelect: boolean): string {
  if (!multiSelect) {
    return choice
  }

  const parts = partsOf(value)

  return (parts.includes(choice) ? parts.filter(part => part !== choice) : [...parts, choice]).join(MULTI_SEPARATOR)
}

const selected = (value: string, choice: string, multiSelect: boolean): boolean =>
  multiSelect ? partsOf(value).includes(choice) : value === choice

export function ClarifySheet({
  item,
  titleId,
  descriptionId,
  onSubmit,
  onLock
}: ClarifySheetProps): ReactElement | null {
  useLocale()

  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...item.answers }))
  /** Submit and Skip both end the sheet: once, whatever lands behind the first press. */
  const left = useRef(false)
  const question = item.questions[Math.min(index, item.questions.length - 1)]
  const locked = useMemo(() => new Set(item.locked), [item.locked])
  const groupId = useId()
  const fieldId = useId()
  const questionRef = useRef<HTMLParagraphElement>(null)
  const firstRender = useRef(true)

  // A step changes what is on screen; the reader is told by moving to the question.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false

      return
    }

    questionRef.current?.focus()
  }, [index])

  if (!question) {
    return null
  }

  const batch = item.questions.length > 1
  const last = index >= item.questions.length - 1
  const isLocked = locked.has(question.qid)
  const value = isLocked ? (item.answers[question.qid] ?? '') : (answers[question.qid] ?? '')
  const choices = question.choices ?? []

  const set = (next: string): void => setAnswers(current => ({ ...current, [question.qid]: next }))

  /** What goes to the gateway: every question answered, a locked one as it was locked. */
  const finished = (overrides: Record<string, string> = {}): Record<string, string> => {
    const out: Record<string, string> = {}

    for (const entry of item.questions) {
      out[entry.qid] = locked.has(entry.qid)
        ? (item.answers[entry.qid] ?? '')
        : (overrides[entry.qid] ?? answers[entry.qid] ?? '')
    }

    return out
  }

  const leave = (all: Record<string, string>): void => {
    if (left.current) {
      return
    }

    left.current = true
    onSubmit(all)
  }

  const advance = (): void => {
    if (last) {
      leave(finished())
    } else {
      setIndex(current => current + 1)
    }
  }

  const skip = (): void => {
    if (isLocked) {
      advance()

      return
    }

    if (last) {
      leave(finished({ [question.qid]: '' }))

      return
    }

    set('')
    setIndex(current => current + 1)
  }

  const canContinue = isLocked || value.trim() !== ''

  const onFieldKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Return writes a second line here; Command or Control with it answers.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && canContinue) {
      event.preventDefault()
      advance()
    }
  }

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {strings.chat.clarify.title}
      </h2>

      {batch ? (
        <p className="hm-requests__meta">
          {strings.chat.clarify.step({ current: index + 1, total: item.questions.length })}
        </p>
      ) : null}

      {/* Keyed by the question, so a step is a new element and its choices start from what that step holds. */}
      <p className="hm-requests__question" id={descriptionId} ref={questionRef} tabIndex={-1} key={question.qid}>
        {question.question}
      </p>

      {isLocked ? <p className="hm-requests__locked">{strings.chat.clarify.locked}</p> : null}
      {question.multiSelect ? <p className="hm-requests__meta">{strings.chat.clarify.multiSelectHint}</p> : null}

      {choices.length > 0 ? (
        <div
          className="hm-requests__choices"
          role={question.multiSelect ? 'group' : 'radiogroup'}
          aria-labelledby={descriptionId}
        >
          {choices.map(choice => (
            <label className="hm-requests__choice" key={choice}>
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`${groupId}-${question.qid}`}
                checked={selected(value, choice, question.multiSelect)}
                disabled={isLocked}
                onChange={() => set(toggled(value, choice, question.multiSelect))}
              />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      ) : null}

      <label className="hm-requests__label" htmlFor={fieldId}>
        {strings.chat.clarify.freeText}
      </label>
      <textarea
        id={fieldId}
        className="hm-requests__field"
        rows={3}
        value={value}
        placeholder={strings.chat.clarify.freeTextPlaceholder}
        disabled={isLocked}
        onChange={event => set(event.target.value)}
        onKeyDown={onFieldKey}
      />

      <div className="hm-requests__actions">
        <Button className="hm-requests__action" disabled={!canContinue} onClick={advance}>
          {batch && !last ? strings.chat.clarify.next : strings.chat.clarify.submit}
        </Button>
        {batch && index > 0 ? (
          <Button
            className="hm-requests__action"
            variant="quiet"
            onClick={() => setIndex(current => Math.max(0, current - 1))}
          >
            {strings.chat.clarify.previous}
          </Button>
        ) : null}
        {batch && onLock && !isLocked ? (
          <Button
            className="hm-requests__action"
            variant="quiet"
            disabled={value.trim() === ''}
            onClick={() => onLock(question.qid, value)}
          >
            {strings.chat.clarify.lock}
          </Button>
        ) : null}
        <Button className="hm-requests__action" variant="quiet" onClick={skip}>
          {webStrings.requests.skip}
        </Button>
      </div>
    </>
  )
}
