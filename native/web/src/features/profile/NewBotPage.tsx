/**
 * The New bot page, `#/new-bot`: the Expo app's New-bot sheet as a page of the main pane (the Crons editor and
 * the bot profile page are pages too, and a page keeps its own address, its Back and its focus).
 *
 * A handle, an optional description, an optional model to pin and an optional bot to clone the settings of, then
 * `profiles.create` (`core/bot-profile/new-bot.ts`). The handle is checked as it is typed against a
 * transcription of the gateway's own rules, so a name that cannot work is said before anything is sent, in the
 * reader's language; the gateway runs the same checks again and its refusal comes back under the form in its own
 * words, as plain text.
 *
 * There is **no display-name field**: no gateway call writes a profile's display name (`profiles.create` has no
 * such parameter), and the reader's own name for a bot lives on its profile page. The handle is what the list
 * shows until then.
 *
 * What happens after a create: the roster is read again, and the page opens the bot's chat. The chat screen
 * resolves the bot's one Bot Chat the ordinary way (ADR-0007); nothing here makes a conversation. A bot with no
 * model, which the gateway reports, stays on this page with a sentence and the way into its chat, instead of
 * opening a chat that can only answer with an error.
 *
 * A chunk of its own, fetched when the route is opened or a pointer or the focus reaches the sidebar's link.
 */
import { type FormEvent, type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import {
  checkProfileName,
  createBot,
  type CreatedBot,
  EMPTY_NEW_BOT_DRAFT,
  loadModelChoices,
  NewBotFailure,
  type NameProblem,
  type NewBotModelChoice
} from '../../core/bot-profile/new-bot'
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { HashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { Button } from '../../ui/primitives'
import { useChatRuntime } from '../chat/chat-runtime'
import { chatHref } from '../shell/router'
import '../settings/settings.css'
import './profile.css'

export interface NewBotPageProps {
  /** The page's address: a made bot's chat is opened through it. */
  router: HashRouter
}

/** The words for what is wrong with a handle. */
function problemText(problem: NameProblem): string {
  const words = sheetStrings.newBot.problem

  switch (problem.kind) {
    case 'empty':
      return words.empty
    case 'default':
      return words.default
    case 'invalid':
      return words.invalid({ suggestion: problem.suggestion })
    case 'reserved':
      return words.reserved({ name: problem.name })
    case 'taken':
      return words.taken({ name: problem.name })
  }
}

/** Why a create failed, in the page's words around the gateway's own (plain text, bounded). */
function failureText(failure: unknown): string {
  if (failure instanceof NewBotFailure && failure.kind === 'not_listed') {
    return sheetStrings.newBot.notListed({ name: displayText(failure.detail, BOT_NAME_LIMIT) })
  }

  const reason = failure instanceof Error && failure.message ? displayText(failure.message, 300) : ''

  return strings.profiles.new.failed({ reason })
}

export function NewBotPage({ router }: NewBotPageProps): ReactElement {
  useLocale()

  const profiles = useChatRuntime()?.profiles
  const roster = useStore(botsStore, state => state.bots)
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const names = useMemo(() => roster.map(bot => bot.name), [roster])

  const [raw, setRaw] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const [made, setMade] = useState<CreatedBot | null>(null)
  const [choices, setChoices] = useState<readonly NewBotModelChoice[]>([])

  const handleField = useRef<HTMLInputElement>(null)
  const doneNote = useRef<HTMLParagraphElement>(null)
  const handleId = useId()
  const hintId = useId()
  const errorId = useId()
  const descriptionId = useId()
  const modelId = useId()
  const cloneId = useId()
  const words = strings.profiles.new

  // The model picker is read once the connection is up; without the list the bot inherits and the field is absent.
  useEffect(() => {
    if (!profiles || !ready) {
      return
    }

    let cancelled = false

    void loadModelChoices(profiles.gateway).then(list => {
      if (!cancelled) {
        setChoices(list)
      }
    })

    return () => {
      cancelled = true
    }
  }, [profiles, ready])

  // After a made bot that has no model, the sentence is where the reader is looked at next.
  useEffect(() => {
    if (made) {
      doneNote.current?.focus()
    }
  }, [made])

  const verdict = useMemo(() => checkProfileName(raw, names), [raw, names])
  const groups = useMemo(() => {
    const byProvider = new Map<string, { name: string; models: NewBotModelChoice[] }>()

    for (const choice of choices) {
      const group = byProvider.get(choice.provider) ?? { name: choice.providerName, models: [] }

      group.models.push(choice)
      byProvider.set(choice.provider, group)
    }

    return [...byProvider.values()]
  }, [choices])

  const shownProblem = (touched || raw !== '') && verdict.problem ? problemText(verdict.problem) : null
  const canCreate = profiles !== undefined && ready && !busy

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setTouched(true)

    if (!verdict.ok) {
      handleField.current?.focus()

      return
    }

    // A press while the last create is being carried out does nothing; the button stays enabled to keep the focus.
    if (!profiles || !ready || busy) {
      return
    }

    const picked = choices.find(choice => choice.model === model)

    setBusy(true)
    setFailure(null)

    void createBot(
      profiles,
      {
        ...EMPTY_NEW_BOT_DRAFT,
        handle: verdict.handle,
        description,
        model: picked?.model ?? '',
        provider: picked?.provider ?? '',
        cloneFrom: cloneFrom || null
      },
      name => botsStore.getState().byName[name] !== undefined
    )
      .then(created => {
        if (created.withoutModel) {
          setMade(created)
        } else {
          router.navigate(chatHref(created.name))
        }
      })
      .catch((error: unknown) => setFailure(error))
      .finally(() => setBusy(false))
  }

  if (made) {
    return (
      <div className="hm-profile hm-newbot">
        <h2 className="hm-profile__heading">{sheetStrings.newBot.created({ name: made.name })}</h2>
        <p className="hm-profile__note" tabIndex={-1} ref={doneNote}>
          {words.withoutModel}
        </p>
        <div className="hm-profile__actions">
          <a className="hm-button" data-variant="primary" href={chatHref(made.name)}>
            {strings.app.activity.openChat({ bot: made.name })}
          </a>
        </div>
      </div>
    )
  }

  return (
    <form className="hm-profile hm-newbot" onSubmit={submit} noValidate>
      <p className="hm-profile__hint">{strings.profiles.settings.newBotHint}</p>

      {profiles && !ready ? (
        <p className="hm-profile__note" role="status">
          {sheetStrings.newBot.offline}
        </p>
      ) : null}

      <div className="hm-profile__field">
        <label htmlFor={handleId}>{words.handle}</label>
        <input
          id={handleId}
          ref={handleField}
          type="text"
          value={raw}
          placeholder={words.handlePlaceholder}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={80}
          aria-invalid={shownProblem ? true : undefined}
          aria-describedby={`${hintId}${shownProblem ? ` ${errorId}` : ''}`}
          onChange={event => setRaw(event.currentTarget.value)}
          onBlur={() => setTouched(true)}
        />
        <span className="hm-profile__hint" id={hintId}>
          {verdict.ok && verdict.warning
            ? sheetStrings.newBot.subcommand({ name: verdict.warning.name })
            : words.handleHint}
        </span>
        {shownProblem ? (
          <span className="hm-profile__failure" id={errorId}>
            {shownProblem}
          </span>
        ) : null}
      </div>

      <div className="hm-profile__field">
        <label htmlFor={descriptionId}>{words.description}</label>
        <textarea
          id={descriptionId}
          value={description}
          rows={3}
          placeholder={words.descriptionPlaceholder}
          spellCheck
          onChange={event => setDescription(event.currentTarget.value)}
        />
      </div>

      {groups.length > 0 ? (
        <div className="hm-profile__field">
          <label htmlFor={modelId}>{words.model}</label>
          <select id={modelId} value={model} onChange={event => setModel(event.currentTarget.value)}>
            <option value="">{words.modelInherit}</option>
            {groups.map(group => (
              <optgroup key={group.name} label={group.name}>
                {group.models.map(choice => (
                  <option key={choice.model} value={choice.model}>
                    {choice.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="hm-profile__hint">{words.modelHint}</span>
        </div>
      ) : null}

      {names.length > 0 ? (
        <div className="hm-profile__field">
          <label htmlFor={cloneId}>{words.cloneFrom}</label>
          <select id={cloneId} value={cloneFrom} onChange={event => setCloneFrom(event.currentTarget.value)}>
            <option value="">{words.cloneNone}</option>
            {names.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="hm-profile__hint">{words.cloneHint}</span>
        </div>
      ) : null}

      {failure ? (
        <p className="hm-profile__failure" role="alert">
          {failureText(failure)}
        </p>
      ) : null}

      <div className="hm-profile__actions">
        <Button type="submit" aria-busy={busy} disabled={!canCreate && !busy}>
          {busy ? words.creating : words.create}
        </Button>
        <a className="hm-button" data-variant="quiet" href="#/">
          {words.cancel}
        </a>
      </div>
    </form>
  )
}
