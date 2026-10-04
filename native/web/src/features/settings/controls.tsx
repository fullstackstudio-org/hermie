/**
 * The pieces every Settings page is made of: the page itself (a labelled section under the route's
 * `h1`), a group of radio buttons, a checkbox with its hint, and the line that says a setting that
 * follows the person is not reaching the gateway.
 *
 * Native controls throughout (`<fieldset>` with a `<legend>`, `<input type="radio">`, `<input
 * type="checkbox">`, `<select>`), so each one is labelled, reachable by Tab and operated by the keys the
 * browser already gives it (the arrows inside a radio group, Space on a checkbox). Nothing here is a
 * `div` with a click handler.
 */
import { type ReactElement, type ReactNode, useId } from 'react'
import { useStore } from 'zustand'

import { sheetStrings } from '../../i18n/sheet-strings'
import { settingsSynced, uiMetaStatusStore } from '../../state/ui-meta-status'
import './settings.css'

/** One settings page: its title is the section's `h2`, and the region is named by it. */
export function SettingsPage({
  title,
  lead,
  children,
  className
}: {
  title: string
  /** One sentence under the title, when the page has one. */
  lead?: string
  children: ReactNode
  className?: string
}): ReactElement {
  const titleId = useId()

  return (
    <section className={className ? `hm-settings-page ${className}` : 'hm-settings-page'} aria-labelledby={titleId}>
      <h2 className="hm-settings-page__title" id={titleId}>
        {title}
      </h2>
      {lead ? <p className="hm-settings-page__lead">{lead}</p> : null}
      {children}
    </section>
  )
}

export interface RadioOption<V extends string> {
  value: V
  label: ReactNode
  /** A shape beside the label that is not its name (a colour swatch): hidden from assistive technology. */
  mark?: ReactNode
}

/** A radio group: a fieldset named by its legend, one native radio per option, and a hint it is described by. */
export function RadioGroup<V extends string>({
  legend,
  value,
  options,
  onChange,
  hint,
  layout = 'column'
}: {
  legend: string
  value: V
  options: readonly RadioOption<V>[]
  onChange: (value: V) => void
  hint?: string
  layout?: 'column' | 'wrap'
}): ReactElement {
  const name = useId()
  const hintId = useId()

  return (
    <fieldset className="hm-set" {...(hint ? { 'aria-describedby': hintId } : {})}>
      <legend className="hm-set__legend">{legend}</legend>
      <div className="hm-set__options" data-layout={layout}>
        {options.map(option => (
          <label className="hm-choice" key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.mark ? (
              <span className="hm-choice__mark" aria-hidden="true">
                {option.mark}
              </span>
            ) : null}
            <span className="hm-choice__label">{option.label}</span>
          </label>
        ))}
      </div>
      {hint ? (
        <p className="hm-set__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </fieldset>
  )
}

/** One checkbox with its label and, when it has one, a hint it is described by. */
export function Checkbox({
  label,
  checked,
  onChange,
  hint,
  disabled = false
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
  /** Not offered right now; the page says why. */
  disabled?: boolean
}): ReactElement {
  const hintId = useId()

  return (
    <div className="hm-set">
      <label className="hm-choice">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={event => onChange(event.currentTarget.checked)}
          {...(hint ? { 'aria-describedby': hintId } : {})}
        />
        <span className="hm-choice__label">{label}</span>
      </label>
      {hint ? (
        <p className="hm-set__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Said over a setting that follows the person through the gateway (`ui_meta`) while the gateway is not
 * taking it, so the reader is never told a choice is everywhere when it is only here. Nothing while the
 * bridge is still starting or while it is synced.
 */
export function SyncNote(): ReactElement | null {
  const state = useStore(uiMetaStatusStore, status => status.state)

  if (settingsSynced({ state }) || state === 'starting') {
    return null
  }

  return (
    <p className="hm-settings-page__sync" role="status" data-sync={state}>
      {state === 'local' ? sheetStrings.settings.notSynced.local : sheetStrings.settings.notSynced.unavailable}
    </p>
  )
}

/** A name and its value in a read-only list: the Gateway and About pages. */
export function Fact({
  label,
  children,
  mono = false
}: {
  label: string
  children: ReactNode
  /** Monospaced and selectable as one token: an address, a commit. */
  mono?: boolean
}): ReactElement {
  return (
    <div className="hm-fact">
      <dt className="hm-fact__label">{label}</dt>
      <dd className="hm-fact__value" data-mono={mono ? 'true' : undefined}>
        {children}
      </dd>
    </div>
  )
}
