import {
  type AuthEvent,
  type GatewayConnection,
  probeGateway,
  type ConnectionStatus,
  type ProbeResult
} from '@hermie/gateway-client'
import { formatTranscriptDiagnostics } from '@hermie/transcript'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, View } from 'react-native'

import { createGatewayConnection, useGateway } from '../../gateway'
// Straight from the store rather than the barrel: the barrel pulls in the whole
// provider, and a screen test that stubs it should not have to stub the store too.
import { useConnectionStore } from '../../gateway/store'
import { strings } from '../../i18n/strings'
import { hasHardwareKeyboard } from '../../platform/keyboard-modifiers'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { RUNS_ON_MAC } from '../../platform/runs-on-mac'
import { useChatsStore } from '../../store/chats'
import { PageFrame, PageScrollView, type PageChromeBack } from '../../ui/chrome'
import { Button, Text, TextField } from '../../ui/primitives'
import { GLASS_MATERIAL, GLASS_PROBES } from '../../ui/glass'
import { useTheme } from '../../ui/theme'

/**
 * A developer screen, not a product screen: it exists so a build on a real
 * device can be pointed at the fake gateway (or the test gateway) and prove the
 * transport works before any of the chat UI exists. The onboarding wizard in M2
 * replaces it for real users; native PKCE sign-in is not wired up here.
 */

// The Android emulator reaches the host machine through 10.0.2.2, never localhost.
const DEFAULT_BASE_URL = Platform.OS === 'android' ? 'http://10.0.2.2:9119' : 'http://localhost:9119'

/** `hh:mm:ss` in the reader's own zone — a ring is read as intervals, not dates. */
function clockOf(at: number): string {
  const when = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')

  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
}

/**
 * One event as a line that can be pasted into an issue as it stands.
 *
 * Everything here is either a name from a closed set or a number the gateway
 * itself said; there is no token value, no host and no message text anywhere in
 * the ring, which is what makes pasting it safe rather than a judgement call.
 */
export function formatAuthEvent(event: AuthEvent): string {
  const parts = [clockOf(event.at), event.event]

  if (event.status !== undefined) {
    parts.push(`http ${event.status}`)
  }

  if (event.closeCode !== undefined) {
    parts.push(`close ${event.closeCode}`)
  }

  if (event.kind !== undefined) {
    parts.push(event.kind)
  }

  if (event.expiresIn !== undefined) {
    // Signed on purpose: a negative reading is an already-expired token, and a
    // reading nowhere near the lifetime the gateway issues is clock drift.
    parts.push(`expires in ${event.expiresIn}s`)
  }

  if (event.reason !== undefined) {
    parts.push(event.reason)
  }

  return parts.join(' · ')
}

/**
 * The account of why the session ended, on the one screen where an owner is
 * already looking for it.
 *
 * This is the whole point of the ring: a Mac session ended in the signed-out card
 * with no gateway restart and no second instance, and there was nothing to read
 * afterwards — the diagnosis had to begin from "we do not know". The last
 * sign-out is called out above the events because it is the line that usually
 * settles it, and the events are what say whether it is the whole story.
 */
function AuthTimelineBlock() {
  const theme = useTheme()
  const timeline = useConnectionStore(state => state.authTimeline)
  /*
    Which gateway's ring this is.

    There is one ring per gateway now, and the events it holds — a refused
    refresh, a 4401, a token that was not there — are sentences about one
    machine. A screen that prints them without saying which one offers a
    diagnosis that could belong to either, which on a device with two is worse
    than offering none.
  */
  const gateway = useGateway().gateway
  const reason = timeline.lastSignOut
  /*
    Whether a front door is configured, and nothing else about it.

    A 401 with no front door and a 401 despite one are different problems, and
    the ring cannot tell them apart on its own — headers are not events. The
    store holds the sentence rather than the headers, so the values never reach
    this screen at all; `describeFrontDoor` produced it once, at the provider,
    and this screen is one screenshot away from an issue tracker.
  */
  const frontDoor = useConnectionStore(state => state.frontDoor)

  return (
    <View style={{ gap: theme.space.xxs }}>
      <Text variant="name">Auth timeline</Text>

      {gateway ? (
        <Text color="textMuted" testID="debug-auth-gateway" variant="meta">
          {`gateway: ${gateway.name} · ${gateway.address}`}
        </Text>
      ) : null}

      {frontDoor ? (
        <Text color="textMuted" testID="debug-front-door" variant="meta">
          {frontDoor}
        </Text>
      ) : null}

      <Text color="textMuted" testID="debug-auth-signout" variant="meta">
        {reason
          ? `last sign-out: ${reason.reason} at ${clockOf(reason.at)}`
          : 'last sign-out: none recorded on this device'}
      </Text>

      {timeline.events.length > 0 ? (
        timeline.events.map(event => (
          <Text color="textMuted" key={`${event.at}-${event.event}`} testID="debug-auth-event" variant="meta">
            {formatAuthEvent(event)}
          </Text>
        ))
      ) : (
        <Text color="textMuted" variant="meta">
          No auth events yet.
        </Text>
      )}
    </View>
  )
}

/**
 * Gateway calls that FAILED and whose failure a screen swallowed.
 *
 * The block that would have saved a day: the slash popover queried
 * `commands.catalog` and `complete.slash` inside `catch {}`, and when a real
 * gateway refused one there was nothing anywhere to say so. Unlike the auth ring
 * above, these lines carry the gateway's own words — which is the only thing
 * that makes `skill command: use command.dispatch for /docx` a diagnosis rather
 * than a shrug — so they can name a command, a profile or a path.
 */
function RpcFailuresBlock() {
  const theme = useTheme()
  const failures = useConnectionStore(state => state.rpcFailures)

  return (
    <View style={{ gap: theme.space.xxs }}>
      <Text variant="name">Refused gateway calls</Text>

      {failures.length > 0 ? (
        failures.map(failure => (
          <Text
            color="textMuted"
            key={`${failure.at}-${failure.method}`}
            selectable
            testID="debug-rpc-failure"
            variant="meta"
          >
            {[
              clockOf(failure.at),
              failure.method,
              failure.code === undefined ? '' : `code ${failure.code}`,
              failure.message
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ))
      ) : (
        <Text color="textMuted" variant="meta">
          No refused calls recorded on this connection.
        </Text>
      )}
    </View>
  )
}

export function DebugConnectionScreen({ back }: { back?: PageChromeBack }) {
  const theme = useTheme()
  const chats = useChatsStore(state => state.chats)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [sessionToken, setSessionToken] = useState('fake-session-token')
  const [showToken, setShowToken] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [transitions, setTransitions] = useState<string[]>([])
  const [profiles, setProfiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const connectionRef = useRef<GatewayConnection | null>(null)

  const disconnect = useCallback(() => {
    connectionRef.current?.stop()
    connectionRef.current = null
  }, [])

  useEffect(() => disconnect, [disconnect])

  const runProbe = useCallback(async () => {
    setError(null)
    setProbe(null)

    try {
      setProbe(await probeGateway(baseUrl))
    } catch (probeError) {
      setError(probeError instanceof Error ? probeError.message : String(probeError))
    }
  }, [baseUrl])

  const connect = useCallback(() => {
    disconnect()
    setError(null)
    setProfiles([])
    setTransitions([])

    const connection = createGatewayConnection({
      config: { baseUrl, authMode: 'session_token' },
      sessionToken
    })
    connectionRef.current = connection

    connection.onStatus((next, statusError) => {
      setStatus(next)
      setTransitions(seen => [...seen, next])

      if (statusError && next !== 'ready') {
        setError(statusError.message)
      }

      if (next !== 'ready') {
        return
      }

      connection
        .request('profiles.list', { include_sessions: true })
        .then(result => setProfiles((result.profiles ?? []).map(profile => profile.name)))
        .catch(listError => setError(listError instanceof Error ? listError.message : String(listError)))
    })

    connection.start()
  }, [baseUrl, disconnect, sessionToken])

  const transcriptLines = Object.entries(chats).flatMap(([botName, chat]) => formatTranscriptDiagnostics(botName, chat))

  return (
    <PageFrame {...(back ? { back } : {})} title={strings.settings.connectionTest}>
      <PageScrollView contentContainerStyle={{ gap: theme.space.md, padding: theme.space.lg }} ref={directTouchPanRef}>
        <Text color="textMuted">
          Points a raw gateway connection at an address and reports what happens. Session-token gateways only; signing
          in with a provider arrives with onboarding.
        </Text>

        <View style={{ gap: theme.space.xs }}>
          <Text variant="meta" color="textMuted">
            GATEWAY ADDRESS
          </Text>
          <TextField
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            placeholder={DEFAULT_BASE_URL}
          />
        </View>

        <View style={{ gap: theme.space.xs }}>
          <Text variant="meta" color="textMuted">
            SESSION TOKEN
          </Text>
          <TextField
            value={sessionToken}
            onChangeText={setSessionToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!showToken}
          />
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setShowToken(current => !current)}>
            <Text color="accentText" variant="meta">
              {showToken ? strings.onboarding.signIn.hideToken : strings.onboarding.signIn.showToken}
            </Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
          <Button title="Probe" variant="secondary" onPress={() => void runProbe()} style={{ flex: 1 }} />
          <Button title="Connect" onPress={connect} style={{ flex: 1 }} />
          <Button title="Stop" variant="secondary" onPress={disconnect} style={{ flex: 1 }} />
        </View>

        {error ? (
          <Text color="dangerText" testID="debug-error">
            {error}
          </Text>
        ) : null}

        {probe ? (
          <View style={{ gap: theme.space.xxs }}>
            <Text variant="name">Probe</Text>
            <Text color="textMuted">version {probe.version || 'unknown'}</Text>
            <Text color="textMuted">auth required: {String(probe.authRequired)}</Text>
            <Text color="textMuted">flows: {probe.authFlows.join(', ') || 'none'}</Text>
            <Text color="textMuted">native PKCE: {String(probe.supportsNativePkce)}</Text>
            <Text color="textMuted">
              providers: {probe.providers.map(provider => provider.displayName).join(', ') || 'none'}
            </Text>
          </View>
        ) : null}

        <View style={{ gap: theme.space.xxs }}>
          <Text variant="name">Runtime</Text>
          <Text color="textMuted" testID="debug-runs-on-mac">
            iOS app on a Mac: {String(RUNS_ON_MAC)}
          </Text>
          <Text color="textMuted" testID="debug-hardware-keyboard">
            hardware keyboard: {String(hasHardwareKeyboard())}
          </Text>
          {/*
            Which material the glass surfaces are actually drawing. It is not
            knowable from a screenshot — the native material and the blur
            fallback look similar over a light wallpaper — and it is the first
            thing to check when a surface looks flat.
          */}
          <Text color="textMuted" testID="debug-glass-material">
            glass material: {GLASS_MATERIAL}
          </Text>
          {/*
            And WHY. The two failures look identical from the outside — an OS
            older than 26 and an iOS 26 beta with a broken `UIGlassEffect`
            initialiser both come out as `blur` — so the answer to "the glass is
            not transparent enough" starts with which of these two is false.
          */}
          <Text color="textMuted" testID="debug-glass-probes">
            liquid glass: {String(GLASS_PROBES.liquidGlass)} · effect API: {String(GLASS_PROBES.effectApi)}
          </Text>
          <Text color="textMuted" testID="debug-reduce-transparency">
            reduce transparency: {String(theme.reduceTransparency)} · reduce motion: {String(theme.reduceMotion)}
          </Text>
        </View>

        <View style={{ gap: theme.space.xxs }}>
          <Text variant="name">Status</Text>
          <Text testID="debug-status">{status}</Text>
          <Text variant="meta" color="textMuted">
            {transitions.join(' → ') || 'not started'}
          </Text>
        </View>

        {profiles.length > 0 ? (
          <View style={{ gap: theme.space.xxs }}>
            <Text variant="name">profiles.list</Text>
            <Text testID="debug-profiles">{profiles.join(', ')}</Text>
          </View>
        ) : null}

        <AuthTimelineBlock />

        <RpcFailuresBlock />

        {/*
          What to read when a chat shows something twice. A screenshot of two
          bubbles cannot say which path put the second one there; these lines
          can — how many items have a durable row id, how many are still
          unpaired, and which items are carrying the same text as another. No
          message text is shown: a repeat is reported as a digest and a length,
          so the lines can be pasted into an issue as they stand.
        */}
        {transcriptLines.length > 0 ? (
          <View style={{ gap: theme.space.xxs }}>
            <Text variant="name">Transcripts</Text>
            {transcriptLines.map(line => (
              <Text key={line} variant="meta" color="textMuted" testID="debug-transcript-line">
                {line}
              </Text>
            ))}
          </View>
        ) : null}
      </PageScrollView>
    </PageFrame>
  )
}
