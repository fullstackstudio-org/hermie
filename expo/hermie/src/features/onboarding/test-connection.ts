import { type GatewayConnection, GatewayError } from '@hermie/gateway-client'
import { pluginAdvert } from '@hermie/gateway-client/plugin'

import { createGatewayConnection, createMemoryTokenStore, createTokenCoordinator } from '../../gateway/client'
import {
  authModeOf,
  connectionPayloadKey,
  type ConnectionTestOutcome,
  effectiveHeaders,
  type OnboardingDraft
} from './draft'

/** How long the whole dial — ticket, socket, `gateway.ready` — gets before the test fails. */
export const CONNECTION_TEST_TIMEOUT_MS = 30_000

/**
 * The three things the test exercises, in order.
 *
 * Reported as each one STARTS, so the step can show which half of the transport
 * a failure belongs to. That distinction is the whole value of the step: REST
 * refused is a credential, the socket refused is a reverse proxy that does not
 * pass upgrades through, and one line saying "it did not work" tells you
 * neither.
 */
export type ConnectionTestStage = 'rest' | 'socket' | 'profiles'

/**
 * Wait for the connection to reach `ready`, or fail at the first sign that it
 * will not.
 *
 * During normal use a drop is something to ride out with backoff. During a test
 * it is the answer: the point of the step is to tell the user now whether this
 * address and this credential work, so `reconnecting` counts as a failure
 * rather than as a reason to wait another fifteen seconds.
 */
function waitForReady(connection: GatewayConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // A box rather than a bare `let`: `onStatus` reports the current status
    // synchronously, so the handler can run before the subscription handle
    // exists, and reading a not-yet-initialised binding would throw.
    const subscription: { off?: () => void } = {}
    let settled = false

    const finish = (error?: unknown) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      subscription.off?.()

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const timer = setTimeout(() => {
      finish(new GatewayError('timeout', `The gateway did not answer within ${Math.round(timeoutMs / 1000)} seconds.`))
    }, timeoutMs)

    subscription.off = connection.onStatus((status, error) => {
      if (status === 'ready') {
        finish()

        return
      }

      if (status === 'needs_signin' || status === 'incompatible' || status === 'reconnecting' || status === 'offline') {
        finish(error ?? new GatewayError('network', 'The gateway connection failed.'))

        return
      }

      if (status === 'disconnected' && error) {
        finish(error)
      }
    })

    connection.start()
  })
}

/**
 * The mandatory step before anything is stored: exercise both halves of the
 * transport with the credential the user just obtained. REST first, because a
 * bearer or session token that is refused there fails with an HTTP status that
 * explains itself; then the socket, which is where a reverse proxy that does
 * not pass upgrades through finally shows up.
 */
export async function runConnectionTest(
  draft: OnboardingDraft,
  timeoutMs: number = CONNECTION_TEST_TIMEOUT_MS,
  /** Called as each stage starts. Reporting only; it decides nothing. */
  onStage: (stage: ConnectionTestStage) => void = () => {}
): Promise<ConnectionTestOutcome> {
  const baseUrl = draft.baseUrl

  if (!baseUrl) {
    throw new GatewayError('config', 'There is no gateway address to test.')
  }

  const authMode = authModeOf(draft.probe)
  const extraHeaders = effectiveHeaders(draft)
  const coordinator =
    authMode === 'native_pkce'
      ? createTokenCoordinator({ baseUrl, extraHeaders, store: createMemoryTokenStore(draft.tokens) })
      : undefined

  const connection = createGatewayConnection({
    config: {
      baseUrl,
      authMode,
      ...(draft.provider ? { provider: draft.provider.name } : {}),
      extraHeaders
    },
    ...(authMode === 'session_token' ? { sessionToken: draft.sessionToken.trim() } : {}),
    ...(coordinator ? { coordinator } : {})
  })

  try {
    let userDisplayName = ''
    let userEmail = ''
    let userPictureUrl = ''

    onStage('rest')

    if (authMode !== 'session_token') {
      const identity = await connection.http.authMe()
      userDisplayName = identity.displayName || identity.email || identity.userId
      userEmail = identity.email
      userPictureUrl = identity.pictureUrl
    } else {
      // An ungated gateway has no identity to report, so the equivalent check is
      // simply that an authenticated read succeeds with the session token.
      await connection.http.get('/api/profiles')
    }

    onStage('socket')
    await waitForReady(connection, timeoutMs)

    onStage('profiles')
    const result = await connection.request('profiles.list', { include_sessions: true })
    // Read the coordinator back rather than the draft: if the dial rotated the
    // pair, this is the only place the live one exists. The payload key is
    // computed against the rotated draft too, or the step would invalidate its
    // own result the moment the caller adopts the token.
    const tokens = coordinator ? await coordinator.current() : null
    const tested = tokens ? { ...draft, tokens } : draft

    return {
      key: connectionPayloadKey(tested),
      userDisplayName,
      userEmail,
      userPictureUrl,
      botCount: (result.profiles ?? []).length,
      // Read off the roster this stage just fetched: the plugin publishes its
      // advert into the gateway's own `ui_meta`, so "is it installed" is
      // already in the answer.
      plugin: pluginAdvert(result.profiles ?? []),
      ...(tokens ? { tokens } : {})
    }
  } finally {
    connection.stop()
  }
}
