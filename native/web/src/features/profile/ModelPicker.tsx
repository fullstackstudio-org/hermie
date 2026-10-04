/**
 * The bot's own model, on its profile page: what its chats start on, written to the profile as the bot's default
 * (`profiles.configure`, `core/bot-profile/model.ts`), where the chat's own option (`ConversationOptions`) only
 * changes one chat.
 *
 * The list is the gateway's inventory (`model.options`), cut into one group per provider with a search when there
 * are many, like the chat's picker; the model the bot is on stays in it even when the inventory does not list it
 * (a model set by hand), because a select whose value is not one of its options shows the wrong thing. What is
 * written is the model id exactly as the inventory spells it plus the provider's slug in its own field, never a
 * `provider/model` made up here.
 *
 * A model the gateway calls expensive writes nothing: it becomes a question under the picker with the gateway's
 * own words, answered on this page and never on the reader's behalf, and the picker stays on the model the bot
 * is on until the answer is yes. A gateway that will not list its models gets one sentence instead of a picker.
 *
 * Every name here is the gateway's and untrusted: plain text.
 */
import { prettyModelName } from '@hermie/transcript'
import { type KeyboardEvent, type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { BotProfileModel, BotProfileState } from '../../core/bot-profile/model'
import type { ModelChoice } from '../../core/bot-profile/params'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { Button } from '../../ui/primitives'
import { MODEL_SEARCH_FROM } from '../chat/model-choices'

interface Group {
  provider: string
  models: ModelChoice[]
}

/** The choices that answer the search, one group per provider in the gateway's order. */
export function choiceGroups(choices: readonly ModelChoice[], query: string, currentId: string): Group[] {
  const needle = query.trim().toLowerCase()
  const groups: Group[] = []

  for (const choice of choices) {
    const matches =
      needle === '' ||
      choice.id === currentId ||
      [prettyModelName(choice.model), choice.model, choice.providerName, choice.provider].some(text =>
        text.toLowerCase().includes(needle)
      )

    if (!matches) {
      continue
    }

    const last = groups.at(-1)

    if (last && last.provider === choice.providerName) {
      last.models.push(choice)
    } else {
      groups.push({ provider: choice.providerName, models: [choice] })
    }
  }

  return groups
}

export function ModelPicker({
  model,
  state,
  editable
}: {
  model: BotProfileModel | null
  state: BotProfileState
  editable: boolean
}): ReactElement | null {
  const words = sheetStrings.botProfile
  const questionId = useId()
  const noMatchId = useId()
  const [query, setQuery] = useState('')
  const select = useRef<HTMLSelectElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const pin = state.details?.model
  const currentId = pin?.provider && pin.model ? `${pin.provider}/${pin.model}` : ''
  const loaded = state.modelChoices.kind === 'loaded' ? state.modelChoices.choices : null
  const choices = useMemo(() => loaded ?? [], [loaded])
  const asking = state.modelConfirmation !== null
  const searchable = choices.length >= MODEL_SEARCH_FROM
  const groups = useMemo(
    () => choiceGroups(choices, searchable ? query : '', currentId),
    [choices, query, searchable, currentId]
  )
  const known = choices.some(choice => choice.id === currentId)
  const noMatch =
    searchable && query.trim() !== '' && groups.every(group => group.models.every(choice => choice.id === currentId))

  // Read the inventory once the page can write: until then there is nothing to choose for.
  useEffect(() => {
    if (model && editable) {
      void model.loadModelChoices()
    }
  }, [model, editable])

  useEffect(() => {
    if (asking) {
      cancel.current?.focus()
    }
  }, [asking])

  if (!state.details) {
    return null
  }

  const withdraw = (): void => {
    model?.cancelModelConfirmation()
    select.current?.focus()
  }

  const currentName = pin?.model ? displayText(prettyModelName(pin.model), 80) : ''

  if (state.modelChoices.kind === 'unavailable') {
    return (
      <>
        <p className="hm-profile__hint">{words.modelUnavailable}</p>
        {currentName ? <p>{currentName}</p> : null}
      </>
    )
  }

  return (
    <>
      {searchable ? (
        <label className="hm-profile__field">
          <span>{strings.chat.options.modelSearch}</span>
          <input
            type="search"
            value={query}
            autoComplete="off"
            aria-describedby={noMatch ? noMatchId : undefined}
            onChange={event => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}

      <label className="hm-profile__field">
        <span>{strings.chat.options.model}</span>
        <select
          ref={select}
          value={currentId}
          disabled={!editable || state.modelChoices.kind !== 'loaded'}
          aria-busy={state.busy.model === true || undefined}
          onChange={event => {
            const picked = choices.find(choice => choice.id === event.currentTarget.value)

            if (picked && !state.busy.model) {
              void model?.chooseModel(picked)
            }
          }}
        >
          {currentId === '' ? (
            <option value="" disabled>
              {words.modelFollows}
            </option>
          ) : null}
          {currentId !== '' && !known ? (
            <option value={currentId}>{words.modelNotListed({ name: currentName })}</option>
          ) : null}
          {groups.map(group => (
            <optgroup key={group.provider} label={displayText(group.provider, 64)}>
              {group.models.map(choice => (
                <option key={choice.id} value={choice.id}>
                  {displayText(prettyModelName(choice.model), 80)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {state.modelChoices.kind === 'loading' ? (
        <p className="hm-profile__hint" role="status">
          {sheetStrings.chatSettings.modelsLoading}
        </p>
      ) : null}
      {noMatch ? (
        <p className="hm-profile__hint" id={noMatchId} role="status">
          {sheetStrings.chatSettings.modelsNoMatch}
        </p>
      ) : null}

      {state.modelConfirmation ? (
        <div
          className="hm-profile__prompt"
          role="group"
          aria-labelledby={questionId}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Escape') {
              // Withdraws the question only.
              event.preventDefault()
              withdraw()
            }
          }}
        >
          <h3 className="hm-profile__subheading" id={questionId}>
            {strings.chat.options.expensiveTitle}
          </h3>
          <p>{strings.app.chat.expensiveModel({ message: displayText(state.modelConfirmation.message, 300) })}</p>
          <p className="hm-profile__hint">{displayText(prettyModelName(state.modelConfirmation.choice.model), 80)}</p>
          <div className="hm-profile__actions">
            <Button
              onClick={() => {
                select.current?.focus()
                void model?.confirmModel()
              }}
            >
              {strings.chat.options.expensiveConfirm}
            </Button>
            <Button ref={cancel} variant="quiet" onClick={withdraw}>
              {strings.chat.options.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}
