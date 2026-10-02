/**
 * Pinning a chat: the sort, where it is stored, and the band a drag may not leave.
 *
 * Three properties, and the third is the one round four's handover warned about
 * — "it changes the order the drag arithmetic reads, and this round had already
 * changed that arithmetic once". So the drag assertions here are not about the
 * gesture (a `PanResponder` needs a touch and a layout pass, as ADR-0019 already
 * says) but about the arithmetic underneath it, which is pure.
 *
 * The rule the clamp enforces, stated once so the tests can be read against it:
 *
 *   **A pinned row may only be dropped among the pinned rows of a container, and
 *   an unpinned row only among the unpinned ones.** A folder is never pinned, so
 *   a folder is clamped to the unpinned band. `folderIn:` and `folderEmpty:`
 *   mean "the top of that folder" and are legal for either band, so pinning has
 *   not made any chat undraggable into a folder.
 */
import { clampToPinnedBand, dragAnchors, folderRows, type RowsInput } from '../src/features/bots/folder-rows'
import { parseRowMenuAction, rowMenuItems } from '../src/features/bots/row-menu-items'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { snapshotFromStores, applySnapshot, type HermieAppShape } from '../src/store/ui-meta-bridge'
import { HERMIE_APP_SECTION_VERSION } from '@hermie/gateway-client/ui-meta'

/** The same in-memory disk `chat-layout-store.test.ts` uses, for the same reason. */
const mockDisk = new Map<string, string>()

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async (key: string) => mockDisk.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockDisk.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      mockDisk.delete(key)
    }),
    getJson: jest.fn(async (key: string) => {
      const raw = mockDisk.get(key)

      return raw === undefined ? null : JSON.parse(raw)
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      mockDisk.set(key, JSON.stringify(value))
    })
  }
}))

const input = (over: Partial<RowsInput> = {}): RowsInput => ({
  arrangement: {
    entries: [
      { kind: 'chat', name: 'alpha' },
      { kind: 'chat', name: 'bravo' },
      { kind: 'folder', id: 'f1' },
      { kind: 'chat', name: 'charlie' }
    ],
    folders: [{ id: 'f1', name: 'Finance', colour: 'default', bots: ['delta', 'echo', 'foxtrot'] }]
  },
  archived: {},
  collapsed: {},
  mutes: {},
  now: 1_700_000_000,
  countsFor: () => ({ unread: 0, needsInput: false }),
  ...over
})

const keys = (over: Partial<RowsInput> = {}) => folderRows(input(over)).map(row => row.key)

/** The store's write queue is a promise chain; one turn lets it drain. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  useChatLayoutStore.getState().reset()
  mockDisk.clear()
})

describe('the sort', () => {
  it('leaves the list exactly as it was when nothing is pinned', () => {
    expect(keys()).toEqual([
      'bot:alpha',
      'bot:bravo',
      'folder:f1',
      'bot:delta',
      'bot:echo',
      'bot:foxtrot',
      'bot:charlie'
    ])
  })

  /**
   * "First within the top level" means first, not "first among the loose chats".
   * A band that stopped at the first folder would not be the top of anything a
   * reader can see.
   */
  it('lifts a pinned chat above the folders as well as above the other chats', () => {
    expect(keys({ pinned: { charlie: true } })[0]).toBe('bot:charlie')
  })

  /**
   * A stable partition, which is the whole rule: pinning reorders nothing
   * WITHIN either half. Pinning bravo and charlie puts them at the top in the
   * order they already had, not in the order they were pinned.
   */
  it('keeps pinned rows in the order they already had, among themselves', () => {
    expect(keys({ pinned: { bravo: true, charlie: true } })).toEqual([
      'bot:bravo',
      'bot:charlie',
      'bot:alpha',
      'folder:f1',
      'bot:delta',
      'bot:echo',
      'bot:foxtrot'
    ])
  })

  it('sorts inside a folder without touching the top level', () => {
    expect(keys({ pinned: { foxtrot: true } })).toEqual([
      'bot:alpha',
      'bot:bravo',
      'folder:f1',
      'bot:foxtrot',
      'bot:delta',
      'bot:echo',
      'bot:charlie'
    ])
  })

  /**
   * The reason pinning is a separate key rather than `moveBotTo(0)`: the
   * arrangement underneath never moved, so letting go puts the row back exactly
   * where it was rather than wherever the top of the list has drifted to.
   */
  it('is a display sort, so unpinning puts the row back where it was', () => {
    const pinnedOnce = keys({ pinned: { charlie: true } })

    expect(pinnedOnce[0]).toBe('bot:charlie')
    expect(keys({ pinned: {} })).toEqual(keys())
  })
})

describe('the anchors the drag reads', () => {
  /**
   * An anchor pairs a place ON SCREEN with the arrangement position a drop
   * commits to, and pinning makes those two orders different. The walk has to be
   * the displayed one or every drop line lands where the finger is not.
   */
  it('are emitted in DISPLAY order, matching the rows one for one', () => {
    const over = { pinned: { charlie: true, foxtrot: true } }
    const rowKeys = folderRows(input(over)).map(row => row.key)
    const anchorKeys = dragAnchors(input(over))
      .map(anchor => anchor.key)
      // The two synthetic anchors stand for positions rather than rows.
      .filter(key => !key.startsWith('folderIn:') && !key.startsWith('folderEmpty:'))

    expect(anchorKeys).toEqual(rowKeys)
  })

  /**
   * ...while the TARGET stays an index into the untouched arrangement, which is
   * the space `moveBotTo` reads. Charlie is displayed first and is arrangement
   * entry 3; reporting 0 would move a different row.
   */
  it('still report arrangement indices, not screen positions', () => {
    const anchors = dragAnchors(input({ pinned: { charlie: true } }))

    expect(anchors[0]).toEqual({ key: 'bot:charlie', target: { folderId: null, index: 3 } })
    expect(anchors.find(anchor => anchor.key === 'bot:foxtrot')?.target).toEqual({ folderId: 'f1', index: 2 })
  })
})

describe('the band a drag may not leave', () => {
  const pinned = { alpha: true, bravo: true }
  const anchors = dragAnchors(input({ pinned }))
  const at = (key: string) => anchors.findIndex(anchor => anchor.key === key)
  const clamp = (key: string, slot: number) => clampToPinnedBand(anchors, pinned, key, slot)

  /** Within the band, nothing is changed: the clamp is a boundary, not a magnet. */
  it('leaves a legal slot alone', () => {
    expect(clamp('bot:alpha', at('bot:bravo'))).toBe(at('bot:bravo'))
    expect(clamp('bot:charlie', at('bot:charlie'))).toBe(at('bot:charlie'))
  })

  /**
   * A slot is a GAP, so the gap just past the band's last row is still inside
   * it — that is "at the end of the band". A pinned row dragged to the bottom of
   * the list rests there rather than snapping back to the top.
   */
  it('holds a pinned row at the end of the pinned band, not at its start', () => {
    // The band is anchors 0 and 1; the gap just past it is slot 2.
    expect(clamp('bot:alpha', anchors.length - 1)).toBe(2)
  })

  /**
   * The failure the `exact` flag exists for, and it was a real one: a pinned row
   * dragged to the bottom walks back up looking for somewhere legal, and without
   * the flag it met `folderIn:f1` first and was filed INSIDE Finance. Landing a
   * chat in a folder nobody pointed at is worse than the thing being prevented.
   */
  it('never files a row into a folder the reader did not aim at', () => {
    const landed = clamp('bot:alpha', anchors.length - 1)

    expect(anchors[landed]?.key).not.toBe('folderIn:f1')
    expect(anchors[landed]?.target.folderId ?? null).toBeNull()
  })

  /** And the mirror: an unpinned row dragged into the band rests at its edge. */
  it('holds an unpinned row below the pinned band', () => {
    const landed = clamp('bot:charlie', 0)

    expect(landed).toBeGreaterThanOrEqual(2)
    expect(anchors.slice(0, landed).every(anchor => ['bot:alpha', 'bot:bravo'].includes(anchor.key))).toBe(true)
  })

  /**
   * A folder has no pinned-ness, so it is clamped to the unpinned band — which
   * is the same statement as "pinned chats sort first", seen from the dragging
   * end.
   */
  it('treats a folder as unpinned, so it cannot be dropped above the pinned chats', () => {
    expect(clamp('folder:f1', 0)).toBeGreaterThanOrEqual(2)
  })

  /**
   * The loss pinning must NOT cause. `folderIn:` means "index 0 of that folder",
   * which is the top of that container and therefore inside either band; a
   * clamp that excluded it would make a pinned chat undraggable into a folder at
   * all.
   */
  it('still lets a pinned chat be dropped into a folder', () => {
    const into = anchors.findIndex(anchor => anchor.key === 'folderIn:f1')

    expect(into).toBeGreaterThan(-1)
    expect(clamp('bot:alpha', into)).toBe(into)
  })

  it('does nothing at all when no chat is pinned', () => {
    const loose = dragAnchors(input())

    for (let slot = 0; slot < loose.length; slot += 1) {
      expect(clampToPinnedBand(loose, {}, 'bot:charlie', slot)).toBe(slot)
    }
  })
})

describe('where a pin is kept', () => {
  it('survives a round trip through the disk', async () => {
    const layout = useChatLayoutStore.getState()

    await layout.load('gw')
    layout.togglePinned('alpha')

    expect(useChatLayoutStore.getState().pinned).toEqual({ alpha: true })

    await settle()

    // A fresh store reading the same gateway's key back.
    useChatLayoutStore.getState().reset()
    await useChatLayoutStore.getState().load('gw')

    expect(useChatLayoutStore.getState().pinned).toEqual({ alpha: true })
  })

  it('toggles off again, and unpinning the last chat is stored as such', async () => {
    await useChatLayoutStore.getState().load('gw')
    useChatLayoutStore.getState().togglePinned('alpha')
    useChatLayoutStore.getState().togglePinned('alpha')

    expect(useChatLayoutStore.getState().pinned).toEqual({})

    await settle()
    useChatLayoutStore.getState().reset()
    await useChatLayoutStore.getState().load('gw')

    expect(useChatLayoutStore.getState().pinned).toEqual({})
  })

  it('rides in the app-wide ui_meta section, beside the order and the folders', () => {
    useChatLayoutStore.setState({ pinned: { alpha: true, bravo: true } })

    const app = snapshotFromStores().app as HermieAppShape

    expect(app.pinned?.sort()).toEqual(['alpha', 'bravo'])
  })

  /**
   * **The version is NOT bumped, and this test is what makes that a decision
   * rather than an oversight.**
   *
   * `readSection` answers `null` for any section whose `v` is greater than the
   * reader's own, and a build that meets one re-seeds the whole app-wide section
   * from its local copy. Bumping would therefore hand every older build the
   * power to delete the folders, the order and the mutes — it would not protect
   * `pinned` from anything. Round four declined the same instruction for
   * `push.perBot` for the same reason.
   */
  it('does not bump the app section version', () => {
    expect(HERMIE_APP_SECTION_VERSION).toBe(1)
    expect((snapshotFromStores().app as HermieAppShape).v).toBe(1)
  })

  /** Always sent, empty included — otherwise unpinning the last chat cannot be said. */
  it('sends the key even when nothing is pinned', () => {
    expect((snapshotFromStores().app as HermieAppShape).pinned).toEqual([])
  })

  /**
   * Absent is not empty. A section written by a build that predates the field
   * says nothing about pins, and reading that as "none" would unpin every chat
   * the moment an older device wrote.
   */
  it('leaves local pins alone when a remote section does not mention the field', () => {
    useChatLayoutStore.setState({ pinned: { alpha: true } })
    applySnapshot({ app: { v: 1, entries: [] } as HermieAppShape, bots: {} })

    expect(useChatLayoutStore.getState().pinned).toEqual({ alpha: true })
  })

  it('takes a remote section that does mention it, including an empty one', () => {
    useChatLayoutStore.setState({ pinned: { alpha: true } })
    applySnapshot({ app: { v: 1, entries: [], pinned: ['bravo'] } as HermieAppShape, bots: {} })

    expect(useChatLayoutStore.getState().pinned).toEqual({ bravo: true })

    applySnapshot({ app: { v: 1, entries: [], pinned: [] } as HermieAppShape, bots: {} })

    expect(useChatLayoutStore.getState().pinned).toEqual({})
  })

  /** A blob an older build wrote can hold anything; a non-string is not a name. */
  it('reads a remote list defensively', () => {
    applySnapshot({
      app: { v: 1, entries: [], pinned: ['alpha', '', 7, null] as unknown as string[] } as HermieAppShape,
      bots: {}
    })

    expect(useChatLayoutStore.getState().pinned).toEqual({ alpha: true })
  })
})

describe('the row menu', () => {
  const model = { accent: 'default' as const, archived: false, botName: 'alpha', displayName: 'Alpha', unread: false }

  it('says what pressing it will do, in both states', () => {
    expect(rowMenuItems({ ...model }).find(item => item.id === 'pin')?.title).toBe('Pin')
    expect(rowMenuItems({ ...model, pinned: true }).find(item => item.id === 'pin')?.title).toBe('Unpin')
  })

  /** Above Mute: the first of the lines about where this row SITS. */
  it('puts Pin directly above Mute', () => {
    const ids = rowMenuItems({ ...model }).map(item => item.id)

    expect(ids.indexOf('pin')).toBe(ids.indexOf('mute') - 1)
  })

  it('reads back as a toggle, not a value', () => {
    expect(parseRowMenuAction('pin')).toEqual({ kind: 'pinToggle' })
  })
})
