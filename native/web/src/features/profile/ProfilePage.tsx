/**
 * One bot's profile, on a page of its own: `#/chat/<bot>/profile`. Reached from a row's menu (Edit
 * profile), from the chat's header and from the bot's name above the chat. The Expo app's profile and
 * capabilities sheets and the native app's bot settings page, in one page of sections (the native
 * app's `BotSettingsScreen`, which this follows):
 *
 *  - **Photo.** Change, replace or remove it. The picture is cut to a square from its middle and re-drawn
 *    as a JPEG in the page (`core/bot-profile/avatar.ts`), so nothing of the original but its pixels, a
 *    photo's location included, goes to the gateway, where every client can read the picture.
 *  - **Name.** What THIS reader calls the bot (the arrangement's label, which follows the person through
 *    `ui_meta`); the gateway keeps the profile's own name, shown beside it as the handle.
 *  - **Description**, which waits for Save, and **colour**, which is the chat list's own setting and
 *    applies at once.
 *  - **Capabilities.** Toolsets, skills and MCP servers, as switches that write at once (`BotProfileModel`).
 *  - **About**: the facts: the model, the provider, the session, the gateway's version.
 *
 * What the gateway keeps (photo, description, capabilities) is written through the gateway's own methods
 * and drawn read-only while there is no connection, once a write was refused as not this account's to make,
 * and not at all on a gateway that lacks the methods; the name and colour are the reader's own and always
 * work. A failure is said under the control it belongs to, in the gateway's words, as plain text.
 *
 * A chunk of its own: nothing of this is in the first load (`features/shell/App.tsx` loads it with its route).
 */
import { prettyModelName } from '@hermie/transcript'
import { type ChangeEvent, type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { AvatarError, prepareAvatar } from '../../core/bot-profile/avatar'
import { skillsToolsetOff } from '../../core/bot-profile/details'
import type { BotProfileFailure } from '../../core/bot-profile/failure'
import { BotProfileModel, IDLE_PROFILE_STORE, type ProfileField } from '../../core/bot-profile/model'
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { ACCENT_NAMES, type AccentName } from '../../state/folders'
import { BOT_LABEL_MAX, layoutStore } from '../../state/layout'
import { Avatar, Button, VisuallyHidden } from '../../ui/primitives'
import { botLabel } from '../bots/bot-label'
import { useChatRuntime } from '../chat/chat-runtime'
import { Checkbox, Fact, RadioGroup } from '../settings/controls'
import { useSettingsRuntime } from '../settings/settings-runtime'
import { chatHref } from '../shell/router'
import { ModelPicker } from './ModelPicker'
import '../settings/settings.css'
import './profile.css'

export interface ProfilePageProps {
  /** The bot of the route. */
  bot: string
}

/** The gateway's words for a failure, cleaned and bounded: somebody else's text, drawn as characters. */
function failureText(failure: BotProfileFailure, bot: string): string {
  const words = sheetStrings.botProfile

  switch (failure.kind) {
    case 'offline':
      return words.notSent
    case 'not_applied':
      return words.notApplied
    case 'last_toolset':
      return words.lastToolset
    case 'unsupported':
      return words.unsupported
    case 'not_found':
      return words.missing({ name: displayText(bot, BOT_NAME_LIMIT) })
    default:
      return failure.detail ? words.refused({ reason: displayText(failure.detail, 300) }) : words.saveFailed
  }
}

/** A line under a control: what went wrong with it, said at once (an alert), and dismissed from the keyboard. */
function FailureLine({
  failure,
  bot,
  onDismiss
}: {
  failure: BotProfileFailure | undefined
  bot: string
  onDismiss: () => void
}): ReactElement | null {
  if (!failure) {
    return null
  }

  return (
    <p className="hm-profile__failure" role="alert">
      <span>{failureText(failure, bot)}</span>{' '}
      <button type="button" className="hm-profile__dismiss" onClick={onDismiss}>
        {strings.app.common.dismiss}
      </button>
    </p>
  )
}

/** The picture this page shows: what the roster has, until this page has changed it. */
type Shown = { kind: 'roster' } | { kind: 'picture'; url: string } | { kind: 'none' }

export function ProfilePage({ bot }: ProfilePageProps): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const profiles = runtime?.profiles
  const settings = useSettingsRuntime()
  const record = useStore(botsStore, state => state.byName[bot])
  const rosterAvatar = useStore(botsStore, state => state.avatars[bot])
  const given = useStore(layoutStore, state => state.labels[bot] ?? '')
  const accent = useStore(layoutStore, state => state.accents[bot] ?? 'default')
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const name = botLabel(given || record?.displayName, bot)

  const model = useMemo(
    () =>
      profiles
        ? new BotProfileModel({
            gateway: profiles.gateway,
            profile: bot,
            runtimeSessionId: () => chatsStore.getState().chats[bot]?.runtimeSessionId,
            onChanged: () => void profiles.refreshRoster().catch(() => undefined)
          })
        : null,
    [profiles, bot]
  )
  const state = useStore(model?.store ?? IDLE_PROFILE_STORE)

  // Read when the page opens and again whenever the connection comes back: a read that failed offline is the moment to retry.
  useEffect(() => {
    if (model && ready) {
      void model.load()
    }
  }, [model, ready])

  const [said, setSaid] = useState('')
  const [shown, setShown] = useState<Shown>({ kind: 'roster' })
  const [photoProblem, setPhotoProblem] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const words = sheetStrings.botProfile

  const gatewayEditable = model !== null && model.canWrite(ready) && state.phase === 'loaded'
  const supported = model !== null && !(state.phase === 'failed' && state.loadFailure?.kind === 'unsupported')
  const details = state.details
  const picture = shown.kind === 'roster' ? rosterAvatar : shown.kind === 'picture' ? shown.url : undefined

  const onPhoto = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget
    const file = input.files?.[0]

    // So choosing the same file again is a change again.
    input.value = ''

    if (!file || !model) {
      return
    }

    setPhotoProblem(null)
    model.dismissFailure('avatar')

    try {
      const prepared = await prepareAvatar(file)

      if (await model.setAvatar(prepared.base64)) {
        setShown({ kind: 'picture', url: prepared.dataUrl })
        setSaid(words.photoChanged)
      }
    } catch (error) {
      setPhotoProblem(
        error instanceof AvatarError && error.problem === 'not_image'
          ? words.photoNotImage
          : error instanceof AvatarError && error.problem === 'too_large'
            ? words.photoTooLarge
            : words.photoFailed
      )
    }
  }

  const onRemovePhoto = async (): Promise<void> => {
    if (model && (await model.clearAvatar())) {
      setShown({ kind: 'none' })
      setSaid(words.photoRemoved)
    }
  }

  const busy = (field: ProfileField): boolean => state.busy[field] === true

  return (
    <div className="hm-profile">
      <a className="hm-profile__back" href={chatHref(bot)}>
        {words.backToChat}
      </a>

      {model === null || state.phase === 'failed' ? (
        <p className="hm-profile__note" role={state.phase === 'failed' && supported ? 'alert' : undefined}>
          {state.phase === 'failed' && supported && state.loadFailure
            ? words.readFailed({ reason: failureText(state.loadFailure, bot) })
            : words.unsupported}{' '}
          {state.phase === 'failed' && supported ? (
            <Button variant="quiet" onClick={() => void model?.load()}>
              {strings.app.common.retry}
            </Button>
          ) : null}
        </p>
      ) : state.phase !== 'loaded' ? (
        <p className="hm-profile__note" role="status">
          {words.loading}
        </p>
      ) : state.refused ? (
        <p className="hm-profile__note">{words.readOnly}</p>
      ) : !ready ? (
        <p className="hm-profile__note">{words.offline}</p>
      ) : null}

      {/* Photo ---------------------------------------------------------------------------------------------- */}
      <section className="hm-profile__section" aria-labelledby="hm-profile-photo">
        <h2 className="hm-profile__heading" id="hm-profile-photo">
          {words.photoHeading}
        </h2>
        <div className="hm-profile__photo">
          <span className="hm-profile__avatar">
            <Avatar name={name} uri={picture} />
          </span>
          <div className="hm-profile__photo-actions">
            <input
              ref={picker}
              hidden
              type="file"
              accept="image/*"
              data-testid="profile-photo-input"
              onChange={event => void onPhoto(event)}
            />
            <Button
              variant="quiet"
              disabled={!gatewayEditable || busy('avatar')}
              onClick={() => picker.current?.click()}
            >
              {picture ? words.photoReplace : words.photoChange}
              <VisuallyHidden>{name}</VisuallyHidden>
            </Button>
            {picture ? (
              <Button
                variant="quiet"
                data-tone="danger"
                disabled={!gatewayEditable || busy('avatar')}
                onClick={() => void onRemovePhoto()}
              >
                {words.photoRemove}
                <VisuallyHidden>{name}</VisuallyHidden>
              </Button>
            ) : null}
          </div>
        </div>
        {busy('avatar') ? (
          <p className="hm-profile__hint" role="status">
            {words.photoUploading}
          </p>
        ) : (
          <p className="hm-profile__hint">{words.photoHint}</p>
        )}
        {photoProblem ? (
          <p className="hm-profile__failure" role="alert">
            {photoProblem}
          </p>
        ) : null}
        <FailureLine failure={state.failures.avatar} bot={bot} onDismiss={() => model?.dismissFailure('avatar')} />
      </section>

      {/* Name ----------------------------------------------------------------------------------------------- */}
      <section className="hm-profile__section" aria-labelledby="hm-profile-name">
        <h2 className="hm-profile__heading" id="hm-profile-name">
          {words.nameHeading}
        </h2>
        <NameField
          stored={given}
          fallback={botLabel(record?.displayName, bot)}
          onCommit={next => {
            layoutStore.getState().setLabel(bot, next)
            setSaid(words.nameSaved)
          }}
        />
        <dl className="hm-facts">
          <Fact label={words.profileLabel} mono>
            {bot}
          </Fact>
        </dl>
        <p className="hm-profile__hint">{words.profileHint}</p>
      </section>

      {/* Description ---------------------------------------------------------------------------------------- */}
      {supported && details ? (
        <section className="hm-profile__section" aria-labelledby="hm-profile-description">
          <h2 className="hm-profile__heading" id="hm-profile-description">
            {words.descriptionHeading}
          </h2>
          <label className="hm-profile__field">
            <VisuallyHidden>{words.descriptionHeading}</VisuallyHidden>
            <textarea
              value={state.descriptionDraft}
              rows={4}
              placeholder={words.descriptionPlaceholder}
              readOnly={!gatewayEditable}
              spellCheck
              onChange={event => model?.setDescriptionDraft(event.currentTarget.value)}
            />
          </label>
          {gatewayEditable && model?.descriptionIsDirty ? (
            <div className="hm-profile__actions">
              <Button variant="quiet" disabled={busy('description')} onClick={() => model.revertDescription()}>
                {words.revert}
              </Button>
              <Button
                disabled={busy('description')}
                onClick={() =>
                  void model.saveDescription().then(() => {
                    if (!model.store.getState().failures.description) {
                      setSaid(words.descriptionSaved)
                    }
                  })
                }
              >
                {busy('description') ? words.saving : words.save}
              </Button>
            </div>
          ) : null}
          <FailureLine
            failure={state.failures.description}
            bot={bot}
            onDismiss={() => model?.dismissFailure('description')}
          />
        </section>
      ) : null}

      {/* Personality ---------------------------------------------------------------------------------------- */}
      {supported && details ? (
        <section className="hm-profile__section" aria-labelledby="hm-profile-personality">
          <h2 className="hm-profile__heading" id="hm-profile-personality">
            {words.personalityHeading}
          </h2>
          <p className="hm-profile__hint" id="hm-profile-personality-hint">
            {words.personalityHint}
          </p>
          <label className="hm-profile__field">
            <VisuallyHidden>{words.personalityHeading}</VisuallyHidden>
            <textarea
              className="hm-profile__soul"
              value={state.soulDraft}
              placeholder={words.personalityEmpty}
              readOnly={!gatewayEditable}
              spellCheck={false}
              aria-describedby="hm-profile-personality-hint"
              onChange={event => model?.setSoulDraft(event.currentTarget.value)}
            />
          </label>
          {gatewayEditable && model?.soulIsDirty ? (
            <div className="hm-profile__actions">
              <Button variant="quiet" disabled={busy('soul')} onClick={() => model.revertSoul()}>
                {words.revert}
              </Button>
              <Button
                disabled={busy('soul')}
                onClick={() =>
                  void model.saveSoul().then(() => {
                    if (!model.store.getState().failures.soul) {
                      setSaid(words.personalitySaved)
                    }
                  })
                }
              >
                {busy('soul') ? words.saving : words.save}
              </Button>
            </div>
          ) : null}
          <FailureLine failure={state.failures.soul} bot={bot} onDismiss={() => model?.dismissFailure('soul')} />
        </section>
      ) : null}

      {/* Model ---------------------------------------------------------------------------------------------- */}
      {supported && details ? (
        <section className="hm-profile__section" aria-labelledby="hm-profile-model">
          <h2 className="hm-profile__heading" id="hm-profile-model">
            {words.modelHeading}
          </h2>
          <p className="hm-profile__hint">{words.modelLead}</p>
          <ModelPicker model={model} state={state} editable={gatewayEditable} />
          <FailureLine failure={state.failures.model} bot={bot} onDismiss={() => model?.dismissFailure('model')} />
        </section>
      ) : null}

      {/* Colour --------------------------------------------------------------------------------------------- */}
      <section className="hm-profile__section" aria-labelledby="hm-profile-colour">
        <h2 className="hm-profile__heading" id="hm-profile-colour">
          {words.colourHeading}
        </h2>
        <RadioGroup<AccentName>
          legend={words.colourOf({ name })}
          value={accent}
          options={ACCENT_NAMES.map(candidate => ({
            value: candidate,
            label: strings.app.layout.accents[candidate],
            mark: <span className="hm-swatch" data-accent={candidate} />
          }))}
          onChange={next => layoutStore.getState().setAccent(bot, next)}
          hint={words.colourHint}
          layout="wrap"
        />
      </section>

      {/* Capabilities --------------------------------------------------------------------------------------- */}
      {supported && details ? (
        <section className="hm-profile__section" aria-labelledby="hm-profile-capabilities">
          <h2 className="hm-profile__heading" id="hm-profile-capabilities">
            {words.capabilitiesHeading}
          </h2>

          <h3 className="hm-profile__subheading">{words.toolsetsHeading}</h3>
          <p className="hm-profile__hint">{details.toolsetsPinned ? words.toolsetsPinned : words.toolsetsUnpinned}</p>
          {details.toolsets.map(toolset => (
            <Checkbox
              key={toolset.name}
              label={displayText(toolset.label, 80)}
              checked={toolset.enabled}
              disabled={!gatewayEditable || state.toolsetsLocked}
              hint={[
                toolset.details ? displayText(toolset.details, 200) : '',
                toolset.toolCount > 0 ? words.toolCount({ count: toolset.toolCount }) : ''
              ]
                .filter(Boolean)
                .join(' · ')}
              onChange={next => void model?.setToolset(toolset.name, next)}
            />
          ))}
          {details.toolsetsPinned && gatewayEditable ? (
            <div className="hm-profile__actions">
              <Button
                variant="quiet"
                disabled={state.toolsetsLocked || busy('toolsets')}
                onClick={() => void model?.useDefaultToolsets()}
              >
                {words.useDefaults}
              </Button>
            </div>
          ) : null}
          <FailureLine
            failure={state.failures.toolsets}
            bot={bot}
            onDismiss={() => model?.dismissFailure('toolsets')}
          />

          <h3 className="hm-profile__subheading">{words.skillsHeading}</h3>
          {skillsToolsetOff(details) ? <p className="hm-profile__hint">{words.skillsToolsetOff}</p> : null}
          {details.skills.length === 0 ? (
            <p className="hm-profile__hint">{words.skillsEmpty}</p>
          ) : (
            <p className="hm-profile__hint">{words.skillsFooter}</p>
          )}
          {details.skills.map(skill => (
            <Checkbox
              key={skill.name}
              label={displayText(skill.name, 80)}
              checked={skill.enabled}
              disabled={!gatewayEditable}
              onChange={next => void model?.setSkill(skill.name, next)}
            />
          ))}
          <FailureLine failure={state.failures.skills} bot={bot} onDismiss={() => model?.dismissFailure('skills')} />

          <h3 className="hm-profile__subheading">{words.mcpHeading}</h3>
          {details.mcpServers.length === 0 ? (
            <p className="hm-profile__hint">{words.mcpEmpty}</p>
          ) : (
            <p className="hm-profile__hint">{words.mcpFooter}</p>
          )}
          {details.mcpServers.map(server => (
            <Checkbox
              key={server.name}
              label={displayText(server.name, 80)}
              checked={server.enabled}
              disabled={!gatewayEditable}
              hint={displayText(server.transport, 24)}
              onChange={next => void model?.setMcpServer(server.name, next)}
            />
          ))}
          {state.mcpReload ? <ReloadPrompt model={model} /> : null}
          {state.notice === 'mcp_reloaded' ? (
            <p className="hm-profile__hint" role="status">
              {words.reloadDone}
            </p>
          ) : null}
          <FailureLine failure={state.failures.mcp} bot={bot} onDismiss={() => model?.dismissFailure('mcp')} />
        </section>
      ) : null}

      {/* About ---------------------------------------------------------------------------------------------- */}
      <section className="hm-profile__section" aria-labelledby="hm-profile-about">
        <h2 className="hm-profile__heading" id="hm-profile-about">
          {words.aboutHeading}
        </h2>
        <dl className="hm-facts">
          <Fact label={words.model}>
            {record?.model ? displayText(prettyModelName(record.model), 80) : words.unknown}
          </Fact>
          <Fact label={words.provider}>{record?.provider ? displayText(record.provider, 80) : words.unknown}</Fact>
          <Fact label={words.session} mono>
            {record?.canonical?.id ? displayText(record.canonical.id, 80) : words.unknown}
          </Fact>
          <Fact label={words.gatewayVersion}>
            {settings?.hermesVersion ? displayText(settings.hermesVersion, 40) : words.unknown}
          </Fact>
        </dl>
      </section>

      {said ? (
        <p className="hm-sr" role="status">
          {said}
        </p>
      ) : null}
    </div>
  )
}

/** The reader's own name for the bot: kept as it is typed, committed when the field is left or Return is pressed. */
function NameField({
  stored,
  fallback,
  onCommit
}: {
  stored: string
  /** What the bot is called without the reader's name: the placeholder, and where clearing the field goes back to. */
  fallback: string
  onCommit: (name: string) => void
}): ReactElement {
  const hintId = useId()
  const [draft, setDraft] = useState(stored)
  const typing = useRef(false)

  // A name set on another device replaces what is shown, unless this field is being typed in.
  useEffect(() => {
    if (!typing.current) {
      setDraft(stored)
    }
  }, [stored])

  const commit = (): void => {
    typing.current = false

    const cleaned = draft.trim().slice(0, BOT_LABEL_MAX)

    if (cleaned !== stored) {
      onCommit(cleaned)
    }

    setDraft(cleaned)
  }

  return (
    <label className="hm-profile__field">
      <span>{sheetStrings.botProfile.displayLabel}</span>
      <input
        type="text"
        value={draft}
        maxLength={BOT_LABEL_MAX}
        placeholder={fallback}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={hintId}
        onChange={event => {
          typing.current = true
          setDraft(event.currentTarget.value)
        }}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
      <span className="hm-profile__hint" id={hintId}>
        {sheetStrings.botProfile.displayHint} {sheetStrings.botProfile.clearHint}
      </span>
    </label>
  )
}

/**
 * The gateway's question after MCP servers changed: reload them into the chats that are running now? What
 * matters is the warning (a reload makes every running chat send its whole input again), in the app's words, with the answers a person can give; the gateway's own sentence is written for its
 * command line ("Reply `/reload-mcp now`...") and is not shown. Focus goes to the question when it appears.
 */
function ReloadPrompt({ model }: { model: BotProfileModel | null }): ReactElement {
  const titleId = useId()
  const first = useRef<HTMLButtonElement>(null)
  const words = sheetStrings.botProfile

  useEffect(() => {
    first.current?.focus()
  }, [])

  return (
    <div className="hm-profile__prompt" role="group" aria-labelledby={titleId}>
      <h3 className="hm-profile__subheading" id={titleId}>
        {words.reloadTitle}
      </h3>
      <p className="hm-profile__hint">{words.reloadBody}</p>
      <div className="hm-profile__actions">
        <Button ref={first} onClick={() => void model?.reloadMcp(false)}>
          {words.reloadNow}
        </Button>
        <Button variant="quiet" onClick={() => void model?.reloadMcp(true)}>
          {words.reloadAlways}
        </Button>
        <Button variant="quiet" onClick={() => model?.declineMcpReload()}>
          {words.reloadLater}
        </Button>
      </div>
      <p className="hm-profile__hint">{words.reloadAlwaysHint}</p>
    </div>
  )
}
