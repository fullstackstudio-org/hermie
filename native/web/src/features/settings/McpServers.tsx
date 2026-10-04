/**
 * Settings › MCP servers: the servers a bot reaches its tools through (`core/manage/mcp-servers.ts`), and what the
 * page can do with each: test the connection, authorise it, remove it, and add a new one from the gateway's
 * catalogue or from an address or a command. Not Settings › MCP, which is the gateway's own endpoint for agents.
 *
 * A list is the CONFIG with the gateway's cached state beside it; neither says whether a server works, and only
 * a test does, by connecting. So nothing is tested on the reader's behalf: a probe is a button, its answer is
 * said under the server, and "needs authorising" is a probe result. Authorising walks the gateway's PKCE flow:
 * the page shows the sign-in address as a link for the reader to open (a page cannot open a window from the
 * middle of a call without being taken for a pop-up), and follows the flow until it settles or is cancelled.
 *
 * Reloading the servers into chats that are already running can refuse by answering (every live chat would
 * re-send its whole input), so the page asks first and says the gateway's own words. A removal asks first too.
 *
 * What the gateway never sends the page never shows: an env key is named and has no value, and the access token
 * of an added server goes to the gateway once and is kept nowhere here.
 */
import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  type CatalogueEntry,
  createMcpServersClient,
  type McpProbe,
  type McpServersClient,
  type McpServerView,
  type NewServer,
  type OauthFlow,
  OauthCancelled
} from '../../core/manage/mcp-servers'
import { routeErrorOf } from '../../core/manage/route-error'
import type { ManageTransport } from '../../core/manage/transport'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { manageStrings } from '../../i18n/manage-strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'
import { SettingsPage } from './controls'
import { BotPicker, ConfirmAction, type Outcome, ProblemLine, StatusLine, useSelectedBot } from './manage-parts'
import { useManageTransport } from './manage-runtime'

const words = manageStrings.mcpServersPage

/** How far a server's own text (a tool's description, an error) runs before it is cut. */
const TEXT_LIMIT = 300

export function McpServers(): ReactElement {
  useLocale()

  const transport = useManageTransport()
  const { choices, selected, select } = useSelectedBot()

  let body: ReactElement

  if (choices.length === 0) {
    body = <p className="hm-manage__text">{strings.memory.botsEmpty}</p>
  } else if (!transport) {
    body = <p className="hm-manage__text">{manageStrings.manageCommon.noGateway}</p>
  } else {
    body = (
      <>
        <BotPicker label={strings.skills.botPicker} choices={choices} value={selected} onChange={select} />
        <ServersBody key={selected} gateway={transport.gateway} profile={selected} />
      </>
    )
  }

  return (
    <SettingsPage title={strings.mcp.title} lead={strings.mcp.subtitle}>
      {body}
    </SettingsPage>
  )
}

function ServersBody({ gateway, profile }: { gateway: ManageTransport['gateway']; profile: string }): ReactElement {
  const client = useMemo(() => createMcpServersClient(gateway), [gateway])
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const reads = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++reads.current

    try {
      const next = await client.load(profile)

      if (mine === reads.current) {
        setServers(next)
        setProblem(null)
      }
    } catch (failure) {
      if (mine === reads.current) {
        setProblem(strings.mcp.failed({ reason: routeErrorOf(failure).message }))
      }
    }
  }, [client, profile])

  useEffect(() => {
    void load()

    return () => {
      reads.current += 1
    }
  }, [load])

  const remove = async (server: McpServerView): Promise<void> => {
    setOutcome(null)

    try {
      await client.remove(profile, server.name)
      await load()
      setOutcome({ tone: 'ok', text: words.removed({ name: displayText(server.name, 64) }) })
      // The row is gone: the list's heading is where the reader is.
      heading.current?.focus()
    } catch (failure) {
      setOutcome({ tone: 'danger', text: words.removeFailed({ message: routeErrorOf(failure).message }) })
    }
  }

  return (
    <>
      <StatusLine outcome={outcome} />

      <Reload client={client} onOutcome={setOutcome} />

      <h3 className="hm-manage__heading" ref={heading} tabIndex={-1}>
        {strings.mcp.title}
      </h3>
      {problem ? <ProblemLine text={problem} retryLabel={strings.memory.retry} onRetry={() => void load()} /> : null}
      {!servers && !problem ? <p className="hm-manage__text">{strings.mcp.loading}</p> : null}
      {servers && servers.length === 0 ? <p className="hm-manage__text">{strings.mcp.empty}</p> : null}

      {servers && servers.length > 0 ? (
        <ul className="hm-manage__list" aria-label={strings.mcp.title}>
          {servers.map(server => (
            <ServerRow
              key={server.name}
              server={server}
              client={client}
              profile={profile}
              onRemove={() => remove(server)}
              onChanged={load}
            />
          ))}
        </ul>
      ) : null}

      <AddServer
        client={client}
        profile={profile}
        onAdded={name => {
          setOutcome({ tone: 'ok', text: words.added({ name: displayText(name, 64) }) })

          return load()
        }}
      />
    </>
  )
}

/** Apply the configuration to chats that are already running. The gateway may want an answer first. */
function Reload({
  client,
  onOutcome
}: {
  client: McpServersClient
  onOutcome: (outcome: Outcome) => void
}): ReactElement {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'running' } | { kind: 'asking'; message: string }>({
    kind: 'idle'
  })
  const trigger = useRef<HTMLButtonElement>(null)

  const run = async (confirm: boolean): Promise<void> => {
    setState({ kind: 'running' })

    try {
      const answer = await client.reload(confirm ? { confirm: true } : {})

      if (answer.kind === 'confirm') {
        setState({ kind: 'asking', message: displayText(answer.message, TEXT_LIMIT) })

        return
      }

      onOutcome({ tone: 'ok', text: words.reloadDone })
    } catch (failure) {
      onOutcome({ tone: 'danger', text: words.reloadFailed({ message: routeErrorOf(failure).message }) })
    }

    setState({ kind: 'idle' })
  }

  if (state.kind === 'asking') {
    return (
      <div className="hm-manage__confirm" role="group" aria-label={strings.mcp.reload}>
        <p className="hm-manage__confirm-question">{words.reloadQuestion}</p>
        {state.message ? <p className="hm-manage__hint">{state.message}</p> : null}
        <div className="hm-manage__actions">
          <Button onClick={() => void run(true)}>{words.reloadAnyway}</Button>
          <Button
            variant="quiet"
            autoFocus
            onClick={() => {
              setState({ kind: 'idle' })
              // The question is gone with its buttons: the reader is back on the button that asked it.
              requestAnimationFrame(() => trigger.current?.focus())
            }}
          >
            {words.cancelSignIn}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="hm-manage__field">
      <div className="hm-manage__actions">
        <Button ref={trigger} variant="quiet" disabled={state.kind === 'running'} onClick={() => void run(false)}>
          {strings.mcp.reload}
        </Button>
      </div>
      <p className="hm-manage__hint">{strings.mcp.reloadHint}</p>
    </div>
  )
}

type Probing = { kind: 'testing' } | { kind: 'done'; probe: McpProbe } | { kind: 'failed'; message: string }

function ServerRow({
  server,
  client,
  profile,
  onRemove,
  onChanged
}: {
  server: McpServerView
  client: McpServersClient
  profile: string
  onRemove: () => Promise<void>
  onChanged: () => Promise<void>
}): ReactElement {
  const name = displayText(server.name, 64)
  const [probing, setProbing] = useState<Probing | null>(null)
  const [flow, setFlow] = useState<{ authUrl: string; cancel: () => void } | { starting: true } | null>(null)
  const [signIn, setSignIn] = useState<Outcome | null>(null)
  const live = useRef<OauthFlow | null>(null)

  // A flow still open when the row goes away (another bot picked, the page left) is ended at the gateway.
  useEffect(
    () => () => {
      live.current?.cancel()
    },
    []
  )

  const test = async (): Promise<void> => {
    setProbing({ kind: 'testing' })

    try {
      setProbing({ kind: 'done', probe: await client.test(server.name, profile) })
    } catch (failure) {
      setProbing({ kind: 'failed', message: routeErrorOf(failure).message })
    }
  }

  const authorise = async (): Promise<void> => {
    setSignIn(null)
    setFlow({ starting: true })

    try {
      const started = await client.authorise(server.name, profile)

      live.current = started
      setFlow({ authUrl: started.authUrl, cancel: started.cancel })

      const probe = await started.done

      setProbing({ kind: 'done', probe })
      setSignIn({ tone: 'ok', text: strings.mcp.authoriseOk })
      await onChanged()
    } catch (failure) {
      setSignIn(
        failure instanceof OauthCancelled
          ? { tone: 'ok', text: words.signInCancelled }
          : { tone: 'danger', text: strings.mcp.authoriseFailed({ reason: routeErrorOf(failure).message }) }
      )
    } finally {
      live.current = null
      setFlow(null)
    }
  }

  const needsAuth =
    (server.auth === 'oauth' && server.tokenPresent !== true) || (probing?.kind === 'done' && probing.probe.needsAuth)
  const oauth = server.auth === 'oauth' || (probing?.kind === 'done' && probing.probe.needsAuth)

  return (
    <li className="hm-manage__item" data-server={server.name}>
      <div className="hm-manage__item-head">
        <span className="hm-manage__name">{name}</span>
        <span className="hm-manage__badge">{server.transport}</span>
        <span
          className="hm-manage__badge"
          data-tone={server.runtime === 'failed' ? 'danger' : server.runtime === 'connected' ? 'ok' : undefined}
        >
          {strings.mcp.runtime[server.runtime]}
        </span>
        {needsAuth ? (
          <span className="hm-manage__badge" data-tone="warn">
            {strings.mcp.needsAuth}
          </span>
        ) : null}
        {server.toolCount !== null ? (
          <span className="hm-manage__meta">{strings.mcp.toolCount({ count: server.toolCount })}</span>
        ) : null}
      </div>

      {server.address ? <code className="hm-manage__code">{displayText(server.address, TEXT_LIMIT)}</code> : null}
      {server.env.length > 0 ? (
        <span className="hm-manage__meta">
          {words.envKeys({ keys: server.env.map(key => displayText(key, 64)).join(', ') })}
        </span>
      ) : null}
      {server.auth ? (
        <span className="hm-manage__meta">
          {words.authValue({ auth: displayText(server.auth, 32) })}
          {server.tokenPresent === null ? '' : ` · ${server.tokenPresent ? words.tokenPresent : words.tokenMissing}`}
        </span>
      ) : null}

      <div className="hm-manage__actions">
        <Button
          variant="quiet"
          disabled={probing?.kind === 'testing'}
          aria-label={words.testName({ name })}
          onClick={() => void test()}
        >
          {probing?.kind === 'testing' ? strings.mcp.testing : strings.mcp.test}
        </Button>
        {oauth ? (
          <Button
            variant="quiet"
            disabled={flow !== null}
            aria-label={words.authoriseName({ name })}
            onClick={() => void authorise()}
          >
            {strings.mcp.authorise}
          </Button>
        ) : null}
        <ConfirmAction
          label={words.remove}
          accessibleName={words.removeName({ name })}
          question={words.removeQuestion({ name })}
          detail={words.removeDetail}
          confirmLabel={words.remove}
          cancelLabel={words.keep}
          onConfirm={() => void onRemove()}
        />
      </div>

      {flow && 'authUrl' in flow ? (
        <div className="hm-manage__form" role="status">
          <p className="hm-manage__text">{words.signInWaiting({ name })}</p>
          <p className="hm-manage__hint">{strings.mcp.authoriseHint}</p>
          <div className="hm-manage__actions">
            <a className="hm-manage__link" href={flow.authUrl} target="_blank" rel="noopener noreferrer">
              {words.openSignIn}
            </a>
            <Button variant="quiet" onClick={flow.cancel}>
              {words.cancelSignIn}
            </Button>
          </div>
        </div>
      ) : null}
      {flow && 'starting' in flow ? (
        <p className="hm-manage__text" role="status">
          {strings.mcp.authorising}
        </p>
      ) : null}
      <StatusLine outcome={signIn} />

      <div aria-live="polite">
        <ProbeResult name={name} probing={probing} />
      </div>
    </li>
  )
}

function ProbeResult({ name, probing }: { name: string; probing: Probing | null }): ReactElement | null {
  if (!probing || probing.kind === 'testing') {
    return null
  }

  if (probing.kind === 'failed') {
    return <p className="hm-manage__problem-text">{strings.mcp.testFailed({ reason: probing.message })}</p>
  }

  const probe = probing.probe

  if (!probe.ok) {
    return (
      <p className="hm-manage__problem-text">
        {strings.mcp.testFailed({ reason: displayText(probe.error ?? '', TEXT_LIMIT) || strings.mcp.needsAuth })}
      </p>
    )
  }

  return (
    <div className="hm-manage__form">
      <p className="hm-manage__text">{strings.mcp.testOk({ count: probe.tools.length })}</p>
      {probe.tools.length === 0 ? (
        <p className="hm-manage__hint">{words.noTools}</p>
      ) : (
        <ul className="hm-manage__list" aria-label={words.toolsHeading({ name })}>
          {probe.tools.map(tool => (
            <li key={tool.name} className="hm-manage__item">
              <span className="hm-manage__name">{displayText(tool.name, 64)}</span>
              {tool.description ? (
                <span className="hm-manage__meta">{displayText(tool.description, TEXT_LIMIT)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const CUSTOM = ''

/** A command line as arguments: words split at spaces; quotes are not interpreted, as the gateway takes a list. */
const splitArgs = (line: string): string[] => line.split(/\s+/u).filter(Boolean)

function AddServer({
  client,
  profile,
  onAdded
}: {
  client: McpServersClient
  profile: string
  onAdded: (name: string) => Promise<void>
}): ReactElement {
  const id = useId()
  const [catalogue, setCatalogue] = useState<CatalogueEntry[] | null>(null)
  const [source, setSource] = useState(CUSTOM)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [token, setToken] = useState('')
  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const open = (): void => {
    if (catalogue === null) {
      client
        .catalogue(profile)
        // A gateway without the catalogue still takes a server of the reader's own.
        .then(setCatalogue)
        .catch(() => setCatalogue([]))
    }
  }

  const preset = catalogue?.find(entry => entry.name === source)
  const ready = name.trim() !== '' && (preset !== undefined || url.trim() !== '' || command.trim() !== '')

  const submit = async (): Promise<void> => {
    if (!ready || adding) {
      setFailure(words.needsNameAndSource)

      return
    }

    const server: NewServer = preset
      ? { kind: 'preset', name: name.trim(), preset: preset.name }
      : {
          kind: 'custom',
          name: name.trim(),
          ...(url.trim() ? { url: url.trim() } : { command: command.trim(), args: splitArgs(args) }),
          ...(token ? { bearerToken: token } : {})
        }

    setAdding(true)
    setFailure(null)

    try {
      await client.add(profile, server)
      setName('')
      setUrl('')
      setCommand('')
      setArgs('')
      setToken('')
      setSource(CUSTOM)
      await onAdded(server.name)
    } catch (error) {
      setFailure(words.addFailed({ message: routeErrorOf(error).message }))
    } finally {
      setAdding(false)
    }
  }

  return (
    <details
      className="hm-manage__disclosure"
      onToggle={event => {
        if (event.currentTarget.open) {
          open()
        }
      }}
    >
      <summary className="hm-manage__summary">{words.add}</summary>
      <form
        className="hm-manage__form"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        {catalogue && catalogue.length > 0 ? (
          <div className="hm-manage__field">
            <label className="hm-manage__label" htmlFor={`${id}-source`}>
              {words.addSource}
            </label>
            <select
              id={`${id}-source`}
              className="hm-manage__select"
              value={source}
              onChange={event => {
                setSource(event.currentTarget.value)

                if (name === '' || catalogue.some(entry => entry.name === name)) {
                  setName(event.currentTarget.value)
                }
              }}
            >
              <option value={CUSTOM}>{words.addCustom}</option>
              {catalogue
                .filter(entry => !entry.installed)
                .map(entry => (
                  <option key={entry.name} value={entry.name}>
                    {entry.description ? `${entry.name} - ${displayText(entry.description, 80)}` : entry.name}
                  </option>
                ))}
            </select>
            {preset && preset.requires.length > 0 ? (
              <p className="hm-manage__hint">{words.addNeeds({ keys: preset.requires.join(', ') })}</p>
            ) : null}
          </div>
        ) : null}

        <div className="hm-manage__field">
          <label className="hm-manage__label" htmlFor={`${id}-name`}>
            {words.addName}
          </label>
          <input
            id={`${id}-name`}
            className="hm-manage__input"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-name-hint`}
            value={name}
            onChange={event => setName(event.currentTarget.value)}
          />
          <p className="hm-manage__hint" id={`${id}-name-hint`}>
            {words.addNameHint}
          </p>
        </div>

        {!preset ? (
          <>
            <div className="hm-manage__field">
              <label className="hm-manage__label" htmlFor={`${id}-url`}>
                {words.addUrl}
              </label>
              <input
                id={`${id}-url`}
                className="hm-manage__input"
                type="url"
                autoComplete="off"
                spellCheck={false}
                data-mono="true"
                value={url}
                onChange={event => setUrl(event.currentTarget.value)}
              />
            </div>
            <div className="hm-manage__field">
              <label className="hm-manage__label" htmlFor={`${id}-command`}>
                {words.addCommand}
              </label>
              <input
                id={`${id}-command`}
                className="hm-manage__input"
                autoComplete="off"
                spellCheck={false}
                data-mono="true"
                value={command}
                disabled={url.trim() !== ''}
                onChange={event => setCommand(event.currentTarget.value)}
              />
            </div>
            <div className="hm-manage__field">
              <label className="hm-manage__label" htmlFor={`${id}-args`}>
                {words.addArgs}
              </label>
              <input
                id={`${id}-args`}
                className="hm-manage__input"
                autoComplete="off"
                spellCheck={false}
                data-mono="true"
                value={args}
                disabled={url.trim() !== ''}
                onChange={event => setArgs(event.currentTarget.value)}
              />
            </div>
            <div className="hm-manage__field">
              <label className="hm-manage__label" htmlFor={`${id}-token`}>
                {words.addToken}
              </label>
              <input
                id={`${id}-token`}
                className="hm-manage__input"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                aria-describedby={`${id}-token-hint`}
                value={token}
                onChange={event => setToken(event.currentTarget.value)}
              />
              <p className="hm-manage__hint" id={`${id}-token-hint`}>
                {words.addTokenHint}
              </p>
            </div>
          </>
        ) : null}

        {failure ? (
          <p className="hm-manage__problem-text" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="hm-manage__actions">
          <Button type="submit" disabled={adding}>
            {adding ? words.adding : words.addSubmit}
          </Button>
        </div>
      </form>
    </details>
  )
}
