/**
 * What the chat's panel says about THIS conversation's session, beyond YOLO:
 * fast mode, reasoning effort, the model, how full the context window is, and the
 * file export.
 *
 * Part of the options panel's chunk (`ChatOptionsPanel`), so none of it loads with
 * the first screen. Native controls throughout (a checkbox, two selects, a meter,
 * buttons), so every one is labelled and the keyboard works the way it works
 * everywhere. The values are the session's own report (`use-session-options.ts`):
 * a select shows the model the gateway says the chat is on, whatever was clicked.
 *
 * A model the gateway calls expensive is a question under the picker, answered
 * in the panel and never on the reader's behalf; the picker stays on the model
 * the chat is on until the answer is yes.
 */
import { type KeyboardEvent, type ReactElement, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { sheetStrings } from '../../i18n/sheet-strings'
import { CONTEXT_DANGER_AT, CONTEXT_WARN_AT, contextSummary } from './context-format'
import { MODEL_SEARCH_FROM, modelGroups, otherModelCount } from './model-choices'
import type { ExportFormat } from './chat-export'
import { REASONING_EFFORTS, type SessionOptionsControl } from './use-session-options'
import type { ContextUsage } from '@hermie/transcript'

const reasoningLabel = (value: string): string =>
  (REASONING_EFFORTS as readonly string[]).includes(value)
    ? sheetStrings.chatSettings.reasoning[value as (typeof REASONING_EFFORTS)[number]]
    : value

/** Fast mode: one checkbox, with its hint. */
function FastOption({ session }: { session: SessionOptionsControl }): ReactElement {
  const hintId = useId()

  return (
    <div className="hm-chat-options__option">
      <label className="hm-chat-options__choice">
        <input
          type="checkbox"
          checked={session.fast}
          aria-busy={session.busy === 'fast' || undefined}
          aria-describedby={hintId}
          onChange={event => {
            if (session.busy !== 'fast') {
              void session.setFast(event.currentTarget.checked)
            }
          }}
        />
        <span>{strings.chat.options.fast}</span>
      </label>
      <p className="hm-chat-options__hint" id={hintId}>
        {strings.chat.options.fastHint}
      </p>
    </div>
  )
}

/** Reasoning effort: a select of the efforts the gateway takes, on the one the session reports. */
function ReasoningOption({ session }: { session: SessionOptionsControl }): ReactElement {
  const known = (REASONING_EFFORTS as readonly string[]).includes(session.reasoning)

  return (
    <label className="hm-chat-options__field">
      <span>{strings.chat.options.reasoning}</span>
      <select
        value={session.reasoning}
        aria-busy={session.busy === 'reasoning' || undefined}
        onChange={event => {
          if (session.busy !== 'reasoning') {
            void session.setReasoning(event.currentTarget.value)
          }
        }}
      >
        {session.reasoning === '' ? (
          <option value="" disabled>
            {sheetStrings.chatSettings.reasoningUnset}
          </option>
        ) : null}
        {/* An effort this client does not know by name is still the one the chat is on. */}
        {session.reasoning !== '' && !known ? <option value={session.reasoning}>{session.reasoning}</option> : null}
        {REASONING_EFFORTS.map(effort => (
          <option key={effort} value={effort}>
            {reasoningLabel(effort)}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The model: a select cut into providers, a search when there are many, and the
 * question the gateway asks before an expensive one.
 */
function ModelOption({ session }: { session: SessionOptionsControl }): ReactElement {
  const questionId = useId()
  const noMatchId = useId()
  const [query, setQuery] = useState('')
  const select = useRef<HTMLSelectElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const asking = session.confirm !== null

  const searchable = session.models.length >= MODEL_SEARCH_FROM
  const groups = useMemo(
    () => modelGroups(session.models, session.model, searchable ? query : ''),
    [query, searchable, session.model, session.models]
  )
  const searching = searchable && query.trim() !== ''
  const noMatch = searching && otherModelCount(groups, session.model) === 0

  // A layout effect, so focus is on the safe answer in the same commit that draws the question: an ordinary effect runs
  // a moment later, and an answer given (or a focus read) in between meets the old focus, which the effect then takes.
  useLayoutEffect(() => {
    if (asking) {
      cancel.current?.focus()
    }
  }, [asking])

  const withdraw = (): void => {
    session.cancelModel()
    select.current?.focus()
  }

  return (
    <div className="hm-chat-options__option">
      {searchable ? (
        <label className="hm-chat-options__field">
          <span>{strings.chat.options.modelSearch}</span>
          <input
            type="search"
            value={query}
            aria-describedby={noMatch ? noMatchId : undefined}
            onChange={event => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}

      <label className="hm-chat-options__field">
        <span>{strings.chat.options.model}</span>
        <select
          ref={select}
          value={session.model}
          aria-busy={session.busy === 'model' || undefined}
          onChange={event => {
            if (session.busy !== 'model') {
              void session.setModel(event.currentTarget.value)
            }
          }}
        >
          {session.model === '' ? <option value="" disabled /> : null}
          {groups.map(group =>
            group.provider === null ? (
              group.models.map(model => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))
            ) : (
              <optgroup key={group.provider} label={group.provider}>
                {group.models.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </optgroup>
            )
          )}
        </select>
      </label>

      {session.modelsLoading ? (
        <p className="hm-chat-options__hint" role="status">
          {sheetStrings.chatSettings.modelsLoading}
        </p>
      ) : null}
      {noMatch ? (
        <p className="hm-chat-options__hint" id={noMatchId} role="status">
          {sheetStrings.chatSettings.modelsNoMatch}
        </p>
      ) : null}

      {session.confirm ? (
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
          <p id={questionId}>
            <strong>{strings.chat.options.expensiveTitle}</strong>
          </p>
          <p>{strings.app.chat.expensiveModel({ message: session.confirm.message })}</p>
          <div className="hm-chat-options__confirm-actions">
            <button
              type="button"
              className="hm-chat-options__reset"
              onClick={() => {
                select.current?.focus()
                void session.confirmModel()
              }}
            >
              {strings.chat.options.expensiveConfirm}
            </button>
            <button ref={cancel} type="button" className="hm-chat-options__reset" onClick={withdraw}>
              {strings.chat.options.cancel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * How full the context window is: the native meter, with the numbers beside it.
 *
 * The meter alone says the proportion and a number alone says nothing about the
 * window, so both are drawn, and the words are what a screen reader is given. The
 * colour steps at three quarters and nine tenths (the meter's own low and high),
 * because the reader is deciding whether there is room for another long turn.
 */
export function ContextMeter({ usage }: { usage: ContextUsage }): ReactElement {
  const labelId = useId()
  const valueId = useId()
  const hintId = useId()

  return (
    <div className="hm-chat-options__option">
      <div className="hm-chat-options__meter">
        <span id={labelId}>{strings.chat.context.label}</span>
        <meter
          min={0}
          max={usage.limit}
          low={usage.limit * CONTEXT_WARN_AT}
          high={usage.limit * CONTEXT_DANGER_AT}
          optimum={0}
          value={Math.min(usage.used, usage.limit)}
          aria-labelledby={labelId}
          aria-describedby={`${valueId} ${hintId}`}
        />
        <span id={valueId} className="hm-chat-options__meter-value">
          {contextSummary(usage)}
        </span>
      </div>
      <p className="hm-chat-options__hint" id={hintId}>
        {strings.chat.context.hint}
      </p>
    </div>
  )
}

/** The way out of the conversation as a file: one button per format, and what the file holds. */
export function ExportOptions({ onExport }: { onExport: (format: ExportFormat) => void }): ReactElement {
  const headingId = useId()
  const hintId = useId()

  return (
    <div className="hm-chat-options__option" role="group" aria-labelledby={headingId} aria-describedby={hintId}>
      <p className="hm-chat-options__label" id={headingId}>
        {strings.chat.export.header}
      </p>
      <div className="hm-chat-options__confirm-actions">
        <button type="button" className="hm-chat-options__reset" onClick={() => onExport('md')}>
          {strings.chat.export.downloadMarkdown}
        </button>
        <button type="button" className="hm-chat-options__reset" onClick={() => onExport('txt')}>
          {strings.chat.export.downloadText}
        </button>
      </div>
      <p className="hm-chat-options__hint" id={hintId}>
        {strings.chat.export.hint}
      </p>
    </div>
  )
}

/** Fast, reasoning, model and the context reading: the controls of a session the page is attached to. */
export function SessionOptions({ session }: { session: SessionOptionsControl }): ReactElement {
  useLocale()

  return (
    <>
      <FastOption session={session} />
      <ReasoningOption session={session} />
      <ModelOption session={session} />
      {session.usage ? <ContextMeter usage={session.usage} /> : null}
    </>
  )
}
