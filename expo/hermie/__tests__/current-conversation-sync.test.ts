/**
 * Which conversation each bot is on, across somebody's devices.
 *
 * The two-position switch becomes a list of the reader's own chats, and "which
 * one is this bot on" becomes `current: Record<bot, storedId>` in ADR-0016's
 * app-wide section. Picking a row is a CHOICE: it is dated, so the device where
 * somebody last picked is the one every other device follows on its next open.
 *
 * Three things have to stay true for builds that do not know the field:
 *
 *  - `myChats` goes on being written as the projection "every bot with a
 *    `current`", because that is all an older build reads;
 *  - a section an older build wrote — `myChats` and no `current` — leaves this
 *    device's map alone (absent is not empty);
 *  - the section version stays 1, because a `v` an older build does not know
 *    makes it re-seed the whole section from its own copy.
 *
 * And, as for the folders, the app's own housekeeping is sent without being
 * dated: forgetting an id the gateway no longer lists must never outrank a
 * choice made on another device.
 */
import { HERMIE_APP_SECTION_VERSION } from '@hermie/gateway-client/ui-meta'

import { keyValueStore } from '../src/platform/key-value-store'
import { APP_STAMP_KEY, useAppStampStore } from '../src/store/app-stamp'
import { CHAT_LAYOUT_KEY, currentTargetOf, useChatLayoutStore } from '../src/store/chat-layout'
import { snapshotFromStores, type HermieAppShape } from '../src/store/ui-meta-bridge'
import {
  APP_KEY,
  GATEWAY_ID,
  holdingGateway,
  newDevice,
  NS,
  openApp,
  settled,
  type HoldingGateway
} from './support/ui-meta-devices'

const ROSTER = ['researcher', 'writer']
const NOW = Math.floor(Date.now() / 1000)
const AN_HOUR_AGO = NOW - 3600
const A_MINUTE_AGO = NOW - 60

const layout = () => useChatLayoutStore.getState()

/** What this device would send right now. */
const projected = (): HermieAppShape => snapshotFromStores().app as HermieAppShape

/** One device, connected, picking one of the reader's own chats for a bot. */
async function chooseOnline(gateway: HoldingGateway, bot: string, sessionId: string | null): Promise<void> {
  const device = openApp(gateway)

  await device.watching
  await device.bridge.reconcile()
  layout().reconcile(ROSTER)
  layout().setCurrent(bot, sessionId)
  await settled()
  device.stop()
  await settled()
}

/** A device that has already picked, at this moment, and was put away. */
async function deviceHolding(current: Record<string, string>, chosenAt: number): Promise<void> {
  await newDevice()
  await keyValueStore.setJson(CHAT_LAYOUT_KEY, {
    [GATEWAY_ID]: {
      entries: ROSTER.map(name => ({ kind: 'chat', name })),
      archived: [],
      accents: {},
      myChats: Object.keys(current),
      current
    }
  })
  await keyValueStore.setJson(NS.key(APP_STAMP_KEY), { updatedAt: chosenAt })
}

/** Open the app, reconcile, and put it away again. */
async function openAndReconcile(gateway: HoldingGateway): Promise<void> {
  const device = openApp(gateway)

  await device.watching
  await device.bridge.reconcile()
  await settled()
  device.stop()
  await settled()
}

/** Write the app-wide section the way a build that predates `current` does. */
async function olderBuildWrites(gateway: HoldingGateway, section: Record<string, unknown>): Promise<void> {
  await gateway.request('profiles.configure', { name: 'researcher', ui_meta: { [APP_KEY]: section } })
}

afterEach(async () => {
  await settled()
  await settled()
})

describe('picking a conversation, on the second device', () => {
  it('arrives on the other device on its next open', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-ideas')

    expect(gateway.app()?.current).toEqual({ researcher: 'sess-ideas' })
    // The section's version did not move for the new field; an older build
    // would treat a `v` it does not know as unreadable and re-seed over it.
    expect(gateway.app()?.v).toBe(1)
    expect(HERMIE_APP_SECTION_VERSION).toBe(1)

    gateway.dateApp(AN_HOUR_AGO)

    await newDevice()
    await openAndReconcile(gateway)

    expect(layout().current).toEqual({ researcher: 'sess-ideas' })
    expect(currentTargetOf(layout(), 'researcher')).toBe('sess-ideas')
    expect(currentTargetOf(layout(), 'writer')).toBeUndefined()
  })

  it('lets the later pick win over an earlier one, whichever device connects first', async () => {
    const gateway = holdingGateway()

    // The desktop picked a minute ago; the phone picked an hour ago and is the
    // one that connects now.
    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-desktop')
    gateway.dateApp(A_MINUTE_AGO)

    await deviceHolding({ researcher: 'sess-phone' }, AN_HOUR_AGO)
    await openAndReconcile(gateway)

    expect(layout().current).toEqual({ researcher: 'sess-desktop' })
    expect(gateway.app()?.current).toEqual({ researcher: 'sess-desktop' })

    // And the other way round: the phone's pick is the newer one.
    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-desktop')
    gateway.dateApp(AN_HOUR_AGO)

    await deviceHolding({ researcher: 'sess-phone' }, A_MINUTE_AGO)
    await openAndReconcile(gateway)

    expect(layout().current).toEqual({ researcher: 'sess-phone' })
    expect(gateway.app()?.current).toEqual({ researcher: 'sess-phone' })
  })

  it('keeps a pick made with no socket, and lands it on the next connect', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-old')
    gateway.dateApp(AN_HOUR_AGO)

    await deviceHolding({ researcher: 'sess-old' }, AN_HOUR_AGO)

    const offline = openApp({ ...gateway, request: () => Promise.reject(new Error('gateway not connected')) })

    await offline.watching
    await offline.bridge.reconcile()
    layout().setCurrent('researcher', 'sess-offline')
    await settled()
    offline.stop()

    // Dated by the pick, and the date went to disk with it.
    expect(useAppStampStore.getState().updatedAt).toBeGreaterThan(AN_HOUR_AGO)

    await openAndReconcile(gateway)

    expect(gateway.app()?.current).toEqual({ researcher: 'sess-offline' })
    expect(layout().current).toEqual({ researcher: 'sess-offline' })
  })

  it('carries a move back to the group chat, which is an entry going away', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-ideas')
    gateway.dateApp(AN_HOUR_AGO)

    await deviceHolding({ researcher: 'sess-ideas' }, AN_HOUR_AGO)
    await chooseOnline(gateway, 'researcher', null)

    // Sent as an empty map rather than omitted: absent would say "this build
    // knows nothing about it" and leave the pick standing everywhere else.
    expect(gateway.app()?.current).toEqual({})
    expect(gateway.app()?.myChats).toEqual([])

    await deviceHolding({ researcher: 'sess-ideas' }, AN_HOUR_AGO - 600)
    await openAndReconcile(gateway)

    expect(layout().current).toEqual({})
    expect(currentTargetOf(layout(), 'researcher')).toBeUndefined()
  })
})

describe('the date the section carries', () => {
  it('moves when somebody picks a conversation', async () => {
    const gateway = holdingGateway()

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()

    expect(projected().updatedAt).toBeUndefined()

    layout().setCurrent('researcher', 'sess-ideas')
    await settled()

    expect(projected().updatedAt).toBeGreaterThan(0)
    expect(projected().current).toEqual({ researcher: 'sess-ideas' })

    device.stop()
  })

  it('does not move for the roster fold or for the app correcting a stale id', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-gone')
    gateway.dateApp(AN_HOUR_AGO)

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    await settled()

    expect(useAppStampStore.getState().updatedAt).toBe(AN_HOUR_AGO)

    // The roster folding itself in, then the listing no longer holding the id
    // this device was told about: both have to be sent, neither is a choice.
    layout().reconcile([...ROSTER, 'bookkeeper'])
    layout().setCurrent('researcher', null, { chore: true })
    await settled()

    expect(useAppStampStore.getState().updatedAt).toBe(AN_HOUR_AGO)
    expect(gateway.app()?.updatedAt).toBe(AN_HOUR_AGO)
    expect(gateway.app()?.current).toEqual({})

    // A legacy entry resolved to the id it names is the app's doing too.
    layout().setCurrent('writer', 'sess-found', { chore: true })
    await settled()

    expect(useAppStampStore.getState().updatedAt).toBe(AN_HOUR_AGO)
    expect(gateway.app()?.current).toEqual({ writer: 'sess-found' })

    // And the reader picking one in the next breath is dated like any other.
    layout().setCurrent('writer', 'sess-picked')
    await settled()

    expect(useAppStampStore.getState().updatedAt).toBeGreaterThan(AN_HOUR_AGO)

    device.stop()
  })

  it('does not move when the reader picks the conversation the bot is already on', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-ideas')
    gateway.dateApp(AN_HOUR_AGO)

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    await settled()
    layout().setCurrent('researcher', 'sess-ideas')
    layout().setCurrent('writer', null)
    await settled()

    expect(useAppStampStore.getState().updatedAt).toBe(AN_HOUR_AGO)

    device.stop()
  })
})

describe('older builds', () => {
  it('go on reading `myChats` as the projection of the bots parked on an own chat', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'researcher', 'sess-ideas')

    expect(gateway.app()?.myChats).toEqual(['researcher'])

    await newDevice()
    await openAndReconcile(gateway)
    await chooseOnline(gateway, 'writer', 'sess-drafts')

    expect([...(gateway.app()?.myChats ?? [])].sort()).toEqual(['researcher', 'writer'])
    expect(gateway.app()?.current).toEqual({ researcher: 'sess-ideas', writer: 'sess-drafts' })
  })

  it('writing the section without `current` changes nothing about it here', async () => {
    const gateway = holdingGateway()

    // This device picked a chat for the writer an hour ago.
    await deviceHolding({ writer: 'sess-drafts' }, AN_HOUR_AGO)

    // Since then an older build wrote the section, newer and dated, with the
    // switch it knows: the researcher on the reader's own chat, no `current`.
    await olderBuildWrites(gateway, {
      v: 1,
      entries: ROSTER.map(name => ({ kind: 'chat', name })),
      myChats: ['researcher'],
      updatedAt: A_MINUTE_AGO
    })

    await openAndReconcile(gateway)

    // The newer section won, and still did not move the writer anywhere.
    expect(useAppStampStore.getState().updatedAt).toBe(A_MINUTE_AGO)
    expect(layout().current).toEqual({ writer: 'sess-drafts' })
    expect(currentTargetOf(layout(), 'writer')).toBe('sess-drafts')
    // The older build's switch is readable as a legacy entry: the bare-lead
    // chat, found by title, for the directory to resolve.
    expect(currentTargetOf(layout(), 'researcher')).toBeNull()
    // And the projection still names the writer, so the next write does not
    // tell an older build that the writer is back on its group chat.
    expect(Object.keys(layout().myChats).sort()).toEqual(['researcher', 'writer'])
  })

  it('leave a first device with the legacy set and an empty map', async () => {
    const gateway = holdingGateway()

    await olderBuildWrites(gateway, {
      v: 1,
      entries: ROSTER.map(name => ({ kind: 'chat', name })),
      myChats: ['researcher'],
      updatedAt: AN_HOUR_AGO
    })

    await newDevice()
    await openAndReconcile(gateway)

    expect(layout().current).toEqual({})
    expect(layout().myChats).toEqual({ researcher: true })
    expect(currentTargetOf(layout(), 'researcher')).toBeNull()
    expect(currentTargetOf(layout(), 'writer')).toBeUndefined()
  })
})

describe('what never leaves the device', () => {
  it('keeps the conversation column’s Hide/Show out of the section', async () => {
    const gateway = holdingGateway()

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    layout().setConversationsCollapsed(true)
    await settled()

    expect(projected()).not.toHaveProperty('conversationsCollapsed')
    expect(gateway.app() ?? {}).not.toHaveProperty('conversationsCollapsed')
    // Not a choice about the section either, so nothing was dated.
    expect(useAppStampStore.getState().updatedAt).toBe(0)

    device.stop()
  })
})
