/**
 * The Connectors page's round trips.
 *
 * Four things about this corner of the gateway shape the whole feature, and
 * three of them are invisible from the screen:
 *
 *  - **A connector list belongs to a SESSION, not to the gateway.**
 *    `connectors.list` takes `session_id`, and `methods_connectors._owned_session`
 *    authorises it by transport ATTACHMENT — `_current_session_steer_authority`
 *    requires the socket making the call to be attached to the live record
 *    under that id. So there is no gateway-wide connector page to build, and a
 *    session this app has not opened answers `NOT_OWNER` rather than a list.
 *
 *  - **`available: false` is a successful answer.** When the bot's
 *    `manage_connections` toolset is off, `list` answers
 *    `{available: false, connectors: []}` with no error frame at all. Reading
 *    that as an empty account would tell the reader they have no connectors
 *    when what they have is a switch turned off.
 *
 *  - **The authorisation URL is per TARGET.** `connectors.connect` answers an
 *    operation, and the link lives at `targets[].connect_url` — never at the
 *    top level. `connector_ui_payload` redacts the whole payload but exempts
 *    `connect_url` by name, which is the only reason the link survives.
 *
 *  - **There is no disconnect.** Not in the gateway, not in the CLI.
 *    `tools/connectors/tool.py` says it outright — the tool "can NOT
 *    disconnect, delete, or revoke an account — that is deliberately
 *    user-only". See {@link CONNECTOR_DISCONNECT_UNAVAILABLE}.
 */
import type {
  ConnectionOperationStatus,
  ConnectionOperationTarget,
  ConnectionTargetState,
  ConnectorRow,
  ConnectorsConnectResult
} from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'

/** How often the open operation is re-read. The gateway's own account watcher runs at 1 Hz. */
export const CONNECT_POLL_INTERVAL_MS = 1_000

/**
 * How long a flow is followed before it is given up on.
 *
 * The operation carries its own `deadline_at` and that is what actually ends
 * it; this is only the ceiling for a gateway that never answers at all.
 */
export const CONNECT_TIMEOUT_MS = 360_000

/**
 * Why this feature has no "Disconnect" control.
 *
 * Upstream registers `connectors.list`, `connectors.connect`,
 * `connectors.operation.status`, `connectors.operation.wake` and
 * `connection.respond`. That is the entire surface — there is no
 * `connectors.disconnect` in `methods_connectors.py`, none in the vendored
 * contract, and no `hermes connectors` subcommand either. It is not an
 * omission: `tools/connectors/targets.py` refuses the verb in its own error
 * text, and `tools/connectors/tool.py` tells the model to say so and send the
 * user to the place that manages the account.
 *
 * So the page states whose decision it is instead of showing a control that
 * could only ever fail, and instead of naming one particular vendor's
 * dashboard — which gateway this app is talking to is not ours to assume.
 */
export const CONNECTOR_DISCONNECT_UNAVAILABLE =
  'The gateway exposes no disconnect. Upstream refuses the verb on purpose and directs the user to ' +
  'wherever the connector account is managed.'

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
  /** `false` means the bot's Connections toolset is off — not "none configured". */
  available: boolean
  connectors: ConnectorView[]
}

/** How a connect attempt ended, in the three words the page has to say. */
export type ConnectOutcome =
  { status: 'connected' } | { status: 'failed'; reason: string } | { status: 'expired' } | { status: 'skipped' }

/** A target state that will not change again without a new attempt. */
const SETTLED_TARGET_STATES = new Set<ConnectionTargetState>([
  'connected',
  'skipped',
  'failed',
  'expired',
  'unavailable'
])

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/**
 * Reduce one wire row to what the page draws.
 *
 * Exported for its own test. `ConnectorRow` is an OPEN model on both sides —
 * upstream's `_Open` base and the contract's `[key: string]: unknown` — because
 * the connector service owns the key set and the gateway passes unknown
 * metadata straight through. So `statusReason` is read off the bag rather than
 * off a declared field: it is a real key on `ConnectorListItem` upstream
 * (`tools/connectors/gateway/wire.py`) that the vendored row type never grew.
 */
export const describeConnector = (row: ConnectorRow): ConnectorView => {
  const slug = text(row.connector) ?? text(row.name) ?? ''

  return {
    slug,
    // `name` is the vendor's label when it sends one. A row with neither is
    // still drawn — under its slug — rather than dropped, because a connector
    // the reader cannot see is a connector they cannot connect.
    label: text(row.name) ?? slug,
    description: text(row.description),
    connected: row.connected === true,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    connectionStatus: text(row.connectionStatus),
    statusReason: text(row.statusReason)
  }
}

/**
 * The `seq` a frame carries, when it carries one.
 *
 * Upstream stamps every operation snapshot with a monotonic write counter and
 * the desktop drops any frame whose `seq` is not newer than the one it holds.
 * The VENDORED contract has not grown the field yet, so it is read off the
 * object rather than off the type — and a gateway that does not send it makes
 * this return `null`, which the caller treats as "cannot order, take it".
 */
export const seqOf = (frame: unknown): number | null => {
  const value = (frame as { seq?: unknown } | null | undefined)?.seq

  return typeof value === 'number' ? value : null
}

/** Pick one target out of an operation snapshot by the slug that was asked for. */
export const targetFor = (
  targets: readonly ConnectionOperationTarget[],
  slug: string
): ConnectionOperationTarget | null => targets.find(entry => entry.name === slug) ?? null

export interface ConnectorsControllerOptions {
  gateway: ChatGateway
  /** Hands `connect_url` to the system browser. Injected so a test can watch it. */
  openUrl: (url: string) => void | Promise<void>
  /** Overridable for tests; real code leaves both alone. */
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

export class ConnectorsController {
  private readonly wait: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly options: ConnectorsControllerOptions) {
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
  }

  /**
   * The list for one attached session.
   *
   * `available` is carried through rather than collapsed into the array,
   * because the two zero-length answers mean opposite things: no connectors
   * offered, and connectors not switched on for this bot.
   */
  async load(sessionId: string, profile?: string | null): Promise<ConnectorList> {
    const result = await this.options.gateway.request('connectors.list', {
      session_id: sessionId,
      ...(profile ? { profile } : {})
    })

    return {
      available: result.available !== false,
      connectors: (result.connectors ?? []).map(describeConnector).filter(entry => entry.slug)
    }
  }

  /**
   * Start an authorisation and follow it until that target stops moving.
   *
   * The link is opened from `targets[].connect_url`. A gateway that answers an
   * operation with no link for the slug that was asked for is a failure the
   * reader has to be told about, not something to wait out — without a URL
   * there is nothing for them to do and the poll would run to the deadline.
   *
   * `reconnect` is the account-switch path. Upstream also routes it through
   * `_reissue` when an operation is already open on the session, and refuses
   * with `LINK_STILL_VALID` unless the target is `failed` or `expired` — which
   * arrives here as a thrown error and is shown as one.
   */
  async connect(
    sessionId: string,
    slug: string,
    options: {
      profile?: string | null
      reconnect?: boolean
      /**
       * The operation this attempt opened, as soon as it has one.
       *
       * The caller needs it to {@link wake} the gateway when the reader comes
       * back from the browser, and it cannot wait for the returned promise —
       * that only resolves once the flow is already over.
       */
      onOperation?: (opId: string) => void
    } = {}
  ): Promise<ConnectOutcome> {
    const scope = {
      session_id: sessionId,
      ...(options.profile ? { profile: options.profile } : {})
    }

    const started: ConnectorsConnectResult = await this.options.gateway.request('connectors.connect', {
      ...scope,
      connectors: [slug],
      ...(options.reconnect ? { reconnect: true } : {})
    })

    options.onOperation?.(started.op_id)

    const opened = targetFor(started.targets ?? [], slug)

    // Already done before the browser was ever opened: a no-auth toolkit mints
    // `connected` straight away, and re-running the flow would be a detour
    // through a page the vendor would just bounce back.
    if (opened?.state === 'connected') {
      return { status: 'connected' }
    }

    if (!opened?.connect_url) {
      throw new Error(opened?.detail ?? 'The gateway opened an authorisation but did not say where to send you.')
    }

    await this.options.openUrl(opened.connect_url)

    return this.follow(scope, started.op_id, slug, seqOf(started))
  }

  /**
   * Re-read the operation until the target settles, the deadline passes or the
   * whole operation settles under it.
   *
   * Frames are ordered by `seq` where the gateway sends one. A snapshot older
   * than one already seen is DROPPED rather than applied: the status read and
   * the gateway's own account watcher race, and applying a stale frame would
   * walk a connected target back to `initiated`.
   */
  private async follow(
    scope: { session_id: string; profile?: string },
    opId: string,
    slug: string,
    startedSeq: number | null
  ): Promise<ConnectOutcome> {
    const deadline = this.now() + CONNECT_TIMEOUT_MS
    let seen = startedSeq

    for (;;) {
      await this.wait(CONNECT_POLL_INTERVAL_MS)

      const frame: ConnectionOperationStatus = await this.options.gateway.request('connectors.operation.status', {
        ...scope,
        op_id: opId
      })

      const seq = seqOf(frame)

      if (seq === null || seen === null || seq > seen) {
        seen = seq

        const target = targetFor(frame.targets ?? [], slug)

        if (target && SETTLED_TARGET_STATES.has(target.state)) {
          return outcomeFor(target)
        }

        /*
          The operation settled without this target settling. That happens when
          the reader answered Continue, when the deadline struck, or when the
          session went away underneath it — none of which is a failure worth a
          red line, and all of which mean nothing more is coming.
        */
        if (frame.settled) {
          return { status: 'skipped' }
        }
      }

      if (this.now() >= deadline) {
        return { status: 'expired' }
      }
    }
  }

  /**
   * Tell the gateway the browser leg is back so it reads the account now
   * rather than on its next watcher tick.
   *
   * This is a LATENCY shortcut and nothing else — upstream's own docstring says
   * the link "is not trusted for anything else". A failure is ignored on
   * purpose: `UNKNOWN_OPERATION` is exactly what a flow that already finished
   * answers, and the poll is what actually decides the outcome.
   *
   * The method is missing from the VENDORED contract — upstream registers it in
   * `methods_connectors.py` and generates it, and this repo's copy predates
   * that — so it is called through a cast rather than by regenerating a file
   * this repo vendors.
   */
  async wake(sessionId: string, opId: string, profile?: string | null): Promise<void> {
    const request = this.options.gateway.request as unknown as (
      method: string,
      params: Record<string, unknown>
    ) => Promise<unknown>

    await request('connectors.operation.wake', {
      session_id: sessionId,
      op_id: opId,
      ...(profile ? { profile } : {})
    }).catch(() => undefined)
  }
}

/** One settled target's state, as the three things the page says about it. */
const outcomeFor = (target: ConnectionOperationTarget): ConnectOutcome => {
  if (target.state === 'connected') {
    return { status: 'connected' }
  }

  if (target.state === 'expired') {
    return { status: 'expired' }
  }

  if (target.state === 'skipped') {
    return { status: 'skipped' }
  }

  // `failed` and `unavailable`. `detail` is the vendor's `error_message` where
  // there was one; the list route never carries it, so it is often absent.
  return { status: 'failed', reason: target.detail ?? target.hint ?? 'The authorisation did not finish.' }
}
