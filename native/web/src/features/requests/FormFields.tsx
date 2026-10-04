/**
 * One field of a form, drawn with the browser's own inputs (`FormSheet.tsx` holds what they hold).
 *
 * `<input type=date|time|datetime-local|number>`, `<select>`, radio and checkbox groups, a switch and a
 * `<textarea>`; an amount is a text input with its currency beside it (a decimal STRING is what the contract wants,
 * and `type=number` would turn it into a float); a range is two date inputs in a group. Every field has a label (or
 * a legend), its hint and what it says about itself (a zone, a currency, what will be sent) are linked with
 * `aria-describedby`, and its problem is linked the same way and marked `aria-invalid`.
 *
 * The request's words (labels, hints, option labels) are React text nodes: plain text, never Markdown, never a
 * link. An option's `value` is the identifier the answer gives back and is never drawn (not even as a DOM
 * attribute): the inputs name an option by its place in the list.
 */
import type { ChangeEvent, FocusEvent, ReactElement, ReactNode } from 'react'

import {
  amountText,
  decimalsOf,
  deviceZone,
  evaluate,
  instantToInput,
  type RawValue,
  zoneOf,
  zoneOffsetLabel
} from '../../core/requests/form-values'
import type { ChoiceField, FormField } from '../../core/requests/interactive-types'
import { sheetStrings } from '../../i18n/sheet-strings'
import { Button, VisuallyHidden } from '../../ui/primitives'

/** Attributes the common password managers read as "leave this field alone": nothing here is a login. */
const NO_FILL = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other'
} as const

/** A blur handler for a group of inputs: it counts only when focus leaves the group, not when it moves within it. */
const leavingGroup =
  (onBlur: () => void) =>
  (event: FocusEvent<HTMLElement>): void => {
    const group = event.currentTarget.closest('fieldset')

    if (!(event.relatedTarget instanceof Node && group?.contains(event.relatedTarget))) {
      onBlur()
    }
  }

/** A single choice with this many options or fewer is a radio group; more is a `<select>`. */
export const RADIO_LIMIT = 4

export interface FieldViewProps {
  field: FormField
  /** A prefix that makes every DOM id of this field unique on the page. */
  base: string
  raw: RawValue
  /** This device's zone, for a datetime whose request names none. */
  device: string
  /** The field's problem, in words, or `null`. */
  error: string | null
  /** The number input holds text it cannot read (`validity.badInput`): the sheet reads that as a problem. */
  onChange(raw: RawValue, bad?: boolean): void
  onBlur(): void
}

/** The label's content: the request's words, a star for a required field and, for a screen reader, the word. */
function LabelText({ field }: { field: FormField }): ReactElement {
  return (
    <>
      {field.label}
      {field.required ? (
        <>
          <span className="hm-form__star" aria-hidden="true">
            {' *'}
          </span>
          <VisuallyHidden>{` (${sheetStrings.interactive.required})`}</VisuallyHidden>
        </>
      ) : null}
    </>
  )
}

interface Described {
  /** `aria-describedby` for the control: the lines under the field, then its problem. */
  describedBy: string | undefined
  /** `aria-invalid`. */
  invalid: true | undefined
}

export function FormFieldView({ field, base, raw, device, error, onChange, onBlur }: FieldViewProps): ReactElement {
  const id = `${base}-${field.id}`
  const hintId = `${id}-hint`
  const noteId = `${id}-note`
  const sentId = `${id}-sent`
  const errorId = `${id}-error`
  const hint = 'hint' in field ? field.hint : undefined
  const notes: string[] = []
  const sentAs = sentLine(field, raw, device)
  const zoneLine = zoneNote(field, device)
  const amountNote =
    field.kind === 'amount'
      ? sheetStrings.interactive.form.amountIn({ currency: field.currency, decimals: decimalsOf(field.currency) })
      : null
  const pickNote = pickCount(field)
  const lines: [string, string][] = []

  if (hint) lines.push([hintId, hint])
  if (amountNote) lines.push([noteId, amountNote])
  if (zoneLine) lines.push([`${noteId}-zone`, zoneLine])
  if (pickNote) lines.push([`${noteId}-pick`, pickNote])
  if (sentAs) lines.push([sentId, sentAs])

  for (const [lineId] of lines) {
    notes.push(lineId)
  }

  if (error) {
    notes.push(errorId)
  }

  const described: Described = {
    describedBy: notes.length ? notes.join(' ') : undefined,
    invalid: error ? true : undefined
  }

  const footer: ReactNode = (
    <>
      {lines.map(([lineId, line]) => (
        <p className="hm-form__hint" id={lineId} key={lineId}>
          {line}
        </p>
      ))}
      {error ? (
        <p className="hm-form__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </>
  )

  switch (field.kind) {
    case 'text': {
      const multiline = field.multiline
      const shared = {
        id,
        value: typeof raw === 'string' ? raw : '',
        'aria-describedby': described.describedBy,
        'aria-invalid': described.invalid,
        'aria-required': field.required || undefined,
        spellCheck: field.input === 'plain',
        autoCapitalize: field.input === 'plain' ? undefined : 'off',
        onBlur,
        ...NO_FILL
      }

      return (
        <div className="hm-form__field" data-field-id={field.id} data-kind="text">
          <label className="hm-requests__label" htmlFor={id}>
            <LabelText field={field} />
          </label>
          {multiline ? (
            <textarea
              {...shared}
              className="hm-requests__field hm-form__textarea"
              rows={4}
              onChange={event => onChange(event.currentTarget.value)}
            />
          ) : (
            <input
              {...shared}
              className="hm-secure__input"
              type={
                field.input === 'email'
                  ? 'email'
                  : field.input === 'phone'
                    ? 'tel'
                    : field.input === 'url'
                      ? 'url'
                      : 'text'
              }
              inputMode={field.input === 'plain' ? undefined : field.input === 'phone' ? 'tel' : field.input}
              onChange={event => onChange(event.currentTarget.value)}
            />
          )}
          {multiline && field.maxLength < 4_000 ? (
            <p className="hm-form__hint" aria-hidden="true">
              {sheetStrings.interactive.form.characters({
                count: Array.from(typeof raw === 'string' ? raw : '').length,
                max: field.maxLength
              })}
            </p>
          ) : null}
          {footer}
        </div>
      )
    }

    case 'number':
      return (
        <div className="hm-form__field" data-field-id={field.id} data-kind="number">
          <label className="hm-requests__label" htmlFor={id}>
            <LabelText field={field} />
          </label>
          <input
            id={id}
            className="hm-secure__input"
            type="number"
            inputMode={field.integer ? 'numeric' : 'decimal'}
            value={typeof raw === 'string' ? raw : ''}
            {...(field.min !== undefined ? { min: field.min } : {})}
            {...(field.max !== undefined ? { max: field.max } : {})}
            step={field.step ?? (field.integer ? 1 : 'any')}
            aria-describedby={described.describedBy}
            aria-invalid={described.invalid}
            aria-required={field.required || undefined}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange(event.currentTarget.value, event.currentTarget.validity.badInput)
            }
            onBlur={onBlur}
            {...NO_FILL}
          />
          {footer}
        </div>
      )

    case 'amount':
      return (
        <div className="hm-form__field" data-field-id={field.id} data-kind="amount">
          <label className="hm-requests__label" htmlFor={id}>
            <LabelText field={field} />
          </label>
          <div className="hm-form__row">
            <input
              id={id}
              className="hm-secure__input"
              type="text"
              inputMode="decimal"
              value={typeof raw === 'string' ? raw : ''}
              placeholder={decimalsOf(field.currency) === 0 ? '0' : `0.${'0'.repeat(decimalsOf(field.currency))}`}
              aria-describedby={described.describedBy}
              aria-invalid={described.invalid}
              aria-required={field.required || undefined}
              spellCheck={false}
              onChange={event => onChange(event.currentTarget.value)}
              onBlur={() => {
                // A comma for the point is taken as one; say so by writing it as the answer will read.
                if (typeof raw === 'string' && amountText(raw) !== raw && /^-?\d+,\d+$/u.test(raw.trim())) {
                  onChange(amountText(raw))
                }

                onBlur()
              }}
              {...NO_FILL}
            />
            <span className="hm-form__unit" aria-hidden="true">
              {field.currency}
            </span>
          </div>
          {footer}
        </div>
      )

    case 'date':
    case 'time':
    case 'datetime': {
      const type = field.kind === 'datetime' ? 'datetime-local' : field.kind
      const range =
        field.kind === 'datetime'
          ? {
              min: instantToInput(field.min, zoneOf(field, device)),
              max: instantToInput(field.max, zoneOf(field, device))
            }
          : { min: field.min ?? '', max: field.max ?? '' }

      return (
        <div className="hm-form__field" data-field-id={field.id} data-kind={field.kind}>
          <label className="hm-requests__label" htmlFor={id}>
            <LabelText field={field} />
          </label>
          <input
            id={id}
            className="hm-secure__input"
            type={type}
            value={typeof raw === 'string' ? raw : ''}
            {...(range.min ? { min: range.min } : {})}
            {...(range.max ? { max: range.max } : {})}
            aria-describedby={described.describedBy}
            aria-invalid={described.invalid}
            aria-required={field.required || undefined}
            onChange={event => onChange(event.currentTarget.value)}
            onBlur={onBlur}
            {...NO_FILL}
          />
          {footer}
        </div>
      )
    }

    case 'daterange': {
      const value =
        typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as { start: string; end: string })
          : { start: '', end: '' }

      return (
        <fieldset className="hm-form__field hm-form__group" data-field-id={field.id} data-kind="daterange">
          <legend className="hm-requests__label">
            <LabelText field={field} />
          </legend>
          <div className="hm-form__pair">
            {(['start', 'end'] as const).map(side => (
              <div className="hm-form__half" key={side}>
                <label className="hm-form__sublabel" htmlFor={`${id}-${side}`}>
                  {side === 'start' ? sheetStrings.interactive.form.rangeStart : sheetStrings.interactive.form.rangeEnd}
                </label>
                <input
                  id={`${id}-${side}`}
                  className="hm-secure__input"
                  type="date"
                  value={value[side]}
                  {...(field.min ? { min: field.min } : {})}
                  {...(field.max ? { max: field.max } : {})}
                  aria-describedby={described.describedBy}
                  aria-invalid={described.invalid}
                  onChange={event => onChange({ ...value, [side]: event.currentTarget.value })}
                  onBlur={leavingGroup(onBlur)}
                  {...NO_FILL}
                />
              </div>
            ))}
          </div>
          {footer}
        </fieldset>
      )
    }

    case 'choice':
      return (
        <ChoiceView
          field={field}
          id={id}
          raw={raw}
          described={described}
          footer={footer}
          onChange={onChange}
          onBlur={onBlur}
        />
      )

    case 'toggle':
      return (
        <div className="hm-form__field" data-field-id={field.id} data-kind="toggle">
          <label className="hm-requests__choice hm-form__toggle" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              role="switch"
              checked={raw === true}
              aria-describedby={described.describedBy}
              onChange={event => onChange(event.currentTarget.checked)}
              onBlur={onBlur}
              {...NO_FILL}
            />
            <span>
              <LabelText field={field} />
            </span>
          </label>
          {footer}
        </div>
      )

    case 'unknown':
      return <></>
  }
}

function ChoiceView({
  field,
  id,
  raw,
  described,
  footer,
  onChange,
  onBlur
}: {
  field: ChoiceField
  id: string
  raw: RawValue
  described: Described
  footer: ReactNode
  onChange(raw: RawValue): void
  onBlur(): void
}): ReactElement {
  const chosen: readonly string[] = Array.isArray(raw)
    ? (raw as readonly string[])
    : typeof raw === 'string' && raw !== ''
      ? [raw]
      : []

  if (!field.multiple && field.options.length > RADIO_LIMIT) {
    const selected = field.options.findIndex(option => option.value === chosen[0])

    return (
      <div className="hm-form__field" data-field-id={field.id} data-kind="choice">
        <label className="hm-requests__label" htmlFor={id}>
          <LabelText field={field} />
        </label>
        <select
          id={id}
          className="hm-secure__input"
          value={selected < 0 ? '' : String(selected)}
          aria-describedby={described.describedBy}
          aria-invalid={described.invalid}
          aria-required={field.required || undefined}
          onChange={event => {
            const index = event.currentTarget.value === '' ? -1 : Number(event.currentTarget.value)

            onChange(field.options[index]?.value ?? '')
          }}
          onBlur={onBlur}
          {...NO_FILL}
        >
          <option value="" />
          {field.options.map((option, index) => (
            <option key={index} value={String(index)}>
              {option.label}
            </option>
          ))}
        </select>
        {footer}
      </div>
    )
  }

  return (
    <fieldset
      className="hm-form__field hm-form__group"
      data-field-id={field.id}
      data-kind="choice"
      aria-describedby={described.describedBy}
    >
      <legend className="hm-requests__label">
        <LabelText field={field} />
      </legend>
      <div className="hm-requests__choices">
        {field.options.map((option, index) => {
          const checked = chosen.includes(option.value)

          return (
            <label className="hm-requests__choice" key={index}>
              <input
                type={field.multiple ? 'checkbox' : 'radio'}
                name={field.multiple ? undefined : id}
                checked={checked}
                onChange={() => {
                  if (field.multiple) {
                    onChange(checked ? chosen.filter(value => value !== option.value) : [...chosen, option.value])
                  } else {
                    onChange(option.value)
                  }
                }}
                onBlur={leavingGroup(onBlur)}
                {...NO_FILL}
              />
              <span>{option.label}</span>
            </label>
          )
        })}
      </div>
      {!field.multiple && !field.required && chosen.length > 0 ? (
        <Button className="hm-form__clear" variant="quiet" onClick={() => onChange('')}>
          {sheetStrings.interactive.form.clear}
        </Button>
      ) : null}
      {footer}
    </fieldset>
  )
}

/** Under a multiple choice: how many may be picked, when the request says. */
function pickCount(field: FormField): string | null {
  if (field.kind !== 'choice' || !field.multiple) {
    return null
  }

  const { minSelected: min, maxSelected: max } = field
  const words = sheetStrings.interactive.form

  if (min !== undefined && max !== undefined) {
    return words.pickBetween({ min, max })
  }

  return min !== undefined ? words.pickAtLeast({ min }) : max !== undefined ? words.pickAtMost({ max }) : null
}

/** Under a date, time or datetime tied to a zone, or a datetime left to this device's: which zone it is in. */
function zoneNote(field: FormField, device: string): string | null {
  if (field.kind === 'datetime' || field.kind === 'time' || field.kind === 'date' || field.kind === 'daterange') {
    if (field.tz) {
      return sheetStrings.interactive.form.zoneField({ zone: field.tz, offset: zoneOffsetLabel(field.tz) })
    }

    if (field.kind === 'datetime') {
      const zone = deviceZone() || device

      return sheetStrings.interactive.form.zoneDevice({ zone, offset: zoneOffsetLabel(zone) })
    }
  }

  return null
}

/** Under a datetime: what will go out for what is entered (the offset and the zone in brackets). */
function sentLine(field: FormField, raw: RawValue, device: string): string | null {
  if (field.kind !== 'datetime' || typeof raw !== 'string' || raw === '') {
    return null
  }

  const result = evaluate(field, raw, device)

  return 'value' in result && typeof result.value === 'string'
    ? sheetStrings.interactive.form.sentAs({ value: result.value })
    : null
}
