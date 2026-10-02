/**
 * Settings ▸ MCP servers, and one server's detail.
 *
 * Two pages, and two routes in the Settings stack: the list pushes the detail
 * through `onOpenServer`, and neither draws a back control of its own — each
 * takes the one its route hands it. What the two share (the probes, and the
 * fact that an authorisation changed the list) is in `probe-store.ts`.
 *
 * Nothing here probes on the reader's behalf. `mcp.servers.test` connects, and
 * a cold `npx` server takes seconds — testing three of them on arrival would
 * make the page feel broken while it was working. So the list paints from the
 * config and the cached runtime view, and connecting is a button.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Linking, Pressable, RefreshControl, View } from 'react-native'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { PageFrame, PageScrollView, type PageChromeBack } from '../../ui/chrome'
import { Button, InsetGroup, InsetRow, InsetValueRow, Text } from '../../ui/primitives'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useTheme } from '../../ui/theme'
import { McpController, type McpProbe, type McpServerView } from './mcp-controller'
import { mcpProbeKey, useMcpProbeStore, type McpProbeScope } from './probe-store'
import { mcpStrings } from './strings'

export interface McpScreenProps {
  /** The page's one back control, labelled with the page it returns to. */
  back?: PageChromeBack
  /** Push one server's page. */
  onOpenServer: (name: string) => void
  /** Scope every call to one bot. Omitted means the gateway's own profile. */
  profile?: string | null
}

/**
 * Which gateway and which bot these probes belong to.
 *
 * Read from the provider rather than passed in, because both pages already take
 * the profile as a prop and neither has any business also being told which
 * gateway it is looking at — there is one, and `useGateway` knows it.
 */
function useProbeScope(profile: string | null): McpProbeScope {
  const { gatewayId } = useGateway()

  return useMemo(() => ({ gateway: gatewayId ?? null, profile }), [gatewayId, profile])
}

/** The controller both pages talk through, one per connection. */
function useMcpController(): McpController | null {
  const { connection } = useGateway()

  return useMemo(
    () =>
      connection
        ? new McpController({
            gateway: chatGatewayFor(connection),
            openUrl: url => void Linking.openURL(url).catch(() => undefined)
          })
        : null,
    [connection]
  )
}

/** The configured servers and their cached runtime view; reloaded when a server's page changed it. */
function useMcpServers(controller: McpController | null, profile: string | null) {
  const revision = useMcpProbeStore(state => state.revision)
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!controller) {
      return
    }

    try {
      setServers(await controller.load(profile))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [controller, profile])

  useEffect(() => {
    void load()
  }, [load, revision])

  return { servers, error, load }
}

export function McpScreen({ back, onOpenServer, profile = null }: McpScreenProps) {
  const theme = useTheme()
  const controller = useMcpController()
  const { servers, error, load } = useMcpServers(controller, profile)
  const scope = useProbeScope(profile)
  const probes = useMcpProbeStore(state => state.probes)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <PageFrame {...(back ? { back } : {})} subtitle={mcpStrings.subtitle} title={mcpStrings.title}>
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
        {error ? (
          <Text color="dangerText" testID="mcp-error">
            {mcpStrings.failed(error)}
          </Text>
        ) : servers === null ? (
          <Text color="textMuted">{mcpStrings.loading}</Text>
        ) : servers.length === 0 ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {mcpStrings.emptyHint}
              </Text>
            }
          >
            <InsetRow>
              <Text color="textMuted">{mcpStrings.empty}</Text>
            </InsetRow>
          </InsetGroup>
        ) : (
          <InsetGroup>
            {servers.map(entry => (
              <ServerRow
                key={entry.name}
                needsAuth={probes[mcpProbeKey(scope, entry.name)]?.needsAuth === true}
                onPress={() => {
                  setNotice(null)
                  onOpenServer(entry.name)
                }}
                server={entry}
              />
            ))}
          </InsetGroup>
        )}

        {notice ? (
          <Text color="textMuted" testID="mcp-notice" variant="meta">
            {notice}
          </Text>
        ) : null}

        <InsetGroup
          footer={
            <Text color="textMuted" variant="meta">
              {mcpStrings.reloadHint}
            </Text>
          }
        >
          <InsetRow>
            <Button
              onPress={() => {
                // The confirm gate lives in `ReloadMcpSheet`, which the bot's
                // Capabilities sheet owns. Here the reload is a plain action on
                // a page the reader came to on purpose, so it asks in place.
                setNotice(null)
                void controller
                  ?.reload({ confirm: true })
                  .then(() => setNotice(mcpStrings.reload))
                  .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
              }}
              testID="mcp-reload"
              title={mcpStrings.reload}
              variant="secondary"
            />
          </InsetRow>
        </InsetGroup>
      </PageScrollView>
    </PageFrame>
  )
}

export interface McpServerScreenProps {
  name: string
  back?: PageChromeBack
  profile?: string | null
}

/** One server's page: what it is, a test that connects, and the authorisation when it asks for one. */
export function McpServerScreen({ name, back, profile = null }: McpServerScreenProps) {
  const controller = useMcpController()
  const { servers } = useMcpServers(controller, profile)
  const scope = useProbeScope(profile)
  const probe = useMcpProbeStore(state => state.probes[mcpProbeKey(scope, name)] ?? null)
  const setProbe = useMcpProbeStore(state => state.setProbe)
  const changed = useMcpProbeStore(state => state.changed)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const server = servers?.find(entry => entry.name === name) ?? null

  const test = () => {
    if (!controller) {
      return
    }

    setBusy(true)
    setNotice(null)
    void controller
      .test(name, profile)
      .then(result => {
        setProbe(scope, name, result)
        setNotice(result.ok ? mcpStrings.testOk(result.tools.length) : mcpStrings.testFailed(result.error ?? ''))
      })
      .catch((cause: unknown) =>
        setNotice(mcpStrings.testFailed(cause instanceof Error ? cause.message : String(cause)))
      )
      .finally(() => setBusy(false))
  }

  const authorise = () => {
    if (!controller) {
      return
    }

    setBusy(true)
    setNotice(mcpStrings.authorising)
    void controller
      .authorise(name, profile)
      .then(result => {
        setProbe(scope, name, result)
        setNotice(mcpStrings.authoriseOk)
        changed()
      })
      .catch((cause: unknown) =>
        setNotice(mcpStrings.authoriseFailed(cause instanceof Error ? cause.message : String(cause)))
      )
      .finally(() => setBusy(false))
  }

  return (
    <McpDetail
      busy={busy}
      name={name}
      notice={notice}
      onAuthorise={authorise}
      onTest={test}
      probe={probe}
      server={server}
      {...(back ? { back } : {})}
    />
  )
}

function ServerRow({ server, needsAuth, onPress }: { server: McpServerView; needsAuth: boolean; onPress: () => void }) {
  const theme = useTheme()
  const state = needsAuth ? mcpStrings.needsAuth : mcpStrings.runtime[server.runtime]

  return (
    <Pressable
      accessibilityLabel={`${server.name}, ${state}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
        gap: theme.space.xxs,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      })}
      testID={`mcp-row-${server.name}`}
    >
      <Text>{server.name}</Text>
      <Text
        color={needsAuth || server.runtime === 'failed' ? 'dangerText' : 'textMuted'}
        testID={`mcp-state-${server.name}`}
        variant="meta"
      >
        {state}
        {server.toolCount ? ` · ${mcpStrings.toolCount(server.toolCount)}` : ''}
      </Text>
    </Pressable>
  )
}

function McpDetail({
  name,
  server,
  probe,
  busy,
  notice,
  back,
  onTest,
  onAuthorise
}: {
  name: string
  /** `null` until the list has loaded; the page is titled by name meanwhile. */
  server: McpServerView | null
  probe: McpProbe | null
  busy: boolean
  notice: string | null
  back?: PageChromeBack
  onTest: () => void
  onAuthorise: () => void
}) {
  const theme = useTheme()

  return (
    <PageFrame
      {...(back ? { back } : {})}
      {...(server ? { subtitle: mcpStrings.runtime[server.runtime] } : {})}
      title={name}
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
        {server ? (
          <InsetGroup>
            <InsetValueRow label={mcpStrings.detail.transport} value={server.transport} />
            <InsetValueRow label={mcpStrings.detail.address} mono value={server.address} />
            <InsetValueRow label={mcpStrings.detail.auth} value={server.auth ?? mcpStrings.detail.authNone} />
          </InsetGroup>
        ) : (
          <Text color="textMuted">{mcpStrings.loading}</Text>
        )}

        {server?.env.length ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {mcpStrings.detail.envHint}
              </Text>
            }
            header={mcpStrings.detail.env}
          >
            {server.env.map(key => (
              <InsetRow key={key}>
                <Text variant="code">{key}</Text>
              </InsetRow>
            ))}
          </InsetGroup>
        ) : null}

        <InsetGroup>
          <InsetRow>
            <Button
              busy={busy}
              onPress={onTest}
              testID="mcp-test"
              title={busy ? mcpStrings.testing : mcpStrings.test}
              variant="secondary"
            />
          </InsetRow>
          {probe?.needsAuth ? (
            <InsetRow>
              <Button busy={busy} onPress={onAuthorise} testID="mcp-authorise" title={mcpStrings.authorise} />
            </InsetRow>
          ) : null}
        </InsetGroup>

        {notice ? (
          <Text color={probe && !probe.ok ? 'dangerText' : 'textMuted'} testID="mcp-detail-notice" variant="meta">
            {notice}
          </Text>
        ) : null}

        <InsetGroup header={mcpStrings.detail.tools}>
          {probe === null ? (
            <InsetRow>
              <Text color="textMuted" variant="meta">
                {mcpStrings.detail.toolsUnknown}
              </Text>
            </InsetRow>
          ) : probe.tools.length === 0 ? (
            <InsetRow>
              <Text color="textMuted" variant="meta">
                {mcpStrings.detail.toolsEmpty}
              </Text>
            </InsetRow>
          ) : (
            probe.tools.map(tool => (
              <InsetRow key={tool.name}>
                <View style={{ gap: theme.space.xxs }}>
                  <Text variant="code">{tool.name}</Text>
                  {tool.description ? (
                    <Text color="textMuted" variant="meta">
                      {tool.description}
                    </Text>
                  ) : null}
                </View>
              </InsetRow>
            ))
          )}
        </InsetGroup>
      </PageScrollView>
    </PageFrame>
  )
}
