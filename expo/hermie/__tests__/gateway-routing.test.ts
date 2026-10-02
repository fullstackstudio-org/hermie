/**
 * A notification, a link and a widget all have to say WHICH gateway.
 *
 * The app keys its storage by a random local id, which means nothing outside
 * the device. What travels instead is `gatewayKeyOf` the gateway's origin — a
 * string the notifier and the app arrive at independently — and everything in
 * this file is about the one rule that makes that safe: a key SELECTS a gateway
 * the owner has already configured, and a key that selects nothing leaves the
 * app exactly where it is.
 */
import { gatewayKeyOf } from '@hermie/gateway-client'

import { pushTapOf } from '../src/features/push/actions'
import type { PushResponse } from '../src/features/push/platform-contract'
import { PushSync, type PushSyncPorts } from '../src/features/push/push-sync'
import { projectWidgetSnapshot, sameWidgetContent } from '../src/features/widgets/snapshot'
import { addGateway, EMPTY_REGISTRY, gatewayForKey, type GatewayRecord } from '../src/gateway/registry'
import { parseHermieLink } from '../src/platform/deep-link'
import { NS_A } from './support/gateway-namespace'

const HOME = 'https://home.example.com:8443'
const WORK = 'https://work.example.com'
const HOME_KEY = gatewayKeyOf(HOME)
const WORK_KEY = gatewayKeyOf(WORK)

const entry = (id: string, address: string, addedAt: number): GatewayRecord => ({
  id,
  name: address,
  address,
  authKind: 'native_pkce',
  addedAt
})

const registry = addGateway(
  addGateway(EMPTY_REGISTRY, entry('gaaaaaaaaaaaaaaaa', HOME, 1)),
  entry('gbbbbbbbbbbbbbbbb', WORK, 2)
)

describe('finding a gateway by the key on the wire', () => {
  it('finds the one whose address the key was made from', () => {
    expect(gatewayForKey(registry, HOME_KEY)?.address).toBe(HOME)
    expect(gatewayForKey(registry, WORK_KEY)?.address).toBe(WORK)
  })

  it('finds nothing for a key this device has never configured', () => {
    // The whole safety property: a forged or stale key selects a gateway the
    // owner already set up, or nothing at all. It can never name a new one.
    expect(gatewayForKey(registry, gatewayKeyOf('https://stranger.example.com'))).toBeNull()
    expect(gatewayForKey(registry, '')).toBeNull()
  })
})

describe('a link that names a gateway', () => {
  it('carries the key through', () => {
    expect(parseHermieLink(`hermie://chat/researcher?gateway=${HOME_KEY}`)).toEqual({
      kind: 'chat',
      bot: 'researcher',
      gatewayKey: HOME_KEY
    })
  })

  it('drops a key that is not the shape this project produces', () => {
    // Not an error and not a refusal: the link still opens the chat, on the
    // gateway the reader is already on. A parameter nothing can resolve has
    // to read as an absent one.
    expect(parseHermieLink('hermie://chat/researcher?gateway=../../etc/passwd')?.gatewayKey).toBe('')
    expect(parseHermieLink('hermie://chat/researcher?gateway=')?.gatewayKey).toBe('')
  })

  it('ignores every other parameter, and a fragment', () => {
    expect(parseHermieLink(`hermie://chat/researcher?from=widget&gateway=${WORK_KEY}#top`)).toEqual({
      kind: 'chat',
      bot: 'researcher',
      gatewayKey: WORK_KEY
    })
  })

  it('still refuses everything the grammar always refused', () => {
    expect(parseHermieLink(`hermie://settings?gateway=${HOME_KEY}`)).toBeNull()
    expect(parseHermieLink(`hermie://chat/a/b?gateway=${HOME_KEY}`)).toBeNull()
  })
})

describe('a notification that names a gateway', () => {
  const response = (data: Record<string, unknown>): PushResponse => ({ actionIdentifier: 'default', data })

  it('carries the key through', () => {
    expect(pushTapOf(response({ bot: 'researcher', gatewayKey: WORK_KEY }))?.gatewayKey).toBe(WORK_KEY)
  })

  it('reads a key it cannot have produced as no key', () => {
    expect(pushTapOf(response({ bot: 'researcher', gatewayKey: 'not-a-key' }))?.gatewayKey).toBe('')
    expect(pushTapOf(response({ bot: 'researcher', gatewayKey: 42 }))?.gatewayKey).toBe('')
    expect(pushTapOf(response({ bot: 'researcher' }))?.gatewayKey).toBe('')
  })
})

describe('tapping a notification from another gateway', () => {
  const platform = {
    available: false,
    platform: 'ios',
    needsSystemSettings: false,
    openSystemSettings: async () => false,
    prepare: async () => undefined,
    permission: async () => 'granted' as const,
    requestPermission: async () => 'granted' as const,
    obtainAddress: async () => ({ address: null, failure: { reason: 'empty' as const } }),
    dropAddress: async () => undefined,
    onResponse: () => () => undefined,
    consumeInitialResponse: async () => null
  }

  function portsThat(switches: boolean, canonical: readonly string[] = []) {
    const calls = {
      switched: [] as [string, string][],
      switchedTo: [] as string[],
      shown: [] as string[],
      conversations: [] as [string, string][],
      responded: [] as string[]
    }
    const ports: PushSyncPorts = {
      showChat: async bot => {
        calls.shown.push(bot)
      },
      showConversation: async (bot, sessionId) => {
        calls.conversations.push([bot, sessionId])
      },
      canonicalSessionIds: () => canonical,
      openApprovals: async () => [{ request_id: 'req-1', choices: ['once', 'deny'] }],
      respondApproval: async (_bot, requestId) => {
        calls.responded.push(requestId)
      },
      switchToGateway: async (key, bot, sessionId) => {
        calls.switched.push([key, bot])
        calls.switchedTo.push(sessionId)

        return switches
      }
    }

    return { calls, ports }
  }

  /** Drive one tap through a sync, without a platform behind it. */
  const tap = async (ports: PushSyncPorts, data: Record<string, unknown>, action = 'default') => {
    const sync = new PushSync({ platform, ports, namespace: NS_A })
    // `onResponse` is private on purpose; this is the seam the platform uses.
    await (sync as unknown as { handle: (response: PushResponse) => Promise<void> }).handle({
      actionIdentifier: action,
      data
    })
  }

  it('switches, and stops there', async () => {
    const { calls, ports } = portsThat(true)

    await tap(ports, { bot: 'researcher', gatewayKey: WORK_KEY, requestId: 'req-1' }, 'allow')

    expect(calls.switched).toEqual([[WORK_KEY, 'researcher']])
    // Nothing else ran. An Allow cannot be validated against a gateway whose
    // connection does not exist yet, so the reader lands on the request and
    // answers it there — ADR-0017's own rule, one step further along.
    expect(calls.shown).toEqual([])
    expect(calls.responded).toEqual([])
  })

  it('carries a conversation the notifier itself classified across the switch', async () => {
    const { calls, ports } = portsThat(true)

    await tap(ports, {
      bot: 'researcher',
      gatewayKey: WORK_KEY,
      sessionId: 'branch-7',
      sessionKind: 'branch'
    })

    expect(calls.switched).toEqual([[WORK_KEY, 'researcher']])
    expect(calls.switchedTo).toEqual(['branch-7'])
  })

  it('carries no conversation across a switch when only an id was named', async () => {
    /*
      An id with no kind can only be placed against a roster — and the roster
      this side holds belongs to the gateway being left. Sending it anyway
      would open some other gateway's conversation because THIS one's canonical
      id happened to differ, which is the wrong screen for a reason nobody
      could see.
    */
    const { calls, ports } = portsThat(true, ['stored-home'])

    await tap(ports, { bot: 'researcher', gatewayKey: WORK_KEY, sessionId: 'sess-work' })

    expect(calls.switchedTo).toEqual([''])
    expect(calls.conversations).toEqual([])
  })

  it('is an ordinary tap when the key names the gateway that is already live', async () => {
    const { calls, ports } = portsThat(false)

    await tap(ports, { bot: 'researcher', gatewayKey: HOME_KEY, requestId: 'req-1' }, 'allow')

    expect(calls.switched).toEqual([[HOME_KEY, 'researcher']])
    expect(calls.shown).toEqual(['researcher'])
    expect(calls.responded).toEqual(['req-1'])
  })

  it('is an ordinary tap when the payload carried no key at all', async () => {
    const { calls, ports } = portsThat(false)

    await tap(ports, { bot: 'researcher' })

    expect(calls.switched).toEqual([['', 'researcher']])
    expect(calls.shown).toEqual(['researcher'])
  })
})

describe('the widget file', () => {
  const input = {
    bots: [],
    nameOrder: 'display-first' as const,
    chats: {},
    running: {},
    lastSeen: {},
    accents: {},
    archived: {},
    mutes: {},
    gatewayReady: true,
    avatars: {},
    // No folders: this suite is about the key, and an empty arrangement is the
    // sharpest case for it — two gateways whose rosters are identical.
    folders: [],
    now: 1_700_000_000_000
  }

  it('names the gateway whose bots it describes', () => {
    expect(projectWidgetSnapshot({ ...input, gatewayAddress: HOME }).gatewayKey).toBe(HOME_KEY)
  })

  it('names none when no gateway is configured', () => {
    expect(projectWidgetSnapshot(input).gatewayKey).toBeUndefined()
  })

  it('counts a change of gateway as a change worth writing', () => {
    const home = projectWidgetSnapshot({ ...input, gatewayAddress: HOME })
    const work = projectWidgetSnapshot({ ...input, gatewayAddress: WORK })

    // Two gateways with the same (here, empty) roster draw the same rows. If
    // the key did not join the comparison the file would keep the previous
    // gateway's, and every tap would land on the wrong machine.
    expect(sameWidgetContent(home, work)).toBe(false)
    expect(sameWidgetContent(home, projectWidgetSnapshot({ ...input, gatewayAddress: HOME }))).toBe(true)
  })
})
