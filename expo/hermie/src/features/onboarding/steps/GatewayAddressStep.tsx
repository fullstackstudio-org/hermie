import {
  classifyProbeFailure,
  type FrontDoorKind,
  frontDoorWithheld,
  hasExplicitScheme,
  NO_FRONT_DOOR,
  normalizeBaseUrl,
  originOf,
  type ProbeAction,
  resolveGatewayAddress
} from '@hermie/gateway-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'

import { describeProbeError } from '../../../gateway/errors'
import { networkWatcher } from '../../../platform/net-info'
import { TransportNotice } from '../../../gateway/TransportNotice'
import { strings } from '../../../i18n/strings'
import { InsetButtonRow, InsetGroup, InsetRow, SecretField, Text, TextField } from '../../../ui/primitives'
import { SegmentedRow } from '../../../ui/sheets'
import { useTheme } from '../../../ui/theme'
import { effectiveHeaders, headerError, newHeaderRow, type OnboardingDraft } from '../draft'
import { StatusLine } from '../StatusLine'

/**
 * The Advanced presets.
 *
 * Two, and the second one is named. Header-based front doors all work the same
 * way — a pair of headers on every request — but only one of them is common
 * enough in front of a self-hosted gateway to be worth labelled fields, a
 * stored origin and a sentence about what it cannot do. Everything else is the
 * first preset, which is the field pair this step has always had.
 */
/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const presets = (): { value: FrontDoorKind; label: string }[] => [
  { value: 'none', label: strings.onboarding.address.frontDoor.custom },
  { value: 'cloudflare_access', label: strings.onboarding.address.frontDoor.cloudflare }
]

/** Long enough that typing an address does not fire a probe per keystroke. */
export const PROBE_DEBOUNCE_MS = 500

export interface GatewayAddressStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
  /** Tests drive this to zero; the app uses the debounce above. */
  debounceMs?: number
}

export function GatewayAddressStep({ draft, update, debounceMs = PROBE_DEBOUNCE_MS }: GatewayAddressStepProps) {
  const theme = useTheme()
  // Open when there is already something in it, which after a sign-out there
  // is: the wizard restores the way in along with the address.
  const [advanced, setAdvanced] = useState(draft.headers.length > 0 || draft.frontDoor.kind !== 'none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /*
    What the reader can press, when the failure leaves anything to press.

    Kept beside the message rather than derived from it, and produced by the
    same classifier that decided the message's extra sentences — so the buttons
    and the words under them cannot come to different conclusions about what
    went wrong. Two cases today: a redirect landed somewhere else, and a proxy
    refused before the gateway was reached.

    Offered, never performed. An app that followed a redirect by itself is
    exactly what the cached 301 did.
  */
  const [actions, setActions] = useState<ProbeAction[]>([])
  // Only true when the user named no scheme and https did not answer. It is
  // said out loud rather than kept: a downgrade nobody is told about is the
  // thing worth avoiding, not the downgrade.
  const [foundOverHttp, setFoundOverHttp] = useState(false)

  // A probe is slower than typing, so answers can come back out of order. Every
  // run takes a ticket and a late answer with a stale ticket is dropped rather
  // than allowed to overwrite a newer result.
  const sequence = useRef(0)
  const updateRef = useRef(update)
  updateRef.current = update

  const raw = draft.rawAddress.trim()
  // The FRONT DOOR is in here too, so editing a service token re-probes. On a
  // gated edge that is the only way to find out whether the pair is right:
  // `/api/status` is the first thing Access refuses.
  const headersKey = JSON.stringify(effectiveHeaders(draft))
  // The resolver tries https first and falls back to http only when the reader
  // left the scheme out, so which of the two is in flight is knowable here
  // without instrumenting the resolver.
  const pinnedScheme = raw && hasExplicitScheme(raw) ? raw.slice(0, raw.indexOf('://') + 3).toLowerCase() : null

  useEffect(() => {
    if (!raw) {
      sequence.current += 1
      setBusy(false)
      setError(null)
      setActions([])
      setFoundOverHttp(false)
      updateRef.current({ probe: null, baseUrl: null })

      return
    }

    let normalized: string

    try {
      // Only to reject what is not an address at all, before a debounce and a
      // round trip. Which SCHEME answers is the resolver's question.
      normalized = normalizeBaseUrl(raw)
    } catch (normalizeError) {
      sequence.current += 1
      setBusy(false)
      setFoundOverHttp(false)
      setActions([])
      setError(describeProbeError(normalizeError, raw))
      updateRef.current({ probe: null, baseUrl: null })

      return
    }

    // Not `normalized.startsWith('https://')` on its own: `normalizeBaseUrl`
    // puts that scheme on an address that named none, and those are the two
    // cases this has to tell apart.
    const httpsWasPinned = hasExplicitScheme(raw) && normalized.startsWith('https://')

    const ticket = ++sequence.current
    let cancelled = false
    setBusy(true)
    setError(null)
    /*
      And the actions, which belong to the failure that produced them.

      `classifyProbeFailure` was given the PREVIOUS address, so a button left
      standing while a new address is probed offers to open a front door for a
      host the reader has already stopped typing. It read as a live offer under
      a "checking…" line, which is also why the suite could see the two at once.
    */
    setActions([])

    const timer = setTimeout(() => {
      resolveGatewayAddress(raw, JSON.parse(headersKey) as Record<string, string>)
        .then(({ baseUrl, foundOverHttp: overHttp, ...result }) => {
          if (cancelled || ticket !== sequence.current) {
            return
          }

          setBusy(false)
          setError(null)
          setActions([])
          setFoundOverHttp(overHttp)
          updateRef.current({ probe: result, baseUrl })
        })
        .catch(async probeError => {
          /*
            The link is asked for AFTER the failure, not kept in state.

            It is one native round trip, it only matters once a probe has
            already failed, and asking here means the answer describes the
            moment the probe ran rather than whenever the step last mounted —
            which on a phone that just left the house is a different answer.
          */
          const network = await networkWatcher.kind().catch(() => 'unknown' as const)

          if (cancelled || ticket !== sequence.current) {
            return
          }

          setBusy(false)
          setFoundOverHttp(false)
          setActions(classifyProbeFailure(probeError, { address: normalized, network }).actions)
          setError(describeProbeError(probeError, normalized, httpsWasPinned, network))
          updateRef.current({ probe: null, baseUrl: null })
        })
    }, debounceMs)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [debounceMs, headersKey, raw])

  // Re-typing the address with the scheme spelled out is exactly what stops the
  // fallback from running again: an explicit `https://` is never downgraded.
  // The port and any path prefix come along — they are not the scheme's.
  /** Point the wizard at the host that actually answered, scheme and all. */
  const takeRedirectTarget = useCallback(
    (host: string) => {
      setActions([])
      update({ rawAddress: host, probe: null, baseUrl: null })
    },
    [update]
  )

  /**
   * Open Advanced on the Cloudflare preset, which is what a 401 or 403 from
   * something in front of the gateway most often wants.
   *
   * It does not choose for the reader beyond that: the preset is switched on
   * and the fields are empty, and "Custom headers" is one tap away for a proxy
   * that is not Cloudflare.
   */
  const openFrontDoor = useCallback(() => {
    setAdvanced(true)

    if (draft.frontDoor.kind === 'none') {
      update({
        frontDoor: {
          kind: 'cloudflare_access',
          clientId: '',
          clientSecret: '',
          origin: originOf(draft.baseUrl ?? draft.rawAddress)
        }
      })
    }
  }, [draft.baseUrl, draft.frontDoor.kind, draft.rawAddress, update])

  const useHttpsInstead = useCallback(() => {
    const current = draft.baseUrl ?? draft.rawAddress.trim()

    update({ rawAddress: `https://${current.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')}` })
  }, [draft.baseUrl, draft.rawAddress, update])

  const setHeader = useCallback(
    (id: string, patch: Partial<{ name: string; value: string }>) => {
      update({ headers: draft.headers.map(row => (row.id === id ? { ...row, ...patch } : row)) })
    },
    [draft.headers, update]
  )

  /**
   * Switch preset.
   *
   * Leaving Cloudflare Access DROPS the pair rather than parking it, which is
   * the whole reason this is a switch and not a checkbox: a secret the reader
   * has turned off should not be sitting in the draft waiting to be saved with
   * the next gateway.
   */
  const setPreset = useCallback(
    (kind: FrontDoorKind) => {
      update({
        frontDoor:
          kind === 'cloudflare_access'
            ? { kind, clientId: '', clientSecret: '', origin: originOf(draft.baseUrl ?? draft.rawAddress) }
            : NO_FRONT_DOOR
      })
    },
    [draft.baseUrl, draft.rawAddress, update]
  )

  const setAccess = useCallback(
    (patch: { clientId?: string; clientSecret?: string }) => {
      if (draft.frontDoor.kind !== 'cloudflare_access') {
        return
      }

      update({ frontDoor: { ...draft.frontDoor, ...patch, origin: originOf(draft.baseUrl ?? draft.rawAddress) } })
    },
    [draft.baseUrl, draft.frontDoor, draft.rawAddress, update]
  )

  return (
    <View style={{ gap: theme.space.lg }}>
      <View style={{ gap: theme.space.sm }}>
        <Text color="textMuted" variant="micro">
          {strings.onboarding.address.label}
        </Text>
        {/*
          Outside an `InsetRow` on purpose, so `TextField` draws the sunk well
          the design board gives every editable thing. A row would have lent it
          its own chrome, which inside a card is a box around a box.
        */}
        <TextField
          accessibilityLabel={strings.onboarding.address.label}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          keyboardType="url"
          onChangeText={next => update({ rawAddress: next })}
          placeholder={strings.onboarding.address.placeholder}
          // The address is one line and the probe runs while you type, so
          // Return has nothing left to submit; it should put the keyboard
          // away and uncover the rest of the card.
          returnKeyType="done"
          testID="gateway-address"
          textContentType="URL"
          value={draft.rawAddress}
        />
        <Text color="textFaint" style={{ marginHorizontal: theme.space.xs }} variant="meta">
          {strings.onboarding.address.hint}
        </Text>
      </View>

      <View style={{ gap: theme.space.sm }}>
        <ProbeLine busy={busy} draft={draft} error={error} foundOverHttp={foundOverHttp} pinnedScheme={pinnedScheme} />
        {/*
          The way out of a redirect, which is a change of gateway address and
          nothing else. Offered rather than done: the host that answered is not
          necessarily the one the owner meant, and a wizard that followed it by
          itself is exactly what the cached 301 did.
        */}
        {actions.length > 0 ? (
          <InsetGroup>
            {actions.map(action =>
              action.kind === 'use_host' ? (
                <InsetButtonRow
                  key="use-host"
                  onPress={() => takeRedirectTarget(action.host)}
                  testID="probe-use-redirect"
                  title={strings.errors.useRedirectTarget(action.host)}
                />
              ) : (
                <InsetButtonRow
                  key="front-door"
                  onPress={openFrontDoor}
                  testID="probe-front-door"
                  title={strings.errors.openFrontDoor}
                />
              )
            )}
          </InsetGroup>
        ) : null}
        <TransportNotice
          baseUrl={busy || error ? null : draft.baseUrl}
          onUseHttps={useHttpsInstead}
          testID="transport-notice"
        />
      </View>

      <View style={{ gap: theme.space.md }}>
        <Pressable
          accessibilityRole="button"
          aria-expanded={advanced}
          hitSlop={8}
          onPress={() => setAdvanced(current => !current)}
          style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}
        >
          <Text color="accentText" variant="preview">
            {/* A static caret: a disclosure is not a thing that needs the reader. */}
            {advanced ? `▾ ${strings.onboarding.address.advanced}` : `▸ ${strings.onboarding.address.advanced}`}
          </Text>
        </Pressable>

        {advanced ? (
          <InsetGroup footer={strings.onboarding.address.frontDoor.hint}>
            <SegmentedRow
              label={strings.onboarding.address.frontDoor.label}
              onChange={setPreset}
              options={presets()}
              testID="front-door-preset"
              value={draft.frontDoor.kind}
            />
          </InsetGroup>
        ) : null}

        {advanced && draft.frontDoor.kind === 'cloudflare_access' ? (
          <InsetGroup
            footer={
              frontDoorWithheld(draft.frontDoor, draft.baseUrl ?? '')
                ? strings.onboarding.address.frontDoor.insecure
                : strings.onboarding.address.frontDoor.cloudflareHint
            }
          >
            <InsetRow style={{ gap: theme.space.sm }}>
              <TextField
                autoCapitalize="none"
                autoCorrect={false}
                label={strings.onboarding.address.frontDoor.clientId}
                onChangeText={clientId => setAccess({ clientId })}
                placeholder={strings.onboarding.address.frontDoor.clientIdPlaceholder}
                returnKeyType="done"
                testID="cf-access-client-id"
                value={draft.frontDoor.clientId}
              />
              {/*
                A `SecretField`, the same as a custom header's value: it is a
                long-lived tenant credential and it is pasted in rooms with
                other people in them.
              */}
              <SecretField
                autoCapitalize="none"
                autoCorrect={false}
                concealLabel={strings.onboarding.address.hideValue}
                label={strings.onboarding.address.frontDoor.clientSecret}
                onChangeText={clientSecret => setAccess({ clientSecret })}
                returnKeyType="done"
                revealLabel={strings.onboarding.address.showValue}
                testID="cf-access-client-secret"
                value={draft.frontDoor.clientSecret}
              />
            </InsetRow>
          </InsetGroup>
        ) : null}

        {advanced && draft.frontDoor.kind === 'none' ? (
          <InsetGroup footer={strings.onboarding.address.advancedHint}>
            {draft.headers.map(row => (
              <InsetRow key={row.id} style={{ gap: theme.space.sm }}>
                <TextField
                  autoCapitalize="none"
                  autoCorrect={false}
                  label={strings.onboarding.address.headerName}
                  onChangeText={name => setHeader(row.id, { name })}
                  placeholder="CF-Access-Client-Id"
                  returnKeyType="done"
                  value={row.name}
                  {...(headerError(row) ? { error: headerError(row) } : {})}
                />
                <SecretField
                  autoCapitalize="none"
                  autoCorrect={false}
                  concealLabel={strings.onboarding.address.hideValue}
                  label={strings.onboarding.address.headerValue}
                  onChangeText={value => setHeader(row.id, { value })}
                  returnKeyType="done"
                  revealLabel={strings.onboarding.address.showValue}
                  value={row.value}
                />
                <Pressable
                  accessibilityLabel={strings.onboarding.address.removeHeader(row.name)}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => update({ headers: draft.headers.filter(other => other.id !== row.id) })}
                >
                  <Text color="dangerText" variant="meta">
                    {strings.common.remove}
                  </Text>
                </Pressable>
              </InsetRow>
            ))}
            <InsetButtonRow
              onPress={() => update({ headers: [...draft.headers, newHeaderRow()] })}
              title={strings.onboarding.address.addHeader}
            />
          </InsetGroup>
        ) : null}
      </View>
    </View>
  )
}

function ProbeLine({
  busy,
  error,
  draft,
  foundOverHttp,
  pinnedScheme
}: {
  busy: boolean
  error: string | null
  draft: OnboardingDraft
  foundOverHttp: boolean
  /** The scheme the reader typed, or `null` when they left it out. */
  pinnedScheme: string | null
}) {
  if (busy) {
    return (
      <StatusLine testID="probe-result" tone="checking">
        {pinnedScheme ? strings.onboarding.address.probingScheme(pinnedScheme) : strings.onboarding.address.probingBoth}
      </StatusLine>
    )
  }

  if (error) {
    return (
      <StatusLine testID="probe-error" tone="error">
        {error}
      </StatusLine>
    )
  }

  const probe = draft.probe

  if (!probe) {
    return null
  }

  // Which scheme answered is part of what the probe found, so it belongs on the
  // same line rather than in a notice the eye can skip. It is only said when
  // the reader left the scheme out, because that is the only time it was an
  // open question.
  const found = pinnedScheme
    ? ''
    : foundOverHttp
      ? ` · ${strings.transport.foundOverHttp}`
      : ` · ${strings.transport.foundOverHttps}`

  if (!probe.authRequired) {
    return (
      <StatusLine testID="probe-result" tone="ok">
        {`${strings.onboarding.address.sessionTokenRequired(probe.version)}${found}`}
      </StatusLine>
    )
  }

  if (probe.providers.length === 0) {
    return (
      <StatusLine testID="probe-result" tone="error">
        {`${strings.onboarding.address.signInRequiredNoProviders(probe.version)}${found}`}
      </StatusLine>
    )
  }

  return (
    <StatusLine testID="probe-result" tone="ok">
      {`${strings.onboarding.address.signInRequired(
        probe.version,
        probe.providers.map(provider => provider.displayName)
      )}${found}`}
    </StatusLine>
  )
}
