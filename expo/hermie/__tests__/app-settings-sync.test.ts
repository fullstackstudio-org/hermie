/**
 * The settings in ADR-0016's app-wide key, on somebody's second device.
 *
 * What was reported: "I set my theme to Graphite on macOS. The moment I open
 * another device, it resets the theme to whatever was active on that device."
 * And it was worse than a second device showing the wrong colour — the second
 * device then wrote its own copy back, so the choice was undone for every device
 * including the one it was made on.
 *
 * Two things were wrong, and both are here:
 *
 *  1. **The disk read raced the gateway's copy.** The settings are read from disk
 *     in one effect and the socket comes up in another, so the arriving theme went
 *     into the stores and the disk's landed on top of it a moment later. The
 *     bridge, which is a diff over the LOCAL stores, then read that as somebody
 *     choosing something and sent it.
 *  2. **The section did not say when anything was chosen.** "Last writer wins"
 *     meant whichever device flushed last, which on a reconnect is the device that
 *     reconnected rather than the choice that was made last.
 *
 * `packages/gateway-client/src/ui-meta.test.ts` pins the comparison itself over a
 * real socket. This suite is the app on top of it: real stores, a real disk, and a
 * gateway that remembers what it was told.
 */
import { HERMIE_APP_SECTION_VERSION } from '@hermie/gateway-client/ui-meta'

import { keyValueStore } from '../src/platform/key-value-store'
import { APP_STAMP_KEY, useAppStampStore } from '../src/store/app-stamp'
import { CHAT_VIEW_KEY, useSettingsStore } from '../src/store/settings'
import { snapshotFromStores, type HermieAppShape } from '../src/store/ui-meta-bridge'
import {
  APP_KEY,
  holdingGateway,
  newDevice,
  NS,
  openApp,
  readDisk,
  settled,
  type HoldingGateway
} from './support/ui-meta-devices'

const AN_HOUR_AGO = Math.floor(Date.now() / 1000) - 3600
const A_MINUTE_AGO = Math.floor(Date.now() / 1000) - 60

/** What this device would send right now. */
const projected = (): HermieAppShape => snapshotFromStores().app as HermieAppShape

/** A device that has already chosen this theme, at this moment, and put it away. */
async function deviceHolding(themePreset: string, chosenAt: number): Promise<void> {
  await newDevice()
  await keyValueStore.setJson(NS.key(CHAT_VIEW_KEY), {
    defaults: { level: 'quiet', showBotToBot: true, showThinking: false },
    perChat: {},
    themeChoice: { kind: 'preset', name: themePreset }
  })
  await keyValueStore.setJson(NS.key(APP_STAMP_KEY), { updatedAt: chosenAt })
}

/** One device picking a theme while it is connected, and the gateway hearing it. */
async function chooseOnline(gateway: HoldingGateway, themePreset: 'blue' | 'graphite' | 'lime'): Promise<void> {
  const device = openApp(gateway)

  await device.bridge.reconcile()
  useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: themePreset })
  await settled()
  device.stop()
  await settled()
}

afterEach(async () => {
  // A flush is one debounce and two round trips behind the last `set`, and a
  // flush still running when the environment goes down is a torn-down import.
  await settled()
  await settled()
})

describe('the theme, on a second device', () => {
  it('follows the person rather than resetting to whatever that device had', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'graphite')

    expect(gateway.app()?.themeChoice).toEqual({ kind: 'preset', name: 'graphite' })

    // The choice was made an hour ago, not in the same second as this test's
    // next line. Everything below would pass on a tie.
    gateway.dateApp(AN_HOUR_AGO)

    // The other device: it has Lime on it, from before, and its disk read lands
    // the way the app's does — after the connection is up.
    await deviceHolding('lime', AN_HOUR_AGO - 600)

    const phone = openApp(gateway)

    await phone.bridge.reconcile()
    await settled()
    phone.stop()

    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
    // And the gateway still holds it, which is the half that made this a loss
    // rather than an inconvenience.
    expect(gateway.app()?.themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
  })

  it('carries in the other direction too, whichever device connected first', async () => {
    const gateway = holdingGateway()

    // The phone goes first this time, and the desktop's choice is the newer one.
    await newDevice()
    await chooseOnline(gateway, 'lime')
    gateway.dateApp(AN_HOUR_AGO)

    await deviceHolding('graphite', A_MINUTE_AGO)

    const desktop = openApp(gateway)

    await desktop.bridge.reconcile()
    await settled()
    desktop.stop()

    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
    expect(gateway.app()?.themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
  })

  it('keeps a change made with no socket, and lands it on the next connect', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'blue')
    gateway.dateApp(AN_HOUR_AGO)

    // The other device, offline: it picks Graphite with nothing to send it to.
    await deviceHolding('lime', AN_HOUR_AGO - 600)

    const failing = openApp({
      ...gateway,
      request: () => Promise.reject(new Error('gateway not connected'))
    })

    await failing.bridge.reconcile()
    useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: 'graphite' })
    await settled()
    failing.stop()

    // Dated by the choice, and the date is on the disk with it.
    expect(useAppStampStore.getState().updatedAt).toBeGreaterThan(AN_HOUR_AGO)

    // The same device, once there is a gateway again. Nothing was wiped: this is
    // the app coming back, not a second device.
    const back = openApp(gateway)

    await back.bridge.reconcile()
    await settled()
    back.stop()

    expect(gateway.app()?.themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
  })

  it('does not let a device that changed nothing win by reconnecting last', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'graphite')
    gateway.dateApp(A_MINUTE_AGO)

    // This device has an unsent section of its own — a push registration, which
    // every device writes on every connect — and an older theme. The section
    // being dirty must not make its theme the newer one.
    await deviceHolding('lime', AN_HOUR_AGO)

    const phone = openApp(gateway)

    await readDisk()
    await phone.bridge.reconcile()
    await settled()
    phone.stop()

    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
    expect(gateway.app()?.themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
  })
})

describe('the date the section carries', () => {
  it('moves when somebody chooses something', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await readDisk()

    const device = openApp(gateway)

    await device.bridge.reconcile()

    expect(projected().updatedAt).toBeUndefined()

    useSettingsStore.getState().setTextSize('large')
    await settled()

    expect(projected().updatedAt).toBeGreaterThan(0)

    device.stop()
  })

  it('does not move for a section that only arrived', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'graphite')
    gateway.dateApp(AN_HOUR_AGO)

    await newDevice()

    const phone = openApp(gateway)

    await phone.bridge.reconcile()
    await settled()
    phone.stop()

    // Adopted with the section, not re-dated as though this device chose it.
    // Without that the two devices would argue again on every reconnect, and the
    // one that reconnected last would keep winning.
    expect(useAppStampStore.getState().updatedAt).toBe(AN_HOUR_AGO)
    expect(gateway.app()?.updatedAt).toBe(AN_HOUR_AGO)
  })

  it('is never older than the date this device already holds', async () => {
    // Two devices do not share a clock. A phone a minute behind the desktop
    // would otherwise date its owner's newest choice into the past and lose to
    // the one it just replaced.
    await newDevice()
    await readDisk()
    useAppStampStore.getState().applyRemote(Math.floor(Date.now() / 1000) + 600)

    const adopted = useAppStampStore.getState().updatedAt

    useAppStampStore.getState().touch()

    expect(useAppStampStore.getState().updatedAt).toBeGreaterThan(adopted)
  })

  it('survives the launch after it arrived', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'graphite')
    gateway.dateApp(AN_HOUR_AGO)

    await newDevice()

    const first = openApp(gateway)

    await first.bridge.reconcile()
    await settled()
    first.stop()
    await settled()

    // The same device again, with nothing to reach: the arriving copy was
    // written to disk, so the window opens on the theme the person chose rather
    // than on the one they replaced.
    useSettingsStore.getState().reset()
    useAppStampStore.getState().reset()
    await readDisk()

    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
    expect(useAppStampStore.getState().updatedAt).toBe(AN_HOUR_AGO)
  })
})

describe('the section this all rides in', () => {
  it('leaves the other keys on the profile exactly where they were', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'graphite')

    const roster = (await gateway.request('profiles.list', {})) as {
      profiles: { name: string; ui_meta: Record<string, unknown> }[]
    }
    const researcher = roster.profiles.find(row => row.name === 'researcher')

    // The marker another tool owns, and the plugin's advert. A client that wrote
    // its settings by replacing the bag would un-bot the whole roster.
    expect(Object.keys(researcher?.ui_meta ?? {}).sort()).toEqual([APP_KEY, 'hermes-bots', 'hermie-plugin'].sort())
  })

  it('stays at version 1 however many fields it gains', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await chooseOnline(gateway, 'graphite')

    // Every field since the first — folders, pins, `myChats`, labels, `current`
    // — is additive. A `v` an older build does not know makes it treat the whole
    // section as unreadable and re-seed it from its own copy (ADR-0016).
    expect(HERMIE_APP_SECTION_VERSION).toBe(1)
    expect(gateway.app()?.v).toBe(1)
    expect(gateway.app()).toHaveProperty('current')
    expect(gateway.app()).toHaveProperty('myChats')
  })
})
