/**
 * ADR-0017's app half: what a switch does, what a tap is allowed to do, and how
 * often the heartbeat beats.
 *
 * `packages/gateway-client/src/push.test.ts` pins the BYTES. This pins the
 * behaviour around them, and the four things worth pinning are the four that can
 * go wrong quietly:
 *
 *  - **The projection, end to end.** A registration only ever reaches a gateway
 *    because `snapshotFromStores` picks it up, so the test that matters is the
 *    one that asserts the app-wide section, not the one that asserts the store.
 *  - **Every removal path.** Off, revoked outside the app, signed out, changed
 *    gateway. Three of the four are easy to implement and easy to forget, and
 *    the symptom of forgetting is a device that goes on buzzing for a gateway
 *    nobody is signed in to.
 *  - **Action validation.** ADR-0017: "a notification is a hint that something
 *    happened, never an instruction". A forged Allow must open a chat and send
 *    nothing.
 *  - **Cadence.** A heartbeat is a `profiles.configure` per beat, so the two
 *    failure modes are "too rarely to suppress anything" and "a write a second".
 */
import { pushSectionFor, pushStampOf } from '@hermie/gateway-client/push'
import type { PushAddress } from '@hermie/gateway-client/push'

import { NS_A } from './support/gateway-namespace'

import {
  pushDestinationOf,
  pushTapOf,
  resolvePushTap,
  type OpenApproval,
  type PushTap
} from '../src/features/push/actions'
import type {
  PushAddressFailure,
  PushPermission,
  PushPlatform,
  PushResponse
} from '../src/features/push/platform-contract'
import { PUSH_ADDRESS_METHOD, PUSH_HEARTBEAT_MS, PushSync, type PushSyncPorts } from '../src/features/push/push-sync'
import type { RpcFailure } from '../src/gateway/rpc-failures'
import { keyValueStore } from '../src/platform/key-value-store'
import { ownRegistration, PUSH_KEY, usePushStore } from '../src/store/push'
import { snapshotFromStores, type HermieAppShape } from '../src/store/ui-meta-bridge'

const NOW_MS = 1_789_957_143_000
const NOW = pushStampOf(NOW_MS)

const TOKEN: PushAddress = { transport: 'expo', token: 'ExponentPushToken[abc]' }

interface FakePlatform extends PushPlatform {
  responses: ((response: PushResponse) => void)[]
  dropped: number
  /** How many times the System Settings pane was asked for. */
  settingsOpened: number
  permissionValue: PushPermission
  /** What the platform will hand over, or `null` with `failureValue` as its reason. */
  addressValue: PushAddress | null
  /** Why there is no address, when `addressValue` is null. */
  failureValue: PushAddressFailure
  initial: PushResponse | null
}

function fakePlatform(patch: Partial<FakePlatform> = {}): FakePlatform {
  const platform: FakePlatform = {
    available: true,
    platform: 'ios',
    needsSystemSettings: false,
    responses: [],
    dropped: 0,
    settingsOpened: 0,
    permissionValue: 'granted',
    addressValue: TOKEN,
    failureValue: { reason: 'failed', message: 'no valid aps-environment entitlement' },
    initial: null,
    openSystemSettings: async () => {
      platform.settingsOpened += 1

      return true
    },
    prepare: async () => undefined,
    permission: async () => platform.permissionValue,
    requestPermission: async () => platform.permissionValue,
    obtainAddress: async () =>
      platform.addressValue ? { address: platform.addressValue } : { address: null, failure: platform.failureValue },
    dropAddress: async () => {
      platform.dropped += 1
    },
    onResponse: handler => {
      platform.responses.push(handler)

      return () => {
        platform.responses = platform.responses.filter(entry => entry !== handler)
      }
    },
    consumeInitialResponse: async () => platform.initial,
    ...patch
  }

  return platform
}

function fakePorts(): PushSyncPorts & {
  shown: string[]
  conversations: [string, string][]
  responded: [string, string, string][]
  open: OpenApproval[]
  switched: [string, string, string][]
  /** What `canonicalSessionIds` answers; empty stages a roster not read yet. */
  canonical: string[]
  /** What `switchToGateway` answers: true stages "this named another gateway". */
  switches: boolean
} {
  const ports = {
    shown: [] as string[],
    conversations: [] as [string, string][],
    responded: [] as [string, string, string][],
    open: [] as OpenApproval[],
    switched: [] as [string, string, string][],
    canonical: [] as string[],
    switches: false,
    showChat: async (bot: string) => {
      ports.shown.push(bot)
    },
    showConversation: async (bot: string, sessionId: string) => {
      ports.conversations.push([bot, sessionId])
    },
    canonicalSessionIds: () => ports.canonical,
    openApprovals: async () => ports.open,
    respondApproval: async (bot: string, requestId: string, choice: string) => {
      ports.responded.push([bot, requestId, choice])
    },
    switchToGateway: async (key: string, bot: string, sessionId: string) => {
      ports.switched.push([key, bot, sessionId])

      return ports.switches
    }
  }

  return ports
}

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

const syncFor = (platform: PushPlatform, ports: PushSyncPorts) =>
  new PushSync({ platform, ports, namespace: NS_A, projectId: 'project', now: () => NOW_MS })

beforeEach(async () => {
  usePushStore.getState().reset()
  await keyValueStore.delete(NS_A.key(PUSH_KEY))
})

describe('the switch', () => {
  it('registers nothing until it is turned on', async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    const app = snapshotFromStores(NOW_MS).app as HermieAppShape

    expect(app.push).toBeUndefined()
    // The dialog is what turning the switch on does. A settings screen that
    // opens one on mount is a settings screen people say no to, once, for ever.
    expect(usePushStore.getState().address).toBeNull()

    sync.stop()
  })

  it('puts this device’s row in the app-wide section once it is on', async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    expect(await sync.enable()).toBe('enabled')

    const state = usePushStore.getState()
    const app = snapshotFromStores(NOW_MS).app as HermieAppShape
    const row = app.push?.registrations[state.installationId] as Record<string, unknown>

    expect(row).toMatchObject({ v: 1, transport: 'expo', token: 'ExponentPushToken[abc]', platform: 'ios' })
    expect(row.updatedAt).toBe(NOW)
    // The payload says who, not what, until somebody says otherwise.
    expect(row.preview).toBe(false)

    sync.stop()
  })

  it('says denied rather than pretending, when the reader refuses', async () => {
    const platform = fakePlatform({ permissionValue: 'denied' })
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    expect(await sync.enable()).toBe('denied')
    expect(usePushStore.getState().enabled).toBe(false)
    expect((snapshotFromStores(NOW_MS).app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('stays on with no row when the platform gives no address', async () => {
    // Permission granted, no token: a simulator with no APNs registration, or a
    // build with no EAS project. The reader asked and the platform has not
    // agreed yet, which is what the switch should show.
    const platform = fakePlatform({ addressValue: null })
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    expect(await sync.enable()).toBe('unavailable')
    expect(usePushStore.getState().enabled).toBe(true)
    expect((snapshotFromStores(NOW_MS).app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  /**
   * The report: `hermie-app.push` on the owner's gateway had a live heartbeat
   * and `registrations: {}`.
   *
   * The app had been switched on and had never obtained a token, and there was
   * nothing on screen or in the ring to say so — `obtainAddress` answered `null`
   * for five unrelated reasons and `enable` turned all of them into
   * `'unavailable'`. These pin the two places a refusal now has to land.
   */
  describe('a refused address says which refusal it was', () => {
    it('keeps the reason in the store, where Settings reads it', async () => {
      const platform = fakePlatform({
        addressValue: null,
        failureValue: { reason: 'failed', message: 'no valid aps-environment entitlement' }
      })
      const sync = syncFor(platform, fakePorts())

      sync.start()
      await settled()
      await sync.enable()

      expect(usePushStore.getState().addressFailure).toEqual({
        reason: 'failed',
        message: 'no valid aps-environment entitlement'
      })

      sync.stop()
    })

    it('puts it in the failure ring, so it outlives the screen', async () => {
      const ring: RpcFailure[] = []
      const platform = fakePlatform({ addressValue: null, failureValue: { reason: 'no-project-id' } })
      const sync = new PushSync({
        platform,
        namespace: NS_A,
        ports: fakePorts(),
        projectId: null,
        now: () => NOW_MS,
        onFailure: failure => ring.push(failure)
      })

      sync.start()
      await settled()
      await sync.enable()

      expect(ring).toEqual([{ at: NOW_MS, method: PUSH_ADDRESS_METHOD, message: 'no EAS project id in this build' }])

      sync.stop()
    })

    it('survives a platform that throws instead of answering', async () => {
      // A platform that rejects out of `obtainAddress` is the same outcome with
      // worse manners, and it must not take `enable` down with it.
      const ring: RpcFailure[] = []
      const platform = fakePlatform({
        obtainAddress: async () => {
          throw new Error('the notifications module is not linked')
        }
      })
      const sync = new PushSync({
        platform,
        namespace: NS_A,
        ports: fakePorts(),
        projectId: 'project',
        now: () => NOW_MS,
        onFailure: failure => ring.push(failure)
      })

      sync.start()
      await settled()

      expect(await sync.enable()).toBe('unavailable')
      expect(usePushStore.getState().addressFailure).toEqual({
        reason: 'failed',
        message: 'the notifications module is not linked'
      })
      expect(ring[0]?.message).toBe('the notifications module is not linked')

      sync.stop()
    })

    it('clears the reason and registers when Retry finds a platform that will', async () => {
      const platform = fakePlatform({ addressValue: null })
      const sync = syncFor(platform, fakePorts())

      sync.start()
      await settled()
      await sync.enable()

      expect(usePushStore.getState().addressFailure).not.toBeNull()

      platform.addressValue = TOKEN

      expect(await sync.retry()).toBe('enabled')
      expect(usePushStore.getState().addressFailure).toBeNull()
      expect((snapshotFromStores(NOW_MS).app as HermieAppShape).push?.registrations).not.toEqual({})

      sync.stop()
    })

    it('forgets the reason when the switch goes off', async () => {
      const platform = fakePlatform({ addressValue: null })
      const sync = syncFor(platform, fakePorts())

      sync.start()
      await settled()
      await sync.enable()
      await sync.disable()

      expect(usePushStore.getState().addressFailure).toBeNull()

      sync.stop()
    })
  })

  it('carries the other devices’ rows through its own write', async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()
    usePushStore.getState().applyRemote({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 'theirs' } },
      seen: { 'i-tablet': { bot: 'writer', at: NOW - 10 } }
    })
    await sync.enable()

    const app = snapshotFromStores(NOW_MS).app as HermieAppShape

    expect(app.push?.registrations['i-tablet']).toEqual({ v: 1, transport: 'expo', token: 'theirs' })
    expect(app.push?.seen['i-tablet']).toBe(NOW - 10)

    sync.stop()
  })
})

describe('every way a registration goes away', () => {
  const enabled = async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()
    await sync.enable()

    return { platform, sync }
  }

  const rowCount = (): number =>
    Object.keys(((snapshotFromStores(NOW_MS).app as HermieAppShape).push?.registrations ?? {}) as object).length

  it('removes the row when the switch goes off', async () => {
    const { sync } = await enabled()

    expect(rowCount()).toBe(1)
    await sync.disable()

    expect((snapshotFromStores(NOW_MS).app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('removes it when permission was revoked outside the app', async () => {
    const { platform, sync } = await enabled()

    // The reader turned Hermie off in system settings while the app was away.
    // A switch that still says ON is the one lie a settings screen must not
    // tell, so the foreground pass follows the system rather than arguing.
    platform.permissionValue = 'denied'
    await sync.refresh()

    expect(usePushStore.getState().enabled).toBe(false)
    expect((snapshotFromStores(NOW_MS).app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('removes it on retire, and keeps the installation id for the next sign-in', async () => {
    const { platform, sync } = await enabled()
    const id = usePushStore.getState().installationId

    await sync.retire()

    expect((snapshotFromStores(NOW_MS).app as HermieAppShape).push).toBeUndefined()
    expect(usePushStore.getState().installationId).toBe(id)
    expect(platform.dropped).toBe(1)

    sync.stop()
  })

  it('keeps the neighbours’ rows on retire, because the last write still carries them', async () => {
    const { sync } = await enabled()

    usePushStore.getState().applyRemote({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 'theirs' } },
      seen: { 'i-tablet': { bot: 'writer', at: NOW } }
    })

    await sync.retire()

    /*
      This used to clear them, and the reasoning was that they belong to the
      gateway being left. True, and the write that removes THIS device's row
      goes to that same gateway while the socket is still up — so a store that
      had already forgotten them would send a section with nobody in it and
      unregister every other device on it. That is how a Mac's registration
      disappeared from the owner's gateway.

      Ours goes; theirs stays. They are dropped when the connection does, in
      `ChatRuntime`, which is the first moment nothing is going to write them.
    */
    const section = (snapshotFromStores(NOW_MS).app as HermieAppShape).push

    expect(Object.keys(section?.registrations ?? {})).toEqual(['i-tablet'])
    // A bare number, because this gateway's plugin has not said it can read the
    // `{bot, at}` shape — see `PushSectionShape.seen`.
    expect(section?.seen).toEqual({ 'i-tablet': NOW })

    sync.stop()
  })

  it('re-stamps rather than re-registering when the token has not changed', async () => {
    const { sync } = await enabled()
    const before = usePushStore.getState().updatedAt

    await sync.refresh()

    expect(usePushStore.getState().updatedAt).toBe(before)
    expect(rowCount()).toBe(1)

    sync.stop()
  })

  it('rewrites the row on the refresh every foreground makes, so a new type reaches the notifier', async () => {
    /*
      A device that upgrades into a type has already adopted it on hydrate —
      `adoptedPushTypes`, pinned in `packages/gateway-client/src/push.test.ts`
      — but the notifier only learns about it when the ROW is written again.
      That write is this refresh, which is why nothing has to be touched in
      Settings for an upgrade to take effect.
    */
    const { sync } = await enabled()

    usePushStore.getState().setType('cron_failed', false)
    await sync.refresh()

    const state = usePushStore.getState()
    const app = snapshotFromStores(NOW_MS).app as HermieAppShape
    const row = app.push?.registrations[state.installationId] as { types: Record<string, boolean> }

    expect(row.types.cron_failed).toBe(false)

    usePushStore.getState().setType('cron_failed', true)
    await sync.refresh()

    const after = (snapshotFromStores(NOW_MS).app as HermieAppShape).push?.registrations[state.installationId] as {
      types: Record<string, boolean>
    }

    expect(after.types.cron_failed).toBe(true)

    sync.stop()
  })
})

describe('the heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const started = () => {
    const sync = new PushSync({
      platform: fakePlatform(),
      ports: fakePorts(),
      namespace: NS_A,
      now: () => NOW_MS,
      heartbeatMs: 1_000
    })

    sync.start()

    return sync
  }

  it('beats immediately when a chat comes on screen', () => {
    const sync = started()

    void usePushStore.getState().hydrate(NS_A)
    jest.advanceTimersByTime(0)

    sync.setOpenChat('researcher')

    const id = usePushStore.getState().installationId

    expect(usePushStore.getState().seen[id]?.at).toBe(NOW)

    sync.stop()
  })

  it('does not beat with no chat open, or in the background', () => {
    const sync = started()

    jest.advanceTimersByTime(10_000)
    expect(Object.keys(usePushStore.getState().seen)).toHaveLength(0)

    sync.setForeground(false)
    sync.setOpenChat('researcher')
    jest.advanceTimersByTime(10_000)

    // A window behind another window is not somebody reading a chat.
    expect(Object.keys(usePushStore.getState().seen)).toHaveLength(0)

    sync.stop()
  })

  it('beats on the cadence and no faster', () => {
    const sync = started()
    const beats: number[] = []
    const unsubscribe = usePushStore.subscribe(state => beats.push(Object.keys(state.seen).length))

    void usePushStore.getState().hydrate(NS_A)
    jest.advanceTimersByTime(0)
    sync.setOpenChat('researcher')

    const after = beats.length

    jest.advanceTimersByTime(3_500)

    // Three periods in 3.5 seconds, and not one per timer tick.
    expect(beats.length - after).toBe(3)

    unsubscribe()
    sync.stop()
  })

  it('stops when the chat closes and starts again when one opens', () => {
    const sync = started()

    void usePushStore.getState().hydrate(NS_A)
    jest.advanceTimersByTime(0)

    sync.setOpenChat('researcher')
    sync.setOpenChat(null)

    const quiet = usePushStore.getState().seen

    jest.advanceTimersByTime(5_000)
    expect(usePushStore.getState().seen).toBe(quiet)

    sync.setOpenChat('writer')
    expect(usePushStore.getState().seen).not.toBe(quiet)

    sync.stop()
  })

  it('beats once the store has hydrated, for a chat that opened before it did', async () => {
    // The launch-straight-onto-a-chat case, measured on a simulator on
    // 2026-09-21: the registration reached the gateway and `seen` stayed empty
    // for a full period, because the first beat had no installation id to key
    // itself by and nothing asked again until the interval came round.
    jest.useRealTimers()

    const sync = new PushSync({ platform: fakePlatform(), ports: fakePorts(), namespace: NS_A, now: () => NOW_MS })

    sync.setOpenChat('researcher')
    sync.start()

    expect(Object.keys(usePushStore.getState().seen)).toHaveLength(0)

    await settled()

    const id = usePushStore.getState().installationId

    expect(usePushStore.getState().seen[id]?.at).toBe(NOW)

    sync.stop()
    jest.useFakeTimers()
  })

  it('has a default cadence measured in tens of seconds, not seconds', () => {
    // A write a second from a device somebody is reading on would be a
    // `profiles.configure` a second. The daemon's suppression window is much
    // wider than this, so the freshness is free.
    expect(PUSH_HEARTBEAT_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('what a tap may do', () => {
  const response = (data: Record<string, unknown>, actionIdentifier = 'default'): PushResponse => ({
    actionIdentifier,
    data
  })

  it('reads a bot out of a payload and nothing else', () => {
    // Every other field is EMPTY rather than absent, which is what makes the
    // tap a total value: nothing downstream has to distinguish "not said" from
    // "said nothing", and the destination table reads one shape.
    expect(pushTapOf(response({ bot: 'researcher', type: 'message' }))).toEqual({
      bot: 'researcher',
      requestId: '',
      action: 'open',
      gatewayKey: '',
      sessionId: '',
      sessionKind: ''
    })
    expect(pushTapOf(response({ type: 'message' }))).toBeNull()
  })

  it('degrades an Allow that names no request to opening the chat', () => {
    expect(pushTapOf(response({ bot: 'researcher' }, 'allow'))).toEqual({
      bot: 'researcher',
      requestId: '',
      action: 'open',
      gatewayKey: '',
      sessionId: '',
      sessionKind: ''
    })
  })

  it('answers only a request the gateway still says is open', () => {
    const tap = { bot: 'researcher', requestId: 'req-1', action: 'allow' as const, gatewayKey: '' }
    const open: OpenApproval[] = [{ request_id: 'req-1', choices: ['once', 'session', 'always', 'deny'] }]

    expect(resolvePushTap({ tap, pending: open })).toEqual({
      kind: 'respond',
      bot: 'researcher',
      requestId: 'req-1',
      choice: 'once'
    })
  })

  it('never widens the grant beyond this one run', () => {
    // A button on a lock screen is the least considered decision of the day.
    // `session` and `always` are on the sheet, where the command is in front of
    // the reader, and nowhere else.
    const tap = { bot: 'researcher', requestId: 'req-1', action: 'allow' as const, gatewayKey: '' }
    const open: OpenApproval[] = [{ request_id: 'req-1', choices: ['session', 'always'] }]

    expect(resolvePushTap({ tap, pending: open })).toEqual({ kind: 'open-chat', bot: 'researcher' })
  })

  it('opens the chat when the request has already been answered elsewhere', () => {
    const tap = { bot: 'researcher', requestId: 'req-1', action: 'deny' as const }

    expect(resolvePushTap({ tap, pending: [] })).toEqual({ kind: 'open-chat', bot: 'researcher' })
  })

  it('opens the chat for a request id the payload made up', () => {
    const tap = { bot: 'researcher', requestId: 'req-forged', action: 'allow' as const }
    const open: OpenApproval[] = [{ request_id: 'req-real', choices: ['once', 'deny'] }]

    expect(resolvePushTap({ tap, pending: open })).toEqual({ kind: 'open-chat', bot: 'researcher' })
  })
})

describe('which conversation a tap opens', () => {
  const tapFor = (patch: Partial<PushTap> = {}): PushTap => ({
    bot: 'researcher',
    requestId: '',
    action: 'open',
    gatewayKey: '',
    sessionId: '',
    sessionKind: '',
    ...patch
  })

  const CANONICAL = ['stored-r', 'live-r']

  /*
    The whole table, and every row of it that is not "open that conversation"
    lands on the CHAT — which is the screen this app can always say something
    true on. A notification is a hint; nothing here is allowed to turn an
    unreadable field into a destination.
  */
  const table: [string, Partial<PushTap>, readonly string[], ReturnType<typeof pushDestinationOf>][] = [
    ['the notifier said canonical', { sessionId: 'branch-7', sessionKind: 'canonical' }, CANONICAL, { kind: 'chat' }],
    [
      'the notifier said branch',
      { sessionId: 'branch-7', sessionKind: 'branch' },
      CANONICAL,
      { kind: 'conversation', sessionId: 'branch-7' }
    ],
    [
      'the notifier said other',
      { sessionId: 'past-2', sessionKind: 'other' },
      CANONICAL,
      { kind: 'conversation', sessionId: 'past-2' }
    ],
    // The notifier's word wins over the id: it read the session's own title,
    // and this app second-guessing that is how a tap lands on the wrong screen.
    [
      'the notifier said branch about an id we think is canonical',
      { sessionId: 'stored-r', sessionKind: 'branch' },
      CANONICAL,
      { kind: 'conversation', sessionId: 'stored-r' }
    ],
    ['no kind, the stored canonical id', { sessionId: 'stored-r' }, CANONICAL, { kind: 'chat' }],
    // The stored id and the resolved id are different strings for one
    // conversation, and a notifier may carry either.
    ['no kind, the resolved canonical id', { sessionId: 'live-r' }, CANONICAL, { kind: 'chat' }],
    [
      'no kind, an id that is neither',
      { sessionId: 'branch-7' },
      CANONICAL,
      { kind: 'conversation', sessionId: 'branch-7' }
    ],
    // A cold start from a notification: the roster has not been read, so there
    // is nothing to compare against and nothing to conclude.
    ['no kind, nothing to compare against', { sessionId: 'branch-7' }, [], { kind: 'chat' }],
    ['no session at all', {}, CANONICAL, { kind: 'chat' }],
    [
      'a kind this build does not know',
      { sessionId: 'x-1', sessionKind: 'martian' as never },
      CANONICAL,
      {
        kind: 'conversation',
        sessionId: 'x-1'
      }
    ]
  ]

  it.each(table)('%s', (_name, patch, canonicalIds, expected) => {
    expect(pushDestinationOf({ tap: tapFor(patch), canonicalIds })).toEqual(expected)
  })

  it('reads both spellings of the session off a payload', () => {
    // `sessionId` is the plugin's; `session` is what Hermie Web's own daemon
    // has always written. A payload from the older notifier is not a payload
    // with no session in it.
    expect(pushTapOf({ actionIdentifier: 'default', data: { bot: 'researcher', sessionId: 'a' } })?.sessionId).toBe('a')
    expect(pushTapOf({ actionIdentifier: 'default', data: { bot: 'researcher', session: 'b' } })?.sessionId).toBe('b')
  })

  it('reads a kind it does not recognise as no kind at all', () => {
    const tap = pushTapOf({
      actionIdentifier: 'default',
      data: { bot: 'researcher', sessionId: 'a', sessionKind: 'past' }
    })

    // `past` is the APP's word for a retired conversation and not the
    // gateway's. An unreadable kind falls through to the id comparison rather
    // than to a guess.
    expect(tap?.sessionKind).toBe('')
  })
})

describe('a tap, end to end', () => {
  it('opens the conversation and answers nothing, for a branch', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()
    const sync = syncFor(platform, ports)

    ports.open = [{ request_id: 'req-1', choices: ['once', 'deny'] }]
    sync.start()
    await settled()

    platform.responses[0]?.({
      actionIdentifier: 'allow',
      data: { bot: 'researcher', type: 'request', requestId: 'req-1', sessionId: 'branch-7', sessionKind: 'branch' }
    })
    await settled()

    expect(ports.conversations).toEqual([['researcher', 'branch-7']])
    /*
      The chat is NOT opened and the Allow is not sent. An Allow has to be
      re-validated against `approval.pending` for the session that asked, and
      that is not the session this controller resumed — answering the canonical
      chat's oldest open request would be answering a different question than
      the one on the lock screen.
    */
    expect(ports.shown).toEqual([])
    expect(ports.responded).toEqual([])

    sync.stop()
  })

  it('opens the chat for a payload that names the canonical session', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()
    const sync = syncFor(platform, ports)

    ports.canonical = ['stored-r']
    sync.start()
    await settled()

    platform.responses[0]?.({
      actionIdentifier: 'default',
      data: { bot: 'researcher', type: 'message', sessionId: 'stored-r' }
    })
    await settled()

    expect(ports.shown).toEqual(['researcher'])
    expect(ports.conversations).toEqual([])

    sync.stop()
  })

  it('opens the chat and sends nothing for a plain notification', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()
    const sync = syncFor(platform, ports)

    sync.start()
    await settled()

    platform.responses[0]?.({ actionIdentifier: 'default', data: { bot: 'researcher', type: 'message' } })
    await settled()

    expect(ports.shown).toEqual(['researcher'])
    expect(ports.responded).toEqual([])

    sync.stop()
  })

  it('opens the chat FIRST, then answers, for an Allow', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()

    ports.open = [{ request_id: 'req-1', choices: ['once', 'deny'] }]

    const sync = syncFor(platform, ports)

    sync.start()
    await settled()

    platform.responses[0]?.({
      actionIdentifier: 'allow',
      data: { bot: 'researcher', type: 'request', requestId: 'req-1' }
    })
    await settled()

    // The chat has to be resumed before `approval.pending` has a session to ask
    // about, so the order is load-bearing rather than cosmetic.
    expect(ports.shown).toEqual(['researcher'])
    expect(ports.responded).toEqual([['researcher', 'req-1', 'once']])

    sync.stop()
  })

  it('sends nothing for a forged Allow, and still opens the chat', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()
    const sync = syncFor(platform, ports)

    sync.start()
    await settled()

    platform.responses[0]?.({
      actionIdentifier: 'allow',
      data: { bot: 'researcher', type: 'request', requestId: 'rm -rf /' }
    })
    await settled()

    expect(ports.shown).toEqual(['researcher'])
    expect(ports.responded).toEqual([])

    sync.stop()
  })

  it('acts on the notification that started the process, once', async () => {
    const platform = fakePlatform({ initial: { actionIdentifier: 'default', data: { bot: 'writer' } } })
    const ports = fakePorts()
    const first = syncFor(platform, ports)

    first.start()
    await settled()
    first.stop()

    // `consumeInitialResponse` answering the same launch tap twice is what would
    // reopen that chat on every remount; the platform consumes it, so a second
    // sync sees nothing.
    platform.initial = null

    const second = syncFor(platform, ports)

    second.start()
    await settled()
    second.stop()

    expect(ports.shown).toEqual(['writer'])
  })
})

describe('the row the store builds', () => {
  it('is null until the store has been hydrated', () => {
    const state = { ...usePushStore.getState(), enabled: true, address: TOKEN, loaded: false }

    // Before hydrate there is no installation id, and a row keyed by an empty
    // string is a row the daemon drops.
    expect(ownRegistration(state, 'ios')).toBeNull()
  })

  it('round-trips the reader’s preferences and omits nothing the daemon reads', async () => {
    await usePushStore.getState().hydrate(NS_A)
    usePushStore.getState().setEnabled(true)
    usePushStore.getState().setType('cron', false)
    usePushStore.getState().setPreview(true)
    usePushStore.getState().setAddress(TOKEN, NOW)

    const own = ownRegistration(usePushStore.getState(), 'android')
    const section = pushSectionFor({ others: {}, own, seen: {}, now: NOW })
    const row = section?.registrations[usePushStore.getState().installationId] as Record<string, unknown>

    expect(row).toMatchObject({ platform: 'android', preview: true })
    // Every type the reader did not turn off. A switch that has just been moved
    // to ON gets all of them, because the notifier only ever sends what the
    // gateway can actually produce — see `DEFAULT_PUSH_TYPES`.
    expect(row.types).toEqual({
      message: true,
      request: true,
      cron: false,
      cron_done: true,
      cron_failed: true,
      turn_done: true,
      turn_failed: true
    })
  })
})
