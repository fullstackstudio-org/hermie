/**
 * The name somebody gave a bot, on their second device.
 *
 * The editable name on a bot's sheet is the APP's own: no call a client has
 * writes a profile's `display_name` — the one route that touches it renames the
 * profile, which is the report that decision came out of — so the name is stored
 * beside the reader's folders and colours and preferred over the roster's copy.
 * That made it a name which only existed on the device it was typed on, which is
 * the gap this suite closes.
 *
 * It travels in ADR-0016's app-wide section, by the same rules and the same dates
 * as the theme and the folders: `expo/hermie/__tests__/app-settings-sync.test.ts`
 * and `arrangement-sync.test.ts` are the two suites beside this one, and
 * `ui-meta-bridge.test.ts` pins the projection itself. What is worth asking here
 * is only what needs two devices: does a rename arrive, does one made with no
 * socket survive, and does CLEARING the field arrive as well — because a name
 * taken back that stays on the other device is the same bug the other way round.
 */
import { useAppStampStore } from '../src/store/app-stamp'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { snapshotFromStores, type HermieAppShape } from '../src/store/ui-meta-bridge'
import { holdingGateway, newDevice, openApp, readDisk, settled, type HoldingGateway } from './support/ui-meta-devices'

const ROSTER = ['researcher', 'writer']
const AN_HOUR_AGO = Math.floor(Date.now() / 1000) - 3600

/** What this device would send right now. */
const projected = (): HermieAppShape => snapshotFromStores().app as HermieAppShape

/** One device, connected, naming the writer. */
async function nameOnline(gateway: HoldingGateway, name: string): Promise<void> {
  const device = openApp(gateway)

  await device.watching
  await device.bridge.reconcile()
  useChatLayoutStore.getState().reconcile(ROSTER)
  useChatLayoutStore.getState().setLabel('writer', name)
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

describe('a bot’s name, on a second device', () => {
  it('follows the person rather than staying on the device it was typed on', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await nameOnline(gateway, 'De Schrijver')

    expect(gateway.app()?.labels).toEqual({ writer: 'De Schrijver' })

    // The name was given an hour ago, not in the same second as the next line.
    gateway.dateApp(AN_HOUR_AGO)

    await newDevice()

    const phone = openApp(gateway)

    await phone.watching
    await phone.bridge.reconcile()
    await settled()
    phone.stop()

    expect(useChatLayoutStore.getState().labels).toEqual({ writer: 'De Schrijver' })
    // And it is still there, which is the half that made this a loss rather
    // than an inconvenience: the second device must not write its own silence
    // back over the name.
    expect(gateway.app()?.labels).toEqual({ writer: 'De Schrijver' })
  })

  it('keeps a rename made with no socket, and lands it on the next connect', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await nameOnline(gateway, 'De Schrijver')
    gateway.dateApp(AN_HOUR_AGO)

    // The other device, offline: it names the same bot with nothing to send it
    // to, and that is a choice rather than a fold.
    await newDevice()

    const failing = openApp({ ...gateway, request: () => Promise.reject(new Error('gateway not connected')) })

    await failing.watching
    await failing.bridge.reconcile()
    useChatLayoutStore.getState().setLabel('writer', 'Tekstschrijver')
    await settled()
    failing.stop()
    await settled()

    // Dated by the choice, which is what tells the next reconcile that this
    // device is holding the newer copy rather than the one it reconnected with.
    expect(useAppStampStore.getState().updatedAt).toBeGreaterThan(AN_HOUR_AGO)

    // The same device, once there is a gateway again.
    const back = openApp(gateway)

    await back.watching
    await back.bridge.reconcile()
    await settled()
    back.stop()

    expect(gateway.app()?.labels).toEqual({ writer: 'Tekstschrijver' })
    expect(useChatLayoutStore.getState().labels).toEqual({ writer: 'Tekstschrijver' })
  })

  it('is taken back everywhere when the reader empties the field', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await nameOnline(gateway, 'De Schrijver')

    // The second device takes the name, and the reader empties the field there.
    await newDevice()

    const phone = openApp(gateway)

    await phone.watching
    await phone.bridge.reconcile()
    await settled()

    expect(useChatLayoutStore.getState().labels).toEqual({ writer: 'De Schrijver' })

    useChatLayoutStore.getState().setLabel('writer', '')
    await settled()
    phone.stop()
    await settled()

    // An EMPTY map rather than an absent key. It is the only way the other
    // device can tell "taken back" from "that build knows nothing about names".
    expect(gateway.app()?.labels).toEqual({})

    // A device that still has the name, from its own disk: it takes the
    // clearing like any other newer choice, and the row falls back to the
    // roster's display name and then to the handle.
    await newDevice()
    await readDisk()
    useChatLayoutStore.getState().setLabel('writer', 'De Schrijver')

    const desktop = openApp(gateway)

    await desktop.watching
    await desktop.bridge.reconcile()
    await settled()
    desktop.stop()

    expect(useChatLayoutStore.getState().labels).toEqual({})
  })

  it('is dated as a choice, unlike the roster folding itself in', async () => {
    const gateway = holdingGateway()

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    // The fold first, so that a date found afterwards cannot be its doing.
    useChatLayoutStore.getState().reconcile(ROSTER)
    await settled()

    expect(projected().updatedAt).toBeUndefined()

    useChatLayoutStore.getState().setLabel('writer', 'De Schrijver')
    await settled()

    // Naming a bot IS somebody deciding something, so it wins on every device
    // of theirs against whatever was chosen before it.
    expect(projected().updatedAt).toBeGreaterThan(0)

    device.stop()
  })
})
