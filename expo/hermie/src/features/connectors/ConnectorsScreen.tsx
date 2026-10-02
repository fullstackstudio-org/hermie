/**
 * Settings ▸ Connectors, and one connector's detail.
 *
 * The page is scoped to a CHAT, and that is the gateway's shape rather than a
 * choice. `connectors.list` takes a `session_id`, and upstream authorises it by
 * whether this socket is attached to that session — so a connector list exists
 * for a conversation that is open and for nothing else. A page that asked for
 * "your connectors" would have no call to make.
 *
 * Two pages, and two routes in the Settings stack: the list pushes a connector
 * through `onOpenConnector` with the session it was listed for, and neither
 * draws a back control of its own. The connect flow lives on the connector's
 * page, and tells the list it changed something through `useConnectorsRevision`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Linking, Pressable, RefreshControl } from 'react-native'
import { create } from 'zustand'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { PageFrame, PageScrollView, type PageChromeBack } from '../../ui/chrome'
import { Button, InsetGroup, InsetRow, InsetValueRow, Text } from '../../ui/primitives'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useTheme } from '../../ui/theme'
import { ConnectorsController, type ConnectorList, type ConnectorView } from './connectors-controller'
import { connectorStrings } from './strings'

/**
 * Bumped by a connector's page when a connect finished, so the list under it
 * reads the account again instead of showing the state it had before.
 */
export const useConnectorsRevision = create<{ revision: number; changed: () => void }>(set => ({
  revision: 0,
  changed: () => set(state => ({ revision: state.revision + 1 }))
}))

export interface ConnectorsScreenProps {
  /** The page's one back control, labelled with the page it returns to. */
  back?: PageChromeBack
  /** Push one connector's page, for the chat it was listed under. */
  onOpenConnector: (sessionId: string, slug: string) => void
}

/** One chat this socket is attached to, which is what a connector list needs. */
interface LiveChat {
  botName: string
  displayName: string
  sessionId: string
}

/** The controller both pages talk through, one per connection. */
function useConnectorsController(): ConnectorsController | null {
  const { connection } = useGateway()

  return useMemo(
    () =>
      connection
        ? new ConnectorsController({
            gateway: chatGatewayFor(connection),
            openUrl: url => void Linking.openURL(url).catch(() => undefined)
          })
        : null,
    [connection]
  )
}

/** One session's connector list, reloaded whenever a connector's page changed it. */
function useConnectorList(controller: ConnectorsController | null, sessionId: string | null) {
  const revision = useConnectorsRevision(state => state.revision)
  const [list, setList] = useState<ConnectorList | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!controller || !sessionId) {
      return
    }

    try {
      setList(await controller.load(sessionId))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [controller, sessionId])

  useEffect(() => {
    void load()
  }, [load, revision])

  return { list, setList, error, load }
}

export function ConnectorsScreen({ back, onOpenConnector }: ConnectorsScreenProps) {
  const theme = useTheme()
  const runtimeToBot = useChatsStore(state => state.runtimeToBot)
  const byName = useBotsStore(state => state.byName)

  /*
    Every chat the app currently holds a runtime session for. `runtimeToBot` is
    the only honest source: it is populated when a chat ATTACHES, which is
    exactly the condition `_current_session_steer_authority` checks before it
    will answer `connectors.list` at all.
  */
  const chats = useMemo<LiveChat[]>(
    () =>
      Object.entries(runtimeToBot)
        .map(([sessionId, botName]) => ({
          botName,
          displayName: byName[botName]?.displayName ?? botName,
          sessionId
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [runtimeToBot, byName]
  )

  const [chosen, setChosen] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // One chat means no choice to make. More than one and the reader picks, so a
  // session that went away does not silently move the page to another bot.
  const chat = chats.find(entry => entry.sessionId === chosen) ?? (chats.length === 1 ? chats[0] : null)

  const controller = useConnectorsController()
  const { list, setList, error, load } = useConnectorList(controller, chat?.sessionId ?? null)

  return (
    <PageFrame {...(back ? { back } : {})} subtitle={connectorStrings.subtitle} title={connectorStrings.title}>
      <PageScrollView
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true)
              void load().finally(() => setRefreshing(false))
            }}
            refreshing={refreshing}
          />
        }
      >
        {chats.length === 0 ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {connectorStrings.scope.noneHint}
              </Text>
            }
          >
            <InsetRow>
              <Text color="textMuted" testID="connectors-no-chat">
                {connectorStrings.scope.none}
              </Text>
            </InsetRow>
          </InsetGroup>
        ) : (
          <>
            {/* The picker is drawn only when there is something to pick. */}
            {chats.length > 1 ? (
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {connectorStrings.scope.hint}
                  </Text>
                }
                header={connectorStrings.scope.header}
              >
                {chats.map(entry => (
                  <Pressable
                    accessibilityLabel={entry.displayName}
                    accessibilityRole="button"
                    aria-selected={entry.sessionId === chat?.sessionId}
                    key={entry.sessionId}
                    onPress={() => {
                      setChosen(entry.sessionId)
                      setList(null)
                    }}
                    style={{
                      backgroundColor: entry.sessionId === chat?.sessionId ? theme.elevation.e2 : 'transparent',
                      paddingHorizontal: theme.space.md,
                      paddingVertical: theme.space.sm
                    }}
                    testID={`connectors-chat-${entry.botName}`}
                  >
                    <Text>{entry.displayName}</Text>
                  </Pressable>
                ))}
              </InsetGroup>
            ) : null}

            {error ? (
              <Text color="dangerText" testID="connectors-error">
                {connectorStrings.failed(error)}
              </Text>
            ) : list === null ? (
              <Text color="textMuted">{connectorStrings.loading}</Text>
            ) : !list.available ? (
              /*
                A successful answer that means the bot's Connections toolset is
                off. Drawing "no connectors" here would report an empty account
                for what is actually a switch the reader owns.
              */
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {connectorStrings.unavailableHint}
                  </Text>
                }
              >
                <InsetRow>
                  <Text color="textMuted" testID="connectors-unavailable">
                    {connectorStrings.unavailable}
                  </Text>
                </InsetRow>
              </InsetGroup>
            ) : list.connectors.length === 0 ? (
              <InsetGroup>
                <InsetRow>
                  <Text color="textMuted" testID="connectors-empty">
                    {connectorStrings.empty}
                  </Text>
                </InsetRow>
              </InsetGroup>
            ) : (
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {connectorStrings.disconnect}
                  </Text>
                }
              >
                {list.connectors.map(entry => (
                  <ConnectorRowView
                    key={entry.slug}
                    connector={entry}
                    onPress={() => (chat ? onOpenConnector(chat.sessionId, entry.slug) : undefined)}
                  />
                ))}
              </InsetGroup>
            )}
          </>
        )}
      </PageScrollView>
    </PageFrame>
  )
}

/** The word for one row's state, kept in one place so the row and the detail agree. */
export const stateLabel = (connector: ConnectorView): string => {
  if (connector.connected) {
    return connectorStrings.state.connected
  }

  if (connector.enabled === false) {
    return connectorStrings.state.disabled
  }

  return connectorStrings.state.notConnected
}

function ConnectorRowView({ connector, onPress }: { connector: ConnectorView; onPress: () => void }) {
  const theme = useTheme()
  const state = stateLabel(connector)

  return (
    <Pressable
      accessibilityLabel={`${connector.label}, ${state}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
        gap: theme.space.xxs,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      })}
      testID={`connector-row-${connector.slug}`}
    >
      <Text>{connector.label}</Text>
      <Text color="textMuted" testID={`connector-state-${connector.slug}`} variant="meta">
        {state}
      </Text>
    </Pressable>
  )
}

export interface ConnectorScreenProps {
  /** The chat the connector was listed under; the gateway answers per session. */
  sessionId: string
  slug: string
  back?: PageChromeBack
}

/** One connector's page, and the connect flow that runs from it. */
export function ConnectorScreen({ sessionId, slug, back }: ConnectorScreenProps) {
  const controller = useConnectorsController()
  const { list, load } = useConnectorList(controller, sessionId)
  const changed = useConnectorsRevision(state => state.changed)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const connector = list?.connectors.find(entry => entry.slug === slug) ?? null

  /*
    The operation a flow is currently walking, so returning from the browser can
    tell the gateway to read the account NOW instead of on its next watcher
    tick. A ref rather than state: nothing draws it, and re-rendering the page
    every time it moved would restart the very poll that sets it.
  */
  const flow = useRef<{ sessionId: string; opId: string } | null>(null)

  /*
    Coming back to the app during an authorisation is this client's version of
    the desktop's `hermes://connections/done` deep link. Hermie has no such
    link, and the foreground edge is the same fact arriving a different way: the
    reader was in a browser and is now here.
  */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const open = flow.current

      if (state === 'active' && open && controller) {
        void controller.wake(open.sessionId, open.opId)
      }
    })

    return () => subscription.remove()
  }, [controller])

  const connect = (reconnect: boolean) => {
    if (!controller) {
      return
    }

    setBusy(true)
    setNotice(connectorStrings.connecting)

    void controller
      .connect(sessionId, slug, {
        reconnect,
        onOperation: opId => {
          flow.current = { opId, sessionId }
        }
      })
      .then(outcome => {
        if (outcome.status === 'connected') {
          setNotice(connectorStrings.connectOk(slug))
        } else if (outcome.status === 'expired') {
          setNotice(connectorStrings.connectExpired)
        } else if (outcome.status === 'skipped') {
          setNotice(connectorStrings.connectSkipped)
        } else {
          setNotice(connectorStrings.connectFailed(outcome.reason))
        }

        changed()

        return load()
      })
      .catch((cause: unknown) =>
        setNotice(connectorStrings.connectFailed(cause instanceof Error ? cause.message : String(cause)))
      )
      .finally(() => {
        flow.current = null
        setBusy(false)
      })
  }

  return (
    <ConnectorDetail
      busy={busy}
      connector={connector}
      notice={notice}
      onConnect={() => connect(connector?.connected === true)}
      slug={slug}
      {...(back ? { back } : {})}
    />
  )
}

function ConnectorDetail({
  slug,
  connector,
  busy,
  notice,
  back,
  onConnect
}: {
  slug: string
  /** `null` until the list has loaded; the page is titled by slug meanwhile. */
  connector: ConnectorView | null
  busy: boolean
  notice: string | null
  back?: PageChromeBack
  onConnect: () => void
}) {
  const theme = useTheme()

  return (
    <PageFrame
      {...(back ? { back } : {})}
      {...(connector ? { subtitle: stateLabel(connector) } : {})}
      title={connector?.label ?? slug}
    >
      <PageScrollView
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
      >
        {connector === null ? <Text color="textMuted">{connectorStrings.loading}</Text> : null}

        {connector?.description ? <Text color="textMuted">{connector.description}</Text> : null}

        {connector ? (
          <InsetGroup>
            <InsetValueRow label={connectorStrings.detail.slug} mono value={connector.slug} />
            <InsetValueRow
              label={connectorStrings.detail.status}
              value={connector.connectionStatus ?? stateLabel(connector)}
            />
            {connector.enabled === null ? null : (
              <InsetValueRow
                label={connectorStrings.detail.enabled}
                value={connector.enabled ? connectorStrings.detail.yes : connectorStrings.detail.no}
              />
            )}
          </InsetGroup>
        ) : null}

        {connector?.statusReason ? (
          <Text color="textMuted" variant="meta">
            {connectorStrings.reason(connector.statusReason)}
          </Text>
        ) : null}

        {connector ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {connectorStrings.connectHint}
              </Text>
            }
          >
            <InsetRow>
              <Button
                busy={busy}
                onPress={onConnect}
                testID="connector-connect"
                title={
                  busy
                    ? connectorStrings.connecting
                    : connector.connected
                      ? connectorStrings.reconnect
                      : connectorStrings.connect
                }
                variant={connector.connected ? 'secondary' : 'primary'}
              />
            </InsetRow>
          </InsetGroup>
        ) : null}

        {notice ? (
          <Text color="textMuted" testID="connector-detail-notice" variant="meta">
            {notice}
          </Text>
        ) : null}

        {/*
          The missing control, explained. There is no disconnect anywhere in the
          gateway or the CLI, and upstream refuses the verb on purpose — see
          `CONNECTOR_DISCONNECT_UNAVAILABLE` in the controller.
        */}
        <Text color="textMuted" testID="connector-disconnect-note" variant="meta">
          {connectorStrings.disconnect}
        </Text>
      </PageScrollView>
    </PageFrame>
  )
}
