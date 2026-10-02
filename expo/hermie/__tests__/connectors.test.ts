/**
 * The connector page's calls, and the four ways this corner of the gateway is
 * not shaped like the screen.
 *
 * Almost every case here exists because the obvious implementation is wrong in
 * a way that reads as working: `available: false` is a SUCCESSFUL answer that
 * means a switch is off, the authorisation link is buried per target rather
 * than returned, a stale status frame can walk a connected target backwards,
 * and the row model is open on both sides so the field the page wants is not
 * the field the type declares.
 */
import { FakeChatGateway } from './support/fake-chat-gateway'

import {
  CONNECTOR_DISCONNECT_UNAVAILABLE,
  ConnectorsController,
  describeConnector,
  seqOf,
  targetFor
} from '../src/features/connectors/connectors-controller'

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  connector: 'gmail',
  connected: false,
  enabled: true,
  connectionStatus: 'not_connected',
  ...overrides
})

const target = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'gmail',
  kind: 'connector',
  action: 'connect',
  state: 'initiated',
  connect_url: 'https://vendor.test/authorize?x=1',
  ...overrides
})

const build = (gateway: FakeChatGateway, opened: string[] = []): ConnectorsController =>
  new ConnectorsController({
    gateway,
    openUrl: url => {
      opened.push(url)
    },
    wait: async () => undefined,
    now: () => 0
  })

describe('describeConnector', () => {
  it('falls back to the slug when the vendor sent no display name', () => {
    expect(describeConnector(row() as never).label).toBe('gmail')
    expect(describeConnector(row({ name: 'Gmail' }) as never).label).toBe('Gmail')
  })

  /**
   * `statusReason` is a real key on upstream's `ConnectorListItem` that the
   * VENDORED row type never grew. Both models are open on purpose — the
   * connector service owns the key set — so it has to be read off the bag.
   */
  it('reads statusReason off the open key set the contract does not declare', () => {
    expect(describeConnector(row({ statusReason: 'token expired' }) as never).statusReason).toBe('token expired')
  })

  /**
   * A row that said nothing about `enabled` is not a row that said `false`.
   * Collapsing the two would draw "Switched off" against a connector the
   * gateway never switched off.
   */
  it('keeps "did not say" apart from "switched off"', () => {
    expect(describeConnector(row({ enabled: undefined }) as never).enabled).toBeNull()
    expect(describeConnector(row({ enabled: false }) as never).enabled).toBe(false)
  })

  it('treats anything other than a literal true as not connected', () => {
    expect(describeConnector(row({ connected: null }) as never).connected).toBe(false)
    expect(describeConnector(row({ connected: true }) as never).connected).toBe(true)
  })
})

describe('ConnectorsController.load', () => {
  it('scopes the call to the session, because the gateway authorises by attachment', async () => {
    const gateway = new FakeChatGateway().reply('connectors.list', { available: true, connectors: [row()] })

    await build(gateway).load('sess-1')

    expect(gateway.lastCall('connectors.list')).toEqual({ session_id: 'sess-1' })
  })

  /**
   * The case a controller that returned a bare array could not express. The
   * toolset being off and the account being empty are both `connectors: []`,
   * and only one of them is something the reader can fix.
   */
  it('keeps "the toolset is off" apart from "there are none"', async () => {
    const off = new FakeChatGateway().reply('connectors.list', { available: false, connectors: [] })
    const empty = new FakeChatGateway().reply('connectors.list', { available: true, connectors: [] })

    expect(await build(off).load('sess-1')).toEqual({ available: false, connectors: [] })
    expect(await build(empty).load('sess-1')).toEqual({ available: true, connectors: [] })
  })

  it('drops a row with no slug rather than drawing a connector nothing can address', async () => {
    const gateway = new FakeChatGateway().reply('connectors.list', {
      available: true,
      connectors: [row(), { connected: true }]
    })

    expect((await build(gateway).load('sess-1')).connectors).toHaveLength(1)
  })
})

describe('ConnectorsController.connect', () => {
  it('opens the link from the target rather than from the top level', async () => {
    const opened: string[] = []
    const gateway = new FakeChatGateway()
      .reply('connectors.connect', { op_id: 'op-1', deadline_at: 9, settled: false, targets: [target()] })
      .reply('connectors.operation.status', {
        op_id: 'op-1',
        deadline_at: 9,
        settled: false,
        targets: [target({ state: 'connected' })]
      })

    const outcome = await build(gateway, opened).connect('sess-1', 'gmail')

    expect(opened).toEqual(['https://vendor.test/authorize?x=1'])
    expect(outcome).toEqual({ status: 'connected' })
  })

  it('asks for exactly the connector it was given, and says so when reconnecting', async () => {
    const gateway = new FakeChatGateway()
      .reply('connectors.connect', {
        op_id: 'op-1',
        deadline_at: 9,
        settled: false,
        targets: [target({ state: 'connected' })]
      })
      .reply('connectors.operation.status', { op_id: 'op-1', deadline_at: 9, settled: true, targets: [] })

    await build(gateway).connect('sess-1', 'gmail', { reconnect: true })

    expect(gateway.lastCall('connectors.connect')).toEqual({
      session_id: 'sess-1',
      connectors: ['gmail'],
      reconnect: true
    })
  })

  /**
   * A no-auth toolkit mints `connected` before any browser is involved. Opening
   * a page the vendor would only bounce back is a worse answer than none.
   */
  it('does not open a browser for a target that came back already connected', async () => {
    const opened: string[] = []
    const gateway = new FakeChatGateway().reply('connectors.connect', {
      op_id: 'op-1',
      deadline_at: 9,
      settled: false,
      targets: [target({ state: 'connected', connect_url: null })]
    })

    expect(await build(gateway, opened).connect('sess-1', 'gmail')).toEqual({ status: 'connected' })
    expect(opened).toEqual([])
    expect(gateway.methodOrder()).toEqual(['connectors.connect'])
  })

  /**
   * Without a link there is nothing for the reader to do, so waiting out the
   * deadline would be six minutes of pretending.
   */
  it('fails immediately when the operation carries no link for that slug', async () => {
    const gateway = new FakeChatGateway().reply('connectors.connect', {
      op_id: 'op-1',
      deadline_at: 9,
      settled: false,
      targets: [target({ connect_url: null, detail: 'the vendor refused' })]
    })

    await expect(build(gateway).connect('sess-1', 'gmail')).rejects.toThrow('the vendor refused')
  })

  it('reports the vendor’s own words when a target fails', async () => {
    const gateway = new FakeChatGateway()
      .reply('connectors.connect', { op_id: 'op-1', deadline_at: 9, settled: false, targets: [target()] })
      .reply('connectors.operation.status', {
        op_id: 'op-1',
        deadline_at: 9,
        settled: false,
        targets: [target({ state: 'failed', detail: 'consent was denied' })]
      })

    expect(await build(gateway).connect('sess-1', 'gmail')).toEqual({
      status: 'failed',
      reason: 'consent was denied'
    })
  })

  /**
   * The ordering guard. The status read and the gateway's own 1 Hz account
   * watcher race, so a frame older than one already applied has to be dropped —
   * otherwise a connected target walks back to `initiated` and the flow keeps
   * polling something that has already finished.
   */
  it('drops a status frame older than one it has already seen', async () => {
    const frames = [
      { op_id: 'op-1', seq: 1, deadline_at: 9, settled: false, targets: [target({ state: 'connected' })] },
      { op_id: 'op-1', seq: 4, deadline_at: 9, settled: false, targets: [target({ state: 'initiated' })] },
      { op_id: 'op-1', seq: 5, deadline_at: 9, settled: false, targets: [target({ state: 'failed', detail: 'no' })] }
    ]
    let next = 0
    const gateway = new FakeChatGateway()
      .reply('connectors.connect', { op_id: 'op-1', seq: 3, deadline_at: 9, settled: false, targets: [target()] })
      .reply('connectors.operation.status', () => frames[next++] ?? frames[frames.length - 1])

    // seq 1 is older than the connect's seq 3, so the `connected` in it is
    // ignored and the flow settles on the genuinely newer failure.
    expect(await build(gateway).connect('sess-1', 'gmail')).toEqual({ status: 'failed', reason: 'no' })
  })

  it('takes every frame when the gateway sends no seq at all', async () => {
    const gateway = new FakeChatGateway()
      .reply('connectors.connect', { op_id: 'op-1', deadline_at: 9, settled: false, targets: [target()] })
      .reply('connectors.operation.status', {
        op_id: 'op-1',
        deadline_at: 9,
        settled: false,
        targets: [target({ state: 'connected' })]
      })

    expect(await build(gateway).connect('sess-1', 'gmail')).toEqual({ status: 'connected' })
  })

  /**
   * The operation settled with this target still moving — Continue, the
   * deadline, or the session going away. Nothing more is coming, and none of it
   * is a failure worth a red line.
   */
  it('stops when the operation settles under an unsettled target', async () => {
    const gateway = new FakeChatGateway()
      .reply('connectors.connect', { op_id: 'op-1', deadline_at: 9, settled: false, targets: [target()] })
      .reply('connectors.operation.status', {
        op_id: 'op-1',
        deadline_at: 9,
        settled: true,
        settled_by: 'continue',
        targets: [target({ state: 'initiated' })]
      })

    expect(await build(gateway).connect('sess-1', 'gmail')).toEqual({ status: 'skipped' })
  })

  it('hands the caller the operation id before the flow finishes', async () => {
    const seen: string[] = []
    const gateway = new FakeChatGateway()
      .reply('connectors.connect', { op_id: 'op-7', deadline_at: 9, settled: false, targets: [target()] })
      .reply('connectors.operation.status', {
        op_id: 'op-7',
        deadline_at: 9,
        settled: false,
        targets: [target({ state: 'connected' })]
      })

    await build(gateway).connect('sess-1', 'gmail', { onOperation: id => seen.push(id) })

    expect(seen).toEqual(['op-7'])
  })
})

describe('ConnectorsController.wake', () => {
  it('nudges the named operation so the gateway reads the account now', async () => {
    const gateway = new FakeChatGateway().reply('connectors.operation.wake', { status: 'ok' })

    await build(gateway).wake('sess-1', 'op-1')

    expect(gateway.lastCall('connectors.operation.wake')).toEqual({ session_id: 'sess-1', op_id: 'op-1' })
  })

  /**
   * `UNKNOWN_OPERATION` is exactly what a flow that already finished answers,
   * and the poll is what decides the outcome anyway. A latency shortcut that
   * could fail the whole attempt would be worse than no shortcut.
   */
  it('swallows a refusal, because it is only a shortcut', async () => {
    const gateway = new FakeChatGateway().reply('connectors.operation.wake', () => {
      throw new Error('no open operation with that op_id in this session')
    })

    await expect(build(gateway).wake('sess-1', 'op-1')).resolves.toBeUndefined()
  })
})

describe('the helpers the page leans on', () => {
  it('finds a target by the slug that was asked for', () => {
    expect(targetFor([target({ name: 'notion' }), target()] as never, 'gmail')?.name).toBe('gmail')
    expect(targetFor([] as never, 'gmail')).toBeNull()
  })

  it('reads a seq only when there is a number to read', () => {
    expect(seqOf({ seq: 3 })).toBe(3)
    expect(seqOf({})).toBeNull()
    expect(seqOf(null)).toBeNull()
  })

  /** The reasoning for the absent control, kept where somebody will find it. */
  it('records why there is no disconnect', () => {
    expect(CONNECTOR_DISCONNECT_UNAVAILABLE).toMatch(/no disconnect/iu)
  })
})
