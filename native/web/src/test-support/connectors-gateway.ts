/**
 * The gateway's connector methods in memory, for the Connectors page's tests: `connectors.list`,
 * `connectors.connect` and `connectors.operation.status` / `wake`, called with an OWNER (`{type: "account"}`) and
 * nothing else naming a chat, as the gateway requires (`extra="forbid"`: a top-level `session_id` is refused).
 * An operation settles after `reads` status reads, or at once after a `wake`, and each frame carries a `seq`.
 */
import { aManageTransport } from './manage-transport'

export interface Connector {
  connector: string
  connected: boolean
  enabled: boolean
  connectionStatus: string
  statusReason: string | null
  name?: string
  description?: string
}

export const GMAIL: Connector = {
  connector: 'gmail',
  connected: true,
  enabled: true,
  connectionStatus: 'active',
  statusReason: null,
  name: 'Gmail',
  description: 'Read and send mail.'
}

export const NOTION: Connector = {
  connector: 'notion',
  connected: false,
  enabled: true,
  connectionStatus: 'not_connected',
  statusReason: null
}

export const SLACK: Connector = {
  connector: 'slack',
  connected: false,
  enabled: false,
  connectionStatus: 'failed',
  statusReason: 'the workspace revoked the token'
}

export function aConnectorsGateway(
  options: {
    connectors?: Connector[]
    unavailable?: boolean
    /** Status reads before the operation settles by itself. */
    reads?: number
    /** What a slug settles as; `connected` unless named. */
    resolvesTo?: Record<string, string>
    /** The address `connect` hands back for a target; `undefined` for the default, `null` for none. */
    connectUrl?: string | null
    /** A connector that needs no sign-in: `connect` answers it `connected` at once. */
    instant?: boolean
  } = {}
) {
  const connectors = (options.connectors ?? [GMAIL, NOTION, SLACK]).map(entry => ({ ...entry }))
  const operations = new Map<string, { reads: number; woken: boolean; slug: string; seq: number; state: string }>()
  let seq = 0

  const frame = (id: string) => {
    const op = operations.get(id)!

    return {
      op_id: id,
      deadline_at: 0,
      settled: op.state !== 'initiated',
      seq: op.seq,
      targets: [
        {
          name: op.slug,
          kind: 'connector',
          action: 'connect',
          state: op.state,
          connect_url:
            options.connectUrl === undefined
              ? `https://vendor.example.test/authorize/${op.slug}?op=${id}`
              : options.connectUrl,
          detail: op.state === 'failed' ? 'the workspace refused the grant' : null
        }
      ]
    }
  }

  const transport = aManageTransport(
    {},
    {
      'connectors.list': params => {
        if ('session_id' in params || (params.owner as { type?: string } | undefined)?.type !== 'account') {
          throw Object.assign(new Error('owner required'), { code: 4000 })
        }

        return options.unavailable ? { available: false, connectors: [] } : { available: true, connectors }
      },
      'connectors.connect': params => {
        if ('session_id' in params || (params.owner as { type?: string } | undefined)?.type !== 'account') {
          throw Object.assign(new Error('owner required'), { code: 4000 })
        }

        const slug = String((params.connectors as string[])[0])
        const id = `op-${operations.size + 1}`

        seq += 1
        operations.set(id, { reads: 0, woken: false, slug, seq, state: options.instant ? 'connected' : 'initiated' })

        return frame(id)
      },
      'connectors.operation.status': params => {
        const id = String(params.op_id)
        const op = operations.get(id)

        if (!op) {
          throw Object.assign(new Error('unknown operation'), { code: 4004 })
        }

        op.reads += 1

        if (op.state === 'initiated' && (op.woken || op.reads >= (options.reads ?? 2))) {
          op.state = options.resolvesTo?.[op.slug] ?? 'connected'

          const entry = connectors.find(row => row.connector === op.slug)

          if (entry && op.state === 'connected') {
            entry.connected = true
            entry.connectionStatus = 'active'
          }
        }

        seq += 1
        op.seq = seq

        return frame(id)
      },
      'connectors.operation.wake': params => {
        const op = operations.get(String(params.op_id))

        if (op) {
          op.woken = true
        }

        return { status: 'ok' }
      }
    }
  )

  return { ...transport, connectors, operations }
}
