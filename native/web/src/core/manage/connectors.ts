/**
 * The apps a bot can reach on the person's behalf, and the flow that signs one in (the Expo app's
 * `features/connectors/connectors-controller.ts`, which this follows).
 *
 * Four things about this corner of the gateway shape the page, and three of them are invisible from the screen:
 *
 *  - **The calls name an OWNER, not a session.** `{type: "account"}` is the settings page's: no chat has to be
 *    open for there to be a list. The vendored TypeScript contract still spells the parameter `session_id`, which
 *    the gateway refuses with 4000 (`extra="forbid"`), so the calls are made with the owner and cast.
 *  - **`available: false` is a successful answer.** When the bot's connections toolset is off the list answers
 *    `{available: false, connectors: []}` with no error frame. Reading that as an empty account would tell the
 *    reader they have no connectors when what they have is a switch turned off.
 *  - **The authorisation address is per TARGET.** `connectors.connect` answers an operation, and the link lives
 *    at `targets[].connect_url`, never at the top level.
 *  - **There is no disconnect.** Not in the gateway, not in the CLI: upstream refuses the verb on purpose and
 *    sends the person to wherever the account is managed. The page says so (`strings.connectors.disconnect`)
 *    instead of showing a control that could only fail.
 *
 * A flow is followed by re-reading the operation until the target settles. Frames are ordered by `seq` where the
 * gateway sends one: the status read and the gateway's own account watcher race, and applying a stale frame would
 * walk a connected target back to `initiated`.
 */
import type {
  ConnectionOperationStatus,
  ConnectionOperationTarget,
  ConnectionTargetState,
  ConnectorRow
} from '@hermes/shared/gateway-contract'

import { signInLink } from './mcp-servers'
import type { ManageTransport } from './transport'

/** How often the open operation is re-read; the gateway's own account watcher runs at 1 Hz. */
export const CONNECT_POLL_INTERVAL_MS = 1_000

/** The operation carries its own deadline; this is the ceiling for a gateway that never answers at all. */
export const CONNECT_TIMEOUT_MS = 360_000

/** One row of the list, with the open key set reduced to what the page draws. */
export interface ConnectorView {
  /** The slug every other call addresses this connector by. */
  slug: string
  /** The vendor's display name when it sent one, else the slug. */
  label: string
  description: string | null
  connected: boolean
  /** `null` when the row did not say, which is not the same as "off". */
  enabled: boolean | null
  /** The vendor's own status word, passed through unmodelled. */
  connectionStatus: string | null
  /** Why the vendor says it is in that state, when it says anything. */
  statusReason: string | null
}

export interface ConnectorList {
  /** `false` means the bot's connections toolset is off, which is not "none configured". */
  available: boolean
  connectors: ConnectorView[]
}

/** How a connect attempt ended, in the four words the page has to say. */
export type ConnectOutcome =
  { status: 'connected' } | { status: 'failed'; reason: string } | { status: 'expired' } | { status: 'skipped' }

/** A target state that will not change again without a new attempt. */
const SETTLED: ReadonlySet<ConnectionTargetState> = new Set([
  'connected',
  'skipped',
  'failed',
  'expired',
  'unavailable'
])

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/**
 * One wire row as the page draws it. `ConnectorRow` is an OPEN model on both sides (the connector service owns the
 * key set), so `statusReason` is read off the bag: it is a real key upstream that the vendored type never grew.
 */
export function describeConnector(row: ConnectorRow): ConnectorView {
  const slug = text(row.connector) ?? text(row.name) ?? ''

  return {
    slug,
    // A row with neither a name nor a label is still drawn, under its slug: a connector the reader cannot see is
    // one they cannot connect.
    label: text(row.name) ?? slug,
    description: text(row.description),
    connected: row.connected === true,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    connectionStatus: text(row.connectionStatus),
    statusReason: text(row.statusReason)
  }
}

/** The state of one row in a word the page maps to its sentence; one place so the row and its badge agree. */
export const connectorState = (connector: ConnectorView): 'connected' | 'disabled' | 'notConnected' =>
  connector.connected ? 'connected' : connector.enabled === false ? 'disabled' : 'notConnected'

/** The `seq` a frame carries when it carries one; `null` cannot be ordered and is taken. */
export const seqOf = (frame: unknown): number | null => {
  const value = (frame as { seq?: unknown } | null | undefined)?.seq

  return typeof value === 'number' ? value : null
}

const targetFor = (targets: readonly ConnectionOperationTarget[] | undefined, slug: string) =>
  (Array.isArray(targets) ? targets : []).find(entry => entry.name === slug) ?? null

/** One settled target's state, as what the page says about it. */
function outcomeFor(target: ConnectionOperationTarget): ConnectOutcome {
  if (target.state === 'connected') {
    return { status: 'connected' }
  }

  if (target.state === 'expired') {
    return { status: 'expired' }
  }

  if (target.state === 'skipped') {
    return { status: 'skipped' }
  }

  // `failed` and `unavailable`. `detail` is the vendor's error message where there was one; the list never has it.
  return { status: 'failed', reason: target.detail ?? target.hint ?? 'The authorisation did not finish.' }
}

/** The flow under way. */
export interface ConnectFlow {
  /** Where the reader goes to sign in, or `null` for a connector that needed no sign-in and is already connected. */
  authUrl: string | null
  /** Where the address goes, for the page to say before it is pressed; `null` with no address. */
  authHost: string | null
  /** Resolves with how it ended; rejects on a failure of the call itself. */
  done: Promise<ConnectOutcome>
  /** The browser leg is back: have the gateway read the account now rather than on its next tick. */
  wake: () => void
  /** Stop following; the gateway's own deadline ends the operation. */
  cancel: () => void
}

export interface ConnectorsClient {
  list(profile: string): Promise<ConnectorList>
  connect(slug: string, options: { profile: string; reconnect: boolean }): Promise<ConnectFlow>
}

export interface ConnectorsClientOptions {
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

/** The calls, with the owner they take. The vendored contract's `session_id` is wrong for the gateway; see above. */
type LooseRequest = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>

const ACCOUNT = { type: 'account' } as const

export function createConnectorsClient(
  gateway: ManageTransport['gateway'],
  options: ConnectorsClientOptions = {}
): ConnectorsClient {
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const request = gateway.request as unknown as LooseRequest

  return {
    async list(profile) {
      const result = await request('connectors.list', { profile, owner: ACCOUNT })
      const rows = Array.isArray(result.connectors) ? (result.connectors as ConnectorRow[]) : []

      return {
        available: result.available !== false,
        connectors: rows.map(describeConnector).filter(entry => entry.slug)
      }
    },

    async connect(slug, { profile, reconnect }) {
      const started = (await request('connectors.connect', {
        profile,
        owner: ACCOUNT,
        connectors: [slug],
        ...(reconnect ? { reconnect: true } : {})
      })) as unknown as ConnectionOperationStatus
      const opened = targetFor(started.targets, slug)
      const scope = { profile, owner: ACCOUNT, op_id: started.op_id }

      // Done before the browser was ever opened: a connector that needs no sign-in is minted `connected` at once.
      if (opened?.state === 'connected') {
        return {
          authUrl: null,
          authHost: null,
          done: Promise.resolve<ConnectOutcome>({ status: 'connected' }),
          wake: () => undefined,
          cancel: () => undefined
        }
      }

      const link = signInLink(opened?.connect_url)

      // Without an address there is nothing for the reader to do, and the poll would run to the deadline.
      if (!link) {
        throw new Error(opened?.detail ?? 'The gateway opened an authorisation but did not say where to send you.')
      }

      let cancelled = false

      const done = (async (): Promise<ConnectOutcome> => {
        const deadline = now() + CONNECT_TIMEOUT_MS
        let seen = seqOf(started)

        for (;;) {
          await wait(CONNECT_POLL_INTERVAL_MS)

          if (cancelled) {
            return { status: 'skipped' }
          }

          const frame = (await request('connectors.operation.status', scope)) as unknown as ConnectionOperationStatus
          const seq = seqOf(frame)

          if (seq === null || seen === null || seq > seen) {
            seen = seq

            const target = targetFor(frame.targets, slug)

            if (target && SETTLED.has(target.state)) {
              return outcomeFor(target)
            }

            // The operation settled without this target settling: the reader answered Continue, the deadline
            // struck, or the session went away. None of those is a failure worth a red line.
            if (frame.settled) {
              return { status: 'skipped' }
            }
          }

          if (now() >= deadline) {
            return { status: 'expired' }
          }
        }
      })()

      return {
        authUrl: link.url,
        authHost: link.host,
        done,
        // A latency shortcut and nothing else (upstream says the link "is not trusted for anything else"); a
        // failure is ignored on purpose: `UNKNOWN_OPERATION` is what a flow that already finished answers.
        wake: () => void request('connectors.operation.wake', scope).catch(() => undefined),
        cancel: () => {
          cancelled = true
        }
      }
    }
  }
}
