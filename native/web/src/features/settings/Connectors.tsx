/**
 * Settings › Connectors: the apps a bot can reach on the person's behalf, and which of them are connected
 * (`core/manage/connectors.ts`).
 *
 * The list is the gateway's, per bot: `available: false` is its own sentence (the bot's connections toolset is
 * off), which is not an empty account. Connecting walks the gateway's operation: the page shows the vendor's
 * sign-in address as a link to open in another tab (a page cannot open a window from the middle of a call without
 * being taken for a pop-up) and follows the operation until the connector settles, telling the gateway to read the
 * account at once when the reader comes back to the tab. A connector that is already connected offers
 * Reconnect, which is how another account is chosen.
 *
 * There is no Disconnect, and the page says why once: the gateway has no such call, on purpose, and sends the
 * person to wherever the account is managed.
 *
 * Everything the vendor sends (a name, a status, a reason) is somebody else's text and is drawn as characters.
 */
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type ConnectFlow,
  type ConnectorList,
  type ConnectorView,
  connectorState,
  createConnectorsClient,
  type ConnectorsClient
} from '../../core/manage/connectors'
import { routeErrorOf } from '../../core/manage/route-error'
import type { ManageTransport } from '../../core/manage/transport'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { manageStrings } from '../../i18n/manage-strings'
import { useLocale } from '../../i18n/use-locale'
import { visibilityWatcher } from '../../platform/visibility'
import { Button } from '../../ui/primitives'
import { SettingsPage } from './controls'
import { BotPicker, type Outcome, ProblemLine, StatusLine, useSelectedBot } from './manage-parts'
import { useManageTransport } from './manage-runtime'

const words = manageStrings.connectorsPage

export function Connectors(): ReactElement {
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
        <ConnectorsBody key={selected} gateway={transport.gateway} profile={selected} />
      </>
    )
  }

  return (
    <SettingsPage title={strings.connectors.title} lead={strings.connectors.subtitle}>
      {body}
    </SettingsPage>
  )
}

function ConnectorsBody({ gateway, profile }: { gateway: ManageTransport['gateway']; profile: string }): ReactElement {
  const client = useMemo(() => createConnectorsClient(gateway), [gateway])
  const [list, setList] = useState<ConnectorList | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const reads = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++reads.current

    setRefreshing(true)

    try {
      const next = await client.list(profile)

      if (mine === reads.current) {
        setList(next)
        setProblem(null)
      }
    } catch (failure) {
      if (mine === reads.current) {
        setProblem(strings.connectors.failed({ reason: routeErrorOf(failure).message }))
      }
    } finally {
      if (mine === reads.current) {
        setRefreshing(false)
      }
    }
  }, [client, profile])

  useEffect(() => {
    void load()

    return () => {
      reads.current += 1
    }
  }, [load])

  return (
    <>
      <StatusLine outcome={outcome} />

      {problem ? <ProblemLine text={problem} retryLabel={strings.memory.retry} onRetry={() => void load()} /> : null}
      {!list && !problem ? <p className="hm-manage__text">{strings.connectors.loading}</p> : null}

      {list && !list.available ? (
        <div className="hm-manage__form">
          <p className="hm-manage__confirm-question">{strings.connectors.unavailable}</p>
          <p className="hm-manage__hint">{strings.connectors.unavailableHint}</p>
        </div>
      ) : null}

      {list && list.available && list.connectors.length === 0 ? (
        <p className="hm-manage__text">{strings.connectors.empty}</p>
      ) : null}

      {list && list.available && list.connectors.length > 0 ? (
        <ul className="hm-manage__list" aria-label={strings.connectors.title}>
          {list.connectors.map(connector => (
            <ConnectorRow
              key={connector.slug}
              connector={connector}
              client={client}
              profile={profile}
              onOutcome={setOutcome}
              onSettled={load}
            />
          ))}
        </ul>
      ) : null}

      {list ? (
        <div className="hm-manage__actions">
          <Button variant="quiet" disabled={refreshing} onClick={() => void load()}>
            {strings.connectors.refresh}
          </Button>
        </div>
      ) : null}
      {list && list.available ? <p className="hm-manage__hint">{strings.connectors.disconnect}</p> : null}
    </>
  )
}

/** The word for one row's state, in one place so the badge and the sentence agree. */
const stateWord = (connector: ConnectorView): string => strings.connectors.state[connectorState(connector)]

function ConnectorRow({
  connector,
  client,
  profile,
  onOutcome,
  onSettled
}: {
  connector: ConnectorView
  client: ConnectorsClient
  profile: string
  onOutcome: (outcome: Outcome) => void
  onSettled: () => Promise<void>
}): ReactElement {
  const name = displayText(connector.label, 64) || connector.slug
  const state = connectorState(connector)
  const [flow, setFlow] = useState<{ starting: true } | { authUrl: string | null; authHost: string | null } | null>(
    null
  )
  const live = useRef<ConnectFlow | null>(null)

  // Coming back to the tab during a sign-in is the same fact as the desktop's "done" link: the reader was in
  // another tab and is here again, so the gateway is told to read the account now.
  useEffect(() => {
    const unsubscribe = visibilityWatcher.subscribe(visibility => {
      if (visibility === 'visible') {
        live.current?.wake()
      }
    })

    return () => {
      unsubscribe()
      live.current?.cancel()
    }
  }, [])

  const connect = async (): Promise<void> => {
    setFlow({ starting: true })

    try {
      const started = await client.connect(connector.slug, { profile, reconnect: connector.connected })

      live.current = started
      setFlow({ authUrl: started.authUrl, authHost: started.authHost })

      const result = await started.done

      onOutcome(
        result.status === 'connected'
          ? { tone: 'ok', text: strings.connectors.connectOk({ name }) }
          : result.status === 'expired'
            ? { tone: 'danger', text: strings.connectors.connectExpired }
            : result.status === 'skipped'
              ? { tone: 'danger', text: strings.connectors.connectSkipped }
              : { tone: 'danger', text: strings.connectors.connectFailed({ reason: displayText(result.reason, 300) }) }
      )
      await onSettled()
    } catch (failure) {
      onOutcome({ tone: 'danger', text: strings.connectors.connectFailed({ reason: routeErrorOf(failure).message }) })
    } finally {
      live.current = null
      setFlow(null)
    }
  }

  const status = connector.connectionStatus ? displayText(connector.connectionStatus, 64) : ''
  const reason = connector.statusReason ? displayText(connector.statusReason, 300) : ''

  return (
    <li className="hm-manage__item" data-connector={connector.slug}>
      <div className="hm-manage__item-head">
        <span className="hm-manage__name">{name}</span>
        <span
          className="hm-manage__badge"
          data-tone={state === 'connected' ? 'ok' : state === 'disabled' ? 'warn' : undefined}
        >
          {stateWord(connector)}
        </span>
        {status ? <span className="hm-manage__meta">{words.vendorStatus({ status })}</span> : null}
      </div>
      {connector.description ? <p className="hm-manage__body">{displayText(connector.description, 300)}</p> : null}
      {reason ? <p className="hm-manage__meta">{strings.connectors.reason({ text: reason })}</p> : null}

      <div className="hm-manage__actions">
        <Button
          variant={connector.connected ? 'quiet' : 'primary'}
          disabled={flow !== null}
          aria-label={connector.connected ? words.reconnectName({ name }) : words.connectName({ name })}
          onClick={() => void connect()}
        >
          {connector.connected ? strings.connectors.reconnect : strings.connectors.connect}
        </Button>
      </div>

      {flow && 'starting' in flow ? (
        <p className="hm-manage__text" role="status">
          {strings.connectors.connecting}
        </p>
      ) : null}
      {flow && 'authUrl' in flow && flow.authUrl ? (
        <div className="hm-manage__form" role="status">
          <p className="hm-manage__text">{manageStrings.manageCommon.signInWaiting({ name })}</p>
          <p className="hm-manage__hint">{strings.connectors.connectHint}</p>
          <div className="hm-manage__actions">
            <a className="hm-manage__link" href={flow.authUrl} target="_blank" rel="noopener noreferrer">
              {manageStrings.manageCommon.openSignIn}
            </a>
            {flow.authHost ? <span className="hm-manage__meta">{flow.authHost}</span> : null}
            <Button variant="quiet" onClick={() => live.current?.cancel()}>
              {manageStrings.manageCommon.cancelSignIn}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
