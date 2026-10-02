/**
 * The chat list's arrangement, on somebody's second device.
 *
 * What was reported: folders do not seem to be synced between devices. They are
 * in the same `ui_meta` section as the theme and travel by the same rules, so the
 * dates that fixed the theme fixed half of this — but only half, and the other
 * half is this suite.
 *
 * The live roster is folded into the arrangement whenever it changes: a bot that
 * has appeared goes at the end of the loose run, one that is gone is dropped. On
 * a second device that fold runs against the list the device happens to be
 * holding, which on a first sign-in is nothing at all, and it runs BEFORE the
 * gateway's copy has been read — the roster arrives on the same connection and
 * does not wait for it. The section was then dated as though somebody had just
 * dragged six rows into place, and a flat list of six chats, being the newer
 * choice, replaced the folders on the gateway for every device.
 *
 * So the fold is counted rather than dated: it is persisted and sent like any
 * other change, because a new bot does belong in the list, and it does not claim
 * that anybody chose anything.
 */
import { useAppStampStore } from '../src/store/app-stamp'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { snapshotFromStores, type HermieAppShape } from '../src/store/ui-meta-bridge'
import { holdingGateway, newDevice, openApp, settled, type HoldingGateway } from './support/ui-meta-devices'

const ROSTER = ['researcher', 'writer']
const AN_HOUR_AGO = Math.floor(Date.now() / 1000) - 3600

/** What this device would send right now. */
const projected = (): HermieAppShape => snapshotFromStores().app as HermieAppShape

/** One device, connected, with a folder holding the writer. */
async function arrangeOnline(gateway: HoldingGateway): Promise<void> {
  const device = openApp(gateway)

  await device.watching
  await device.bridge.reconcile()
  useChatLayoutStore.getState().reconcile(ROSTER)

  const folder = useChatLayoutStore.getState().addFolder('Finance')

  useChatLayoutStore.getState().moveToFolder('writer', folder)
  await settled()
  device.stop()
  await settled()
}

afterEach(async () => {
  await settled()
  await settled()
})

describe('the folders, on a second device', () => {
  it('arrive, and are not replaced by that device’s own flat list', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await arrangeOnline(gateway)

    expect(gateway.app()?.folders).toHaveLength(1)

    // An hour ago, so that nothing below can pass on a tie.
    gateway.dateApp(AN_HOUR_AGO)

    // The other device: nothing arranged on it, and the roster lands before the
    // reconcile does, exactly as it does in the app.
    await newDevice()

    const phone = openApp(gateway)

    await phone.watching
    useChatLayoutStore.getState().reconcile(ROSTER)
    await phone.bridge.reconcile()
    await settled()
    phone.stop()

    expect(useChatLayoutStore.getState().folders.map(folder => folder.name)).toEqual(['Finance'])
    expect(useChatLayoutStore.getState().folders[0]?.bots).toEqual(['writer'])
    // And the gateway still holds them, which is the half that made this a loss
    // rather than an inconvenience.
    expect(gateway.app()?.folders).toHaveLength(1)
  })

  it('arrive in the other connect order too', async () => {
    const gateway = holdingGateway()

    // This device goes first with a flat list of its own, and is then the older
    // copy when the arranged one turns up.
    await newDevice()

    const first = openApp(gateway)

    await first.watching
    useChatLayoutStore.getState().reconcile(ROSTER)
    await first.bridge.reconcile()
    await settled()
    first.stop()
    await settled()

    expect(gateway.app()?.entries).toHaveLength(2)

    await newDevice()
    await arrangeOnline(gateway)

    expect(gateway.app()?.folders).toHaveLength(1)

    // An hour ago, so that the fold below cannot win a tie instead of losing on
    // the rule this case is about.
    gateway.dateApp(AN_HOUR_AGO)

    // And back on the first device, whose own list was the flat one.
    await newDevice()

    const again = openApp(gateway)

    await again.watching
    useChatLayoutStore.getState().reconcile(ROSTER)
    await again.bridge.reconcile()
    await settled()
    again.stop()

    expect(useChatLayoutStore.getState().folders.map(folder => folder.name)).toEqual(['Finance'])
  })

  it('keeps a rearrangement made with no socket', async () => {
    const gateway = holdingGateway()

    await newDevice()
    await arrangeOnline(gateway)
    gateway.dateApp(AN_HOUR_AGO)

    // The other device, offline: it makes a folder of its own with nothing to
    // send it to, and that is a choice rather than a fold.
    await newDevice()

    const failing = openApp({ ...gateway, request: () => Promise.reject(new Error('gateway not connected')) })

    await failing.watching
    useChatLayoutStore.getState().reconcile(ROSTER)
    await failing.bridge.reconcile()
    useChatLayoutStore.getState().addFolder('Travel')
    await settled()
    failing.stop()
    await settled()

    const back = openApp(gateway)

    await back.bridge.reconcile()
    await settled()
    back.stop()

    expect(gateway.app()?.folders?.map(folder => folder.name)).toEqual(['Travel'])
  })
})

describe('the roster folding itself in', () => {
  it('does not date the section, because nobody chose it', async () => {
    const gateway = holdingGateway()

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    useChatLayoutStore.getState().reconcile(ROSTER)
    await settled()

    expect(useChatLayoutStore.getState().entries).toHaveLength(2)
    expect(useAppStampStore.getState().updatedAt).toBe(0)
    expect(projected().updatedAt).toBeUndefined()

    device.stop()
  })

  it('is still sent, because a bot that has appeared belongs in the list', async () => {
    const gateway = holdingGateway()

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    useChatLayoutStore.getState().reconcile(ROSTER)
    await settled()

    expect(gateway.app()?.entries).toEqual([
      { kind: 'chat', name: 'researcher' },
      { kind: 'chat', name: 'writer' }
    ])

    device.stop()
  })

  it('does not date the sweep of mutes that have already lapsed either', async () => {
    // The same housekeeping, on the same store, and it runs on every foreground.
    // A deadline that has passed had already stopped silencing anything, so
    // forgetting it is not a decision — and a device that dated it would become
    // the one that chose last and win an argument about a theme it had nothing
    // to say about.
    const gateway = holdingGateway()

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    useChatLayoutStore.getState().setMute('researcher', 1_000)
    await settled()

    const chosenAt = useAppStampStore.getState().updatedAt

    expect(chosenAt).toBeGreaterThan(0)

    useChatLayoutStore.getState().dropExpiredMutes(2_000)
    await settled()

    expect(useChatLayoutStore.getState().mutes).toEqual({})
    expect(useAppStampStore.getState().updatedAt).toBe(chosenAt)
    // Still sent, so that the section stops collecting last spring's deadlines.
    expect(gateway.app()?.mutes).toEqual({})

    device.stop()
  })

  it('leaves a drag straight after it dated, which is the case next to it', async () => {
    const gateway = holdingGateway()

    await newDevice()

    const device = openApp(gateway)

    await device.watching
    await device.bridge.reconcile()
    useChatLayoutStore.getState().reconcile(ROSTER)
    // The fold and the drag are two writes, so they are two notifications, and
    // only the second one is somebody's decision.
    useChatLayoutStore.getState().addFolder('Finance')
    await settled()

    expect(useAppStampStore.getState().updatedAt).toBeGreaterThan(0)

    device.stop()
  })
})
