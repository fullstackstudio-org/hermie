/**
 * The sheet for an `input.form` request: the bot's fields, drawn with the browser's own inputs
 * (`FormFields.tsx`), checked here the way the gateway checks them, and sent as one answer.
 *
 *  - **What it holds** is what the inputs hold, in this component's state for as long as the sheet is open: raw
 *    text, switches and the options ticked. `core/requests/form-values.ts` turns that into the contract's values
 *    (a JSON number, a decimal string for an amount, a datetime with its offset and its zone) at the press of Send,
 *    and the model puts them into the one `request.answer` call. No store, cache, draft or log holds them.
 *  - **The page checks first.** Send with a problem in a field says what it is next to that field, in the
 *    gateway's own terms (`field:<id>:<problem>`), and sends nothing; the first field with a problem takes focus. A
 *    field is also checked once it was left. The gateway still decides: its refusal comes back as `refusal` on the
 *    request and is shown next to the field it names, until that field is changed. A refusal does NOT remount the
 *    sheet (the layer keys it by the request, not by its version), so nothing the person entered is lost.
 *  - **Skip** only when the request is `optional`. **A countdown** to the gateway's deadline. **A tap guard**: the
 *    fields and buttons are off for a moment after the sheet appears.
 *  - **Offline, busy, failed, an earlier answer that was lost** are said; what was entered stays.
 */
import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  deviceZone,
  evaluateForm,
  initialRaw,
  parseFieldRefusal,
  type Problem,
  type RawValue
} from '../../core/requests/form-values'
import type { AnswerOutcome } from '../../core/requests/interactive'
import type { FormAsk, InteractiveAnswer } from '../../core/requests/interactive-types'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { InteractiveRequest } from '../../state/interactive'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { FormFieldView } from './FormFields'
import { problemText } from './form-problems'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'

export interface FormSheetProps {
  request: InteractiveRequest & { ask: FormAsk }
  /** The gateway's host. */
  gateway: string
  titleId: string
  descriptionId: string
  onAnswer: (result: InteractiveAnswer) => Promise<AnswerOutcome>
  onSkip: () => Promise<AnswerOutcome>
  /** Tell the gateway the person chooses not to share (`4041 declined`). */
  onCannotShow: (reason: string) => 'sent' | 'closed' | 'offline' | 'busy'
  /** Put the sheet away without answering (what was entered stays while it is away). */
  onLater: () => void
  /** Whether the sheet is the one on screen: its tap guard runs from the moment it is (default: it is). */
  shown?: boolean
  /** Milliseconds before a field or button takes anything. Tests pass 0. */
  tapGuardMs?: number
  /** Epoch milliseconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

export function FormSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  onCannotShow,
  onLater,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: FormSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const { fields } = ask
  const base = useId()
  const device = useMemo(deviceZone, [])
  const form = useRef<HTMLFormElement>(null)
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  const [raw, setRaw] = useState<Record<string, RawValue>>(() =>
    Object.fromEntries(fields.map(field => [field.id, initialRaw(field, device)]))
  )
  /** Number inputs that hold text they cannot read: a browser hands over `''` for it, which would pass as empty. */
  const [bad, setBad] = useState<Readonly<Record<string, boolean>>>({})
  /** Fields the person has been in and left. */
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set())
  /** Send was pressed with a problem somewhere: every field says what is wrong with it from then on. */
  const [attempted, setAttempted] = useState(false)
  /** Fields changed since the gateway's last refusal: their refusal is out of date. */
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set())
  const focusedRefusal = useRef<string | null>(null)

  const { values, problems } = useMemo(() => {
    const result = evaluateForm(fields, raw, device)

    // Text a number input cannot read is no value, whatever the input hands over for it.
    for (const field of fields) {
      if (field.kind === 'number' && bad[field.id]) {
        delete result.values[field.id]
        result.problems[field.id] = 'format'
      }
    }

    return result
  }, [fields, raw, bad, device])

  const refusal = parseFieldRefusal(request.refusal)
  const refusedField = refusal ? fields.find(field => field.id === refusal.id) : undefined
  const locked = !armed || sending.pending || sending.finished
  const problemCount = fields.filter(field => problems[field.id] !== undefined).length

  const focusField = (id: string): void => {
    form.current
      ?.querySelector<HTMLElement>(`[data-field-id="${id}"] :is(input, select, textarea)`)
      ?.focus({ preventScroll: false })
  }

  // The gateway's refusal is new: its field is out of date no more, and the person is taken to it.
  useEffect(() => {
    setChanged(new Set())
  }, [request.refusal])

  useEffect(() => {
    if (request.refusal === null) {
      focusedRefusal.current = null

      return
    }

    if (sending.pending || focusedRefusal.current === request.refusal) {
      return
    }

    focusedRefusal.current = request.refusal

    if (refusedField) {
      focusField(refusedField.id)
    }
  }, [request.refusal, request.version, sending.pending, refusedField])

  const change = (id: string, value: RawValue, unreadable = false): void => {
    setRaw(previous => ({ ...previous, [id]: value }))
    setBad(previous => (previous[id] === unreadable ? previous : { ...previous, [id]: unreadable }))
    setChanged(previous => (previous.has(id) ? previous : new Set(previous).add(id)))
    sending.clearNotice()
  }

  const submit = (): void => {
    if (locked) {
      return
    }

    setAttempted(true)

    const first = fields.find(field => problems[field.id] !== undefined)

    if (first) {
      focusField(first.id)

      return
    }

    void sending.run(() => onAnswer({ status: 'answered', values }))
  }

  const errorOf = (id: string): string | null => {
    const field = fields.find(entry => entry.id === id)

    if (!field) {
      return null
    }

    if (refusal && refusal.id === id && !changed.has(id)) {
      return problemText(field, refusal.problem, device)
    }

    const problem: Problem | undefined = problems[id]

    return problem !== undefined && (attempted || left.has(id)) ? problemText(field, problem, device) : null
  }

  /** A refusal with no field to sit next to: the gateway's words in one line over the buttons. */
  const generalRefusal =
    request.refusal !== null && !(refusedField && !changed.has(refusedField.id))
      ? sheetStrings.interactive.refusedOther({ reason: request.refusal })
      : null
  const shownCount = fields.filter(field => errorOf(field.id) !== null).length

  return (
    <form
      className="hm-interactive__form"
      ref={form}
      noValidate
      autoComplete="off"
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={event => {
        // Only the Send button sends: Return in a one-line field is not a send (a textarea keeps its line break).
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault()
        }
      }}
    >
      <InteractiveFrame
        request={request}
        gateway={gateway}
        title={sheetStrings.interactive.form.title}
        titleId={titleId}
        descriptionId={descriptionId}
        receiver={sheetStrings.interactive.form.receiver}
        {...(now ? { now } : {})}
        status={
          <>
            <RefusalAlert text={generalRefusal} />
            <SendStatus notice={sending.notice} />
            <p className="hm-requests__phase" role="status" data-tone="danger">
              {attempted && problemCount > 0 && shownCount > 0
                ? sheetStrings.interactive.form.needsAttention({ count: problemCount })
                : ''}
            </p>
          </>
        }
        actions={
          <>
            <Button className="hm-requests__action" variant="quiet" onClick={onLater}>
              {sheetStrings.interactive.later}
            </Button>
            <Button
              className="hm-requests__action"
              variant="quiet"
              disabled={locked}
              data-interactive-dont-share=""
              onClick={() => sending.declined(onCannotShow('declined'))}
            >
              {sheetStrings.interactive.dontShare}
            </Button>
            {ask.optional ? (
              <Button
                className="hm-requests__action"
                variant="quiet"
                disabled={locked}
                onClick={() => void sending.run(onSkip)}
              >
                {sheetStrings.secureInput.skip}
              </Button>
            ) : null}
            <Button className="hm-requests__action" variant="primary" type="submit" disabled={locked}>
              {sheetStrings.interactive.form.send}
            </Button>
          </>
        }
      >
        <fieldset className="hm-form__fields" disabled={locked}>
          <legend className="hm-sr">{sheetStrings.interactive.form.fields}</legend>
          {fields.map(field => (
            <FormFieldView
              key={field.id}
              field={field}
              base={base}
              raw={raw[field.id] ?? ''}
              device={device}
              error={errorOf(field.id)}
              onChange={(value, unreadable) => change(field.id, value, unreadable)}
              onBlur={() => setLeft(previous => (previous.has(field.id) ? previous : new Set(previous).add(field.id)))}
            />
          ))}
          {fields.some(field => field.required) ? (
            <p className="hm-form__hint" aria-hidden="true">
              {sheetStrings.interactive.requiredNote}
            </p>
          ) : null}
        </fieldset>
      </InteractiveFrame>
    </form>
  )
}
