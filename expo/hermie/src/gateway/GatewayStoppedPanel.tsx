/**
 * The gateway, said out loud, when it cannot be used at all.
 *
 * This started as the signed-out card, and the report that shaped it was from a
 * real Mac session: the content area showed a chat error, a corner showed a
 * link, and it was not clear at all that the thing to do was sign in. A dead
 * connection is not a chat problem and must not read as one, so it takes the
 * whole content column.
 *
 * The second report widened it. A fresh install inherited a stored gateway
 * address from an earlier one, and everything the app had to say about it was
 * that the endpoint was not what it expected: no address on screen, nothing to
 * press, and reinstalling as the only way out. So every stop the connection can
 * come to — a gateway that does not trust the address, a takeover, chat
 * switched off, a rejected certificate, an address that is not a gateway or
 * leads somewhere else, a version too old, and the expired session this card
 * started with — now lands here, names the address it is talking about, and
 * offers the three things that can be done about it.
 *
 * The sign-in itself is unchanged: the same in-place flow, the same web view,
 * and on success the tokens go to the coordinator and the dial loop picks up
 * where it stopped. Nobody is sent back through the wizard for an expired
 * refresh token.
 */
import { View } from 'react-native'

import { strings } from '../i18n/strings'
import { GlassSurface } from '../ui/glass'
import { Button, InsetButtonRow, InsetGroup, InsetValueRow, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { GatewayAddressRow } from './GatewayAddressRow'
import { gatewayStop, type GatewayStop } from './gateway-stop'
import { useGateway } from './GatewayProvider'
import { EMPTY_REGISTRY, gatewaysInOrder } from './registry'
import { describeSignOutReason, useReauth } from './reauth'
import { useConnectionStore } from './store'
import { WEB_GATEWAY_BASE_URL } from './web-config'

/** Statuses a re-check passes through, which the button says out loud. */
const CHECKING_STATUSES = new Set(['probing', 'authenticating', 'connecting'])

/** The current stop, or `null` while the app is usable. See `gatewayStop`. */
export function useGatewayStop(): GatewayStop | null {
  const { status, lastError, config, gateway, registry } = useGateway()

  return gatewayStop({
    status,
    error: lastError,
    config,
    gateway,
    // `?.` for the reason `GatewayTitle` gives: several suites stand in for
    // this context with the fields they care about, and a card that explains a
    // dead connection must not be the thing that crashes.
    gatewayCount: registry?.gateways.length ?? 1
  })
}

/**
 * The other gateways this device knows, as one row each.
 *
 * A picker would be the obvious shape and is the wrong one here: the reader is
 * looking at a card that says the machine they were on cannot be used, and the
 * shortest path off it is a button with the other machine's name on it. With
 * one gateway configured this draws nothing, because there is nowhere to go.
 */
function OtherGateways() {
  const { gatewayId, registry, switchGateway } = useGateway()
  const others = gatewaysInOrder(registry ?? EMPTY_REGISTRY).filter(entry => entry.id !== gatewayId)

  if (!others.length) {
    return null
  }

  return (
    <InsetGroup footer={strings.signedOut.stopped.othersHint} header={strings.signedOut.stopped.others}>
      {others.map(entry => (
        <InsetButtonRow
          key={entry.id}
          onPress={() => void switchGateway(entry.id)}
          testID={`gateway-stopped-switch-${entry.id}`}
          title={strings.signedOut.stopped.switchTo(entry.name)}
        />
      ))}
    </InsetGroup>
  )
}

/**
 * The address, in the parts a reader checks it by.
 *
 * In a browser those parts would be a lie. Hermie Web proxies the gateway onto
 * this page's own origin, so `config.baseUrl` is this app's address and its
 * scheme and port say nothing about the gateway — `GatewayAddressRow.web.tsx`
 * is the row that knows how to answer "which gateway am I on" there, and on the
 * web it is the whole block.
 */
function AddressBlock({ stop }: { stop: GatewayStop }) {
  const { config } = useGateway()

  return (
    <InsetGroup header={strings.signedOut.stopped.gateway}>
      <GatewayAddressRow baseUrl={config?.baseUrl} />
      {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.host} value={stop.address.host} />}
      {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.scheme} value={stop.address.scheme} />}
      {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.port} value={stop.address.port} />}
      <InsetValueRow label={strings.settings.user} value={stop.identity ?? strings.signedOut.stopped.notSignedIn} />
    </InsetGroup>
  )
}

/** The card itself: the content column on the wide layout, full width on phone. */
export function GatewayStoppedPanel() {
  const theme = useTheme()
  const { status, retryNow, signOut } = useGateway()
  const { busy, changeGateway, signIn, webView } = useReauth()
  const stop = useGatewayStop()
  const reason = describeSignOutReason(useConnectionStore(state => state.authTimeline.lastSignOut?.reason))

  if (!stop) {
    return null
  }

  const checking = CHECKING_STATUSES.has(status)

  return (
    <View
      style={{
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        padding: theme.space.xl
      }}
      /*
        Named after the state it is showing rather than after the file. The
        signed-out case is the one every other screen already knows this card
        by — the shell asserts it, the sidebar's line sits beside it — and a
        reader of a failing test learns from the id which stop was on screen.
      */
      testID={stop.kind === 'auth' ? 'signed-out-panel' : 'gateway-stopped-panel'}
    >
      <GlassSurface style={{ maxWidth: 420, width: '100%' }} variant="card">
        <View style={{ gap: theme.space.md, padding: theme.space.panel }}>
          {/* Which machine this is about, above the title, and only on a
              device that knows more than one. See `GatewayStop.gatewayName`. */}
          {stop.gatewayName ? (
            <Text color="textMuted" testID="gateway-stopped-name" variant="meta">
              {strings.signedOut.stopped.onGateway(stop.gatewayName)}
            </Text>
          ) : null}

          <Text variant="sheetTitle">{stop.title}</Text>

          <Text color="textMuted" testID="gateway-stopped-sentence" variant="preview">
            {stop.sentence}
          </Text>

          {/* The auth ring's account of the sign-out, where it has one. A
              session that ends with no explanation reads as the app's fault;
              a confidently wrong explanation is worse, so nothing is said
              when nothing was recorded. */}
          {stop.kind === 'auth' && reason ? (
            <Text color="textMuted" testID="signed-out-reason" variant="meta">
              {reason}
            </Text>
          ) : null}

          {stop.hint ? (
            <Text color="textFaint" testID="gateway-stopped-hint" variant="meta">
              {stop.hint}
            </Text>
          ) : null}

          <AddressBlock stop={stop} />

          {/* After the address block, because choosing another machine is only
              worth doing once the reader has read what is wrong with this one. */}
          {stop.actions.includes('switchGateway') ? <OtherGateways /> : null}

          <View style={{ gap: theme.space.sm, paddingTop: theme.space.xs }}>
            {/* Labels rather than spinners while these work. This card exists
                to say what is going on, and a button that swaps its own
                wording for a spinner says less than it did unpressed. */}
            {stop.actions.includes('signIn') ? (
              <Button
                disabled={busy}
                onPress={signIn}
                testID="signed-out-sign-in"
                title={busy ? strings.connection.reauth.saving : strings.signedOut.signIn}
              />
            ) : null}

            <Button
              disabled={busy || checking}
              onPress={retryNow}
              testID="gateway-stopped-recheck"
              title={checking ? strings.signedOut.stopped.rechecking : strings.signedOut.stopped.recheck}
              variant={stop.actions.includes('signIn') ? 'secondary' : 'primary'}
            />

            {/* In a browser there is no address to change: Hermie Web fixes the
                gateway and the wizard has no address step at all. Offering the
                button there would be offering a step that does not exist, so
                the reader is told where the decision actually lives. */}
            {WEB_GATEWAY_BASE_URL ? (
              <Text color="textFaint" testID="gateway-stopped-fixed" variant="meta">
                {strings.signedOut.stopped.fixedByServer}
              </Text>
            ) : (
              <>
                <Button
                  disabled={busy}
                  onPress={() => void changeGateway()}
                  testID="signed-out-change-gateway"
                  title={strings.signedOut.changeGateway}
                  variant="secondary"
                />
                <Text color="textFaint" variant="meta">
                  {strings.signedOut.stopped.changeGatewayHint}
                </Text>
              </>
            )}

            {/* Signing out is not the destructive action here — it keeps the
                address and drops only the credentials — so it is not dressed
                as one. The filled danger shade is Settings' "Forget this
                gateway", which deletes both. */}
            {stop.actions.includes('signOut') ? (
              <Button
                disabled={busy}
                onPress={() => void signOut()}
                testID="gateway-stopped-sign-out"
                title={strings.signedOut.stopped.signOut}
                variant="secondary"
              />
            ) : null}
          </View>
        </View>
      </GlassSurface>

      {webView}
    </View>
  )
}
