/**
 * The schedule part of the editor: how often (interval, daily, a cron expression, once), and the words that say
 * what was built.
 *
 * Native controls throughout: a fieldset of radios for the kind, number, time and text inputs, a select for the unit
 * and a fieldset of checkboxes for the days, each with a label, so a keyboard or a screen reader meets the same form
 * a mouse does. A mistake is said in words under the field it is in, tied to it (`aria-describedby`,
 * `aria-invalid`), and only once the reader has tried to save (`showErrors`): a half-typed number is not yet wrong.
 *
 * The line under the fields describes what was built, and never when it fires: that is the gateway's to say, after
 * the save (`editor.nextRunHint`).
 */
import { type ReactElement, useId } from 'react'

import {
  buildSchedule,
  describeSchedule,
  type IntervalUnit,
  type ScheduleDraft,
  type ScheduleMode
} from '../../core/cron/schedule'
import { strings } from '../../generated/strings'
import { cronWebStrings } from '../../i18n/cron-strings'

const MODES: readonly ScheduleMode[] = ['interval', 'daily', 'cron', 'once']
const UNITS: readonly IntervalUnit[] = ['minutes', 'hours', 'days']

export interface ScheduleFieldsProps {
  draft: ScheduleDraft
  onChange: (draft: ScheduleDraft) => void
  /** Say what is wrong with the fields. */
  showErrors: boolean
}

export function ScheduleFields({ draft, onChange, showErrors }: ScheduleFieldsProps): ReactElement {
  const id = useId()
  const built = buildSchedule(draft)
  const error = showErrors && !built.ok ? built.error : null
  const errorId = `${id}-error`
  const set = (patch: Partial<ScheduleDraft>): void => onChange({ ...draft, ...patch })
  const invalid = error !== null
  const describedBy = invalid ? errorId : undefined

  return (
    <div className="hm-schedule">
      <fieldset className="hm-fieldset">
        <legend className="hm-fieldset__legend">{strings.cron.schedule.mode}</legend>
        <div className="hm-schedule__modes">
          {MODES.map(mode => (
            <label className="hm-cron-choice" key={mode}>
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                checked={draft.mode === mode}
                onChange={() => set({ mode })}
              />
              <span>{strings.cron.schedule.modes[mode]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {draft.mode === 'interval' ? (
        <div className="hm-schedule__row">
          <div className="hm-field">
            <label className="hm-field__label" htmlFor={`${id}-every`}>
              {strings.cron.schedule.everyLabel}
            </label>
            <input
              id={`${id}-every`}
              className="hm-field__input hm-field__input--short"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.intervalValue}
              onChange={event => set({ intervalValue: event.target.value })}
              aria-invalid={invalid}
              aria-describedby={describedBy}
            />
          </div>
          <div className="hm-field">
            <label className="hm-field__label" htmlFor={`${id}-unit`}>
              {cronWebStrings.unit}
            </label>
            <select
              id={`${id}-unit`}
              className="hm-field__input"
              value={draft.intervalUnit}
              onChange={event => set({ intervalUnit: event.target.value as IntervalUnit })}
            >
              {UNITS.map(unit => (
                <option key={unit} value={unit}>
                  {strings.cron.schedule.units[unit]}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {draft.mode === 'daily' ? (
        <>
          <div className="hm-field">
            <label className="hm-field__label" htmlFor={`${id}-time`}>
              {strings.cron.schedule.time}
            </label>
            <input
              id={`${id}-time`}
              className="hm-field__input hm-field__input--short"
              type="time"
              value={draft.time}
              onChange={event => set({ time: event.target.value })}
              aria-invalid={invalid}
              aria-describedby={describedBy}
            />
          </div>
          <fieldset className="hm-fieldset" aria-describedby={`${id}-days-hint`}>
            <legend className="hm-fieldset__legend">{strings.cron.schedule.days}</legend>
            <div className="hm-schedule__days">
              {strings.cron.schedule.weekdayNames.map((dayName, day) => (
                <label className="hm-cron-choice" key={day}>
                  <input
                    type="checkbox"
                    checked={draft.weekdays.includes(day)}
                    onChange={event =>
                      set({
                        weekdays: event.target.checked
                          ? [...draft.weekdays, day].sort((a, b) => a - b)
                          : draft.weekdays.filter(entry => entry !== day)
                      })
                    }
                  />
                  <span>{dayName}</span>
                </label>
              ))}
            </div>
            <p className="hm-field__hint" id={`${id}-days-hint`}>
              {strings.cron.schedule.daysHint}
            </p>
          </fieldset>
        </>
      ) : null}

      {draft.mode === 'cron' ? (
        <div className="hm-field">
          <label className="hm-field__label" htmlFor={`${id}-cron`}>
            {strings.cron.schedule.cronExpression}
          </label>
          <input
            id={`${id}-cron`}
            className="hm-field__input hm-field__input--mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={strings.cron.schedule.cronPlaceholder}
            value={draft.cronExpression}
            onChange={event => set({ cronExpression: event.target.value })}
            aria-invalid={invalid}
            aria-describedby={describedBy ? `${describedBy} ${id}-hint` : `${id}-hint`}
          />
          <p className="hm-field__hint" id={`${id}-hint`}>
            {strings.cron.schedule.cronHint}
          </p>
        </div>
      ) : null}

      {draft.mode === 'once' ? (
        <div className="hm-field">
          <label className="hm-field__label" htmlFor={`${id}-once`}>
            {strings.cron.schedule.once}
          </label>
          <input
            id={`${id}-once`}
            className="hm-field__input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={strings.cron.schedule.oncePlaceholder}
            value={draft.onceValue}
            onChange={event => set({ onceValue: event.target.value })}
            aria-invalid={invalid}
            aria-describedby={describedBy ? `${describedBy} ${id}-hint` : `${id}-hint`}
          />
          <p className="hm-field__hint" id={`${id}-hint`}>
            {strings.cron.schedule.onceHint}
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="hm-field__error" id={errorId}>
          {error}
        </p>
      ) : null}

      {built.ok ? (
        <p className="hm-schedule__preview">
          <span>{describeSchedule(built.schedule)}</span>
          <span className="hm-schedule__raw">{strings.cron.editor.preview({ schedule: built.schedule })}</span>
        </p>
      ) : null}
    </div>
  )
}
